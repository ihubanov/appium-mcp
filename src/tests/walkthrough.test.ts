import {afterAll, beforeEach, describe, expect, jest, test} from '@jest/globals';

// A 1080x2400 PNG header is all pngSize() needs.
function fakePng(width: number, height: number): string {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf.toString('base64');
}

const ELEMENTS: Record<string, {id: string; rect: {x: number; y: number; width: number; height: number}}> = {
  settings: {id: 'el-settings', rect: {x: 108, y: 240, width: 216, height: 120}},
  password: {id: 'el-password', rect: {x: 0, y: 1200, width: 1080, height: 120}},
  name: {id: 'el-name', rect: {x: 0, y: 600, width: 1080, height: 120}},
};
let pageSource = '<hierarchy screen="1"/>';

jest.unstable_mockModule('../command.js', () => ({
  findElement: jest.fn(async (_d: unknown, _s: string, selector: string) => {
    const el = ELEMENTS[selector];
    if (!el) {
      throw new Error('no such element');
    }
    return {'element-6066-11e4-a52e-4f735466cecf': el.id};
  }),
  getElementRect: jest.fn(async (_d: unknown, id: string) => Object.values(ELEMENTS).find((e) => e.id === id)?.rect),
  getWindowRect: jest.fn(async () => ({x: 0, y: 0, width: 360, height: 800})),
  getScreenshot: jest.fn(async () => fakePng(1080, 2400)),
  getPageSource: jest.fn(async () => pageSource),
  getElementAttribute: jest.fn(async (_d: unknown, id: string, attr: string) =>
    attr === 'password' && id === 'el-password' ? 'true' : 'false',
  ),
  elementClick: jest.fn(async () => {}),
  setValue: jest.fn(async () => {}),
  performActions: jest.fn(async () => {}),
  back: jest.fn(async () => {}),
}));
jest.unstable_mockModule('../session-store.js', () => ({
  getPlatformName: jest.fn(() => 'Android'),
  PLATFORM: {ios: 'iOS', android: 'Android'},
}));
jest.unstable_mockModule('../tools/tool-response.js', () => ({
  readWebElementId: (el: Record<string, string>) => el['element-6066-11e4-a52e-4f735466cecf'],
}));
jest.unstable_mockModule('../tools/gestures/handlers/tap.js', () => ({
  w3cTapAt: (x: number, y: number) => [{tap: [x, y]}],
}));

const command = await import('../command.js');
const {WalkthroughViewerServer, parseInput} = await import('../walkthrough/viewer-server.js');
const {Walkthrough, pngSize, swipeLine} = await import('../walkthrough/walkthrough.js');

const server = new WalkthroughViewerServer('127.0.0.1', 0);

afterAll(async () => {
  await server.stop();
});

const input = (url: string, body: unknown) =>
  fetch(`${url}/input`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});

/** Minimal SSE client: collects step/rect/finish messages; `ackSteps` reports each step as shown, like the page. */
async function connect(url: string, ackSteps = false) {
  const messages: Array<Record<string, any>> = [];
  const controller = new AbortController();
  const res = await fetch(`${url}/events`, {signal: controller.signal});
  if (!res.body) {
    throw new Error('no event stream');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) {
          return;
        }
        buffer += decoder.decode(value, {stream: true});
        let i: number;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          if (chunk.startsWith('data: ')) {
            const msg = JSON.parse(chunk.slice(6));
            messages.push(msg);
            if (ackSteps && msg.type === 'step') {
              void input(url, {type: 'shown', index: msg.index});
            }
          }
        }
      }
    } catch {
      // aborted
    }
  })();
  const waitFor = async (pred: (m: Record<string, any>) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const hit = messages.find(pred);
      if (hit) {
        return hit;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`message not received; got ${JSON.stringify(messages)}`);
  };
  return {messages, waitFor, close: () => controller.abort()};
}

