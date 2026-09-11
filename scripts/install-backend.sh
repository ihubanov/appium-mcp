#!/usr/bin/env bash
#
# install-backend.sh — provision the appium-mcp web-driving backend on a
# fresh machine (or re-provision after moving the repo). Idempotent,
# non-root, systemd USER units only. What it does:
#
#   1. sanity checks (user session, node >= 20, systemd --user works)
#   2. npm ci + build (dist/)
#   3. installs three user units:
#        appium-mcp-backend.service  — node dist/index.js --httpStream :18766
#        appium-mcp.socket           — stable listener on 127.0.0.1:8766
#        appium-mcp.service          — socket proxy 8766 -> 18766
#   4. optional drop-in env overrides (--cdp-endpoint, --cdp-required,
#      --with-vision)
#   5. enables + starts everything, then health-checks the SSE endpoint
#      with a real MCP initialize handshake through the proxy port.
#
# Existing units are NEVER clobbered without --force (this box's hand-tuned
# overrides — vision env, focus-guard kill switch — live on as drop-ins
# and survive reinstalls).
#
# Options:
#   --port N            backend port          (default 18766)
#   --proxy-port N      stable proxy port     (default 8766)
#   --cdp-endpoint URL  attach to a shared Chromium (herdr-share gate, the
#                       user's own browser, ...) instead of detached launches
#   --cdp-required      failed attach THROWS instead of falling back to a
#                       detached launch (loud, for shared-display boxes)
#   --with-vision       build the OCR+YOLO sidecar venv and fetch the MIT
#                       OmniParser icon-detect weights (needs python3.11)
#   --with-chromium     install Playwright's chromium for detached mode
#   --force             overwrite existing unit files (drop-ins are kept)
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${APPIUM_MCP_BACKEND_PORT:-18766}"
PROXY_PORT="${APPIUM_MCP_PROXY_PORT:-8766}"
UNITS_DIR="$HOME/.config/systemd/user"
FORCE=0 WITH_VISION=0 WITH_CHROMIUM=0 CDP_REQUIRED=0
CDP_ENDPOINT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port) BACKEND_PORT="$2"; shift 2 ;;
    --proxy-port) PROXY_PORT="$2"; shift 2 ;;
    --cdp-endpoint) CDP_ENDPOINT="$2"; shift 2 ;;
    --cdp-required) CDP_REQUIRED=1; shift ;;
    --with-vision) WITH_VISION=1; shift ;;
    --with-chromium) WITH_CHROMIUM=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) grep '^# \{0,1\}' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
