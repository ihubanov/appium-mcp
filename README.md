# Squire — AI-native desktop & browser automation (MCP)

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![npm](https://img.shields.io/npm/v/@sniffski/squire.svg)](https://www.npmjs.com/package/@sniffski/squire)

**Squire** is a Model Context Protocol (MCP) server that lets an AI assistant drive a **real web browser like a human** — logging in, filling forms, clicking through flows, and scraping — alongside you, in your own Chrome.

> Built on the [appium-mcp](https://github.com/appium/appium-mcp) foundation and still ships its Appium mobile tools, but Squire is **desktop/browser-first**. **Not affiliated with the Appium project.**

## What makes it different

- **`run_script` — drive a page like a human in one call.** A sequence of steps (fill → click → wait → verify) that **survives navigations** (a form submit no longer aborts the rest), **reveals hidden/shadow-DOM elements** when a plain click can't reach them, and **stops-and-resumes** on failure instead of blindly barreling on.
- **Real multi-tab.** Stable tab ids let you drive several background tabs **concurrently** without them clobbering each other — and the orchestrator plans parallel work when a task fans out.
- **Attaches to your real Chrome** over CDP, so cookies, logins, redirects and captchas behave exactly as they do for you — with guards so the AI never hijacks the tab you're using.
- **Vision grounding** for canvas/WebGL/custom UIs where DOM selectors fail: OCR text labels plus an optional ONNX icon detector.
- **Self-cleaning**: closes browsers it no longer needs and drops sessions when the attached browser goes away.

## Install

### As a Claude Code plugin (recommended — one step)
```
/plugin marketplace add ihubanov/appium-mcp
/plugin install squire@squire
```
This installs the web-driving skill, the `browser-driver` subagent, the cleanup hook, **and** the MCP server (via `npx @sniffski/squire`). Restart the session afterwards.

### As a plain MCP server
```bash
npx @sniffski/squire          # stdio MCP server
```
Point your MCP client at that command. To attach to a running Chrome, launch Chrome with `--remote-debugging-port=9222` and set `APPIUM_MCP_CDP_ENDPOINT=http://localhost:9222`.

## Configuration (env)

| Var | Purpose |
|-----|---------|
| `APPIUM_MCP_CDP_ENDPOINT` | Attach to a running Chrome (e.g. `http://localhost:9222`). Unset → launches its own detached browser. |
| `APPIUM_MCP_RESPECT_USER_FOCUS` | `false` to let the AI act on the focused tab (default guards it). |
| `APPIUM_MCP_VISION_MODEL` / `APPIUM_MCP_VISION_PYTHON` | Enable the ONNX icon detector (path to the `.onnx` + a Python with `onnxruntime`). OCR text grounding works without them. |

## License

Apache-2.0. A fork of [appium/appium-mcp](https://github.com/appium/appium-mcp); the inherited mobile tooling remains under its original license. Squire is an independent project and is not affiliated with or endorsed by the Appium project.
