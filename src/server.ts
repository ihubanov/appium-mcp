import { FastMCP } from 'fastmcp';
import registerTools from './tools/index.js';
import registerResources from './resources/index.js';
import { listSessions, safeDeleteAllSessions } from './session-store.js';
import log from './logger.js';

const server = new FastMCP({
  name: 'MCP Appium',
  version: '1.0.0',
  instructions:
    'Intelligent MCP server providing AI assistants with powerful tools and resources for Appium mobile automation and Playwright web browser automation',
});

registerResources(server);
registerTools(server);

// Whether to tear down browser/device sessions when a *client transport*
// disconnects. For stdio this is correct (disconnect == client gone). For
// httpStream/SSE the transport cycles the FastMCP connection between tool
// calls, so auto-cleanup here destroys live sessions mid-task (the browser
// window vanishes and the next call reports "no session"). Default: only
// clean up on disconnect for stdio. Override with
// APPIUM_MCP_CLEANUP_ON_DISCONNECT=true|false.
const isHttpStream = process.argv.includes('--httpStream');
const cleanupEnv = process.env['APPIUM_MCP_CLEANUP_ON_DISCONNECT'];
const cleanupOnDisconnect =
  cleanupEnv != null
    ? !['false', '0', 'no'].includes(cleanupEnv.trim().toLowerCase())
    : !isHttpStream;

// Handle client connection and disconnection events
server.on('connect', (event) => {
  log.info('Client connected:', event.session);
});

server.on('disconnect', async (event) => {
  log.info('Client disconnected:', event.session);
  if (!cleanupOnDisconnect) {
    log.info(
      'Skipping session cleanup on disconnect (httpStream mode; sessions ' +
        'persist across transport reconnects). Set ' +
        'APPIUM_MCP_CLEANUP_ON_DISCONNECT=true to restore the old behavior.'
    );
    return;
  }
  const sessions = listSessions();
  if (sessions.length > 0) {
    try {
      log.info(
        `${sessions.length} active session(s) detected on disconnect, cleaning up...`
      );
      const deletedCount = await safeDeleteAllSessions();
      log.info(
        `${deletedCount} session(s) cleaned up successfully on disconnect.`
      );
    } catch (error) {
      log.error('Error cleaning up session on disconnect:', error);
    }
  } else {
    log.info('No active sessions to clean up on disconnect.');
  }
});

// Clean up real sessions on process shutdown so headed browsers (and Appium
// drivers) don't leak when the service is stopped/restarted. With
// disconnect-cleanup disabled in httpStream mode, this is the only place
// sessions get torn down automatically.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}, cleaning up active sessions before exit...`);
  try {
    const deletedCount = await safeDeleteAllSessions();
    log.info(`${deletedCount} session(s) cleaned up on shutdown.`);
  } catch (error) {
    log.error('Error cleaning up sessions on shutdown:', error);
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

export default server;
