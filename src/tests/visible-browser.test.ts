/**
 * playwright_present must never run where nobody can see it: a headless
 * session is replaced by a headed one on the same page, and attached or
 * headed sessions are left alone.
 */
import { describe, test, expect, jest, beforeEach } from '@jest/globals';

const openWebSession = jest.fn<(opts: any) => Promise<any>>();
const safeDeleteSession = jest.fn<(id: string) => Promise<boolean>>();
let capabilities: Record<string, unknown>;

await jest.unstable_mockModule('../tools/session/create-session', () => ({
  openWebSession,
}));
await jest.unstable_mockModule('../session-store', () => ({
  getSessionId: () => 'pw-1',
  listSessions: () => [{ sessionId: 'pw-1', capabilities }],
  safeDeleteSession,
}));
await jest.unstable_mockModule('../logger', () => ({
  default: { warn: jest.fn() },
}));

const { ensureVisibleBrowser } = await import('../visible-browser.js');

const state = { cookies: [{ name: 'sid' }], origins: [] };
const page = (url: string): any => ({ url: () => url });
const driver = (attachedToUserBrowser = false): any => ({
  attachedToUserBrowser,
  context: { storageState: async () => state },
});
const headedPage = page('https://example.com/a');
const headedDriver = { page: headedPage };

beforeEach(() => {
  capabilities = {
    headless: true,
    browserName: 'chromium',
    viewport: { width: 1280, height: 720 },
  };
  openWebSession.mockReset();
  openWebSession.mockResolvedValue({ driver: headedDriver });
  safeDeleteSession.mockReset();
  safeDeleteSession.mockResolvedValue(true);
});

describe('ensureVisibleBrowser', () => {
  test('leaves a headed session alone', async () => {
    capabilities.headless = false;
    const d = driver();
    const p = page('https://example.com/a');
    expect(await ensureVisibleBrowser(d, p)).toEqual({
      driver: d,
      page: p,
      reopened: false,
    });
    expect(openWebSession).not.toHaveBeenCalled();
  });

  test('trusts attachment over the headless flag', async () => {
    const r = await ensureVisibleBrowser(driver(true), page('https://a.test/'));
    expect(r.reopened).toBe(false);
    expect(openWebSession).not.toHaveBeenCalled();
  });

  test('reopens a headless session headed, then closes the old one', async () => {
    const r = await ensureVisibleBrowser(
      driver(),
      page('https://example.com/a')
    );
    expect(openWebSession).toHaveBeenCalledWith({
      browser: 'chromium',
      headless: false,
      viewport: { width: 1280, height: 720 },
      url: 'https://example.com/a',
      storageState: state,
    });
    expect(safeDeleteSession).toHaveBeenCalledWith('pw-1');
    expect(r).toEqual({
      driver: headedDriver,
      page: headedPage,
      reopened: true,
    });
  });

  test('does not navigate to about:blank', async () => {
    await ensureVisibleBrowser(driver(), page('about:blank'));
    expect(openWebSession.mock.calls[0][0].url).toBeUndefined();
  });

  test('keeps the old session and explains when no browser can open', async () => {
    openWebSession.mockRejectedValue(new Error('no XServer'));
    await expect(
      ensureVisibleBrowser(driver(), page('https://example.com/a'))
    ).rejects.toThrow(/nobody could see the tour.*no XServer/);
    expect(safeDeleteSession).not.toHaveBeenCalled();
  });

  test('a failed cleanup does not stop the tour', async () => {
    safeDeleteSession.mockRejectedValue(new Error('already gone'));
    const r = await ensureVisibleBrowser(
      driver(),
      page('https://example.com/a')
    );
    expect(r.reopened).toBe(true);
  });
});