describe('walkthrough', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pageSource = '<hierarchy screen="1"/>';
  });

  test('pngSize reads the IHDR dimensions', () => {
    expect(pngSize(Buffer.from(fakePng(1080, 2400), 'base64'))).toEqual({width: 1080, height: 2400});
    expect(pngSize(Buffer.from('not a png'))).toBeNull();
  });

  test('swipeLine runs against the finger direction from behind the centre', () => {
    const up = swipeLine('up', null);
    expect(up.x1).toBeCloseTo(0.5);
    expect(up.y1).toBeCloseTo(0.8);
    expect(up.y2).toBeCloseTo(0.25);
    const right = swipeLine('right', {x: 0, y: 0.5, w: 0.5, h: 0.1});
    expect(right.x1).toBeCloseTo(0.1);
    expect(right.x2).toBeCloseTo(0.375);
    expect(right.y1).toBeCloseTo(0.55);
  });

  test('guided: Next performs a swipe step, and a drag on the mirror is forwarded', async () => {
    const w = new Walkthrough(
      {} as any,
      [{text: 'Swipe up to open your apps.', action: 'swipe', direction: 'up'}, {text: 'Done.'}],
      server,
    );
    const url = await w.open();
    const viewer = await connect(url);
    const run = w.run(20_000);
    await viewer.waitFor((m) => m.type === 'step' && m.index === 0);
    await new Promise((r) => setTimeout(r, 200));
    await input(url, {type: 'swipe', x1: 0.5, y1: 0.9, x2: 0.5, y2: 0.1});
    await new Promise((r) => setTimeout(r, 200));
    expect(command.performActions).toHaveBeenCalledTimes(1);
    const forwarded = (jest.mocked(command.performActions).mock.calls[0][1] as any)[0].actions;
    expect(forwarded[0]).toMatchObject({type: 'pointerMove', x: 540, y: 2160});
    expect(forwarded[3]).toMatchObject({type: 'pointerMove', x: 540, y: 240});
    await input(url, {type: 'next'});
    await viewer.waitFor((m) => m.type === 'step' && m.index === 1);
    expect(command.performActions).toHaveBeenCalledTimes(2);
    await input(url, {type: 'skip'});
    await run;
    viewer.close();
  }, 30_000);

  test('parseInput accepts only known inputs with in-range taps', () => {
    expect(parseInput('{"type":"next"}')).toEqual({type: 'next'});
    expect(parseInput('{"type":"tap","x":0.5,"y":1}')).toEqual({type: 'tap', x: 0.5, y: 1});
    expect(parseInput('{"type":"tap","x":2,"y":0}')).toBeNull();
    expect(parseInput('{"type":"swipe","x1":0.5,"y1":0.8,"x2":0.5,"y2":0.2}')).toEqual({
      type: 'swipe',
      x1: 0.5,
      y1: 0.8,
      x2: 0.5,
      y2: 0.2,
    });
    expect(parseInput('{"type":"swipe","x1":0.5,"y1":0.8}')).toBeNull();
    expect(parseInput('{"type":"shown","index":2}')).toEqual({type: 'shown', index: 2});
    expect(parseInput('{"type":"shown","index":-1}')).toBeNull();
    expect(parseInput('{"type":"rm -rf"}')).toBeNull();
    expect(parseInput('nope')).toBeNull();
  });

  test('viewer server serves the page and frames, and rejects foreign hosts', async () => {
    const w = new Walkthrough({} as any, [{text: 'Hi'}], server);
    const url = await w.open();
    const page = await fetch(url);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('installOverlay');
    expect(html).toContain('__appiumWalkthrough');
    const frame = await fetch(`${url}/frame`);
    expect(frame.headers.get('content-type')).toBe('image/png');
    expect(Number(frame.headers.get('x-frame-at'))).toBeGreaterThan(0);
    expect(pngSize(Buffer.from(await frame.arrayBuffer()))).toEqual({width: 1080, height: 2400});

    const {port} = new URL(url);
    const http = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      http
        .get(`${url}`, {headers: {host: `evil.example:${port}`}}, (res) => resolve(res.statusCode ?? 0))
        .on('error', () => resolve(0));
    });
    expect(status).toBe(404);
    expect((await fetch(`${url.replace(/[0-9a-f-]{36}$/, crypto.randomUUID())}`)).status).toBe(404);
    w.stop();
  });

  test('returns at once while nobody has opened the viewer, then waits for one', async () => {
    const w = new Walkthrough({} as any, [{text: 'Hi'}], server);
    await w.open();
    const started = Date.now();
    const first = await w.run(20_000);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(first.waiting).toBe(true);
    expect(first.viewers).toBe(0);
    const second = await w.run(300);
    expect(second.waiting).toBe(true);
    expect(second.completed).toBe(0);
    w.stop();
  });

  test('guided: Next, then a tap on the highlighted element advances', async () => {
    const w = new Walkthrough(
      {} as any,
      [
        {text: 'This is the home screen.'},
        {strategy: 'id', selector: 'settings', text: 'Tap Settings.', action: 'tap'},
      ],
      server,
    );
    const url = await w.open();
    const viewer = await connect(url);
    const run = w.run(20_000);

    const first = await viewer.waitFor((m) => m.type === 'step' && m.index === 0);
    expect(first.rect).toBeNull();
    await input(url, {type: 'next'});

    const second = await viewer.waitFor((m) => m.type === 'step' && m.index === 1);
    expect(second.advance).toBe('tap');
    // 108/1080, 240/2400, 216/1080, 120/2400
    expect(second.rect).toEqual({x: 0.1, y: 0.1, w: 0.2, h: 0.05});
    // The step names the screenshot it belongs to, so the viewer can wait for it.
    expect(typeof second.frameAt).toBe('number');

    await input(url, {type: 'tap', x: 0.2, y: 0.125});
    const st = await run;
    expect(command.performActions).toHaveBeenCalledWith(expect.anything(), [{tap: [216, 300]}]);
    expect(st.finished).toBe(true);
    expect(st.steps.map((s) => s.by)).toEqual(['next', 'tap']);
    await viewer.waitFor((m) => m.type === 'finish');
    viewer.close();
  }, 30_000);

  test('guided: Next performs the step, Back goes back on the device', async () => {
    const tapsChangeScreen = jest.mocked(command.elementClick).mockImplementation(async () => {
      pageSource = '<hierarchy screen="display"/>';
    });
    const w = new Walkthrough(
      {} as any,
      [
        {strategy: 'id', selector: 'settings', text: 'Tap Settings.', action: 'tap'},
        {text: 'Now you are in Settings.'},
      ],
      server,
    );
    const url = await w.open();
    const viewer = await connect(url);
    const run = w.run(20_000);
    await viewer.waitFor((m) => m.type === 'step' && m.index === 0);
    await input(url, {type: 'next'});
    await viewer.waitFor((m) => m.type === 'step' && m.index === 1);
    expect(command.elementClick).toHaveBeenCalledWith(expect.anything(), 'el-settings');

    await input(url, {type: 'back'});
    await viewer.waitFor((m) => m.type === 'step' && m.index === 0 && m !== viewer.messages[0]);
    expect(command.back).toHaveBeenCalledTimes(1);
    await input(url, {type: 'skip'});
    await run;
    tapsChangeScreen.mockReset();
    viewer.close();
  }, 30_000);

  test('guided: Next does not repeat a step the person already did', async () => {
    const w = new Walkthrough(
      {} as any,
      [{strategy: 'id', selector: 'settings', text: 'Tap Settings.', action: 'tap', advance: 'next'}, {text: 'Done.'}],
      server,
    );
    const url = await w.open();
    const viewer = await connect(url);
    const run = w.run(20_000);
    await viewer.waitFor((m) => m.type === 'step' && m.index === 0);
    await new Promise((r) => setTimeout(r, 200));
    pageSource = '<hierarchy screen="display"/>';
    await input(url, {type: 'next'});
    await viewer.waitFor((m) => m.type === 'step' && m.index === 1);
    expect(command.elementClick).not.toHaveBeenCalled();
    await input(url, {type: 'skip'});
    await run;
    viewer.close();
  }, 30_000);

  test('guided: budget runs out, resume finishes on a screen change', async () => {
    const w = new Walkthrough(
      {} as any,
      [{strategy: 'id', selector: 'name', text: 'Type your name.', action: 'type'}],
      server,
    );
    const url = await w.open();
    const viewer = await connect(url);
    const first = await w.run(800);
    expect(first.waiting).toBe(true);
    expect(first.at).toBe(0);

    const second = w.run(20_000);
    pageSource = '<hierarchy screen="2"/>';
    const st = await second;
    expect(st.finished).toBe(true);
    expect(st.steps[0].by).toBe('screen-change');
    viewer.close();
  }, 30_000);

  test('guided: Skip ends the walkthrough', async () => {
    const w = new Walkthrough({} as any, [{text: 'One'}, {text: 'Two'}], server);
    const url = await w.open();
    const viewer = await connect(url);
    const run = w.run(20_000);
    await viewer.waitFor((m) => m.type === 'step');
    await input(url, {type: 'skip'});
    const st = await run;
    expect(st.stoppedByUser).toBe(true);
    expect(st.finished).toBe(false);
    await viewer.waitFor((m) => m.type === 'end');
    viewer.close();
  }, 30_000);

  test('demo: taps and types itself, but hands a password field to the person', async () => {
    const w = new Walkthrough(
      {} as any,
      [
        {strategy: 'id', selector: 'settings', text: 'Open Settings.', action: 'tap', readMs: 50},
        {strategy: 'id', selector: 'name', text: 'Type a name.', action: 'type', value: 'Ivo', readMs: 50},
        {
          strategy: 'id',
          selector: 'password',
          text: 'Enter the password.',
          action: 'type',
          value: 'hunter2',
          readMs: 50,
        },
      ],
      server,
      'demo',
    );
    const url = await w.open();
    const viewer = await connect(url, true);
    const st = await w.run(6000);
    expect(command.elementClick).toHaveBeenCalledWith(expect.anything(), 'el-settings');
    expect(command.setValue).toHaveBeenCalledWith(expect.anything(), 'el-name', 'Ivo');
    expect(command.setValue).not.toHaveBeenCalledWith(expect.anything(), 'el-password', expect.anything());
    expect(st.waiting).toBe(true);
    expect(st.at).toBe(2);
    expect(st.steps[2].detail).toMatch(/sensitive/);
    await viewer.waitFor((m) => m.type === 'cursor');
    // The handed-over step is re-shown in guided mode.
    await viewer.waitFor((m) => m.type === 'step' && m.index === 2 && m.mode === 'guided');
    w.stop();
    viewer.close();
  }, 30_000);
});
