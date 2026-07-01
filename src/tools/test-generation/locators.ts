/**
 * Tool to get page source from the Android session
 *
 * TOOL EXTENSION GUIDE:
 * This tool demonstrates the traditional approach where metadata is defined inline.
 *
 * ALTERNATIVE APPROACH: You can also use YAML metadata files for better separation.
 * See src/tools/metadata/ for examples and src/tools/scroll-with-yaml.example.ts
 *
 * For detailed documentation on adding tools, see docs/CONTRIBUTING.md
 */
import { z } from 'zod';
import {
  getDriver,
  isAndroidUiautomator2DriverSession,
  isXCUITestDriverSession,
  isPlaywrightDriverSession,
} from '../../session-store.js';
import { generateAllElementLocators } from '../../locators/generate-all-locators.js';
import {
  createUIResource,
  createLocatorGeneratorUI,
  addUIResourceToResponse,
} from '../../ui/mcp-ui-utils.js';
import { getPageSource } from '../../command.js';

export default function generateLocators(server: any): void {
  server.addTool({
    name: 'generate_locators',
    description: `Generate locators for all interactable elements on the current page. [PRIORITY 3: Use this for debugging/inspection or when you need comprehensive element info with locator suggestions]`,
    parameters: z.object({}),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
    execute: async (_args: any, { log }: any): Promise<any> => {
      log.info('Getting page source');
      try {
        // Check for active driver session

        const driver = getDriver();
        if (!driver) {
          throw new Error(
            'No active driver session. Please create a session first.'
          );
        }

        // generate_locators builds NATIVE-mobile locators (resource-id,
        // accessibility id, and XPath) by parsing the page source as strict
        // XML. Web (Playwright) sessions return HTML, which (a) isn't valid XML
        // so the parser throws "Opening and ending tag mismatch", and (b) even
        // when parsed leniently lands in the XHTML namespace, so the XPath
        // engine matches nothing and the locators are silently wrong. Rather
        // than crash or mislead, direct the caller to the right web workflow.
        if (isPlaywrightDriverSession(driver)) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  message:
                    'generate_locators is not supported for web (Playwright) sessions — it targets native mobile elements.',
                  guidance:
                    'To inspect and locate elements on a web page: call appium_get_page_source to read the HTML/DOM, take an appium_screenshot to see the page, then locate and interact using the playwright_* tools (playwright_navigate, playwright_hover, playwright_type, playwright_press_key, playwright_select_option) or appium_find_element with CSS/text selectors.',
                }),
              },
            ],
          };
        }

        try {
          // Get the page source from the driver
          const pageSource = await getPageSource(driver);
          let driverName;
          if (isPlaywrightDriverSession(driver)) {
            driverName = 'playwright';
          } else if (isAndroidUiautomator2DriverSession(driver)) {
            driverName = await driver.caps.automationName?.toLowerCase();
          } else if (isXCUITestDriverSession(driver)) {
            driverName = await driver.caps.automationName?.toLowerCase();
          } else {
            driverName =
              await driver.capabilities['appium:automationName']?.toLowerCase();
          }
          if (!pageSource) {
            throw new Error('Page source is empty or null');
          }
          const sampleXML = pageSource;
          const interactableElements = generateAllElementLocators(
            sampleXML,
            true,
            driverName,
            {
              fetchableOnly: true,
            }
          );

          const textResponse = {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  interactableElements,
                  message: 'Page source retrieved successfully',
                  instruction: `This the locators for the current page. Use this to generate code for the current page.
                     Using the template provided by generate://code-with-locators resource.`,
                }),
              },
            ],
          };

          // Add interactive locator generator UI
          const uiResource = createUIResource(
            `ui://appium-mcp/locator-generator/${Date.now()}`,
            createLocatorGeneratorUI(interactableElements)
          );

          return addUIResourceToResponse(textResponse, uiResource);
        } catch (parseError: any) {
          log.error('Error parsing XML:', parseError);
          throw new Error(`Failed to parse XML: ${parseError.message}`);
        }
      } catch (error: any) {
        log.error('Error getting page source:', error);
        throw new Error(`Failed to get page source: ${error.message}`);
      }
    },
  });
}
