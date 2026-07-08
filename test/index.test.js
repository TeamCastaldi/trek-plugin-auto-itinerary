const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { processMessage } = require('../src/index');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

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

/**
 * A minimal Resend `email.received` payload. `processMessage` calls the real `extractCalendar`,
 * which fetches attachment content over `fetch` — `stubResendFetch` below stubs that out to return
 * whichever `.ics` fixture text the test cares about, so these ledger/orchestration state-machine
 * tests don't need to re-mock the Resend attachment-fetch path (covered separately in
 * test/extract.test.js).
 */
function webhookPayload({ emailId = 'email_1' } = {}) {
  return {
    type: 'email.received',
    data: {
      email_id: emailId,
      from: 'reservations@example.com',
      to: ['family-inbox@example.com'],
      subject: 'Booking',
      headers: { 'message-id': `<${emailId}@resend.dev>` },
      attachments: [{ id: 'att_1', filename: 'invite.ics', content_type: 'text/calendar' }],
    },
  };
}

function stubResendFetch(t) {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url) => {
    if (typeof url === 'string' && url.includes('/attachments/')) {
      return new Response(JSON.stringify({ download_url: 'https://files.example.com/att_1' }), { status: 200 });
    }
    if (url === 'https://files.example.com/att_1') {
      return new Response(stubResendFetch.currentIcsText, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

test('a brand-new invite builds a trip and marks the ledger done', async (t) => {
  const ctx = fakeCtx();
  const deps = fakeDeps({ tripId: 'trip_new' });
  stubResendFetch(t);
  stubResendFetch.currentIcsText = GENERIC_ICS;

  const result = await processMessage(ctx, webhookPayload(), deps);

  assert.equal(result.ok, true);
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].existingTripId, null);
  const [row] = [...ctx._rows.values()];
  assert.equal(row.status, 'done');
  assert.equal(row.trip_id, 'trip_new');
});

test('re-delivering an unchanged already-done invite is a no-op: no new MCP calls', async (t) => {
  const ctx = fakeCtx();
  const deps = fakeDeps({ tripId: 'trip_done' });
  stubResendFetch(t);
  stubResendFetch.currentIcsText = GENERIC_ICS;
  const payload = webhookPayload();

  await processMessage(ctx, payload, deps);
  await processMessage(ctx, payload, deps);

  assert.equal(deps.calls.length, 1, 'buildTripForMessage should only be called once');
});

test('a sequence-bumped re-send logs a warning and does not call the MCP builder again', async (t) => {
  const ctx = fakeCtx();
  const deps = fakeDeps({ tripId: 'trip_done' });
  stubResendFetch(t);
  stubResendFetch.currentIcsText = GENERIC_ICS;
  await processMessage(ctx, webhookPayload({ emailId: 'email_1' }), deps);

  const bumpedIcs = GENERIC_ICS.replace('SEQUENCE:0', 'SEQUENCE:1');
  stubResendFetch.currentIcsText = bumpedIcs;
  await processMessage(ctx, webhookPayload({ emailId: 'email_2' }), deps);

  assert.equal(deps.calls.length, 1, 'no new create_trip/build call on a detected update');
  assert.ok(ctx.logs.warn.some((m) => /re-sent with changed content\/sequence/.test(m)));
});

test('an all-cancelled invite after a prior done trip marks the ledger cancelled', async (t) => {
  const ctx = fakeCtx();
  const deps = fakeDeps({ tripId: 'trip_done' });
  stubResendFetch(t);
  stubResendFetch.currentIcsText = GENERIC_ICS;

  await processMessage(ctx, webhookPayload({ emailId: 'email_1' }), deps);

  const cancelledOfSameUid = CANCEL_ICS.replace(
    'flight-abc123@testairlines.com',
    'dinner-reservation-42@thebistro.com'
  );
  stubResendFetch.currentIcsText = cancelledOfSameUid;
  await processMessage(ctx, webhookPayload({ emailId: 'email_2' }), deps);

  const [row] = [...ctx._rows.values()];
  assert.equal(row.status, 'cancelled');
  assert.equal(deps.calls.length, 1, 'cancellation of an existing trip does not call the MCP builder');
});

test('an all-cancelled invite with no prior trip is skipped without creating a ledger row', async (t) => {
  const ctx = fakeCtx();
  const deps = fakeDeps();
  stubResendFetch(t);
  stubResendFetch.currentIcsText = CANCEL_ICS;

  await processMessage(ctx, webhookPayload(), deps);

  assert.equal(deps.calls.length, 0);
  assert.equal(ctx._rows.size, 0);
});

test('a stale in_progress row with a stored trip_id resumes without calling create_trip again', async (t) => {
  const ctx = fakeCtx();
  await ctx.db.exec(
    `INSERT INTO processed_invites (uid, message_id, sequence, status, payload_hash, updated_at) VALUES (?, ?, ?, 'in_progress', ?, datetime('now'))`,
    ['dinner-reservation-42@thebistro.com', '<prior>', 0, 'stale-hash']
  );
  await ctx.db.exec(`UPDATE processed_invites SET trip_id = ? WHERE uid = ?`, [
    'trip_partial',
    'dinner-reservation-42@thebistro.com',
  ]);

  const deps = fakeDeps();
  stubResendFetch(t);
  stubResendFetch.currentIcsText = GENERIC_ICS;

  await processMessage(ctx, webhookPayload(), deps);

  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].existingTripId, 'trip_partial');
  const [row] = [...ctx._rows.values()];
  assert.equal(row.status, 'done');
  assert.equal(row.trip_id, 'trip_partial');
});

test('a build failure marks the ledger error and reports ok:false so the route can 500 (Resend retries)', async (t) => {
  const ctx = fakeCtx();
  const deps = {
    createSession: async () => ({ fake: true }),
    buildTripForMessage: async () => {
      throw new Error('create_trip failed');
    },
  };
  stubResendFetch(t);
  stubResendFetch.currentIcsText = GENERIC_ICS;

  const result = await processMessage(ctx, webhookPayload(), deps);

  assert.equal(result.ok, false);
  const [row] = [...ctx._rows.values()];
  assert.equal(row.status, 'error');
  assert.ok(ctx.logs.error.some((m) => /will retry on next Resend delivery/.test(m)));
});
