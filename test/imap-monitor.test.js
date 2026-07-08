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

  await shutdownIdleMonitor();
  const connected = isIdleConnected();
  assert.strictEqual(connected, false, 'Should return false when not initialized');
});

test('IMAP Monitor getIdleState returns null when not initialized', async (t) => {
  const { getIdleState, shutdownIdleMonitor } = require('../src/imap-monitor');

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

test('IMAP Monitor requires valid processMessageFn', async (t) => {
  const { initializeIdleMonitor, shutdownIdleMonitor } = require('../src/imap-monitor');

  await shutdownIdleMonitor();

  const mockCtx = {
    config: { imap_host: 'test.example.com', imap_port: 993 },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    db: { migrate: async () => {} },
  };

  // Should throw when processMessageFn is not provided
  try {
    await initializeIdleMonitor(mockCtx, null);
    assert.fail('Should have thrown for missing processMessageFn');
  } catch (err) {
    assert.ok(err.message.includes('processMessageFn'), 'Should mention processMessageFn');
  }

  await shutdownIdleMonitor();
});

test('IMAP Monitor initialize and shutdown with dependency injection', async (t) => {
  const { initializeIdleMonitor, shutdownIdleMonitor, getIdleState } = require('../src/imap-monitor');

  await shutdownIdleMonitor();

  const mockCtx = {
    config: { imap_host: 'test.example.com', imap_port: 993 },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    db: { migrate: async () => {} },
  };

  const mockProcessMessage = async () => {};

  // Create a fake listener that tracks calls
  let listenerStarted = false;
  const fakeListener = {
    start: async () => { listenerStarted = true; },
    stop: () => {},
    isConnected: () => true,
    getState: () => 'idle_active',
  };

  const deps = {
    createIdleListenerFn: () => fakeListener,
  };

  // Initialize with fake listener
  await initializeIdleMonitor(mockCtx, mockProcessMessage, deps);

  assert.strictEqual(listenerStarted, true, 'Fake listener start() should have been called');

  const state = getIdleState();
  assert.strictEqual(state, 'idle_active', 'Should return listener state');

  await shutdownIdleMonitor();

  assert.strictEqual(getIdleState(), null, 'State should be null after shutdown');
});

test('IMAP Monitor prevents double initialization', async (t) => {
  const { initializeIdleMonitor, shutdownIdleMonitor } = require('../src/imap-monitor');

  await shutdownIdleMonitor();

  const logs = [];
  const mockCtx = {
    config: { imap_host: 'test.example.com', imap_port: 993 },
    log: {
      info: (msg) => logs.push(msg),
      warn: (msg) => logs.push(msg),
      error: (msg) => logs.push(msg),
    },
    db: { migrate: async () => {} },
  };

  const mockProcessMessage = async () => {};

  const fakeListener = {
    start: async () => {},
    stop: () => {},
    isConnected: () => false,
    getState: () => 'disconnected',
  };

  const deps = {
    createIdleListenerFn: () => fakeListener,
  };

  // First init
  await initializeIdleMonitor(mockCtx, mockProcessMessage, deps);

  const logsBefore = logs.length;

  // Second init should warn
  await initializeIdleMonitor(mockCtx, mockProcessMessage, deps);

  const newLogs = logs.slice(logsBefore);
  assert.ok(newLogs.some((m) => m.includes('already initialized')), 'Should warn on double init');

  await shutdownIdleMonitor();
});

test('IMAP Monitor mail handler guards against concurrent invocations', async (t) => {
  const { initializeIdleMonitor, shutdownIdleMonitor } = require('../src/imap-monitor');

  await shutdownIdleMonitor();

  let processMessageCallCount = 0;
  const mockCtx = {
    config: { imap_host: 'test.example.com', imap_port: 993 },
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    db: { migrate: async () => {} },
  };

  // Track mail handler calls
  let capturedMailHandler = null;
  const fakeListener = {
    start: async (handler) => {
      capturedMailHandler = handler;
    },
    stop: () => {},
    isConnected: () => false,
    getState: () => 'disconnected',
  };

  const mockProcessMessage = async () => {
    processMessageCallCount++;
    // Simulate slow processing
    await new Promise((resolve) => setTimeout(resolve, 50));
  };

  const deps = {
    createIdleListenerFn: () => fakeListener,
  };

  await initializeIdleMonitor(mockCtx, mockProcessMessage, deps);

  // Simulate concurrent mail events
  if (capturedMailHandler) {
    const p1 = capturedMailHandler();
    const p2 = capturedMailHandler(); // Should be guarded

    await Promise.all([p1, p2]);

    // Only one should have completed due to guard
    assert.strictEqual(processMessageCallCount, 1, 'Should have processed only once due to guard');
  }

  await shutdownIdleMonitor();
});
