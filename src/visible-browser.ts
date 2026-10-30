/**
 * A tour nobody can see is pointless, so `playwright_present` always runs in
 * a browser the person can watch. Sessions default to headless, so one may
 * arrive here that shows nothing; it is replaced by a headed one on the same
 * page, with its cookies and localStorage.
 */
import type { Page } from 'playwright';
import type { PlaywrightDriver } from './playwright-adapter.js';
import {
  getSessionId,
  listSessions,
  safeDeleteSession,
} from './session-store.js';
import { openWebSession } from './tools/session/create-session.js';
import log from './logger.js';

export interface VisibleBrowser {
  driver: PlaywrightDriver;
  page: Page;
  reopened: boolean;
}

export async function ensureVisibleBrowser(
  driver: PlaywrightDriver,
  page: Page
): Promise<VisibleBrowser> {
  const sessionId = getSessionId();
  const capabilities =
    listSessions().find((s) => s.sessionId === sessionId)?.capabilities ?? {};
  // `headless` is only what was asked for: it stays true on a session that
  // attached to the user's own browser, which they can always see.
  if (driver.attachedToUserBrowser || capabilities.headless === false) {
    return { driver, page, reopened: false };
  }

  const url = page.url();
  let opened;
  try {
    opened = await openWebSession({
      browser: capabilities.browserName,
      headless: false,
      viewport: capabilities.viewport,
      url: url === 'about:blank' ? undefined : url,
      storageState: await driver.context.storageState(),
    });
  } catch (e) {
    throw new Error(
      `This session is headless and a visible browser could not be opened, so nobody could see the tour: ${(e as Error).message}`
    );
  }

  if (sessionId) {
    await safeDeleteSession(sessionId).catch((e) =>
      log.warn(`Could not close headless session ${sessionId}: ${e}`)
    );
  }
  return { driver: opened.driver, page: opened.driver.page, reopened: true };
}
