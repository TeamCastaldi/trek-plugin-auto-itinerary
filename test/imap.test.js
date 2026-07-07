const test = require('node:test');
const assert = require('node:assert/strict');
const { markProcessed, searchUnseen } = require('../src/imap');

function fakeMessage({ uid, from, messageId, source }) {
  return {
    attributes: { uid },
    parts: [
      { which: 'HEADER', body: { from: [from], 'message-id': [messageId] } },
      { which: '', body: source },
    ],
  };
}

test('searchUnseen extracts the Message-Id header alongside uid and raw source', async () => {
  const connection = {
    search: async () => [
      fakeMessage({ uid: 1, from: 'traveler@example.com', messageId: '<abc@mail>', source: 'RAW1' }),
    ],
  };

  const results = await searchUnseen(connection, {});

  assert.deepEqual(results, [{ uid: 1, source: 'RAW1', messageId: '<abc@mail>' }]);
});

test('searchUnseen still applies the sender allowlist filter', async () => {
  const connection = {
    search: async () => [
      fakeMessage({ uid: 1, from: 'traveler@example.com', messageId: '<a>', source: 'RAW1' }),
      fakeMessage({ uid: 2, from: 'spam@other.com', messageId: '<b>', source: 'RAW2' }),
    ],
  };

  const results = await searchUnseen(connection, { sender_allowlist: 'traveler@example.com' });

  assert.deepEqual(results, [{ uid: 1, source: 'RAW1', messageId: '<a>' }]);
});

function fakeLog() {
  const warnings = [];
  return { warn: (msg) => warnings.push(msg), warnings };
}

test('markProcessed marks \\Seen and does not move when no processed_folder is configured', async () => {
  const calls = [];
  const connection = {
    addFlags: async (uid, flag) => calls.push(['addFlags', uid, flag]),
    moveMessage: async (uid, folder) => calls.push(['moveMessage', uid, folder]),
  };

  await markProcessed(connection, {}, 42, fakeLog());

  assert.deepEqual(calls, [['addFlags', 42, '\\Seen']]);
});

test('markProcessed moves to the configured processed folder after marking \\Seen', async () => {
  const calls = [];
  const connection = {
    addFlags: async (uid, flag) => calls.push(['addFlags', uid, flag]),
    moveMessage: async (uid, folder) => calls.push(['moveMessage', uid, folder]),
  };

  await markProcessed(connection, { processed_folder: 'Processed' }, 7, fakeLog());

  assert.deepEqual(calls, [
    ['addFlags', 7, '\\Seen'],
    ['moveMessage', 7, 'Processed'],
  ]);
});

test('markProcessed is best-effort: a failure logs a warning and does not throw', async () => {
  const connection = {
    addFlags: async () => {
      throw new Error('IMAP connection reset');
    },
    moveMessage: async () => {},
  };
  const log = fakeLog();

  await markProcessed(connection, {}, 1, log);

  assert.equal(log.warnings.length, 1);
  assert.match(log.warnings[0], /IMAP connection reset/);
});

test('markProcessed with no log argument still swallows failures silently', async () => {
  const connection = {
    addFlags: async () => {
      throw new Error('boom');
    },
  };

  await assert.doesNotReject(markProcessed(connection, {}, 1));
});
