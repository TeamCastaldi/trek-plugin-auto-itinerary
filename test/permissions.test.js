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

test('processMessage never touches a ctx surface outside db:own, even with a live trip fixture available', async () => {
  const { ctx, calls } = createMockHost({
    grants: ['db:own'],
    trips: { 1: { members: [42], data: { id: 1 } } },
  });
  await plugin.onLoad(ctx);
  calls.length = 0;

  const connection = { addFlags: async () => {}, moveMessage: async () => {} };
  const icsMessage = {
    uid: 1,
    source: [
      'From: reservations@example.com',
      'To: family-inbox@example.com',
      'Subject: Booking',
      'MIME-Version: 1.0',
      'Content-Type: text/calendar; charset="UTF-8"; method=REQUEST',
      'Content-Transfer-Encoding: 7bit',
      '',
      require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'generic.ics'), 'utf8'),
    ].join('\r\n'),
  };

  await processMessage(ctx, connection, icsMessage, {
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
