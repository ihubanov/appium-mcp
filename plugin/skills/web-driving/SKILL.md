---
name: web-driving
description: Drive a web page through the appium-mcp Playwright tools the right way — how to run multi-step flows (login, forms, open-menu-then-click) as one human-like unit, survive navigations, reach hidden modals, and respect the user's own tabs in CDP-attach mode. Use whenever a task involves browsing, filling forms, logging in, scraping, or clicking through a site with the appium-mcp `playwright_*` / `appium_*` web tools.
---

# Driving a web page with appium-mcp

The appium-mcp web tools drive a **real** browser (real JS, cookies, redirects, captchas). Prefer `playwright_run_script` for any flow that is more than one action; fall back to the single-action tools only for genuinely one-off interactions.

## Pick the right tool

- **`playwright_run_script`** — a sequence that should run as one human-like unit: a login, a multi-field form, open-a-menu-then-click, click-through-then-read. It is the default for multi-step work.
- **Single-action tools** (`appium_click`, `appium_set_value`, `playwright_type`, `playwright_navigate`, …) — one-off interactions, or when you must inspect the result of each step before deciding the next.
- **`playwright_evaluate`** — read structured data out of the page, call a page JS API, or `fetch()` a same-origin endpoint. Not for multi-step interaction.

## The four things that bite you (and how run_script handles them)

1. **A submit/click navigates and destroys the JS context.** A raw `playwright_evaluate` that submits a form dies with *"Execution context was destroyed, most likely because of a navigation"* and everything after it is lost. `playwright_run_script` **absorbs the navigation** — the step is marked `navigated: true` and the remaining steps run on the settled new page. Put the post-login check as a later step in the same script; it will run on the far side.

2. **The element is hidden / not actionable / behind an overlay** (menus, modals, custom dropdowns). Each step tries the fast normal path first; on a wall it **escalates to a human path** that reveals the element (unhides ancestors, pierces shadow DOM, scrolls into view), paces input, and can dispatch the event in-page. Look at each step's `via` field: `"normal"` vs `"human"` tells you whether the fallback was needed. Leave `humanize: "auto"` (the default); use `"always"` only for a site that actively fights automation, `"never"` to force a hard failure instead of a fallback.

3. **A step fails mid-flow.** With `stopOnError` (default true) the run stops at the first failing step and returns a `continuationId` plus the per-step results. Inspect what failed, then call `playwright_run_script` again with `resume: "<continuationId>"` to pick up from the next step — after you fix the selector, dismiss a blocker, or navigate. Don't restart the whole flow.

4. **CDP-attach mode shares the user's real browser.** When the session attached to the user's own Chromium (the create_session result says so), the tabs are the *user's* real tabs. **Open your own tab first** with `playwright_new_tab` before navigating or interacting, or you'll be refused (protected-tab / user-focused guards) — or worse, yank the user off their page. The guards also apply inside `run_script`: every mutating step is checked against the live tab.

## Step vocabulary for run_script

`fill`, `type`, `click`, `hover`, `select`, `scrollTo`, `press` (with `key`), `reveal` (force-unhide a selector), `wait` (with `ms`, or `waitFor: load|domcontentloaded|networkidle|navigation`), `eval` (with `script`). Selectors are CSS by default; `xpath=…` and `text=…` prefixes work too.

## When the DOM has nothing: the vision rung

Canvas, WebGL, embedded viewers (PDFs, maps) and images have **no locatable DOM nodes** — every selector fails. For those, add a `visual` hint on click/fill/type steps. Two forms, strongest signal first:

**1. Visible text label** — the control has readable text:
```json
{ "action": "click", "selector": "#canvas-app", "visual": "Sign in to Portal" }
```
OCR grounds the label; when an icon detector is also configured, the match is refined to the detected *control* region — click the button, not its caption (`via: "vision"`, backend `tesseract+onnx`).

**2. Position hint** — icon-only control, nothing readable:
```json
{ "action": "click", "selector": "#canvas-app", "visual": "hamburger menu icon top left" }
```
The icon detector (OmniParser YOLOv9-E, MIT) finds interactive regions; the named screen zone (`top left`, `top right`, `bottom left`, `bottom right`, `center`) picks the right one. Good for ✕ close buttons, hamburger menus, play icons in canvas apps.

Partial OCR matches count (half the label's words, contiguous). Vision works for `click`/`fill`/`type` only, is lazy (the sidecar spawns on first use), and can be disabled with `APPIUM_MCP_VISION=0`. The detector needs `APPIUM_MCP_VISION_MODEL` (path to the `.onnx`) and usually `APPIUM_MCP_VISION_PYTHON` (a venv interpreter with `onnxruntime` — system Pythons too new for wheels are fine to skip via this override). Without a detector, OCR-only still grounds text labels; icon-only targets need the position form *and* a detector.

## Example — log in and verify, across the navigation

```json
{
  "steps": [
    { "action": "fill",  "selector": "#email",    "text": "user@example.com" },
    { "action": "fill",  "selector": "#password", "text": "••••••" },
    { "action": "click", "selector": "button[type=submit]" },
    { "action": "wait",  "waitFor": "load" },
    { "action": "eval",  "script": "!!document.querySelector('#logout') || location.pathname" }
  ]
}
```

The submit navigates; the `wait` and the verify `eval` run on the logged-in page. If the submit selector is wrong, the run stops there with a `continuationId` — fix the selector and `resume`.

## Verify, don't assume

A step returning `status: "ok"` means the action didn't throw — not that the flow achieved its goal. Confirm with a final `eval` (a logged-in-only element, the expected URL/host, a success banner) or a screenshot before reporting success.
