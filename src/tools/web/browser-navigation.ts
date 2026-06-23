/**
 * Tools for browser back/forward/reload navigation in Playwright sessions
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { logActivity } from '../../activity-log.js';

export function goBack(server: FastMCP): void {
  server.addTool({
    name: 'playwright_go_back',
    description:
      'Go back to the previous page in browser history. Only works with Playwright web sessions.',
    parameters: z.object({}),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      assertNotProtected(driver.page.url(), 'navigate back on');
      await assertNotUserFocused(driver.page, 'navigate back on');

      try {
        await driver.page.goBack();
        const title = await driver.page.title();
        const url = driver.page.url();
        return {
          content: [
            {
              type: 'text',
              text: `Navigated back.\nURL: ${url}\nTitle: ${title}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to go back. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}

export function goForward(server: FastMCP): void {
  server.addTool({
    name: 'playwright_go_forward',
    description:
      'Go forward to the next page in browser history. Only works with Playwright web sessions.',
    parameters: z.object({}),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      assertNotProtected(driver.page.url(), 'navigate forward on');
      await assertNotUserFocused(driver.page, 'navigate forward on');

      try {
        await driver.page.goForward();
        const title = await driver.page.title();
        const url = driver.page.url();
        return {
          content: [
            {
              type: 'text',
              text: `Navigated forward.\nURL: ${url}\nTitle: ${title}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to go forward. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}

export function reload(server: FastMCP): void {
  server.addTool({
    name: 'playwright_reload',
    description:
      'Reload the current page. Only works with Playwright web sessions.',
    parameters: z.object({}),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      assertNotProtected(driver.page.url(), 'reload');
      await assertNotUserFocused(driver.page, 'reload');

      try {
        await driver.page.reload();
        const title = await driver.page.title();
        const url = driver.page.url();
        return {
          content: [
            {
              type: 'text',
              text: `Page reloaded.\nURL: ${url}\nTitle: ${title}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to reload page. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}
