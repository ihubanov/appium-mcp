#!/usr/bin/env bash
#
# Cleanup idle appium-mcp browsers when a Claude session ends.
#
# Fires from the plugin's SessionEnd hook. It signals the appium-mcp backend
# (SIGUSR2) to run its idle-session reaper, which closes any browser/driver
# session with no tool activity for APPIUM_MCP_IDLE_REAP_MS (default 5 min).
#
# Why a signal and not an API call: in the shared httpStream/SSE backend,
# transport disconnect is not a reliable "client gone" signal (the transport
# cycles between tool calls), and per-connection isolation stops an outside
# process from deleting another connection's sessions. SIGUSR2 lets the server
# do the cleanup itself, using its own idle bookkeeping — so a browser another
# Claude instance is actively driving (fresh activity clock) is never closed.
#
# Safe by construction:
#   - only IDLE sessions are reaped (active ones survive);
#   - SIGUSR2 is a benign, server-defined trigger (not a kill);
#   - always exits 0 so a missing/renamed server never blocks session exit.
#
# SessionEnd hooks share a ~1.5s budget; sending a signal is instant.

# Drain the SessionEnd payload on stdin (session_id, cwd, reason). Unused, but
# reading it avoids a broken-pipe on the writer side.
cat >/dev/null 2>&1 || true

# Match the appium-mcp backend by its script path — covers both the shared
# systemd server (…/dist/index.js --httpStream --port=…) and any stdio child
# (…/dist/index.js). SIGUSR2 only triggers the idle reaper; it never kills.
pkill -USR2 -f 'appium-mcp/dist/index.js' 2>/dev/null || true

exit 0
