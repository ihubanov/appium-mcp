/**
 * Walkthrough: show a person how to do something in a mobile app, on a
 * mirrored device screen with an animated spotlight, pointing arrow and
 * caption drawn on top (see viewer-page.ts).
 *
 * Two modes:
 *  - guided: the walkthrough only points and explains; the PERSON does each
 *    step, on the device or by tapping the mirror (taps are forwarded). A
 *    step advances on Next, on a tap on the highlighted element, or when the
 *    screen changes, per the step's `advance`. Waiting is bounded per call:
 *    when the budget runs out the walkthrough stays on screen and the caller
 *    resumes it, so a slow human never trips an MCP timeout.
 *  - demo: like guided, but hands-free: each step is shown for a few seconds,
 *    then performed by the walkthrough itself, with a cursor gliding to the
 *    target and a tap ripple. It never types into password fields; those
 *    steps fall back to guided and wait for the person.
 */
import crypto from 'node:crypto';

import {
  back,
  elementClick,
  findElement,
  getElementAttribute,
  getElementRect,
  getPageSource,
  getScreenshot,
  getWindowRect,
  performActions,
  setValue,
} from '../command.js';
import {getPlatformName, PLATFORM, type DriverInstance} from '../session-store.js';
import {w3cTapAt} from '../tools/gestures/handlers/tap.js';
import {readWebElementId} from '../tools/tool-response.js';
import type {ViewerInput, ViewerMessage, WalkthroughViewerServer} from './viewer-server.js';

export type WalkthroughMode = 'guided' | 'demo';
export type WalkthroughAdvance = 'next' | 'tap' | 'change';
export type WalkthroughAction = 'none' | 'tap' | 'type' | 'swipe';
export type SwipeDirection = 'up' | 'down' | 'left' | 'right';

export interface WalkthroughStep {
  /** Locator strategy, as for appium_find_element. Omit with selector for a caption-only step. */
  strategy?: string;
  selector?: string;
  title?: string;
  /** What to tell the person at this step. */
  text: string;
  /** What the step does: performed in demo mode, by the person in guided mode. */
  action?: WalkthroughAction;
  /** Text to type for action=type. */
  value?: string;
  /** Finger direction for action=swipe, across the element or else the whole screen. Default up. */
  direction?: SwipeDirection;
  /** Guided: what moves on to the next step. Defaults from action: tap→tap, type→change, else next. */
  advance?: WalkthroughAdvance;
  /** Demo: ms to let the caption be read before acting. */
  readMs?: number;
}

export interface WalkthroughStepResult {
  index: number;
  status: 'shown' | 'done' | 'failed';
  /** What finished the step: next, tap, screen-change, demo. */
  by?: string;
  target: 'element' | 'none';
  detail?: string;
}

export interface WalkthroughStatus {
  finished: boolean;
  stoppedByUser: boolean;
  /** The person hasn't finished the current step (or hasn't opened the viewer) yet: resume to keep waiting. */
  waiting: boolean;
  failed: boolean;
  /** Zero-based index of the step on screen (or `total` when finished). */
  at: number;
  completed: number;
  total: number;
  viewers: number;
  steps: WalkthroughStepResult[];
}

/** Rect in screen fractions (0..1), so it maps onto the mirror at any size. */
export interface FractionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Target {
  elementId: string | null;
  rect: FractionRect | null;
  /** Why the element could not be highlighted, for the caller to fix the step. */
  error?: string;
}

const POLL_MS = 2000;
const FRAME_MAX_AGE_MS = 250;
const SETTLE_MS = 900;
const DEMO_READ_MS = 5000;
const SHOWN_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function defaultAdvance(step: WalkthroughStep): WalkthroughAdvance {
  if (step.advance) {
    return step.advance;
  }
  if (step.action === 'tap') {
    return 'tap';
  }
  if (step.action === 'type' || step.action === 'swipe') {
    return 'change';
  }
  return 'next';
}

/** Start and end of a swipe in screen fractions: from 30% behind the centre to 25% ahead of it. */
export function swipeLine(
  direction: SwipeDirection,
  area: FractionRect | null,
): {x1: number; y1: number; x2: number; y2: number} {
  const a = area ?? {x: 0, y: 0, w: 1, h: 1};
  const cx = a.x + a.w / 2;
  const cy = a.y + a.h / 2;
  const [dx, dy] = {up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0]}[direction];
  return {
    x1: cx - dx * 0.3 * a.w,
    y1: cy - dy * 0.3 * a.h,
    x2: cx + dx * 0.25 * a.w,
    y2: cy + dy * 0.25 * a.h,
  };
}

