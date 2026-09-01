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


def detect_onnx(png: str, width: int, height: int) -> list[dict]:
    """Run the ONNX detector over the screenshot (optional backend)."""
    import numpy as np
    from PIL import Image
    import onnxruntime as ort

    img = Image.open(png).convert("RGB")
    scale = min(640 / img.width, 640 / img.height, 1.0)
    resized = img.resize((int(img.width * scale), int(img.height * scale)))
    arr = np.asarray(resized).astype(np.float32) / 255.0
    arr = arr.transpose(2, 0, 1)[None]  # 1x3xHxW, 0..1

    sess = ort.InferenceSession(MODEL_PATH, providers=["CPUExecutionProvider"])
    out = sess.run(None, {sess.get_inputs()[0].name: arr})[0]

    regions = []
    for det in np.asarray(out).reshape(-1, 6):
        x1, y1, x2, y2, score, cls = det
        if score < 0.35:
            continue
        regions.append({
            "x": float(x1) / scale, "y": float(y1) / scale,
            "w": float(x2 - x1) / scale, "h": float(y2 - y1) / scale,
            "label": str(int(cls)), "confidence": float(score),
        })
    return regions


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

            if op == "ground":
                target = (req.get("target") or "").strip()
                if not target:
                    return {"ok": False, "reason": "missing target text"}
                if not TESSERACT:
                    return {"ok": False,
                            "reason": "tesseract binary not found on PATH"}
                match = ground_tesseract(png, target)
                if match is None:
                    return {"ok": False,
                            "reason": f"label {target!r} not found on screen"}
                return {"ok": True, "match": match}

            # op == "detect"
            if not have_onnx():
                return {"ok": False,
                        "reason": "onnx backend not configured "
                                  "(set APPIUM_MCP_VISION_MODEL)"}
            regions = detect_onnx(png, req.get("width") or 0,
                                  req.get("height") or 0)
            return {"ok": True, "regions": regions}
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