die()  { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "run as your normal user — everything here is user-level"
step "Sanity checks"
systemctl --user show-environment >/dev/null 2>&1 || die "no systemd user session (log in via a real session, not ssh -p ... bare)"
NODE_BIN="$(command -v node)" || die "node not in PATH"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (found $(node -v)); recommend the LTS you already use"
echo "node $(node -v) at $NODE_BIN, repo at $REPO_ROOT"

step "Dependencies + build"
cd "$REPO_ROOT"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
npm run build
[ -f dist/index.js ] || die "build did not produce dist/index.js"

if [ "$WITH_CHROMIUM" = 1 ]; then
  step "Playwright chromium (detached mode)"
  npx playwright install chromium
fi

if [ "$WITH_VISION" = 1 ]; then
  step "Vision sidecar (OCR + YOLO icon detector)"
  command -v python3.11 >/dev/null || die "--with-vision needs python3.11 (onnxruntime has no wheels for newer pythons)"
  [ -d .venv-vision ] || python3.11 -m venv .venv-vision
  .venv-vision/bin/pip install --quiet --upgrade pip
  .venv-vision/bin/pip install --quiet onnxruntime opencv-python-headless pillow numpy pytesseract
  mkdir -p .vision-model
  if [ ! -f .vision-model/icon_detect.onnx ]; then
    curl -fL --progress-bar \
      -o .vision-model/icon_detect.onnx \
      "https://huggingface.co/onnx-community/OmniParser-icon_detect/resolve/main/icon_detect.onnx"
    curl -fL --progress-bar \
      -o .vision-model/preprocessor_config.json \
      "https://huggingface.co/onnx-community/OmniParser-icon_detect/resolve/main/preprocessor_config.json" \
      || true # cosmetic; the sidecar works without it
  fi
  command -v tesseract >/dev/null || echo "NOTE: install the tesseract binary (apt install tesseract-ocr) for OCR grounding"
fi

step "Systemd user units"
mkdir -p "$UNITS_DIR"

write_unit() { # path content
  local path="$1" content="$2"
  if [ -f "$path" ] && [ "$FORCE" != 1 ]; then
    echo "  keep existing $(basename "$path") (use --force to overwrite)"
  else
    printf '%s\n' "$content" > "$path"
    echo "  wrote $(basename "$path")"
  fi
}

NODE_ABS="$(readlink -f "$NODE_BIN")"
write_unit "$UNITS_DIR/appium-mcp-backend.service" \
"[Unit]
Description=MCP appium backend

[Service]
Type=simple
ExecStart=$NODE_ABS $REPO_ROOT/dist/index.js --httpStream --port=$BACKEND_PORT
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=default.target"

write_unit "$UNITS_DIR/appium-mcp.socket" \
"[Unit]
Description=MCP appium socket (stable public port)

[Socket]
ListenStream=127.0.0.1:$PROXY_PORT

[Install]
WantedBy=sockets.target"

write_unit "$UNITS_DIR/appium-mcp.service" \
"[Unit]
Description=MCP appium proxy (activates backend on demand)
Requires=appium-mcp-backend.service
After=appium-mcp-backend.service

[Service]
ExecStartPre=/bin/sh -c 'for i in \$(seq 1 150); do ss -tln 2>/dev/null | grep -q \":$BACKEND_PORT \" && exit 0; sleep 0.2; done; exit 1'
ExecStart=/usr/lib/systemd/systemd-socket-proxyd 127.0.0.1:$BACKEND_PORT"

# Optional env drop-ins (never touch existing drop-ins — they may hold
# hand-tuned settings like the focus-guard kill switch on this box).
dropin_dir="$UNITS_DIR/appium-mcp-backend.service.d"
mkdir -p "$dropin_dir"
if [ -n "$CDP_ENDPOINT" ] || [ "$CDP_REQUIRED" = 1 ]; then
  [ -n "$CDP_ENDPOINT" ] || die "--cdp-required needs --cdp-endpoint (or an endpoint already configured in a drop-in)"
  { echo "[Service]"
    echo "Environment=APPIUM_MCP_CDP_ENDPOINT=$CDP_ENDPOINT"
    [ "$CDP_REQUIRED" = 1 ] && echo "Environment=APPIUM_MCP_CDP_REQUIRED=1"
  } > "$dropin_dir/cdp-attach.conf"
  REQ_NOTE=""
  [ "$CDP_REQUIRED" = 1 ] && REQ_NOTE=", hard-fail on attach loss"
  echo "  wrote drop-in cdp-attach.conf (endpoint=$CDP_ENDPOINT$REQ_NOTE)"
fi
if [ "$WITH_VISION" = 1 ]; then
  { echo "[Service]"
    echo "Environment=APPIUM_MCP_VISION_MODEL=$REPO_ROOT/.vision-model/icon_detect.onnx"
    echo "Environment=APPIUM_MCP_VISION_PYTHON=$REPO_ROOT/.venv-vision/bin/python"
  } > "$dropin_dir/vision.conf"
  echo "  wrote drop-in vision.conf"
fi

step "Enable + start"
systemctl --user daemon-reload
systemctl --user enable --now appium-mcp-backend.service
# The proxy service is socket-activated by appium-mcp.socket — enabling it
# directly only prints a "no installation config" warning. Start it once so
# the health check below passes even before the first socket connection.
systemctl --user start appium-mcp.service 2>/dev/null || true
systemctl --user enable --now appium-mcp.socket

step "Health check (MCP initialize handshake via proxy :$PROXY_PORT)"
HDR="$(mktemp)"; trap 'rm -f "$HDR"' EXIT
for i in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
    -D "$HDR" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -X POST "http://127.0.0.1:$PROXY_PORT/sse" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install-backend","version":"0"}}}' \
    || true)"
  if [ "$code" = "200" ] && grep -qi '^mcp-session-id:' "$HDR"; then
    echo "OK — backend answered an initialize handshake on 127.0.0.1:$PROXY_PORT/sse"
    echo
    echo "Done. Clients (claude-local plugin manifest, official global config) should point at:"
    echo "  http://127.0.0.1:$PROXY_PORT/sse"
    exit 0
  fi
  sleep 1
done
die "backend did not answer the initialize handshake in 30s — check: journalctl --user -u appium-mcp-backend.service"
