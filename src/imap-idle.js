// IMAP IDLE connection manager
// Manages persistent IMAP connection with server-push notifications

const { openConnection, getUnderlyingImap } = require('./imap');

// State constants
const STATE = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  IDLE_ACTIVE: 'idle_active',
  RECONNECTING: 'reconnecting',
};

// Reconnect backoff: 5s, 10s, 20s, 40s, 60s, then hold at 60s
const BACKOFF_DELAYS = [5000, 10000, 20000, 40000, 60000];
const JITTER_PERCENT = 0.1; // 0-10% random jitter

function addJitter(ms) {
  const jitterAmount = ms * JITTER_PERCENT * Math.random();
  return ms + jitterAmount;
}

/**
 * Create an IMAP IDLE listener that maintains a persistent connection
 * and processes mail events as they arrive from the server.
 *
 * @param {Object} config - IMAP config (imap_host, imap_port, imap_user, etc.)
 * @param {Object} callbacks - { onMail(uid, messageId), onError(err) }
 * @param {Object} log - Logger with .info, .warn, .error methods
 * @returns {Object} listener with { start(), stop(), isConnected(), getState() }
 */
function createIdleListener(config, callbacks, log) {
  let connection = null;
  let state = STATE.DISCONNECTED;
  let idleAbort = null;
  let reconnectTimeout = null;
  let reconnectAttempt = 0;
  let mailHandler = null;

  function setState(newState) {
    if (state !== newState) {
      log.info(`imap-idle: state transition ${state} → ${newState}`);
      state = newState;
    }
  }

  async function _connectAndStartIdle() {
    try {
      setState(STATE.CONNECTING);
      log.info('imap-idle: opening connection...');

      connection = await openConnection(config);
      const imapConn = getUnderlyingImap(connection);

      // Check if server supports IDLE
      if (!imapConn.serverCapabilities.includes('IDLE')) {
        log.warn('imap-idle: server does not support IDLE, falling back to polling');
        setState(STATE.CONNECTED);
        return false;
      }

      setState(STATE.IDLE_ACTIVE);
      log.info('imap-idle: IDLE capability confirmed, starting IDLE...');

      // Set up event listeners on the raw imap connection
      imapConn.on('mail', () => {
        log.info('imap-idle: mail event received');
        if (mailHandler) {
          mailHandler().catch((err) => {
            log.error(`imap-idle: mail handler error: ${err.message}`);
          });
        }
      });

      imapConn.on('error', (err) => {
        log.error(`imap-idle: connection error: ${err.message}`);
        if (callbacks.onError) {
          callbacks.onError(err);
        }
      });

      imapConn.on('close', () => {
        log.warn('imap-idle: connection closed by server');
        setState(STATE.DISCONNECTED);
        _scheduleReconnect();
      });

      imapConn.on('end', () => {
        log.info('imap-idle: connection ended');
        setState(STATE.DISCONNECTED);
      });

      imapConn.on('alert', (msg) => {
        log.info(`imap-idle: server alert: ${msg}`);
      });

      // Start IDLE mode
      await new Promise((resolve, reject) => {
        imapConn.idle((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      log.info('imap-idle: IDLE mode active, listening for mail...');
      reconnectAttempt = 0; // Reset on successful connection
      return true;
    } catch (err) {
      log.error(`imap-idle: failed to start IDLE: ${err.message}`);
      setState(STATE.DISCONNECTED);
      return false;
    }
  }

  function _scheduleReconnect() {
    if (state === STATE.RECONNECTING) {
      return; // Already scheduling
    }

    setState(STATE.RECONNECTING);

    // Get backoff delay (cap at 60s)
    const delayIndex = Math.min(reconnectAttempt, BACKOFF_DELAYS.length - 1);
    const baseDelay = BACKOFF_DELAYS[delayIndex];
    const delay = addJitter(baseDelay);

    reconnectAttempt++;
    log.info(`imap-idle: scheduling reconnect in ${Math.round(delay)}ms (attempt ${reconnectAttempt})`);

    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      _connectAndStartIdle().then((success) => {
        if (!success && state === STATE.DISCONNECTED) {
          _scheduleReconnect();
        }
      });
    }, delay);
  }

  function closeConnection() {
    if (connection) {
      try {
        connection.end();
      } catch (err) {
        log.warn(`imap-idle: error closing connection: ${err.message}`);
      }
      connection = null;
    }
  }

  return {
    async start(handler) {
      if (state !== STATE.DISCONNECTED) {
        log.warn('imap-idle: already started or starting');
        return;
      }

      mailHandler = handler;
      const success = await _connectAndStartIdle();

      if (!success && state === STATE.DISCONNECTED) {
        log.warn('imap-idle: initial connection failed, will retry...');
        _scheduleReconnect();
      }
    },

    stop() {
      log.info('imap-idle: stopping listener...');

      // Clear any pending reconnect
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }

      // Close connection gracefully
      if (connection) {
        try {
          const imapConn = getUnderlyingImap(connection);
          if (imapConn.state === 'idle') {
            // Exit IDLE mode before closing
            imapConn.closebox((err) => {
              if (err) log.warn(`imap-idle: error closing mailbox: ${err.message}`);
            });
          }
        } catch (err) {
          log.warn(`imap-idle: error exiting IDLE: ${err.message}`);
        }

        closeConnection();
      }

      setState(STATE.DISCONNECTED);
      mailHandler = null;
      log.info('imap-idle: listener stopped');
    },

    isConnected() {
      return state === STATE.IDLE_ACTIVE;
    },

    getState() {
      return state;
    },
  };
}

module.exports = {
  createIdleListener,
  STATE,
};
