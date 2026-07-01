import { AndroidUiautomator2Driver } from 'appium-uiautomator2-driver';
import { XCUITestDriver } from 'appium-xcuitest-driver';
import type { Client } from 'webdriver';
import { PlaywrightDriver } from './playwright-adapter.js';
import log from './logger.js';
import { currentConnectionId } from './connection-context.js';

// Type aliases for driver variants used throughout the project.
export type DriverInstance =
  | Client
  | AndroidUiautomator2Driver
  | XCUITestDriver
  | PlaywrightDriver;
export type NullableDriverInstance = DriverInstance | null;
export type SessionCapabilities = Record<string, any>;

interface SessionMetadata {
  platform: string | null;
  automationName: string | null;
  deviceName: string | null;
  capabilities: SessionCapabilities;
}

interface SessionInfo {
  driver: DriverInstance;
  sessionId: string;
  currentContext: string | null;
  isDeletingSession: boolean;
  metadata: SessionMetadata;
  /**
   * The MCP connection (client) that created this session. Used to keep the
   * "active session" pointer isolated per client and to avoid auto-activating
   * another client's session after a deletion.
   */
  ownerConnection: string;
}

/**
 * In-memory store for active Appium sessions and their associated drivers.
 * The map is shared across all clients (keyed by the driver's own session id),
 * but *which* session is "active" is tracked per client — see
 * `activeSessionByConnection`.
 */
const sessions = new Map<string, SessionInfo>();
/**
 * The active session id for each MCP connection (client). Because a single
 * httpStream backend is shared by many clients, a global active pointer would
 * let one client's create/select repoint every other client. Partitioning by
 * connection id keeps each client operating on its own driver.
 */
const activeSessionByConnection = new Map<string, string>();

/** Active session id for the client making the current tool call. */
function getActiveSessionId(): string | null {
  return activeSessionByConnection.get(currentConnectionId()) ?? null;
}

/** Set (or clear) the active session for the client making the current call. */
function setActiveSessionForCurrent(id: string | null): void {
  const connectionId = currentConnectionId();
  if (id) {
    activeSessionByConnection.set(connectionId, id);
  } else {
    activeSessionByConnection.delete(connectionId);
  }
}

export const PLATFORM = {
  android: 'Android',
  ios: 'iOS',
  web: 'Web',
};

/**
 * Determine whether the provided driver represents a remote driver session.
 *
 * This checks for the presence of a string-valued `sessionId` property on the
 * driver object, which indicates a remote/WebDriver session.
 *
 * @param driver - The driver instance to inspect (may be a Client, AndroidUiautomator2Driver, XCUITestDriver, or null).
 * @returns `true` if `driver` is non-null and has a string `sessionId`; otherwise `false`.
 */
export function isPlaywrightDriverSession(
  driver: NullableDriverInstance
): driver is PlaywrightDriver {
  return driver instanceof PlaywrightDriver;
}

export function isRemoteDriverSession(driver: NullableDriverInstance): boolean {
  if (driver) {
    return (
      !(driver instanceof AndroidUiautomator2Driver) &&
      !(driver instanceof XCUITestDriver) &&
      !(driver instanceof PlaywrightDriver)
    );
  }
  return false;
}

/**
 * Type-guard that asserts the provided driver is an Android UiAutomator2 driver.
 *
 * Performs a runtime `instanceof` check. When this function returns `true`,
 * TypeScript will narrow the variable's type to `AndroidUiautomator2Driver`.
 * Use this helper to safely call Android-specific driver methods without
 * casting.
 *
 * @param driver - The driver instance to test (may be a `Client`,
 *   `AndroidUiautomator2Driver`, `XCUITestDriver`, or `null`).
 * @returns `true` if `driver` is an `AndroidUiautomator2Driver`.
 */
export function isAndroidUiautomator2DriverSession(
  driver: NullableDriverInstance
): driver is AndroidUiautomator2Driver {
  return driver instanceof AndroidUiautomator2Driver;
}

/**
 * Type-guard that asserts the provided driver is an XCUITest (iOS) driver.
 *
 * Performs a runtime `instanceof` check and narrows the type to
 * `XCUITestDriver` when true. This lets callers invoke iOS-specific driver
 * APIs without explicit casts.
 *
 * @param driver - The driver instance to test (may be a `Client`,
 *   `AndroidUiautomator2Driver`, `XCUITestDriver`, or `null`).
 * @returns `true` if `driver` is an `XCUITestDriver`.
 */
export function isXCUITestDriverSession(
  driver: NullableDriverInstance
): driver is XCUITestDriver {
  return driver instanceof XCUITestDriver;
}

export function setSession(
  d: DriverInstance,
  id: string | null,
  capabilities: SessionCapabilities = {}
) {
  if (!id) {
    setActiveSessionForCurrent(null);
    return;
  }

  const metadata: SessionMetadata = {
    platform:
      (capabilities.platformName as string | undefined) ??
      (capabilities['appium:platformName'] as string | undefined) ??
      null,
    automationName:
      (capabilities['appium:automationName'] as string | undefined) ?? null,
    deviceName:
      (capabilities['appium:deviceName'] as string | undefined) ??
      (capabilities.deviceName as string | undefined) ??
      null,
    capabilities,
  };

  sessions.set(id, {
    driver: d,
    sessionId: id,
    currentContext: 'NATIVE_APP',
    isDeletingSession: false,
    metadata,
    ownerConnection: currentConnectionId(),
  });
  setActiveSessionForCurrent(id);
}

export function getDriver(sessionId?: string): NullableDriverInstance {
  const id = sessionId ?? getActiveSessionId();
  if (!id) {
    return null;
  }
  return sessions.get(id)?.driver ?? null;
}

