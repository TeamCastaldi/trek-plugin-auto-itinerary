const test = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../src/ledger');

/**
 * A minimal SQLite-ish fake for `ctx.db.query`/`ctx.db.exec` backed by an in-memory Map, just
 * enough to exercise src/ledger.js's actual SQL. Not a real SQL engine — parses only the specific
 * statement shapes ledger.js issues.
 */
function fakeCtx() {
  const rows = new Map();

  return {
    db: {
      async query(sql, params) {
        assert.match(sql, /SELECT \* FROM processed_invites WHERE uid = \?/);
        const row = rows.get(params[0]);
        return row ? [{ ...row }] : [];
      },
      async exec(sql, params) {
        if (sql.includes('INSERT INTO processed_invites')) {
          const [uid, messageId, sequence, payloadHash] = params;
          const existing = rows.get(uid);
          rows.set(uid, {
            uid,
            message_id: messageId,
            sequence,
            trip_id: existing ? existing.trip_id : null,
            share_url: existing ? existing.share_url : null,
            status: 'in_progress',
            payload_hash: payloadHash,
            created_at: existing ? existing.created_at : 'now',
          });
        } else if (sql.includes('SET trip_id = ?')) {
          const [tripId, uid] = params;
          rows.set(uid, { ...rows.get(uid), trip_id: tripId });
        } else if (sql.includes("status = 'done'")) {
          const [tripId, shareUrl, sequence, payloadHash, uid] = params;
          const row = rows.get(uid);
          rows.set(uid, {
            ...row,
            status: 'done',
            trip_id: tripId ?? row.trip_id,
            share_url: shareUrl ?? row.share_url,
            sequence: sequence ?? row.sequence,
            payload_hash: payloadHash ?? row.payload_hash,
          });
        } else if (sql.includes("status = 'cancelled'")) {
          const [uid] = params;
          rows.set(uid, { ...rows.get(uid), status: 'cancelled' });
        } else if (sql.includes("status = 'error'")) {
          const [uid] = params;
          rows.set(uid, { ...rows.get(uid), status: 'error' });
        } else {
          throw new Error(`fakeCtx: unrecognized SQL: ${sql}`);
        }
      },
    },
  };
}

test('beginProcessing -> recordTripCreated -> markDone round-trip', async () => {
  const ctx = fakeCtx();

  await ledger.beginProcessing(ctx, {
    uid: 'evt-1',
    messageId: '<msg-1>',
    sequence: 0,
    payloadHash: 'hash-1',
  });
  let entry = await ledger.getEntry(ctx, 'evt-1');
  assert.equal(entry.status, 'in_progress');
  assert.equal(entry.trip_id, null);

  await ledger.recordTripCreated(ctx, 'evt-1', 'trip_1');
  entry = await ledger.getEntry(ctx, 'evt-1');
  assert.equal(entry.trip_id, 'trip_1');
  assert.equal(entry.status, 'in_progress');

  await ledger.markDone(ctx, 'evt-1', { tripId: 'trip_1', shareUrl: 'https://example.com/s' });
  entry = await ledger.getEntry(ctx, 'evt-1');
  assert.equal(entry.status, 'done');
  assert.equal(entry.share_url, 'https://example.com/s');
});

test('beginProcessing on an existing in_progress row preserves trip_id (crash-recovery resume)', async () => {
  const ctx = fakeCtx();

  await ledger.beginProcessing(ctx, {
    uid: 'evt-2',
    messageId: '<msg-2>',
    sequence: 0,
    payloadHash: 'hash-a',
  });
  await ledger.recordTripCreated(ctx, 'evt-2', 'trip_partial');

  // Simulates a second poll finding the row still in_progress after a crash.
  await ledger.beginProcessing(ctx, {
    uid: 'evt-2',
    messageId: '<msg-2>',
    sequence: 0,
    payloadHash: 'hash-a',
  });

  const entry = await ledger.getEntry(ctx, 'evt-2');
  assert.equal(entry.trip_id, 'trip_partial');
  assert.equal(entry.status, 'in_progress');
});

test('markCancelled and markError transition status without touching trip_id', async () => {
  const ctx = fakeCtx();

  await ledger.beginProcessing(ctx, { uid: 'evt-3', messageId: null, sequence: 0, payloadHash: 'h' });
  await ledger.recordTripCreated(ctx, 'evt-3', 'trip_3');

  await ledger.markCancelled(ctx, 'evt-3');
  let entry = await ledger.getEntry(ctx, 'evt-3');
  assert.equal(entry.status, 'cancelled');
  assert.equal(entry.trip_id, 'trip_3');

  await ledger.markError(ctx, 'evt-3');
  entry = await ledger.getEntry(ctx, 'evt-3');
  assert.equal(entry.status, 'error');
  assert.equal(entry.trip_id, 'trip_3');
});

test('getEntry returns null for an unknown uid', async () => {
  const ctx = fakeCtx();
  assert.equal(await ledger.getEntry(ctx, 'nope'), null);
});

test('computePayloadHash is stable for identical events and changes when a field changes', () => {
  const baseEvent = {
    uid: 'a@example.com',
    sequence: 0,
    summary: 'Flight to Denver',
    location: 'DEN',
    description: 'PNR: ABC',
    start: new Date('2026-08-05T14:00:00Z'),
    end: new Date('2026-08-05T16:00:00Z'),
  };
  const activeEvents = [{ type: 'flight', event: baseEvent }];

  const hash1 = ledger.computePayloadHash(activeEvents);
  const hash2 = ledger.computePayloadHash([{ type: 'flight', event: { ...baseEvent } }]);
  assert.equal(hash1, hash2);

  const changed = [{ type: 'flight', event: { ...baseEvent, summary: 'Flight to Boston' } }];
  assert.notEqual(hash1, ledger.computePayloadHash(changed));
});

test('computePayloadHash is order-independent across multiple events', () => {
  const eventA = { uid: 'a@example.com', sequence: 0, summary: 'A', location: '', description: '', start: null, end: null };
  const eventB = { uid: 'b@example.com', sequence: 0, summary: 'B', location: '', description: '', start: null, end: null };

  const hash1 = ledger.computePayloadHash([
    { type: 'reservation', event: eventA },
    { type: 'reservation', event: eventB },
  ]);
  const hash2 = ledger.computePayloadHash([
    { type: 'reservation', event: eventB },
    { type: 'reservation', event: eventA },
  ]);
  assert.equal(hash1, hash2);
});
