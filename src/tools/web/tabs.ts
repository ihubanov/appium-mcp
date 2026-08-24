/**
 * Tools for managing browser tabs in Playwright sessions
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';
import { assertNotProtected } from '../../protected-urls.js';
import { assertNotUserFocused } from '../../focus-guard.js';
import { writeAiActiveTab } from '../../ai-state.js';
import { logActivity } from '../../activity-log.js';

export function newTab(server: FastMCP): void {
  const newTabSchema = z.object({
    url: z
      .string()
      .optional()
      .describe('Optional URL to navigate to in the new tab'),
    bringToFront: z
      .boolean()
      .optional()
      .describe(
        'Whether to bring the new tab to the foreground in the user\'s window. Default false — new tabs open in the background so the AI doesn\'t steal focus from the user. Set true only if the user explicitly asked you to show them the new tab.',
      ),
  });

  server.addTool({
    name: 'playwright_new_tab',
    description:
      'Open a new tab in the real Chromium window the user is in, optionally navigated to a URL. This is your primary tool for "go look at a website" — it does literally what a person does when they Cmd+T and type a URL. The page loads with full JavaScript, cookies, redirects, and captchas just like for a human. New tabs open in the background by default so the user\'s view doesn\'t get yanked; the AI\'s "active tab" follows the new one. Use this for: web search (always via http://localhost:8484/search?q=…, never google.com directly), opening a specific site the user mentioned, opening a result link from a previous search.',
    parameters: newTabSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
    },
    execute: async (
      args: z.infer<typeof newTabSchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      try {
        const wantBackground = args.bringToFront !== true;
        let page: import('playwright').Page;

        if (wantBackground) {
          // True background creation via CDP — Chromium never foregrounds
          // the new tab, so the user's focused tab doesn't even flicker.
          // We can't use context.newPage() which always steals focus.
          const cdp = await driver.context.newCDPSession(driver.page);
          const newPagePromise = driver.context.waitForEvent('page', { timeout: 15000 });
          // If cdp.send() below throws, control jumps to the catch and this
          // promise is never awaited — 15s later it rejects with no handler,
          // which under Node's default --unhandled-rejections=throw crashes
          // the whole MCP server. Register a no-op handler so a stranded
          // waiter can never take the process down.
          newPagePromise.catch(() => { /* superseded by the catch below */ });
          await cdp.send('Target.createTarget', {
            url: args.url ?? 'about:blank',
            background: true,
          });
          page = await newPagePromise;
          // Wait for initial load (best-effort) so the AI can act on it
          // immediately after this call returns.
          if (args.url) {
            try { await page.waitForLoadState('load', { timeout: 15000 }); } catch { /* ignore */ }
          }
          try { await cdp.detach(); } catch { /* ignore */ }
        } else {
          page = await driver.context.newPage();
          if (args.url) {
            await page.goto(args.url);
          }
        }

        // The AI's "active page" follows the new tab regardless of who
        // has window focus — it's a separate concept.
        driver.setPage(page);
        writeAiActiveTab(driver.context.pages().indexOf(page), page.url());
        logActivity({ tool: 'playwright_new_tab', tab: page.url(), status: 'ok', detail: wantBackground ? 'background' : 'foreground' });

        const title = await page.title();
        const url = page.url();
        const pages = driver.context.pages();
        const newIndex = pages.indexOf(page);

        return {
          content: [
            {
              type: 'text',
              text: `New tab opened at index ${newIndex} (${
                wantBackground ? 'in background — user focus preserved' : 'foregrounded'
              }).\nURL: ${url}\nTitle: ${title}\nTotal tabs: ${pages.length}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to open new tab. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}

export function switchTab(server: FastMCP): void {
  const switchTabSchema = z.object({
    index: z
      .number()
      .int()
      .min(0)
      .describe('Zero-based index of the tab to switch to'),
    bringToFront: z
      .boolean()
      .optional()
      .describe(
        'Whether to also foreground the tab in the user\'s window. Default false — switches the AI\'s internal active tab without stealing focus from the user. Set true only if the user explicitly asked to be shown that tab.',
      ),
  });

  server.addTool({
    name: 'playwright_switch_tab',
    description:
      "Change which existing open tab the AI is acting on. By default this does NOT change what the user sees — the user's foreground tab stays put — it only retargets subsequent playwright_* calls. Pass bringToFront=true to also surface the tab in the user's window (only do this if the user explicitly asked to be shown that tab).",
    parameters: switchTabSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (
      args: z.infer<typeof switchTabSchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      try {
        const pages = driver.context.pages();
        if (args.index >= pages.length) {
          throw new Error(
            `Tab index ${args.index} is out of range. There are ${pages.length} tab(s) (0-${pages.length - 1}).`
          );
        }

        const page = pages[args.index];
        driver.setPage(page);
        writeAiActiveTab(args.index, page.url());

        if (args.bringToFront === true) {
          await page.bringToFront();
        }

        const title = await page.title();
        const url = page.url();
        const visible = args.bringToFront === true ? 'foregrounded' : 'AI-active only (user focus untouched)';

        return {
          content: [
            {
              type: 'text',
              text: `Switched AI active tab to ${args.index} (${visible}).\nURL: ${url}\nTitle: ${title}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to switch tab. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}

export function listTabs(server: FastMCP): void {
  server.addTool({
    name: 'playwright_list_tabs',
    description:
      'List every tab currently open in the real browser window with index, URL, title, and which is the AI-active tab. Use mcp__tabs__tabs_state instead when you can — it also reports user-focus and content previews, and doesn\'t require a session bootstrap.',
    parameters: z.object({}),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    execute: async (): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      try {
        const pages = driver.context.pages();
        const currentPage = driver.page;

        const tabInfo = await Promise.all(
          pages.map(async (page, index) => {
            const title = await page.title();
            const url = page.url();
            const isActive = page === currentPage ? ' (active)' : '';
            return `  ${index}. ${title || '(no title)'} - ${url}${isActive}`;
          })
        );

        return {
          content: [
            {
              type: 'text',
              text: `Open tabs (${pages.length}):\n${tabInfo.join('\n')}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to list tabs. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}

export function closeTab(server: FastMCP): void {
  const closeTabSchema = z.object({
    index: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Zero-based index of the tab to close. Defaults to the current active tab.'
      ),
  });

  server.addTool({
    name: 'playwright_close_tab',
    description:
      'Close a tab in the user\'s browser window by index, or the AI-active tab if no index is given. Use this to clean up after you\'re done with a research tab and don\'t need it anymore. Refused on the qwen-web TUI tab and on a tab the user is currently looking at.',
    parameters: closeTabSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (
      args: z.infer<typeof closeTabSchema>,
      _context: Record<string, unknown> | undefined
    ): Promise<ContentResult> => {
      const driver = getDriver();
      if (!driver || !isPlaywrightDriverSession(driver)) {
        throw new Error(
          'No Playwright web session found. Create a session with platform="web" first.'
        );
      }

      try {
        const pages = driver.context.pages();
        const targetIndex = args.index ?? pages.indexOf(driver.page);

        if (targetIndex < 0 || targetIndex >= pages.length) {
          throw new Error(
            `Tab index ${targetIndex} is out of range. There are ${pages.length} tab(s).`
          );
        }

        const pageToClose = pages[targetIndex];
        assertNotProtected(pageToClose.url(), 'close tab');
        await assertNotUserFocused(pageToClose, 'close tab');
        const closedUrl = pageToClose.url();
        await pageToClose.close();
        logActivity({ tool: 'playwright_close_tab', tab: closedUrl, status: 'ok' });

        // Switch to the last remaining tab if we closed the active one
        const remaining = driver.context.pages();
        if (remaining.length > 0 && pageToClose === driver.page) {
          driver.setPage(remaining[remaining.length - 1]);
        }

        return {
          content: [
            {
              type: 'text',
              text: `Tab ${targetIndex} closed. ${remaining.length} tab(s) remaining.`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to close tab. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}
