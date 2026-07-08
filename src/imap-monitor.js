// IMAP event monitor and orchestrator
// Bridges IDLE events to message processing pipeline

const { createIdleListener } = require('./imap-idle');

let idleListener = null;
let activeContext = null;

/**
 * Initialize the IMAP IDLE monitor on plugin startup.
 * Called from onLoad to activate persistent mail listening.
 *
 * @param {Object} ctx - Plugin context with config, db, log, etc.
 * @param {Function} processMessageFn - Message handler (from src/index.js)
 * @returns {Promise<void>}
 */
async function initializeIdleMonitor(ctx, processMessageFn) {
  if (idleListener) {
    ctx.log.warn('imap-monitor: already initialized');
    return;
  }

  activeContext = ctx;

  const callbacks = {
    onError: (err) => {
      ctx.log.error(`imap-monitor: IDLE error: ${err.message}`);
    },
  };

  idleListener = createIdleListener(ctx.config, callbacks, ctx.log);

  // Create mail handler that fetches message and processes it
  const mailHandler = async () => {
    try {
      // When mail event fires, re-search for UNSEEN messages
      // (simpler than trying to extract the specific UID from the event)
      const { openConnection, searchUnseen, markProcessed } = require('./imap');

      const connection = await openConnection(ctx.config);
      try {
        const messages = await searchUnseen(connection, ctx.config);

        for (const message of messages) {
          try {
            await processMessageFn(ctx, connection, message);
          } catch (err) {
            ctx.log.error(`imap-monitor: error processing message: ${err.message}`);
            // Continue processing other messages; this one may retry on next poll
          }
        }
      } finally {
        connection.end();
      }
    } catch (err) {
      ctx.log.error(`imap-monitor: mail handler failed: ${err.message}`);
    }
  };

  await idleListener.start(mailHandler);
  ctx.log.info('imap-monitor: IDLE monitor initialized and started');
}

/**
 * Shut down the IMAP IDLE monitor gracefully.
 * Called on plugin unload or shutdown.
 *
 * @returns {Promise<void>}
 */
async function shutdownIdleMonitor() {
  if (idleListener) {
    idleListener.stop();
    idleListener = null;
  }

  activeContext = null;
}

/**
 * Check if IDLE listener is currently connected.
 * Used by fallback jobs to avoid duplicate processing.
 *
 * @returns {boolean}
 */
function isIdleConnected() {
  return !!(idleListener && idleListener.isConnected());
}

/**
 * Get current IDLE state for debugging/logging.
 *
 * @returns {string|null} Current state or null if not initialized
 */
function getIdleState() {
  return idleListener ? idleListener.getState() : null;
}

module.exports = {
  initializeIdleMonitor,
  shutdownIdleMonitor,
  isIdleConnected,
  getIdleState,
};
