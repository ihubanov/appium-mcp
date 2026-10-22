import {installOverlay} from './overlay.js';

/**
 * The walkthrough viewer: a browser page that mirrors the device screen
 * (polled screenshots) and draws the walkthrough overlay on top of it.
 *
 * The server pushes steps over Server-Sent Events; the page sends the
 * person's input back (Next / Back / Skip, and taps on the mirror, which
 * are forwarded to the device). Element rectangles arrive as fractions of
 * the screen, so they map onto the mirror at any display size.
 */
export function createWalkthroughViewerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Appium walkthrough</title>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      display: flex;
      flex-direction: column;
      background: #15171f;
      color: #c9ccd9;
      font: 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-bottom: 1px solid #262938;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #8a8fa6; }
    .dot.live { background: #3ccf7a; }
    .stage {
      position: relative;
      display: flex;
      flex: 1;
      align-items: center;
      justify-content: center;
      min-height: 0;
      padding: 18px;
    }
    #screen {
      display: none;
      max-width: 100%;
      max-height: 100%;
      border-radius: 18px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, .55);
      cursor: pointer;
      touch-action: none;
      user-select: none;
      -webkit-user-drag: none;
    }
    #screen.on { display: block; }
    #target { position: fixed; display: none; pointer-events: none; }
    .tap {
      position: fixed;
      width: 16px;
      height: 16px;
      margin: -8px 0 0 -8px;
      border: 2px solid #fff;
      border-radius: 50%;
      pointer-events: none;
      animation: tap .5s ease-out forwards;
    }
    @keyframes tap { from { transform: scale(.5); opacity: 1; } to { transform: scale(2.6); opacity: 0; } }
    .message { color: #8a8fa6; font-size: 15px; }
  </style>
</head>
<body>
  <div class="bar"><span class="dot" id="dot"></span><span id="status">Connecting…</span></div>
  <div class="stage" id="stage">
    <span class="message" id="message">Waiting for the device screen…</span>
    <img id="screen" alt="Device screen" draggable="false">
  </div>
  <div id="target"></div>
  <script>
    const installOverlay = ${installOverlay.toString()};
    (() => {
      const base = location.pathname.replace(/\\/$/, '');
      const screen = document.getElementById('screen');
      const target = document.getElementById('target');
      const statusText = document.getElementById('status');
      const dot = document.getElementById('dot');
      const message = document.getElementById('message');
      let step = null;
      let ended = false;
      let lastSeq = 0;
      let objectUrl = null;
      // A step waits off-screen until the mirror shows a frame taken after the
      // device got to that step, so captions never sit on the previous screen.
      let queued = null;
      let shownFrameAt = 0;

      const overlay = () => {
        // Captions go beside the mirror when there is room, so they don't cover the screen.
        installOverlay({sides: ['right', 'left', 'bottom', 'top'], compact: true});
        return window.__appiumWalkthrough;
      };

      const post = (body) =>
        fetch(base + '/input', {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(body),
        }).catch(() => {});

      // Map a rect given as screen fractions onto the displayed mirror image.
      const box = () => screen.getBoundingClientRect();
      // The overlay always tracks this proxy box: over the element when there
      // is one, over the whole mirror for caption-only steps. While a step's
      // element is still being looked up it stays where it was.
      const placeTarget = () => {
        if (!step || !screen.classList.contains('on')) {
          return;
        }
        const b = box();
        const r = step.rect || {x: 0, y: 0, w: 1, h: 1};
        target.style.display = 'block';
        target.style.left = b.left + r.x * b.width + 'px';
        target.style.top = b.top + r.y * b.height + 'px';
        target.style.width = Math.max(1, r.w * b.width) + 'px';
        target.style.height = Math.max(1, r.h * b.height) + 'px';
      };
      const toViewport = (p) => {
        const b = box();
        return {x: b.left + p.x * b.width, y: b.top + p.y * b.height};
      };

      const showStep = () => {
        placeTarget();
        if (!screen.classList.contains('on')) return;
        overlay().show({
          el: target,
          index: step.index,
          total: step.total,
          title: step.title,
          text: step.text,
          mode: step.mode,
          advance: step.advance,
          isLast: step.isLast,
          showBack: step.showBack,
          holdMs: step.holdMs,
        });
        // Demo mode starts its reading pause only once the person can see the step.
        post({type: 'shown', index: step.index});
      };

      // Mirror: poll screenshots, swapping images only once each has loaded.
      const poll = async () => {
        while (!ended) {
          try {
            const res = await fetch(base + '/frame?t=' + Date.now(), {cache: 'no-store'});
            if (!res.ok) throw new Error(String(res.status));
            const frameAt = Number(res.headers.get('x-frame-at')) || 0;
            const url = URL.createObjectURL(await res.blob());
            await new Promise((resolve) => {
              screen.onload = resolve;
              screen.onerror = resolve;
              screen.src = url;
            });
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            objectUrl = url;
            shownFrameAt = Math.max(shownFrameAt, frameAt);
            if (!screen.classList.contains('on')) {
              screen.classList.add('on');
              message.style.display = 'none';
            }
            if (queued && shownFrameAt >= queued.frameAt) {
              step = queued;
              queued = null;
              showStep();
            }
            placeTarget();
            await new Promise((r) => setTimeout(r, 250));
          } catch {
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
      };

      // A click on the mirror is a tap on the device; a drag is a swipe.
      const toScreen = (e) => {
        const b = box();
        return {x: (e.clientX - b.left) / b.width, y: (e.clientY - b.top) / b.height};
      };
      const inside = (p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
      const clamp = (v) => Math.min(1, Math.max(0, v));
      let down = null;
      screen.addEventListener('pointerdown', (e) => {
        if (ended || e.button !== 0) return;
        const p = toScreen(e);
        if (!inside(p)) return;
        down = p;
        screen.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      screen.addEventListener('pointerup', (e) => {
        if (!down) return;
        const start = down;
        down = null;
        const end = toScreen(e);
        const t = document.createElement('div');
        t.className = 'tap';
        t.style.left = e.clientX + 'px';
        t.style.top = e.clientY + 'px';
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 600);
        if (Math.hypot(end.x - start.x, end.y - start.y) < 0.02) {
          post({type: 'tap', x: start.x, y: start.y});
        } else {
          post({type: 'swipe', x1: start.x, y1: start.y, x2: clamp(end.x), y2: clamp(end.y)});
        }
      });
      screen.addEventListener('pointercancel', () => {
        down = null;
      });

      // Forward the overlay's Next / Back / Skip presses.
      setInterval(() => {
        const ov = window.__appiumWalkthrough;
        if (!ov) return;
        for (const ev of ov.events) {
          if (ev.seq > lastSeq) {
            lastSeq = ev.seq;
            post({type: ev.type});
          }
        }
      }, 100);

      window.addEventListener('resize', placeTarget);

      const finish = (text, flourish) => {
        ended = true;
        step = null;
        target.style.display = 'none';
        dot.classList.remove('live');
        statusText.textContent = text;
        const ov = window.__appiumWalkthrough;
        if (ov) {
          if (flourish) ov.finish('✓ ' + text);
          else ov.destroy();
        }
      };

      const events = new EventSource(base + '/events');
      events.onopen = () => {
        if (ended) return;
        dot.classList.add('live');
        statusText.textContent = 'Live';
      };
      events.onerror = () => {
        if (ended) return;
        dot.classList.remove('live');
        statusText.textContent = 'Reconnecting…';
      };
      events.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'step') {
          lastSeq = window.__appiumWalkthrough ? window.__appiumWalkthrough.seq : 0;
          if (screen.classList.contains('on') && shownFrameAt >= (msg.frameAt || 0)) {
            step = msg;
            showStep();
          } else {
            queued = msg;
            const ov = window.__appiumWalkthrough;
            if (ov) ov.hide();
          }
        } else if (msg.type === 'rect') {
          if (queued) queued.rect = msg.rect;
          else if (step) step.rect = msg.rect;
          placeTarget();
        } else if (msg.type === 'cursor' && screen.classList.contains('on')) {
          const p = toViewport(msg);
          overlay().moveCursor(p.x, p.y);
        } else if (msg.type === 'ripple' && screen.classList.contains('on')) {
          const p = toViewport(msg);
          overlay().ripple(p.x, p.y);
        } else if (msg.type === 'finish') {
          events.close();
          finish(msg.message || 'All done', true);
        } else if (msg.type === 'end') {
          events.close();
          finish(msg.message || 'Walkthrough ended', false);
        }
      };

      poll();
    })();
  </script>
</body>
</html>`;
}
