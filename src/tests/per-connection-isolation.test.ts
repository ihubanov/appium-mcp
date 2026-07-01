import { describe, test, expect, jest, afterEach } from '@jest/globals';

// Mock heavy native driver packages so the store can be imported without
// native dependencies installed in the test environment.
await jest.unstable_mockModule('appium-uiautomator2-driver', () => ({
  AndroidUiautomator2Driver: class MockAndroidUiautomator2Driver {
    async deleteSession() {}
  },
}));

await jest.unstable_mockModule('appium-xcuitest-driver', () => ({
  XCUITestDriver: class MockXCUITestDriver {
    async deleteSession() {}
  },
}));

await jest.unstable_mockModule('../logger', () => ({
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const { runWithConnection } = await import('../connection-context.js');
const {
  setSession,
  getDriver,
  getSessionId,
  listSessions,
  hasActiveSession,
  safeDeleteSession,
  safeDeleteAllSessions,
  safeDeleteSessionsForConnection,
} = await import('../session-store.js');

function makeMockDriver(id: string) {
  return { id, deleteSession: async () => {} } as any;
}

afterEach(async () => {
  await safeDeleteAllSessions();
});

// ---------------------------------------------------------------------------
// Per-connection active-session isolation
//
// A single httpStream backend is shared by many MCP clients. These tests prove
// that one client creating/selecting/deleting a session never repoints another
// client's active session — the bug that made tool calls land in the wrong
// browser/device.
// ---------------------------------------------------------------------------
describe('per-connection session isolation', () => {
  test('each connection sees only its own active session and driver', () => {
    runWithConnection('conn-A', () =>
      setSession(makeMockDriver('A'), 'A1', { platformName: 'Web' })
    );
    runWithConnection('conn-B', () =>
      setSession(makeMockDriver('B'), 'B1', { platformName: 'Web' })
    );

    runWithConnection('conn-A', () => {
      expect(getSessionId()).toBe('A1');
      expect((getDriver() as any)?.id).toBe('A');
      expect(hasActiveSession()).toBe(true);
    });
    runWithConnection('conn-B', () => {
      expect(getSessionId()).toBe('B1');
      expect((getDriver() as any)?.id).toBe('B');
    });
  });

  test('creating a session in one connection does not move another connection', () => {
    runWithConnection('conn-A', () => setSession(makeMockDriver('A'), 'A1'));
    runWithConnection('conn-B', () => setSession(makeMockDriver('B'), 'B1'));

    // B creates a second session — becomes B's active, must not touch A.
    runWithConnection('conn-B', () => setSession(makeMockDriver('B2'), 'B2'));

    runWithConnection('conn-A', () => expect(getSessionId()).toBe('A1'));
    runWithConnection('conn-B', () => expect(getSessionId()).toBe('B2'));
  });

  test('listSessions shows all sessions but isActive is per-connection', () => {
    runWithConnection('conn-A', () => setSession(makeMockDriver('A'), 'A1'));
    runWithConnection('conn-B', () => setSession(makeMockDriver('B'), 'B1'));

    runWithConnection('conn-A', () => {
      const list = listSessions();
      expect(list).toHaveLength(2);
      const active = list.filter((s) => s.isActive).map((s) => s.sessionId);
      expect(active).toEqual(['A1']);
    });
  });

  test('deleting your own session never activates another connection session', async () => {
    runWithConnection('conn-A', () => setSession(makeMockDriver('A'), 'A1'));
    runWithConnection('conn-B', () => setSession(makeMockDriver('B'), 'B1'));

    await runWithConnection('conn-A', () => safeDeleteSession());

    runWithConnection('conn-A', () => {
      expect(getSessionId()).toBeNull();
      expect(hasActiveSession()).toBe(false);
    });
    // B must be untouched — not auto-activated onto some other session.
    runWithConnection('conn-B', () => expect(getSessionId()).toBe('B1'));
  });

  test('deleting your own session falls back to another session you own', async () => {
    runWithConnection('conn-A', () => {
      setSession(makeMockDriver('A1'), 'A1');
      setSession(makeMockDriver('A2'), 'A2'); // A2 now active for A
    });

    await runWithConnection('conn-A', () => safeDeleteSession()); // deletes A2

    runWithConnection('conn-A', () => expect(getSessionId()).toBe('A1'));
  });

  test('disconnect cleanup removes only the disconnecting connection sessions', async () => {
    runWithConnection('conn-A', () => setSession(makeMockDriver('A'), 'A1'));
    runWithConnection('conn-B', () => {
      setSession(makeMockDriver('B1'), 'B1');
      setSession(makeMockDriver('B2'), 'B2');
    });

    const removed = await safeDeleteSessionsForConnection('conn-B');
    expect(removed).toBe(2);

    // A's session survives B's disconnect.
    const remaining = listSessions().map((s) => s.sessionId);
    expect(remaining).toEqual(['A1']);
    runWithConnection('conn-A', () => expect(getSessionId()).toBe('A1'));
  });
});
