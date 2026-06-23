/**
 * Refuse mutating tools on a tab the user is currently focused on.
 *
 * The signal is `document.hidden` — Chromium flips visibility per-tab as
 * the user switches tabs. We make a single evaluate() call per guard check.
 * It costs ~50-100ms but only fires on mutations, which are infrequent
 * compared to the read-only `tabs_state` / `playwright_list_tabs` queries.
 *
 * Disable the guard with APPIUM_MCP_RESPECT_USER_FOCUS=false (escape hatch
 * if it ever gets in the way; default is enabled).
 */
import type { Page } from 'playwright';

function isEnabled(): boolean {
  const v = (process.env['APPIUM_MCP_RESPECT_USER_FOCUS'] ?? 'true')
    .trim()
    .toLowerCase();
  return v !== 'false' && v !== '0';
}

/**
 * Returns true if `document.hidden === false` — the page is the foreground
 * tab in its window. Returns false on any error (page closed, eval blocked,
 * etc.) so the guard fails open: better to allow an action than to lock
 * the AI out due to a flaky probe.
 */
export async function isPageUserFocused(page: Page): Promise<boolean> {
  if (page.isClosed()) return false;
  try {
    return await page.evaluate(() => !document.hidden);
  } catch {
    return false;
  }
}

export async function assertNotUserFocused(
  page: Page,
  action: string,
): Promise<void> {
  if (!isEnabled()) return;
  if (await isPageUserFocused(page)) {
    let url = '';
    try { url = page.url(); } catch { /* ignore */ }
    const msg =
      `Refusing to ${action} on tab "${url}" — the user is currently focused on it. ` +
      `Work on a different tab (open one with playwright_new_tab if needed), or ` +
      `wait until the user switches away. Use mcp__tabs__tabs_state to see which ` +
      `tab is user-focused before retrying.`;
    import('./activity-log.js').then(({ logActivity }) =>
      logActivity({ tool: action, tab: url, status: 'blocked', detail: 'user-focused tab' }),
    ).catch(() => { /* ignore */ });
    throw new Error(msg);
  }
}
