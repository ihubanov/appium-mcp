---
name: presenting
description: Walk a person through a website on their own screen with an animated spotlight, pointing arrow and captions, using the Squire `playwright_present` tool. Use whenever the user asks to be SHOWN or GUIDED rather than to have the task done — "show me how to…", "show me where…", "where do I click to…", "walk me through…", "guide me through…", "teach me how to…", "how do I … on <site>", "give me a tour of…". Default to guided mode (the person does each step). Use demo mode only when they ask you to do it while they watch ("show me by doing it", "do it slowly so I can see").
---

# Presenting a website to a person

`playwright_present` draws a guided tour over the real page: the rest of the page dims, a spotlight glides to the element, an arrow bobs toward it, and a caption explains the step. It is for **teaching a human**, not for getting the task done — if the user just wants the result, use `playwright_run_script` (the `web-driving` skill) instead.

## Guided vs demo

- **guided (default)** — "show me how", "where do I", "walk me through", "guide me". Squire only points and explains; the **person** clicks and types. Each step advances when they press **Next**, click the highlighted element, fill it in, or the page navigates.
- **demo** — "show me by doing it", "do it while I watch", "demonstrate". Squire performs each step itself at human pace, with a visible cursor and click ripple. It never types into password, payment or one-time-code fields: those steps turn into guided ones and wait for the person.

When in doubt, use **guided**. People learn by doing it themselves.

## Workflow

1. **Get onto the right page, in the person's view.**
   - In CDP-attach mode (their real Chrome), present on the tab they're looking at when they mean "this page" — `playwright_list_tabs`, then pass that tab id as `tab`. For a site they haven't opened yet, open it with `playwright_new_tab` and present there (the tour brings the tab to the front).
   - A headless browser shows nothing to anyone. If the session is headless, say so and ask them to attach Squire to their Chrome (or create a headed session) first.
2. **Scout before you present.** Find the real path through the site with read-only tools (`appium_get_page_source`, `generate_locators`, `playwright_evaluate`) so every step's `selector` is right. Don't guess selectors and don't navigate the person's tab away while scouting — scout in a separate tab if you need to click around, then close it.
3. **Write the tour.** One idea per step, plain words, imperative ("Click **New expense**", "Type the amount here"). Usually 3–8 steps. The first step can be caption-only (no selector) to set the scene: "I'll show you how to file an expense — it takes four clicks."
4. **Set each step's `action`** (`click`, `fill`, `select`…) to say what the step is. In guided mode that picks how it advances (`click` → waits for their click, `fill`/`select` → waits for their input). Override with `advance` when needed: `next` for steps that are just "look here", `navigation` for "submit this and we continue on the next page".
5. **Run it and wait for the person.** A guided call returns `waiting: true` with a `tourId` when they haven't finished within `waitSeconds` (default 120). The overlay stays on screen. Call again with `resume: "<tourId>"` to keep waiting. Don't pile on chat messages while they work.
6. **Finish cleanly.** When the result says `finished`, the overlay plays a short "All done" and removes itself. If they hit **Skip**, `stoppedByUser` is true — ask whether they want to pick it up later rather than restarting. To end a tour yourself, call with `stop: "<tourId>"`.

## Step shape

```json
{
  "mode": "guided",
  "steps": [
    { "text": "I'll show you how to add an expense — four steps.", "title": "Expenses" },
    { "selector": "a[href='/expenses/new']", "title": "Start a new one", "text": "Click New expense.", "action": "click" },
    { "selector": "#amount", "text": "Type the amount, e.g. 42.50.", "action": "fill" },
    { "selector": "select#category", "text": "Pick a category.", "action": "select" },
    { "selector": "button[type=submit]", "text": "Save it — the next page confirms it worked.", "action": "click", "advance": "navigation" }
  ]
}
```

For demo mode, add `value` to `fill`/`type`/`select` steps (what Squire types or picks) and optionally `readMs` to slow down a step with a long caption.

When the DOM has nothing to point at (canvas apps, PDF viewers), use `visual` instead of `selector` — a visible label ("Sign in") or a position hint ("close X top right"), grounded via OCR/vision like `run_script`'s vision rung.

## Rules

- **Never fill in secrets for the person.** No passwords, card numbers or one-time codes, even if they're in your context. Point at the field and let them type. Demo mode enforces this; follow it in your own step design too.
- **Don't act behind their back in guided mode.** In guided mode the person drives. Don't run `run_script` or click on that tab while a tour is waiting.
- **Keep captions short.** About 1–2 lines per step. The bubble is small, and long text pushes it off the element.
- **Check the result.** `steps[i].target` is `"none"` when a selector didn't match; the caption showed without a spotlight. If that happens on an important step, fix the selector and present the tour again.
- **Stay off protected tabs.** The protected TUI tab is off-limits, as with the other tools.
