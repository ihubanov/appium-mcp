#!/usr/bin/env python3
"""
vision-grounding sidecar — OCR/ONNX grounding for appium-mcp.

Gives the browser tools "eyes" for content the DOM cannot see: canvas, WebGL,
embedded viewers, images. Speaks JSON-lines over stdio (one request line in,
one response line out) and is spawned lazily by src/vision-grounding.ts.

Backends, in order of availability:
  1. onnx   — a YOLO-style detector exported to ONNX (OmniParser's MIT-licensed
              YOLOv9-E icon detector works here). Enabled by pointing
              APPIUM_MCP_VISION_MODEL at the .onnx file AND having onnxruntime
              importable. Optional: no runtime/weights, no problem.
  2. tesseract — OCR via the `tesseract` binary (no python deps). Locates a
              *visible text label* ("Sign in", "Play", …) and returns its
              bounding box. This is what the vision fallback rung uses to
              click controls that only exist as pixels.

Protocol:
  {"op": "ping"}
      -> {"ok": true, "backends": ["tesseract"], "model": null}
  {"op": "ground", "screenshot": "<base64 PNG>", "target": "Sign in",
   "width": 1280, "height": 720}
      -> {"ok": true, "match": {"x": .., "y": .., "w": .., "h": ..,
                                "text": "Sign in", "backend": "tesseract"}}
         x/y/w/h are in SCREENSHOT pixels. The Node caller rescales to
         viewport coordinates using width/height vs the image's own size.
  {"op": "detect", "screenshot": "<base64 PNG>", "width": .., "height": ..}
      -> {"ok": true, "regions": [{"x":..,"y":..,"w":..,"h":..,
                                    "label": .., "confidence": ..}]}
         All interactive-ish regions the ONNX backend can find. Requires the
         onnx backend; tesseract cannot enumerate regions.
Errors come back as {"ok": false, "reason": ".."} so the caller can degrade.
"""

import base64
import json
import os
import selectors
import shutil
import subprocess
import sys
import tempfile
import time

MODEL_PATH = os.environ.get("APPIUM_MCP_VISION_MODEL") or None
TESSERACT = shutil.which("tesseract")

# OmniParser defaults for the YOLOv9-E icon detector.
ONNX_CONF = 0.05
ONNX_IOU = 0.1

_ORT_SESSION = None  # cached onnxruntime session (weights load is ~100ms)


# ── backends ────────────────────────────────────────────────────────────────

def have_onnx() -> bool:
    if not MODEL_PATH or not os.path.isfile(MODEL_PATH):
        return False
    try:
        import onnxruntime  # noqa: F401
        return True
    except Exception:
        return False


def decode_png(b64: str, path: str) -> None:
    with open(path, "wb") as f:
        f.write(base64.b64decode(b64))


def run_tesseract(png: str, psm: int) -> list[dict]:
    """Run tesseract in TSV mode; return word boxes with layout ids.

    Each word: {block, par, line, word_num, left, top, width, height, conf, text}
    """
    proc = subprocess.run(
        [TESSERACT, png, "stdout", "tsv", "--psm", str(psm)],
        capture_output=True, text=True, timeout=60,
    )
    words = []
    header = None
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if header is None:
            if parts and parts[0] == "level":
                header = parts
            continue
        if len(parts) != len(header):
            continue
        row = dict(zip(header, parts))
        try:
            conf = float(row.get("conf", -1))
        except ValueError:
            conf = -1.0
        text = (row.get("text") or "").strip()
        if conf < 30 or not text:
            continue
        words.append({
            "block": int(row["block_num"]),
            "par": int(row["par_num"]),
            "line": int(row["line_num"]),
            "left": int(row["left"]),
            "top": int(row["top"]),
            "width": int(row["width"]),
            "height": int(row["height"]),
            "conf": conf,
            "text": text,
        })
    return words


