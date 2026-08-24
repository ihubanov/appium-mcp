/**
 * Playwright Adapter
 *
 * Bridges Playwright's Locator/ElementHandle-based API to the UUID-based
 * element model used by the existing tool infrastructure.
 */
import type {
  Browser,
  BrowserContext,
  Page,
  ElementHandle,
} from 'playwright';
import { randomUUID } from 'node:crypto';

/**
 * Wraps a Playwright Browser + BrowserContext + Page into a single object
 * that can be stored in the session store alongside Appium drivers.
 *
 * Maintains an element registry that maps generated UUIDs to Playwright
 * ElementHandles so that downstream tools can reference elements the
 * same way they do with Appium's W3C element IDs.
 */
export class PlaywrightDriver {
  readonly browser: Browser;
  readonly context: BrowserContext;
  private _page: Page;
  private readonly elements = new Map<string, ElementHandle>();
  /**
   * True when this driver is attached (over CDP) to a browser the user is
   * also using. In that mode the context is the user's OWN default context
   * and its pages are the user's real tabs — teardown must not close them.
   */
  readonly attachedToUserBrowser: boolean;

  constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    attachedToUserBrowser = false,
  ) {
    this.browser = browser;
    this.context = context;
    this._page = page;
    this.attachedToUserBrowser = attachedToUserBrowser;
  }

  get page(): Page {
    return this._page;
  }

  /** Switch the active page (tab). */
  setPage(page: Page): void {
    this._page = page;
  }

  // ── Element Registry ────────────────────────────────────────────

  /** Register an ElementHandle and return a UUID for it. */
  registerElement(handle: ElementHandle): string {
    const uuid = randomUUID();
    this.elements.set(uuid, handle);
    return uuid;
  }

  /** Look up a previously registered ElementHandle by UUID. */
  getElement(uuid: string): ElementHandle | undefined {
    return this.elements.get(uuid);
  }

  /** Require an element handle or throw. */
  requireElement(uuid: string): ElementHandle {
    const el = this.elements.get(uuid);
    if (!el) {
      throw new Error(
        `Element with UUID "${uuid}" not found. It may have been removed from the DOM or the page navigated away.`
      );
    }
    return el;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  /** Clean up: close context and browser. */
  async deleteSession(): Promise<void> {
    this.elements.clear();
    if (this.attachedToUserBrowser) {
      // We are attached to the user's own browser over CDP. `context` is
      // the user's default context (contexts[0]) and its pages are the
      // user's real tabs — closing it would nuke every tab the user has
      // open, including the protected TUI tab. Only DISCONNECT the CDP
      // session (browser.close() on a connected browser detaches without
      // killing the browser or its contexts). Never touch the context.
      try {
        await this.browser.close();
      } catch {
        /* already gone / disconnected */
      }
      return;
    }
    await this.context.close();
    await this.browser.close();
  }

  // ── Element Operations (Appium-compatible surface) ──────────────

  async findElement(
    strategy: string,
    selector: string
  ): Promise<Record<string, string>> {
    let pwSelector: string;

    switch (strategy) {
      case 'css selector':
        pwSelector = selector;
        break;
      case 'xpath':
        pwSelector = `xpath=${selector}`;
        break;
      case 'id':
        pwSelector = `#${selector}`;
        break;
      case 'name':
        pwSelector = `[name="${selector}"]`;
        break;
      case 'class name':
        pwSelector = `.${selector}`;
        break;
      case 'tag name':
        pwSelector = selector;
        break;
      case 'text':
        pwSelector = `text=${selector}`;
        break;
      case 'accessibility id':
      case 'role':
        pwSelector = `[aria-label="${selector}"]`;
        break;
      case 'data-testid':
      case 'test id':
        pwSelector = `[data-testid="${selector}"]`;
        break;
      case 'placeholder':
        pwSelector = `[placeholder="${selector}"]`;
        break;
      default:
        // Treat unknown strategies as CSS selectors
        pwSelector = selector;
    }

    const handle = await this._page.waitForSelector(pwSelector, {
      timeout: 10000,
    });
    if (!handle) {
      throw new Error(
        `Element not found with strategy "${strategy}" and selector "${selector}"`
      );
    }

    const uuid = this.registerElement(handle);
    return { 'element-6066-11e4-a52e-4f735466cecf': uuid };
  }
}