/** Width and height from a PNG's IHDR chunk, or null if it isn't a PNG. */
export function pngSize(png: Buffer): {width: number; height: number} | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.toString('ascii', 12, 16) !== 'IHDR') {
    return null;
  }
  return {width: png.readUInt32BE(16), height: png.readUInt32BE(20)};
}

export class Walkthrough {
  readonly id = crypto.randomUUID();
  private index = 0;
  private shownIndex = -1;
  private stopped = false;
  private failed = false;
  private started = false;
  private calledBefore = false;
  /** Driver commands in flight; the mirror reuses its last frame meanwhile (Appium runs commands one at a time). */
  private busy = 0;
  /** Steps whose completion moved the device to another screen, so Back has to go back on the device too. */
  private readonly navigated = new Set<number>();
  private target: Target = {elementId: null, rect: null};
  private signature = '';
  private readonly results = new Map<number, WalkthroughStepResult>();
  /** Steps that must wait for the person even in demo mode (password fields). */
  private readonly handedToPerson = new Set<number>();
  private readonly inputs: ViewerInput[] = [];
  private wake: (() => void) | null = null;
  private frameCache: {png: Buffer; at: number} | null = null;
  private framePending: Promise<{png: Buffer; at: number}> | null = null;
  /** Coordinate space of element rects and taps, in the driver's units. */
  private screen: {width: number; height: number} | null = null;
  url = '';

  constructor(
    readonly driver: DriverInstance,
    readonly steps: WalkthroughStep[],
    readonly viewer: WalkthroughViewerServer,
    readonly mode: WalkthroughMode = 'guided',
  ) {
    if (steps.length === 0) {
      throw new Error('A walkthrough needs at least one step.');
    }
  }

  get done(): boolean {
    return this.stopped || this.index >= this.steps.length;
  }

  /** Register with the viewer server; returns the URL to open. */
  async open(): Promise<string> {
    this.url = await this.viewer.open({
      id: this.id,
      frame: () => this.frame(),
      onInput: (input) => {
        this.inputs.push(input);
        this.wake?.();
      },
    });
    return this.url;
  }

  /**
   * Advance the walkthrough for at most `budgetMs`. Returns when it finishes,
   * the person stops it, a demo action fails, or the budget runs out while
   * waiting on the person; call run() again to resume.
   */
  async run(budgetMs: number, onTick?: () => void): Promise<WalkthroughStatus> {
    const deadline = Date.now() + budgetMs;
    const tick = setInterval(() => onTick?.(), 5000);
    try {
      this.failed = false;
      // Nothing is worth showing to an empty room. The first call returns at
      // once so the caller can hand out the viewer URL; later calls wait for it.
      const firstCall = !this.calledBefore;
      this.calledBefore = true;
      while (this.viewer.viewerCount(this.id) === 0 && !this.started) {
        if (firstCall || Date.now() >= deadline) {
          return this.status(true);
        }
        await this.waitInput(Math.min(500, deadline - Date.now()));
      }
      this.started = true;

      while (!this.done) {
        if (this.drainStop()) {
          break;
        }
        if (this.shownIndex !== this.index) {
          await this.showStep();
        }
        if (this.mode === 'demo' && !this.handedToPerson.has(this.index)) {
          const ok = await this.demoStep();
          if (!ok) {
            this.failed = true;
            return this.status(false);
          }
          continue;
        }
        const outcome = await this.waitForPerson(deadline);
        if (outcome === 'timeout') {
          return this.status(true);
        }
      }

      if (!this.stopped) {
        this.viewer.close(this.id, {type: 'finish', message: 'All done'});
      } else {
        this.viewer.close(this.id, {type: 'end', message: 'Walkthrough skipped'});
      }
      return this.status(false);
    } finally {
      clearInterval(tick);
    }
  }

  /** End the walkthrough now and take the overlay down. */
  stop(): void {
    this.stopped = true;
    this.viewer.close(this.id, {type: 'end', message: 'Walkthrough ended'});
    this.wake?.();
  }

