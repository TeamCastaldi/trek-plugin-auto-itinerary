const test = require('node:test');
const assert = require('node:assert');
const { createIdleListener, STATE } = require('../src/imap-idle');

test('IMAP IDLE module exports expected functions', async (t) => {
  assert.strictEqual(typeof createIdleListener, 'function', 'createIdleListener should be a function');
  assert.ok(STATE, 'STATE should be defined');
  assert.strictEqual(STATE.DISCONNECTED, 'disconnected', 'Should have DISCONNECTED state');
  assert.strictEqual(STATE.CONNECTING, 'connecting', 'Should have CONNECTING state');
  assert.strictEqual(STATE.CONNECTED, 'connected', 'Should have CONNECTED state');
  assert.strictEqual(STATE.IDLE_ACTIVE, 'idle_active', 'Should have IDLE_ACTIVE state');
  assert.strictEqual(STATE.RECONNECTING, 'reconnecting', 'Should have RECONNECTING state');
});

test('IMAP IDLE listener has required methods', async (t) => {
  const mockLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const mockConfig = {
    imap_host: 'imap.example.com',
    imap_port: 993,
    imap_user: 'test@example.com',
    imap_password: 'password',
    imap_tls: 'implicit',
    imap_folder: 'INBOX',
  };

  const mockCallbacks = {
    onMail: null,
    onError: null,
  };

  const listener = createIdleListener(mockConfig, mockCallbacks, mockLog);

  assert.strictEqual(typeof listener.start, 'function', 'Should have start method');
  assert.strictEqual(typeof listener.stop, 'function', 'Should have stop method');
  assert.strictEqual(typeof listener.isConnected, 'function', 'Should have isConnected method');
  assert.strictEqual(typeof listener.getState, 'function', 'Should have getState method');

  // Verify initial state
  assert.strictEqual(listener.getState(), 'disconnected', 'Should start in disconnected state');
  assert.strictEqual(listener.isConnected(), false, 'Should not be connected initially');
});

test('IMAP IDLE listener state transitions on stop', async (t) => {
  const mockLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const mockConfig = {
    imap_host: 'imap.example.com',
    imap_port: 993,
    imap_user: 'test@example.com',
    imap_password: 'password',
    imap_tls: 'implicit',
    imap_folder: 'INBOX',
  };

  const mockCallbacks = {};
  const listener = createIdleListener(mockConfig, mockCallbacks, mockLog);

  // Initial state should be disconnected
  assert.strictEqual(listener.getState(), STATE.DISCONNECTED);

  // Calling stop should keep it disconnected
  listener.stop();
  assert.strictEqual(listener.getState(), STATE.DISCONNECTED);
  assert.strictEqual(listener.isConnected(), false);
});

test('IMAP IDLE listener logs state transitions', async (t) => {
  const logs = [];
  const mockLog = {
    info: (msg) => logs.push({ level: 'info', msg }),
    warn: (msg) => logs.push({ level: 'warn', msg }),
    error: (msg) => logs.push({ level: 'error', msg }),
  };

  const mockConfig = {
    imap_host: 'imap.example.com',
    imap_port: 993,
    imap_user: 'test@example.com',
    imap_password: 'password',
    imap_tls: 'implicit',
    imap_folder: 'INBOX',
  };

  const mockCallbacks = {};
  const listener = createIdleListener(mockConfig, mockCallbacks, mockLog);

  // Start listener (will fail to connect but should log attempts)
  await listener.start(async () => {});

  // Stop listener (to clean up any pending timeouts)
  listener.stop();

  // Verify logs exist
  assert.ok(logs.length > 0, 'Should have logged messages');

  // Check for key messages
  const infoLogs = logs.filter((l) => l.level === 'info').map((l) => l.msg);
  assert.ok(infoLogs.some((m) => m.includes('opening connection')), 'Should log connection attempt');
});

test('IMAP IDLE listener handles reconnect gracefully', async (t) => {
  const logs = [];
  const mockLog = {
    info: (msg) => logs.push({ level: 'info', msg }),
    warn: (msg) => logs.push({ level: 'warn', msg }),
    error: (msg) => logs.push({ level: 'error', msg }),
  };

  const mockConfig = {
    imap_host: 'imap.example.com',
    imap_port: 993,
    imap_user: 'test@example.com',
    imap_password: 'password',
    imap_tls: 'implicit',
    imap_folder: 'INBOX',
  };

  const mockCallbacks = {};
  const listener = createIdleListener(mockConfig, mockCallbacks, mockLog);

  // Start listener (will fail but should schedule reconnect)
  await listener.start(async () => {});

  // Wait briefly for potential reconnect scheduling
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Stop to clean up any pending timeouts
  listener.stop();

  // Verify no errors thrown and state is clean
  assert.strictEqual(listener.getState(), STATE.DISCONNECTED);
});

test('IMAP IDLE listener cleanly stops multiple times', async (t) => {
  const mockLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const mockConfig = {
    imap_host: 'imap.example.com',
    imap_port: 993,
    imap_user: 'test@example.com',
    imap_password: 'password',
    imap_tls: 'implicit',
    imap_folder: 'INBOX',
  };

  const listener = createIdleListener(mockConfig, {}, mockLog);

  // Multiple stops should not throw
  listener.stop();
  listener.stop();
  listener.stop();

  assert.strictEqual(listener.getState(), STATE.DISCONNECTED);
});
