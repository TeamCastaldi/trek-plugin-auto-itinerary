const test = require('node:test');
const assert = require('node:assert/strict');
const { createMockHost } = require('trek-plugin-sdk/testing');
const plugin = require('../src/index');
const { processMessage } = plugin;

test('onLoad succeeds and migrates the ledger schema under the plugin\'s own db:own grant', async () => {
  const { ctx, calls } = createMockHost({ grants: ['db:own'] });

  await plugin.onLoad(ctx);

  assert.ok(calls.some((c) => c.method === 'db.migrate'));
});

test('a ctx call outside the manifest grant set rejects with PERMISSION_DENIED', async () => {
  const { ctx } = createMockHost({ grants: ['db:own'] });

  await assert.rejects(ctx.trips.getById(1, 1), /PERMISSION_DENIED: trips\.getById requires db:read:trips/);
});

test('a job-context trip read (no bound user) rejects with RESOURCE_FORBIDDEN even when granted', async () => {
  const { ctx } = createMockHost({
    grants: ['db:own', 'db:read:trips'],
    trips: { 1: { members: [42], data: { id: 1 } } },
    // No actingUserId set — models a `jobs`/`onLoad` execution context, which has no bound user.
  });

  await assert.rejects(ctx.trips.getById(1), /RESOURCE_FORBIDDEN: this call requires an authenticated user context/);
});

test('processMessage never touches a ctx surface outside db:own, even with a live trip fixture available', async (t) => {
  const { ctx, calls } = createMockHost({
    grants: ['db:own'],
    trips: { 1: { members: [42], data: { id: 1 } } },
  });
  await plugin.onLoad(ctx);
  calls.length = 0;

  const icsText = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'fixtures', 'generic.ics'),
    'utf8'
  );
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = async (url) => {
    if (typeof url === 'string' && url.includes('/attachments/')) {
      return new Response(JSON.stringify({ download_url: 'https://files.example.com/att_1' }), { status: 200 });
    }
    if (url === 'https://files.example.com/att_1') {
      return new Response(icsText, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const webhookPayload = {
    type: 'email.received',
    data: {
      email_id: 'email_1',
      from: 'reservations@example.com',
      to: ['family-inbox@example.com'],
      subject: 'Booking',
      headers: { 'message-id': '<email_1@resend.dev>' },
      attachments: [{ id: 'att_1', filename: 'invite.ics', content_type: 'text/calendar' }],
    },
  };

  await processMessage(ctx, webhookPayload, {
    createSession: async () => ({ fake: true }),
    buildTripForMessage: async (session, message, classifiedEvents, config, opts) => {
      await opts.onTripCreated('trip_1');
      return { tripId: 'trip_1', shareUrl: null, entityCount: 1, trace: [] };
    },
  });

  const untouchedPrefixes = ['trips.', 'places.', 'days.', 'itinerary.', 'costs.', 'packing.', 'files.', 'meta.', 'users.', 'ws.'];
  const offender = calls.find((c) => untouchedPrefixes.some((prefix) => c.method.startsWith(prefix)));
  assert.equal(offender, undefined, `plugin called forbidden ctx surface: ${offender && offender.method}`);
  assert.ok(calls.some((c) => c.method.startsWith('db.')));
});
