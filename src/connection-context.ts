/**
 * Per-connection execution context.
 *
 * This server is frequently run as a single long-lived httpStream/SSE backend
 * shared by *multiple* MCP clients at once (e.g. several Claude Code sessions
 * pointed at the same http://localhost:PORT/sse). Historically the "active
 * session" (which device/browser tool calls operate on) and the pre-create
 * "selected device" were stored in module-level globals, so a `create_session`
 * or `select_session` in one client silently repointed *every* other client at
 * the wrong driver — screenshots and clicks landed in someone else's browser.
 *
 * To fix that without threading a sessionId through all 60+ tools, we run every
 * tool's `execute()` inside an AsyncLocalStorage keyed by the MCP connection id
 * (`context.sessionId`, which in stateful httpStream is the stable
 * `mcp-session-id` header — one per client). Session-store and select-device
 * then partition their state by this connection id, so each client gets its own
 * isolated active session and device selection.
 *
 * Calls without a connection id (stdio transport, or any code path that runs
 * outside a wrapped tool execution) fall back to a single shared bucket
 * (`GLOBAL_CONNECTION`), preserving the original single-client behavior.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Bucket used when no per-connection id is available (stdio, startup code). */
export const GLOBAL_CONNECTION = '__global__';

interface ConnectionState {
  connectionId: string;
}

const storage = new AsyncLocalStorage<ConnectionState>();

/**
 * Run `fn` (typically a tool's async `execute`) with the given MCP connection
 * id bound as the current connection for the whole async call chain. The bound
 * id is inherited across every `await` inside `fn`.
 */
export function runWithConnection<T>(
  connectionId: string | undefined,
  fn: () => T
): T {
  return storage.run({ connectionId: connectionId || GLOBAL_CONNECTION }, fn);
}

/**
 * The MCP connection id for the currently executing tool call, or
 * `GLOBAL_CONNECTION` when running outside a wrapped execution (stdio, startup).
 */
export function currentConnectionId(): string {
  return storage.getStore()?.connectionId ?? GLOBAL_CONNECTION;
}
