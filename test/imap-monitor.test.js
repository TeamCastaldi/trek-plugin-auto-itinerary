const test = require('node:test');
const assert = require('node:assert');

test('IMAP Monitor module exports expected functions', async (t) => {
  const { initializeIdleMonitor, shutdownIdleMonitor, isIdleConnected, getIdleState } = require('../src/imap-monitor');

  assert.strictEqual(typeof initializeIdleMonitor, 'function', 'initializeIdleMonitor should be a function');
  assert.strictEqual(typeof shutdownIdleMonitor, 'function', 'shutdownIdleMonitor should be a function');
  assert.strictEqual(typeof isIdleConnected, 'function', 'isIdleConnected should be a function');
  assert.strictEqual(typeof getIdleState, 'function', 'getIdleState should be a function');
});

test('IMAP Monitor isIdleConnected returns false when not initialized', async (t) => {
  const { isIdleConnected, shutdownIdleMonitor } = require('../src/imap-monitor');

  // Ensure shutdown before test
  await shutdownIdleMonitor();

  const connected = isIdleConnected();
  assert.strictEqual(connected, false, 'Should return false when not initialized');
});

test('IMAP Monitor getIdleState returns null when not initialized', async (t) => {
  const { getIdleState, shutdownIdleMonitor } = require('../src/imap-monitor');

  // Ensure shutdown before test
  await shutdownIdleMonitor();

  const state = getIdleState();
  assert.strictEqual(state, null, 'Should return null when not initialized');
});

test('IMAP Monitor shutdown is idempotent', async (t) => {
  const { shutdownIdleMonitor } = require('../src/imap-monitor');

  // Multiple shutdowns should not throw
  await shutdownIdleMonitor();
  await shutdownIdleMonitor();
  await shutdownIdleMonitor();

  assert.ok(true, 'Should complete without error');
});

test('IMAP Monitor initialize requires processMessage callback', async (t) => {
  const { initializeIdleMonitor, shutdownIdleMonitor } = require('../src/imap-monitor');

  await shutdownIdleMonitor();

  const mockCtx = {
    config: {
      imap_host: 'imap.example.com',
      imap_port: 993,
      imap_user: 'test@example.com',
      imap_password: 'password',
      imap_tls: 'implicit',
      imap_folder: 'INBOX',
    },
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    db: {
      migrate: async () => {},
    },
  };

  const mockProcessMessage = async () => {};

  // Initialize should complete without error
  await initializeIdleMonitor(mockCtx, mockProcessMessage);

  // Verify state changed
  const { getIdleState } = require('../src/imap-monitor');
  const state = getIdleState();
  assert.ok(state !== null, 'Should have a state after initialization');

  await shutdownIdleMonitor();
});

test('IMAP Monitor prevents double initialization', async (t) => {
  const { initializeIdleMonitor, shutdownIdleMonitor } = require('../src/imap-monitor');

  await shutdownIdleMonitor();

  const mockCtx = {
    config: {
      imap_host: 'imap.example.com',
      imap_port: 993,
      imap_user: 'test@example.com',
      imap_password: 'password',
      imap_tls: 'implicit',
      imap_folder: 'INBOX',
    },
    log: {
      logs: [],
      info: function (msg) { this.logs.push({ level: 'info', msg }); },
      warn: function (msg) { this.logs.push({ level: 'warn', msg }); },
      error: function (msg) { this.logs.push({ level: 'error', msg }); },
    },
    db: {
      migrate: async () => {},
    },
  };

  const mockProcessMessage = async () => {};

  // First init should succeed
  await initializeIdleMonitor(mockCtx, mockProcessMessage);

  const logsBefore = mockCtx.log.logs.length;

  // Second init should warn
  await initializeIdleMonitor(mockCtx, mockProcessMessage);

  const newLogs = mockCtx.log.logs.slice(logsBefore);
  const warnMsg = newLogs.find((l) => l.level === 'warn');

  assert.ok(warnMsg && warnMsg.msg.includes('already initialized'), 'Should warn on double initialization');

  await shutdownIdleMonitor();
});