export function getSessionId() {
  return getActiveSessionId();
}

export function listSessions(): Array<{
  sessionId: string;
  currentContext: string | null;
  isActive: boolean;
  platform: string | null;
  automationName: string | null;
  deviceName: string | null;
  capabilities: SessionCapabilities;
}> {
  return Array.from(sessions.values()).map((session) => ({
    sessionId: session.sessionId,
    currentContext: session.currentContext,
    isActive: session.sessionId === getActiveSessionId(),
    platform: session.metadata.platform,
    automationName: session.metadata.automationName,
    deviceName: session.metadata.deviceName,
    capabilities: session.metadata.capabilities,
  }));
}

export function setActiveSession(sessionId: string): boolean {
  if (!sessions.has(sessionId)) {
    return false;
  }
  setActiveSessionForCurrent(sessionId);
  return true;
}

export function setCurrentContext(
  context: string,
  sessionId?: string
): boolean {
  const id = sessionId ?? getActiveSessionId();
  if (!id) {
    return false;
  }

  const session = sessions.get(id);
  if (!session) {
    return false;
  }

  session.currentContext = context;
  return true;
}

export function getCurrentContext(sessionId?: string): string | null {
  const id = sessionId ?? getActiveSessionId();
  if (!id) {
    return null;
  }
  return sessions.get(id)?.currentContext ?? null;
}

export function isDeletingSessionInProgress(sessionId?: string) {
  const id = sessionId ?? getActiveSessionId();
  if (!id) {
    return false;
  }
  return sessions.get(id)?.isDeletingSession ?? false;
}

export function hasActiveSession(): boolean {
  const activeId = getActiveSessionId();
  if (!activeId) {
    return false;
  }
  const session = sessions.get(activeId);
  return !!session && !session.isDeletingSession;
}

/**
 * After a session is deleted, drop it as the active session for every client
 * that had it selected, and — for the client performing the deletion — fall
 * back only to another session that *same* client owns. We deliberately never
 * auto-activate a session owned by a different client, which would re-introduce
 * cross-client interference.
 */
function reassignActiveAfterDelete(deletedSessionId: string): void {
  const deletingConnection = currentConnectionId();

  for (const [connectionId, activeId] of activeSessionByConnection.entries()) {
    if (activeId !== deletedSessionId) {
      continue;
    }
    if (connectionId === deletingConnection) {
      const replacement = Array.from(sessions.values()).find(
        (s) =>
          s.sessionId !== deletedSessionId &&
          s.ownerConnection === deletingConnection
      );
      if (replacement) {
        activeSessionByConnection.set(connectionId, replacement.sessionId);
      } else {
        activeSessionByConnection.delete(connectionId);
      }
    } else {
      activeSessionByConnection.delete(connectionId);
    }
  }
}

export async function safeDeleteSession(sessionId?: string): Promise<boolean> {
  const id = sessionId ?? getActiveSessionId();

  if (!id) {
    log.info('No active session to delete.');
    return false;
  }

  const session = sessions.get(id);

  // Check if there's no session to delete
  if (!session) {
    log.info(`Session ${id} not found.`);
    return false;
  }

  // Check if deletion is already in progress
  if (session.isDeletingSession) {
    log.info(`Session ${id} deletion already in progress, skipping...`);
    return false;
  }

  // Set lock
  session.isDeletingSession = true;

  try {
    log.info(`Deleting session ${id}`);
    await session.driver.deleteSession();

    // Clear the session from store
    sessions.delete(id);
    reassignActiveAfterDelete(id);

    log.info(`Session ${id} deleted successfully.`);
    return true;
  } catch (error) {
    log.error('Error deleting session:', error);
    throw error;
  } finally {
    // Always release lock
    const existingSession = sessions.get(id);
    if (existingSession) {
      existingSession.isDeletingSession = false;
    }
  }
}

export async function safeDeleteAllSessions(): Promise<number> {
  let deletedCount = 0;
  const sessionIds = Array.from(sessions.keys());

  for (const sessionId of sessionIds) {
    try {
      const deleted = await safeDeleteSession(sessionId);
      if (deleted) {
        deletedCount += 1;
      }
    } catch (error) {
      log.error(`Error deleting session ${sessionId}:`, error);
    }
  }

  return deletedCount;
}

/**
 * Delete only the sessions owned by a specific MCP connection. Used on client
 * disconnect so tearing down one client never destroys another client's live
 * browser/device session.
 */
export async function safeDeleteSessionsForConnection(
  connectionId: string
): Promise<number> {
  let deletedCount = 0;
  const ownedSessionIds = Array.from(sessions.values())
    .filter((s) => s.ownerConnection === connectionId)
    .map((s) => s.sessionId);

  for (const sessionId of ownedSessionIds) {
    try {
      const deleted = await safeDeleteSession(sessionId);
      if (deleted) {
        deletedCount += 1;
      }
    } catch (error) {
      log.error(`Error deleting session ${sessionId}:`, error);
    }
  }

  // Drop any lingering active-pointer for this connection.
  activeSessionByConnection.delete(connectionId);

  return deletedCount;
}

export const getPlatformName = (driver: any): string => {
  if (driver instanceof PlaywrightDriver) {
    return PLATFORM.web;
  }
  if (driver instanceof AndroidUiautomator2Driver) {
    return PLATFORM.android;
  }
  if (driver instanceof XCUITestDriver) {
    return PLATFORM.ios;
  }

  if ((driver as Client).isAndroid) {
    return PLATFORM.android;
  } else if ((driver as Client).isIOS) {
    return PLATFORM.ios;
  }

  throw new Error('Unknown driver type');
};