  /**
   * Latest screenshot and when it was taken, shared between viewers and
   * refreshed at most every 250 ms. `fresh` forces a new capture, taken
   * after any capture already in flight.
   */
  async frame(fresh = false): Promise<{png: Buffer; at: number}> {
    if (!fresh && this.frameCache && (this.busy > 0 || Date.now() - this.frameCache.at < FRAME_MAX_AGE_MS)) {
      return this.frameCache;
    }
    if (fresh && this.framePending) {
      await this.framePending.catch(() => {});
    }
    this.framePending ??= getScreenshot(this.driver)
      .then((b64) => {
        this.frameCache = {png: Buffer.from(b64, 'base64'), at: Date.now()};
        return this.frameCache;
      })
      .finally(() => {
        this.framePending = null;
      });
    return await this.framePending;
  }

  private status(waiting: boolean): WalkthroughStatus {
    const finished = !this.stopped && this.index >= this.steps.length;
    const steps = [...this.results.values()].sort((a, b) => a.index - b.index);
    return {
      finished,
      stoppedByUser: this.stopped,
      waiting: waiting && !finished && !this.stopped,
      failed: this.failed,
      at: Math.min(this.index, this.steps.length),
      completed: steps.filter((s) => s.status === 'done').length,
      total: this.steps.length,
      viewers: this.viewer.viewerCount(this.id),
      steps,
    };
  }

  private record(result: WalkthroughStepResult): void {
    const prev = this.results.get(result.index);
    this.results.set(result.index, {...prev, ...result, detail: result.detail ?? prev?.detail});
  }

  private drainStop(): boolean {
    if (this.inputs.some((i) => i.type === 'skip')) {
      this.inputs.length = 0;
      this.stopped = true;
    }
    return this.stopped;
  }

