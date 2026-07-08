const test = require('node:test');
const assert = require('node:assert');
const { createIdleListener, STATE } = require('../src/imap-idle');

// Create a fake IMAP connection for testing
function createFakeImapConnection() {
  const listeners = {};
  return {
    imap: {
      serverCapabilities: ['IDLE', 'APPEND'],
      state: 'authenticated',
      on: (event, handler) => {
        listeners[event] = handler;
      },
      idle: (cb) => {
        process.nextTick(() => cb(null));
      },
      idleDone: (cb) => {
        process.nextTick(() => cb(null));
      },
    },
    openBox: async () => {},
    end: () => {},
    listeners,
  };
}

// Stub dependencies for testing
function createTestDeps() {
  return {
    openConnectionFn: async () => createFakeImapConnection(),
    getUnderlyingImapFn: (conn) => conn.imap,
  };
}

test('IMAP IDLE module exports expected functions', async (t) => {
  assert.strictEqual(typeof createIdleListener, 'function', 'createIdleListener should be a function');
  assert.ok(STATE, 'STATE should be defined');
  assert.strictEqual(STATE.DISCONNECTED, 'disconnected', 'Should have DISCONNECTED state');
  assert.strictEqual(STATE.CONNECTING, 'connecting', 'Should have CONNECTING state');
  assert.strictEqual(STATE.IDLE_ACTIVE, 'idle_active', 'Should have IDLE_ACTIVE state');
});

test('IMAP IDLE listener has required methods', async (t) => {
  const mockLog = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  const mockConfig = {
    imap_host: 'test.example.com',
    imap_port: 993,
    imap_user: 'test@example.com',
    imap_password: 'password',
    imap_tls: 'implicit',
    imap_folder: 'INBOX',
  };

  const deps = createTestDeps();
  const listener = createIdleListener(mockConfig, {}, mockLog, deps);

  assert.strictEqual(typeof listener.start, 'function', 'Should have start method');
  assert.strictEqual(typeof listener.stop, 'function', 'Should have stop method');
  assert.strictEqual(typeof listener.isConnected, 'function', 'Should have isConnected method');
  assert.strictEqual(typeof listener.getState, 'function', 'Should have getState method');

  // Verify initial state
  assert.strictEqual(listener.getState(), 'disconnected', 'Should start in disconnected state');
  assert.strictEqual(listener.isConnected(), false, 'Should not be connected initially');
});

test('IMAP IDLE listener successfully connects with IDLE capability', async (t) => {
  const mockLog = {
    logs: [],
    info: function (msg) { this.logs.push(msg); },
    warn: function (msg) { this.logs.push(msg); },
    error: function (msg) { this.logs.push(msg); },
  };

  const mockConfig = { imap_host: 'test.example.com', imap_port: 993, imap_user: 'test@example.com', imap_password: 'password', imap_tls: 'implicit', imap_folder: 'INBOX' };

  const deps = createTestDeps();
  const listener = createIdleListener(mockConfig, {}, mockLog, deps);

  await listener.start(async () => {});

  assert.strictEqual(listener.isConnected(), true, 'Should be connected after successful start');
  assert.ok(mockLog.logs.some((m) => m.includes('opening connection')), 'Should log connection');

  listener.stop();
  assert.strictEqual(listener.isConnected(), false, 'Should not be connected after stop');
});

test('IMAP IDLE listener handles missing IDLE capability', async (t) => {
  const mockLog = {
    logs: [],
    info: function (msg) { this.logs.push(msg); },
    warn: function (msg) { this.logs.push(msg); },
    error: function (msg) { this.logs.push(msg); },
  };

  const mockConfig = { imap_host: 'test.example.com', imap_port: 993, imap_user: 'test@example.com', imap_password: 'password', imap_tls: 'implicit', imap_folder: 'INBOX' };

  // Override deps to return connection without IDLE capability
  const deps = {
    openConnectionFn: async () => {
      const conn = createFakeImapConnection();
      conn.imap.serverCapabilities = ['APPEND']; // No IDLE
      return conn;
    },
    getUnderlyingImapFn: (conn) => conn.imap,
  };

  const listener = createIdleListener(mockConfig, {}, mockLog, deps);

  await listener.start(async () => {});

  // Should not be connected since IDLE is unavailable
  assert.strictEqual(listener.isConnected(), false);
  assert.ok(mockLog.logs.some((m) => m.includes('does not support IDLE')), 'Should log IDLE not supported');

  listener.stop();
});

test('IMAP IDLE listener reconnects on connection failure', async (t) => {
  const mockLog = {
    logs: [],
    info: function (msg) { this.logs.push(msg); },
    warn: function (msg) { this.logs.push(msg); },
    error: function (msg) { this.logs.push(msg); },
  };

  const mockConfig = { imap_host: 'test.example.com', imap_port: 993, imap_user: 'test@example.com', imap_password: 'password', imap_tls: 'implicit', imap_folder: 'INBOX' };

  // Override deps to fail on first attempt
  let attemptCount = 0;
  const deps = {
    openConnectionFn: async () => {
      attemptCount++;
      if (attemptCount === 1) throw new Error('Connection refused');
      return createFakeImapConnection();
    },
    getUnderlyingImapFn: (conn) => conn.imap,
  };

  const listener = createIdleListener(mockConfig, {}, mockLog, deps);

  await listener.start(async () => {});

  // Should be reconnecting after initial failure
  assert.ok([STATE.RECONNECTING, STATE.DISCONNECTED].includes(listener.getState()), 'Should be reconnecting or disconnected');

  listener.stop();
});

test('IMAP IDLE listener stop clears state cleanly', async (t) => {
  const mockLog = { info: () => {}, warn: () => {}, error: () => {} };
  const mockConfig = { imap_host: 'test.example.com', imap_port: 993, imap_user: 'test@example.com', imap_password: 'password', imap_tls: 'implicit', imap_folder: 'INBOX' };

  const deps = createTestDeps();
  const listener = createIdleListener(mockConfig, {}, mockLog, deps);

  // Multiple stops should not throw
  listener.stop();
  listener.stop();
  listener.stop();

  assert.strictEqual(listener.getState(), STATE.DISCONNECTED);
  assert.strictEqual(listener.isConnected(), false);
});
