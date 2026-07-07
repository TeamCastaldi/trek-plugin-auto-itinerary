const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { processMessage } = require('../src/index');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function rawEmailWithCalendar(icsText) {
  return [
    'From: reservations@example.com',
    'To: family-inbox@example.com',
    'Subject: Booking',
    'MIME-Version: 1.0',
    'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST',
    'Content-Transfer-Encoding: 7bit',
    '',
    icsText,
  ].join('\r\n');
}

const GENERIC_ICS = fixture('generic.ics');
const CANCEL_ICS = fixture('cancel.ics');

function fakeCtx() {
  const rows = new Map();
  const logs = { info: [], warn: [], error: [] };
  return {
    log: {
      info: (m) => logs.info.push(m),
      warn: (m) => logs.warn.push(m),
      error: (m) => logs.error.push(m),
    },
    logs,
    config: {},
    db: {
      async query(sql, params) {
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
          rows.set(params[0], { ...rows.get(params[0]), status: 'cancelled' });
        } else if (sql.includes("status = 'error'")) {
          rows.set(params[0], { ...rows.get(params[0]), status: 'error' });
        } else {
          throw new Error(`fakeCtx: unrecognized SQL: ${sql}`);
        }
      },
    },
    _rows: rows,
  };
}

function fakeConnection() {
  const marked = [];
  return {
    marked,
    addFlags: async (uid) => marked.push(uid),
    moveMessage: async () => {},
  };
}

function fakeDeps({ tripId = 'trip_1', shareUrl = null } = {}) {
  const sessionCalls = [];
  return {
    calls: sessionCalls,
    createSession: async () => ({ fake: true }),
    buildTripForMessage: async (session, message, classifiedEvents, config, opts) => {
      sessionCalls.push({ existingTripId: opts.existingTripId });
      if (opts.existingTripId) {
        return { tripId: opts.existingTripId, shareUrl, entityCount: 1, trace: [] };
      }
      await opts.onTripCreated(tripId);
      return { tripId, shareUrl, entityCount: 1, trace: [] };
    },
  };
}

test('a brand-new invite builds a trip and marks the ledger done + message processed', async () => {
  const ctx = fakeCtx();
  const connection = fakeConnection();
  const deps = fakeDeps({ tripId: 'trip_new' });

  await processMessage(ctx, connection, { uid: 1, source: rawEmailWithCalendar(GENERIC_ICS) }, deps);

  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].existingTripId, null);
  assert.deepEqual(connection.marked, [1]);
  const [row] = [...ctx._rows.values()];
  assert.equal(row.status, 'done');
  assert.equal(row.trip_id, 'trip_new');
});

test('re-polling an unchanged already-done invite is a no-op: no new MCP calls', async () => {
  const ctx = fakeCtx();
  const connection = fakeConnection();
  const deps = fakeDeps({ tripId: 'trip_done' });
  const message = { uid: 1, source: rawEmailWithCalendar(GENERIC_ICS) };

  await processMessage(ctx, connection, message, deps);
  await processMessage(ctx, connection, message, deps);

  assert.equal(deps.calls.length, 1, 'buildTripForMessage should only be called once');
  assert.deepEqual(connection.marked, [1, 1]);
});

test('a sequence-bumped re-send logs a warning and does not call the MCP builder again', async () => {
  const ctx = fakeCtx();
  const connection = fakeConnection();
  const deps = fakeDeps({ tripId: 'trip_done' });
  const message = { uid: 1, source: rawEmailWithCalendar(GENERIC_ICS) };
  await processMessage(ctx, connection, message, deps);

  const bumpedIcs = GENERIC_ICS.replace('SEQUENCE:0', 'SEQUENCE:1');
  await processMessage(ctx, connection, { uid: 2, source: rawEmailWithCalendar(bumpedIcs) }, deps);

  assert.equal(deps.calls.length, 1, 'no new create_trip/build call on a detected update');
  assert.ok(ctx.logs.warn.some((m) => /re-sent with changed content\/sequence/.test(m)));
});

test('an all-cancelled invite after a prior done trip marks the ledger cancelled', async () => {
  const ctx = fakeCtx();
  const connection = fakeConnection();
  const deps = fakeDeps({ tripId: 'trip_done' });

  await processMessage(
    ctx,
    connection,
    { uid: 1, source: rawEmailWithCalendar(GENERIC_ICS) },
    deps
  );

  const cancelledOfSameUid = CANCEL_ICS.replace(
    'flight-abc123@testairlines.com',
    'dinner-reservation-42@thebistro.com'
  );
  await processMessage(ctx, connection, { uid: 2, source: rawEmailWithCalendar(cancelledOfSameUid) }, deps);

  const [row] = [...ctx._rows.values()];
  assert.equal(row.status, 'cancelled');
  assert.equal(deps.calls.length, 1, 'cancellation of an existing trip does not call the MCP builder');
});

test('an all-cancelled invite with no prior trip is skipped without creating a ledger row', async () => {
  const ctx = fakeCtx();
  const connection = fakeConnection();
  const deps = fakeDeps();

  await processMessage(ctx, connection, { uid: 1, source: rawEmailWithCalendar(CANCEL_ICS) }, deps);

  assert.equal(deps.calls.length, 0);
  assert.equal(ctx._rows.size, 0);
  assert.deepEqual(connection.marked, [1]);
});

test('a stale in_progress row with a stored trip_id resumes without calling create_trip again', async () => {
  const ctx = fakeCtx();
  await ctx.db.exec(
    `INSERT INTO processed_invites (uid, message_id, sequence, status, payload_hash, updated_at) VALUES (?, ?, ?, 'in_progress', ?, datetime('now'))`,
    ['dinner-reservation-42@thebistro.com', '<prior>', 0, 'stale-hash']
  );
  await ctx.db.exec(`UPDATE processed_invites SET trip_id = ? WHERE uid = ?`, [
    'trip_partial',
    'dinner-reservation-42@thebistro.com',
  ]);

  const connection = fakeConnection();
  const deps = fakeDeps();

  await processMessage(ctx, connection, { uid: 1, source: rawEmailWithCalendar(GENERIC_ICS) }, deps);

  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].existingTripId, 'trip_partial');
  const [row] = [...ctx._rows.values()];
  assert.equal(row.status, 'done');
  assert.equal(row.trip_id, 'trip_partial');
});

test('a build failure marks the ledger error and leaves the message unprocessed for retry', async () => {
  const ctx = fakeCtx();
  const connection = fakeConnection();
  const deps = {
    createSession: async () => ({ fake: true }),
    buildTripForMessage: async () => {
      throw new Error('create_trip failed');
    },
  };

  await processMessage(ctx, connection, { uid: 1, source: rawEmailWithCalendar(GENERIC_ICS) }, deps);

  const [row] = [...ctx._rows.values()];
  assert.equal(row.status, 'error');
  assert.deepEqual(connection.marked, [], 'message must stay unmarked so it is retried next poll');
  assert.ok(ctx.logs.error.some((m) => /will retry next poll/.test(m)));
});