def ground_tesseract(png: str, target: str) -> dict | None:
    """Find `target` (a visible label, case-insensitive) among OCR'd words.

    Two passes, strictest first:
      1. A contiguous word sequence on one OCR line matching ALL target
         words (e.g. "Sign in" for target "Sign in").
      2. Partial match: OCR on small/styled UI text (white-on-color,
         subpixel rendering) often misreads or drops a word, so an exact
         phrase match fails even though the label is plainly visible. Any
         line containing at least half the target words (min 1) counts;
         pick the line with the most matched words. This is what lets
         "Sign in to Portal" ground via its clearly-read "Sign in" part.
    The word boxes are unioned so the caller can click the middle.
    """
    target_words = target.lower().split()
    if not target_words:
        return None
    words = run_tesseract(png, psm=11)  # 11 = sparse text, right for UIs
    # Group words into lines.
    lines: dict[tuple, list[dict]] = {}
    for w in words:
        lines.setdefault((w["block"], w["par"], w["line"]), []).append(w)

    def bbox(ws: list[dict]) -> dict:
        left = min(w["left"] for w in ws)
        top = min(w["top"] for w in ws)
        right = max(w["left"] + w["width"] for w in ws)
        bottom = max(w["top"] + w["height"] for w in ws)
        return {"x": left, "y": top, "w": right - left, "h": bottom - top}

    # Pass 1: exact contiguous sequence.
    for ws in lines.values():
        ws = sorted(ws, key=lambda w: w["left"])
        texts = [w["text"].lower() for w in ws]
        n = len(target_words)
        for i in range(len(texts) - n + 1):
            if texts[i : i + n] == target_words:
                out = bbox(ws[i : i + n])
                out["text"] = " ".join(w["text"] for w in ws[i : i + n])
                out["backend"] = "tesseract"
                return out

    # Pass 2: partial — best line by matched target-word count.
    threshold = max(1, (len(target_words) + 1) // 2)
    best: tuple[int, list[dict]] | None = None
    for ws in lines.values():
        ws = sorted(ws, key=lambda w: w["left"])
        matched: list[dict] = []
        seen: set[str] = set()
        for w in ws:
            t = w["text"].lower()
            if t in target_words and t not in seen:
                seen.add(t)
                matched.append(w)
        if len(matched) >= threshold and (best is None or len(matched) > best[0]):
            best = (len(matched), matched)
    if best is not None:
        _, matched = best
        out = bbox(matched)
        out["text"] = " ".join(w["text"] for w in matched)
        out["backend"] = "tesseract"
        return out
    return None


def detect_onnx(png: str) -> list[dict]:
    """Run the icon detector (OmniParser YOLOv9-E ONNX export) over the
    screenshot. Returns xyxy regions in ORIGINAL pixel coordinates.

    Model I/O (verified against onnx-community/OmniParser-icon_detect):
      input  "images" [1,3,H,W] float, H/W dynamic but multiples of 16
             (preprocessor_config: longest edge 640, divisor 16, bilinear,
             rescale 1/255, no normalize)
      output [1,5,N] = cx, cy, w, h, conf  (single class: interactive icon)
    """
    import numpy as np
    from PIL import Image
    import onnxruntime as ort

    global _ORT_SESSION
    if _ORT_SESSION is None:
        _ORT_SESSION = ort.InferenceSession(
            MODEL_PATH, providers=["CPUExecutionProvider"]
        )
    sess = _ORT_SESSION

    img = Image.open(png).convert("RGB")
    scale = min(640 / img.width, 640 / img.height, 1.0)
    w = max(16, int(img.width * scale) // 16 * 16)
    h = max(16, int(img.height * scale) // 16 * 16)
    arr = np.asarray(img.resize((w, h), Image.BILINEAR)).astype(np.float32) / 255.0
    arr = arr.transpose(2, 0, 1)[None]

    out = np.asarray(sess.run(None, {sess.get_inputs()[0].name: arr})[0])[0].T
    sel = out[out[:, 4] > ONNX_CONF]
    if sel.size == 0:
        return []

    # cxcywh (model scale) -> xyxy (original scale)
    c = sel[:, :4] / scale
    xyxy = np.stack(
        [c[:, 0] - c[:, 2] / 2, c[:, 1] - c[:, 3] / 2,
         c[:, 0] + c[:, 2] / 2, c[:, 1] + c[:, 3] / 2], axis=1)

    # NMS at OmniParser's iou=0.1
    scores = sel[:, 4]
    keep: list[int] = []
    order = scores.argsort()[::-1]
    while order.size:
        i = order[0]
        keep.append(int(i))
        if order.size == 1:
            break
        xx = np.maximum(xyxy[i, 0], xyxy[order[1:], 0])
        yy = np.maximum(xyxy[i, 1], xyxy[order[1:], 1])
        x2 = np.minimum(xyxy[i, 2], xyxy[order[1:], 2])
        y2 = np.minimum(xyxy[i, 3], xyxy[order[1:], 3])
        inter = np.maximum(0, x2 - xx) * np.maximum(0, y2 - yy)
        a1 = (xyxy[i, 2] - xyxy[i, 0]) * (xyxy[i, 3] - xyxy[i, 1])
        a2 = (xyxy[order[1:], 2] - xyxy[order[1:], 0]) * \
             (xyxy[order[1:], 3] - xyxy[order[1:], 1])
        iou = inter / (a1 + a2 - inter + 1e-9)
        order = order[1:][iou <= ONNX_IOU]

    return [
        {
            "x": float(xyxy[i, 0]), "y": float(xyxy[i, 1]),
            "w": float(xyxy[i, 2] - xyxy[i, 0]),
            "h": float(xyxy[i, 3] - xyxy[i, 1]),
            "confidence": float(scores[i]),
        }
        for i in keep
    ]


# ── positional grounding (icon-only targets) ────────────────────────────────
# An icon with no readable text can't be matched by label. The hint can name
# WHERE it is on screen instead — "hamburger menu top left", "X close button
# top right", "play button center" — and we pick the highest-confidence
# detected interactive region in that zone.

POSITION_PHRASES = [
    "top left", "top right", "bottom left", "bottom right",
    "top center", "bottom center", "center", "middle",
]


def extract_position(target: str) -> tuple[str | None, str]:
    """Split a target like "X close button top right" into
    ("top right", "X close button"). Position words are removed from the
    text label so they never pollute the OCR word match."""
    t = target.lower()
    for phrase in POSITION_PHRASES:
        if phrase in t:
            label = target.lower().replace(phrase, " ").strip()
            return phrase, " ".join(label.split())
    return None, t


def region_in_zone(region: dict, zone: str, img_w: int, img_h: int) -> bool:
    cx = (region["x"] + region["w"] / 2) / max(img_w, 1)
    cy = (region["y"] + region["h"] / 2) / max(img_h, 1)
    top, bottom, left, right = cy < 1 / 3, cy > 2 / 3, cx < 1 / 3, cx > 2 / 3
    horiz_mid = 1 / 3 <= cx <= 2 / 3
    vert_mid = 1 / 3 <= cy <= 2 / 3
    return {
        "top left": top and left,
        "top right": top and right,
        "bottom left": bottom and left,
        "bottom right": bottom and right,
        "top center": top and horiz_mid,
        "bottom center": bottom and horiz_mid,
        "center": vert_mid and horiz_mid,
        "middle": vert_mid and horiz_mid,
    }.get(zone, False)


def refine_to_control(label_box: dict, regions: list[dict]) -> dict | None:
    """When OCR located a text label, the actual clickable control is often
    BIGGER than the text (button chrome, icon next to label). If a detected
    interactive region overlaps the label box well, return the control's
    box instead — click the button, not its caption."""
    lx1, ly1 = label_box["x"], label_box["y"]
    lx2, ly2 = lx1 + label_box["w"], ly1 + label_box["h"]
    l_area = max(label_box["w"] * label_box["h"], 1)
    best = None
    for r in regions:
        rx2, ry2 = r["x"] + r["w"], r["y"] + r["h"]
        ix = max(0, min(lx2, rx2) - max(lx1, r["x"]))
        iy = max(0, min(ly2, ry2) - max(ly1, r["y"]))
        if ix * iy / l_area > 0.5:  # region covers most of the label
            if best is None or r["confidence"] > best["confidence"]:
                best = r
    return best


# ── request handling ────────────────────────────────────────────────────────

def handle(req: dict) -> dict:
    op = req.get("op")

    if op == "ping":
        backends = []
        if TESSERACT:
            backends.append("tesseract")
        if have_onnx():
            backends.append("onnx")
        return {"ok": True, "backends": backends,
                "model": MODEL_PATH if have_onnx() else None}

    if op in ("ground", "detect"):
        b64 = req.get("screenshot")
        if not b64:
            return {"ok": False, "reason": "missing screenshot"}
        fd, png = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            decode_png(b64, png)

            if op == "detect":
                if not have_onnx():
                    return {"ok": False,
                            "reason": "onnx backend not configured "
                                      "(set APPIUM_MCP_VISION_MODEL)"}
                return {"ok": True, "regions": detect_onnx(png)}

            # op == "ground": the full ladder, strongest signal first.
            target = (req.get("target") or "").strip()
            if not target:
                return {"ok": False, "reason": "missing target text"}
            zone, text_label = extract_position(target)

            regions: list[dict] = []
            if have_onnx():
                try:
                    regions = detect_onnx(png)
                except Exception:
                    regions = []  # degrade to OCR-only, never fail the rung

            # 1. OCR text match on the label (position words stripped).
            label_box = None
            if text_label and TESSERACT:
                label_box = ground_tesseract(png, text_label)

            if label_box is not None:
                # 2. If a detected interactive control covers the label,
                #    click the control (button) rather than the caption.
                control = refine_to_control(label_box, regions)
                if control is not None:
                    return {"ok": True, "match": {
                        **control, "text": text_label,
                        "backend": "tesseract+onnx"}}
                return {"ok": True, "match": {
                    **label_box, "backend": "tesseract"}}

            # 3. Icon-only: no readable text matched. Use the zone the hint
            #    named ("top right", "center", …) to pick a detected region.
            if zone and regions:
                from PIL import Image
                img = Image.open(png)
                in_zone = [r for r in regions
                           if region_in_zone(r, zone, img.width, img.height)]
                if in_zone:
                    best = max(in_zone, key=lambda r: r["confidence"])
                    return {"ok": True, "match": {
                        **best, "text": zone, "backend": "onnx"}}

            # 4. Last resort: a single detected interactive region is
            #    unambiguous by construction.
            if label_box is None and len(regions) == 1:
                return {"ok": True, "match": {
                    **regions[0], "text": target, "backend": "onnx"}}

            why = f"label {text_label!r} not found on screen"
            if regions:
                why += (f" ({len(regions)} interactive region(s) detected — "
                        "add a position like 'top right' to the visual hint "
                        "to pick one)")
            return {"ok": False, "reason": why}
        finally:
            try:
                os.unlink(png)
            except OSError:
                pass

    return {"ok": False, "reason": f"unknown op {op!r}"}


IDLE_EXIT_SECONDS = 10 * 60  # self-exit after 10 min with no requests


def main() -> None:
    """
    Read JSON-lines requests until stdin closes OR we go idle. The idle exit
    is the backstop for a host that dies without killing us: a sidecar nobody
    talks to for 10 minutes exits on its own, so strays cannot accumulate.
    """
    sel = selectors.DefaultSelector()
    sel.register(sys.stdin, selectors.EVENT_READ)
    last_request = time.time()
    while True:
        events = sel.select(timeout=30)
        if not events:
            if time.time() - last_request > IDLE_EXIT_SECONDS:
                return
            continue
        line = sys.stdin.readline()
        if not line:  # stdin closed — host is gone
            return
        last_request = time.time()
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"ok": False, "reason": f"bad json: {e}"}),
                  flush=True)
            continue
        try:
            resp = handle(req)
        except Exception as e:  # never die on a bad request
            resp = {"ok": False, "reason": f"{type(e).__name__}: {e}"}
        print(json.dumps(resp), flush=True)


if __name__ == "__main__":
    main()
