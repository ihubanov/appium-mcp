/**
 * Tool to get the current page URL in Playwright sessions
 */
import type { ContentResult, FastMCP } from 'fastmcp';
import { z } from 'zod';
import { getDriver, isPlaywrightDriverSession } from '../../session-store.js';

export default function getUrl(server: FastMCP): void {
  server.addTool({
    name: 'playwright_get_url',
    description:
      "Get the URL and title of the AI's currently active tab in the real browser. Useful after a navigation or a click that may have triggered a redirect.",
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
        const url = driver.page.url();
        const title = await driver.page.title();
        return {
          content: [
            {
              type: 'text',
              text: `URL: ${url}\nTitle: ${title}`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: 'text',
              text: `Failed to get URL. Error: ${err.toString()}`,
            },
          ],
        };
      }
    },
  });
}
