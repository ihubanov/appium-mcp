/**
 * Real-Chromium tests for the presenter (playwright_present engine):
 *  - guided: Next button and a click on the highlighted element advance it;
 *  - guided: a short budget returns waiting:true, a second run() resumes;
 *  - guided: the tour follows the person across a navigation;
 *  - guided: Back re-shows the previous step; Skip ends the tour and
 *    removes the overlay;
 *  - demo: Squire fills and clicks itself, but hands a password field back
 *    to the person instead of typing into it.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  jest,
} from '@jest/globals';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

await jest.unstable_mockModule('../activity-log', () => ({
  logActivity: jest.fn(async () => {}),
}));

const { chromium } = await import('playwright');
const { Tour } = await import('../presenter.js');

const PAGE_A = `<!doctype html><html><body style="height:2000px">
  <h1 id="title">Expenses</h1>
  <input id="amount" placeholder="Amount">
  <input id="pw" type="password">
  <button id="save" onclick="window.__saved=true">Save</button>
  <a id="next-page" href="/b">Continue</a>
</body></html>`;

const PAGE_B = `<!doctype html><html><body><h1 id="done">Submitted</h1></body></html>`;

let server: http.Server;
let base: string;
let browser: import('playwright').Browser;

const NEXT = 'squire-presenter .next';
const BACK = 'squire-presenter .back';
const SKIP = 'squire-presenter .skip';
const COUNT = 'squire-presenter .count';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/b' ? PAGE_B : PAGE_A);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
});

async function freshPage() {
  const page = await browser.newPage();
  await page.goto(`${base}/a`);
  return page;
}

const stepShown = (page: import('playwright').Page, label: string) =>
  page.locator(COUNT).filter({ hasText: label }).waitFor({ timeout: 10_000 });

const overlayGone = (page: import('playwright').Page) =>
  page.waitForFunction(() => !(window as any).__squirePresenter, null, {
    timeout: 5000,
  });

describe('presenter', () => {
  test('guided: Next and a click on the target advance the tour', async () => {
    const page = await freshPage();
    try {
      const tour = new Tour(page, [
        { selector: '#title', text: 'This is the expenses page.' },
        { selector: '#save', text: 'Click Save.', action: 'click' },
      ]);
      const run = tour.run(20_000);
      await page.locator(NEXT).click();
      await stepShown(page, 'Step 2 of 2');
      // The overlay must not block the real element under the spotlight.
      await page.click('#save');
      const st = await run;
      expect(st.finished).toBe(true);
      expect(st.completed).toBe(2);
      expect(st.steps[0]!.by).toBe('next');
      expect(st.steps[1]!.by).toBe('target-click');
      expect(st.steps[1]!.target).toBe('element');
      expect(await page.evaluate(() => (window as any).__saved)).toBe(true);
      await overlayGone(page);
    } finally {
      await page.close();
    }
  }, 30_000);

  test('guided: budget runs out → waiting, then resume finishes', async () => {
    const page = await freshPage();
    try {
      const tour = new Tour(page, [{ selector: '#title', text: 'Look here.' }]);
      const first = await tour.run(600);
      expect(first.waiting).toBe(true);
      expect(first.finished).toBe(false);
      expect(await page.locator(NEXT).isVisible()).toBe(true);

      const second = tour.run(20_000);
      await page.locator(NEXT).click();
      const st = await second;
      expect(st.finished).toBe(true);
      expect(tour.done).toBe(true);
    } finally {
      await page.close();
    }
  }, 30_000);

  test('guided: the tour follows a navigation to the next page', async () => {
    const page = await freshPage();
    try {
      const tour = new Tour(page, [
        {
          selector: '#next-page',
          text: 'Continue to the next page.',
          action: 'click',
        },
        { selector: '#done', text: 'And you are done.' },
      ]);
      const run = tour.run(20_000);
      await page.locator(NEXT).waitFor();
      await page.click('#next-page');
      await page.waitForURL(`${base}/b`);
      // Re-injected on the new document, now on step 2.
      await stepShown(page, 'Step 2 of 2');
      await page.locator(NEXT).click();
      const st = await run;
      expect(st.finished).toBe(true);
      expect(st.finalUrl).toBe(`${base}/b`);
    } finally {
      await page.close();
    }
  }, 30_000);

  test('guided: Back re-shows the previous step, Skip ends the tour', async () => {
    const page = await freshPage();
    try {
      const tour = new Tour(page, [
        { selector: '#title', text: 'One.' },
        { selector: '#amount', text: 'Two.' },
      ]);
      const run = tour.run(20_000);
      await page.locator(NEXT).click();
      await stepShown(page, 'Step 2 of 2');
      await page.locator(BACK).click();
      await stepShown(page, 'Step 1 of 2');
      await page.locator(SKIP).click();
      const st = await run;
      expect(st.stoppedByUser).toBe(true);
      expect(st.finished).toBe(false);
      await overlayGone(page);
    } finally {
      await page.close();
    }
  }, 30_000);

  test('demo: fills and clicks itself, but hands a password back', async () => {
    const page = await freshPage();
    try {
      const tour = new Tour(
        page,
        [
          {
            selector: '#amount',
            text: 'Type the amount.',
            action: 'fill',
            value: '42',
            readMs: 100,
          },
          {
            selector: '#save',
            text: 'Then save.',
            action: 'click',
            readMs: 100,
          },
          {
            selector: '#pw',
            text: 'Enter your password.',
            action: 'fill',
            value: 'hunter2',
            readMs: 100,
          },
        ],
        'demo'
      );
      const st = await tour.run(1500);
      expect(await page.inputValue('#amount')).toBe('42');
      expect(await page.evaluate(() => (window as any).__saved)).toBe(true);
      // Never typed; waiting on the person instead.
      expect(await page.inputValue('#pw')).toBe('');
      expect(st.waiting).toBe(true);
      expect(st.at).toBe(2);
      expect(st.steps[2]!.detail).toMatch(/sensitive/);
      expect(st.steps[0]!.by).toBe('squire');
      await tour.stop();
      await overlayGone(page);
    } finally {
      await page.close();
    }
  }, 30_000);
});