  private waitInput(ms: number): Promise<void> {
    if (this.inputs.length > 0 || this.stopped || ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = () => {
        this.wake = null;
        done();
      };
    });
  }

  /** The coordinate space element rects and taps use: pixels on Android, points on iOS. */
  private async screenSize(): Promise<{width: number; height: number}> {
    if (getPlatformName(this.driver) === PLATFORM.ios) {
      const r = await getWindowRect(this.driver);
      return {width: r.width, height: r.height};
    }
    // UiAutomator2 reports element bounds in physical pixels, i.e. screenshot pixels.
    const size = pngSize((await this.frame()).png);
    if (size) {
      return size;
    }
    const r = await getWindowRect(this.driver);
    return {width: r.width, height: r.height};
  }

  private async resolveTarget(step: WalkthroughStep): Promise<Target> {
    if (!step.strategy || !step.selector) {
      return {elementId: null, rect: null};
    }
    try {
      const elementId = readWebElementId(await findElement(this.driver, step.strategy, step.selector));
      if (!elementId) {
        return {elementId: null, rect: null, error: 'the driver returned no element id'};
      }
      const [r, size] = await Promise.all([getElementRect(this.driver, elementId), this.screenSize()]);
      this.screen = size;
      if (r.width <= 0 || r.height <= 0) {
        return {elementId, rect: null, error: 'the element has no size on screen'};
      }
      return {
        elementId,
        rect: {x: r.x / size.width, y: r.y / size.height, w: r.width / size.width, h: r.height / size.height},
      };
    } catch (err: unknown) {
      return {elementId: null, rect: null, error: err instanceof Error ? err.message : String(err)};
    }
  }

  private async screenSignature(): Promise<string> {
    try {
      return crypto
        .createHash('sha1')
        .update(await getPageSource(this.driver))
        .digest('hex');
    } catch {
      return '';
    }
  }

  private send(message: ViewerMessage): void {
    this.viewer.send(this.id, message);
  }

  private async showStep(): Promise<void> {
    const step = this.steps[this.index];
    const handed = this.handedToPerson.has(this.index);
    const mode = this.mode === 'demo' && !handed ? 'demo' : 'guided';
    // Find the element and grab a screenshot of the screen it is on, so the
    // viewer can show the caption, spotlight and screen together.
    const {target, frameAt} = await this.whileBusy(async () => {
      const t = await this.resolveTarget(step);
      const {at} = await this.frame(true);
      return {target: t, frameAt: at};
    });
    this.target = target;
    this.send({
      type: 'step',
      index: this.index,
      total: this.steps.length,
      title: step.title ?? '',
      text: step.text,
      mode,
      advance: handed ? 'change' : defaultAdvance(step),
      isLast: this.index === this.steps.length - 1,
      showBack: this.index > 0,
      holdMs: mode === 'demo' ? (step.readMs ?? DEMO_READ_MS) : 0,
      rect: this.target.rect,
      frameAt,
    });
    this.shownIndex = this.index;
    this.signature = await this.whileBusy(() => this.screenSignature());
    this.record({
      index: this.index,
      status: 'shown',
      target: this.target.rect ? 'element' : 'none',
      ...(step.selector && !this.target.rect
        ? {detail: `could not highlight ${step.strategy}=${step.selector}: ${this.target.error ?? 'not found'}`}
        : {}),
    });
  }

  private async whileBusy<T>(fn: () => Promise<T>): Promise<T> {
    this.busy += 1;
    try {
      return await fn();
    } finally {
      this.busy -= 1;
    }
  }

  /**
   * Next on a step that has an action: do it for the person, unless they
   * already did (the screen changed since the step was shown).
   */
  private async performOnNext(step: WalkthroughStep): Promise<void> {
    const action = step.action ?? 'none';
    const {elementId} = this.target;
    if (action === 'none' || (action !== 'swipe' && !elementId)) {
      return;
    }
    await this.whileBusy(async () => {
      const sig = await this.screenSignature();
      if (sig && this.signature && sig !== this.signature) {
        this.navigated.add(this.index);
        return;
      }
      try {
        if (action === 'swipe') {
          await this.swipe(swipeLine(step.direction ?? 'up', this.target.rect));
        } else if (!elementId) {
          return;
        } else if (action === 'tap') {
          await elementClick(this.driver, elementId);
        } else if (step.value !== undefined && !(await this.isSensitive(elementId))) {
          await setValue(this.driver, elementId, step.value);
        } else {
          return;
        }
      } catch {
        return;
      }
      await sleep(SETTLE_MS);
      const after = await this.screenSignature();
      if (after && after !== this.signature) {
        this.navigated.add(this.index);
      }
    });
  }

  private complete(by: string): void {
    this.record({index: this.index, status: 'done', by, target: this.target.rect ? 'element' : 'none'});
    this.index += 1;
  }

  /** Swipe along a line given in screen fractions. */
  private async swipe(line: {x1: number; y1: number; x2: number; y2: number}): Promise<void> {
    this.screen ??= await this.screenSize();
    const from = this.toDevice(line.x1, line.y1);
    const to = this.toDevice(line.x2, line.y2);
    if (!from || !to) {
      return;
    }
    await performActions(this.driver, [
      {
        type: 'pointer',
        id: 'finger1',
        parameters: {pointerType: 'touch'},
        actions: [
          {type: 'pointerMove', duration: 0, x: from.x, y: from.y},
          {type: 'pointerDown', button: 0},
          {type: 'pause', duration: 50},
          {type: 'pointerMove', duration: 300, x: to.x, y: to.y},
          {type: 'pointerUp', button: 0},
        ],
      },
    ]);
  }

  private toDevice(x: number, y: number): {x: number; y: number} | null {
    if (!this.screen) {
      return null;
    }
    return {x: Math.round(x * this.screen.width), y: Math.round(y * this.screen.height)};
  }

  private inRect(x: number, y: number): boolean {
    const r = this.target.rect;
    if (!r) {
      return false;
    }
    const pad = 0.01;
    return x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad;
  }

  /** Wait for the person to finish the current step, or for the budget to run out. */
  private async waitForPerson(deadline: number): Promise<'advanced' | 'timeout'> {
    const step = this.steps[this.index];
    const advance = this.handedToPerson.has(this.index) ? 'change' : defaultAdvance(step);
    let nextPoll = Date.now() + POLL_MS;
    while (Date.now() < deadline) {
      await this.waitInput(Math.min(nextPoll, deadline) - Date.now());
      if (this.drainStop()) {
        return 'advanced';
      }
      const input = this.inputs.shift();
      if (input?.type === 'next') {
        await this.performOnNext(step);
        this.complete('next');
        return 'advanced';
      }
      if (input?.type === 'back') {
        if (this.index > 0) {
          this.index -= 1;
          if (this.navigated.delete(this.index)) {
            await this.whileBusy(async () => {
              await back(this.driver).catch(() => {});
              await sleep(SETTLE_MS);
            });
          }
        }
        this.shownIndex = -1;
        return 'advanced';
      }
      if (input?.type === 'swipe') {
        await this.whileBusy(() => this.swipe(input)).catch(() => {});
        nextPoll = Date.now();
        continue;
      }
      if (input?.type === 'tap') {
        this.screen ??= await this.screenSize();
        const hit = this.inRect(input.x, input.y);
        const point = this.toDevice(input.x, input.y);
        if (point) {
          await performActions(this.driver, w3cTapAt(point.x, point.y)).catch(() => {});
        }
        if (hit && advance === 'tap') {
          await sleep(SETTLE_MS);
          this.navigated.add(this.index);
          this.complete('tap');
          return 'advanced';
        }
        nextPoll = Date.now();
        continue;
      }
      if (Date.now() >= nextPoll) {
        nextPoll = Date.now() + POLL_MS;
        if (advance !== 'next') {
          const sig = await this.whileBusy(() => this.screenSignature());
          if (sig && this.signature && sig !== this.signature) {
            this.navigated.add(this.index);
            this.complete('screen-change');
            return 'advanced';
          }
        }
        // Follow the element if the screen scrolled or re-laid out.
        const next = await this.whileBusy(() => this.resolveTarget(step));
        if (JSON.stringify(next.rect) !== JSON.stringify(this.target.rect)) {
          this.target = next;
          this.send({type: 'rect', rect: next.rect});
        }
      }
    }
    return 'timeout';
  }

  /** Perform the current step on the device; false if the action failed. */
  private async demoStep(): Promise<boolean> {
    const step = this.steps[this.index];
    // Wait until the viewer has the step on screen, then give the person time
    // to read it before acting. The device can be slower than the caption.
    const shownBy = Date.now() + SHOWN_TIMEOUT_MS;
    let shown = false;
    while (!shown && Date.now() < shownBy) {
      await this.waitInput(shownBy - Date.now());
      if (this.drainStop()) {
        return true;
      }
      shown = this.inputs.some((i) => i.type === 'shown' && i.index === this.index);
      // The person watches in demo mode; their taps and Next presses are ignored.
      this.inputs.length = 0;
    }
    const readUntil = Date.now() + (step.readMs ?? DEMO_READ_MS);
    while (Date.now() < readUntil) {
      await this.waitInput(readUntil - Date.now());
      if (this.drainStop()) {
        return true;
      }
      this.inputs.length = 0;
    }
    const action = step.action ?? 'none';
    if (action === 'none') {
      this.complete('demo');
      return true;
    }
    const {elementId, rect} = this.target;
    if (action === 'swipe') {
      const line = swipeLine(step.direction ?? 'up', rect);
      this.send({type: 'cursor', x: line.x1, y: line.y1});
      await sleep(850);
      this.send({type: 'ripple', x: line.x1, y: line.y1});
      this.send({type: 'cursor', x: line.x2, y: line.y2});
      try {
        await this.whileBusy(() => this.swipe(line));
      } catch (err: unknown) {
        this.record({
          index: this.index,
          status: 'failed',
          target: rect ? 'element' : 'none',
          detail: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
      await sleep(SETTLE_MS);
      this.complete('demo');
      return true;
    }
    if (!elementId) {
      this.record({index: this.index, status: 'failed', target: 'none', detail: 'no element to act on'});
      return false;
    }
    if (action === 'type' && (await this.isSensitive(elementId))) {
      this.handedToPerson.add(this.index);
      this.record({
        index: this.index,
        status: 'shown',
        target: 'element',
        detail: 'sensitive field: left for the person to type',
      });
      this.shownIndex = -1;
      return true;
    }
    if (rect) {
      const cx = rect.x + rect.w / 2;
      const cy = rect.y + rect.h / 2;
      this.send({type: 'cursor', x: cx, y: cy});
      await sleep(850);
      this.send({type: 'ripple', x: cx, y: cy});
    }
    try {
      if (action === 'tap') {
        await elementClick(this.driver, elementId);
      } else {
        await setValue(this.driver, elementId, step.value ?? '');
      }
    } catch (err: unknown) {
      this.record({
        index: this.index,
        status: 'failed',
        target: rect ? 'element' : 'none',
        detail: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    await sleep(SETTLE_MS);
    this.complete('demo');
    return true;
  }

  private async isSensitive(elementId: string): Promise<boolean> {
    try {
      if (getPlatformName(this.driver) === PLATFORM.ios) {
        return (await getElementAttribute(this.driver, elementId, 'type')) === 'XCUIElementTypeSecureTextField';
      }
      return (await getElementAttribute(this.driver, elementId, 'password')) === 'true';
    } catch {
      // Can't tell: err on the side of not typing.
      return true;
    }
  }
}
