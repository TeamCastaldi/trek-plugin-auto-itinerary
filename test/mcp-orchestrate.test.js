const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEvents } = require('../src/parse');
const { classifyEvent } = require('../src/classify');
const { filterActiveEvents, buildTripForMessage } = require('../src/mcp/orchestrate');

const loadClassifiedEvents = (name) => {
  const ics = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  return parseEvents(ics).map((event) => classifyEvent(event));
};

function fakeSession({ toolsMap = new Map(), results = {}, onCall } = {}) {
  const calls = [];
  return {
    calls,
    listTools: async () => toolsMap,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (onCall) await onCall(name, args);
      if (results[name] === 'reject') {
        throw new Error(`${name} failed`);
      }
      return typeof results[name] === 'function' ? results[name](args) : results[name] || {};
    },
  };
}

test('filterActiveEvents drops a cancelled event', () => {
  const classifiedEvents = loadClassifiedEvents('cancel.ics');
  assert.equal(filterActiveEvents(classifiedEvents).length, 0);
});

test('builds one trip with one transport entry for a single-VEVENT flight invite', async () => {
  const classifiedEvents = loadClassifiedEvents('flight.ics');
  const session = fakeSession({
    results: {
      create_trip: { tripId: 'trip_1' },
      create_and_assign_place: { placeId: 'place_1' },
      create_transport: {},
    },
  });

  const result = await buildTripForMessage(session, { uid: 1 }, classifiedEvents, {});

  assert.equal(result.tripId, 'trip_1');
  assert.equal(result.entityCount, 1);
  assert.equal(result.shareUrl, null);
  assert.deepEqual(
    session.calls.map((c) => c.name),
    ['create_trip', 'create_and_assign_place', 'create_transport']
  );
  assert.equal(session.calls[2].args.type, 'flight');
  assert.equal(session.calls[2].args.place_id, 'place_1');
});

test('folds a multi-VEVENT message into exactly one trip, sharing the trip id across sub-calls', async () => {
  const classifiedEvents = loadClassifiedEvents('multi-vevent.ics');
  const session = fakeSession({
    results: {
      create_trip: { tripId: 'trip_multi' },
      create_and_assign_place: { placeId: 'place_x' },
      create_transport: {},
      create_accommodation: {},
    },
  });

  const result = await buildTripForMessage(session, { uid: 2 }, classifiedEvents, {});

  const tripCalls = session.calls.filter((c) => c.name === 'create_trip');
  assert.equal(tripCalls.length, 1);
  assert.equal(result.entityCount, 2);

  const transportCall = session.calls.find((c) => c.name === 'create_transport');
  const accommodationCall = session.calls.find((c) => c.name === 'create_accommodation');
  assert.equal(transportCall.args.trip_id, 'trip_multi');
  assert.equal(accommodationCall.args.trip_id, 'trip_multi');
});

test('calls create_share_link when auto_share is yes', async () => {
  const classifiedEvents = loadClassifiedEvents('train.ics');
  const session = fakeSession({
    results: {
      create_trip: { tripId: 'trip_1' },
      create_and_assign_place: { placeId: 'place_1' },
      create_transport: {},
      create_share_link: { url: 'https://trek.example.com/share/abc' },
    },
  });

  const result = await buildTripForMessage(session, { uid: 3 }, classifiedEvents, { auto_share: 'yes' });

  assert.equal(result.shareUrl, 'https://trek.example.com/share/abc');
  assert.ok(session.calls.some((c) => c.name === 'create_share_link'));
});

test('does not call create_share_link when auto_share is not yes', async () => {
  const classifiedEvents = loadClassifiedEvents('generic.ics');
  const session = fakeSession({
    results: {
      create_trip: { tripId: 'trip_1' },
      create_reservation: {},
    },
  });

  const result = await buildTripForMessage(session, { uid: 4 }, classifiedEvents, {});

  assert.equal(result.shareUrl, null);
  assert.ok(!session.calls.some((c) => c.name === 'create_share_link'));
});

test('a mid-sequence failure throws and does not silently continue', async () => {
  const classifiedEvents = loadClassifiedEvents('multi-vevent.ics');
  const session = fakeSession({
    results: {
      create_trip: { tripId: 'trip_1' },
      create_and_assign_place: { placeId: 'place_1' },
      create_transport: {},
      create_accommodation: 'reject',
    },
  });

  await assert.rejects(
    buildTripForMessage(session, { uid: 5 }, classifiedEvents, {}),
    /create_accommodation failed/
  );

  // The earlier calls in the sequence still happened before the failure.
  assert.ok(session.calls.some((c) => c.name === 'create_trip'));
  assert.ok(session.calls.some((c) => c.name === 'create_transport'));
});

test('logs a schema-check warning (not a hard failure) when a guessed field is missing from the live inputSchema', async () => {
  const classifiedEvents = loadClassifiedEvents('generic.ics');
  const toolsMap = new Map([
    ['create_trip', { properties: { some_other_field: {} } }],
    ['create_reservation', { properties: {} }],
  ]);
  const session = fakeSession({
    toolsMap,
    results: { create_trip: { tripId: 'trip_1' }, create_reservation: {} },
  });

  const result = await buildTripForMessage(session, { uid: 6 }, classifiedEvents, {});

  const warnings = result.trace.filter((entry) => entry.step === 'schema-check');
  assert.ok(warnings.length > 0);
  assert.equal(warnings[0].ok, false);
});

test('throws a descriptive error if create_trip does not return a usable trip id', async () => {
  const classifiedEvents = loadClassifiedEvents('generic.ics');
  const session = fakeSession({
    results: { create_trip: { unexpectedField: 'oops' } },
  });

  await assert.rejects(
    buildTripForMessage(session, { uid: 7 }, classifiedEvents, {}),
    /create_trip did not return a usable trip id/
  );
  // No sub-entity calls should have been attempted with an invalid trip id.
  assert.ok(!session.calls.some((c) => c.name === 'create_reservation'));
});

test('buildTripForMessage filters cancelled events itself, even if the caller forgot to pre-filter', async () => {
  const classifiedEvents = loadClassifiedEvents('cancel.ics');
  const session = fakeSession({ results: { create_trip: { tripId: 'trip_1' } } });

  const result = await buildTripForMessage(session, { uid: 8 }, classifiedEvents, {});

  assert.equal(result.tripId, null);
  assert.equal(result.entityCount, 0);
  assert.equal(session.calls.length, 0);
});

test('an existingTripId skips create_trip and reuses the id for sub-entity calls', async () => {
  const classifiedEvents = loadClassifiedEvents('flight.ics');
  const session = fakeSession({
    results: {
      create_and_assign_place: { placeId: 'place_1' },
      create_transport: {},
    },
  });
  const onTripCreated = () => {
    throw new Error('onTripCreated must not fire when resuming an existing trip');
  };

  const result = await buildTripForMessage(session, { uid: 9 }, classifiedEvents, {}, {
    existingTripId: 'trip_resumed',
    onTripCreated,
  });

  assert.equal(result.tripId, 'trip_resumed');
  assert.ok(!session.calls.some((c) => c.name === 'create_trip'));
  assert.equal(session.calls[0].args.trip_id, 'trip_resumed');
});

test('extracts the trip id from the real live { trip: { id, ... } } response shape', async () => {
  // Captured from a live TREK instance (2026-07-07): create_trip nests the full created row
  // under `trip`, not a bare `{ tripId }` as originally guessed.
  const classifiedEvents = loadClassifiedEvents('flight.ics');
  const session = fakeSession({
    results: {
      create_trip: {
        trip: {
          id: 3,
          user_id: 2,
          title: 'Flight UA123 to SFO',
          start_date: '2026-08-01',
          end_date: '2026-08-01',
          currency: 'EUR',
          is_owner: 1,
          owner_username: 'Nathan',
        },
      },
      create_and_assign_place: { place: { id: 7 } },
      create_transport: {},
    },
  });

  const result = await buildTripForMessage(session, { uid: 11 }, classifiedEvents, {});

  assert.equal(result.tripId, 3);
  const transportCall = session.calls.find((c) => c.name === 'create_transport');
  assert.equal(transportCall.args.trip_id, 3);
  assert.equal(transportCall.args.place_id, 7);
});

test('onTripCreated fires exactly once, right after a fresh create_trip succeeds', async () => {
  const classifiedEvents = loadClassifiedEvents('flight.ics');
  const session = fakeSession({
    results: {
      create_trip: { tripId: 'trip_fresh' },
      create_and_assign_place: { placeId: 'place_1' },
      create_transport: {},
    },
  });
  const createdIds = [];

  const result = await buildTripForMessage(session, { uid: 10 }, classifiedEvents, {}, {
    onTripCreated: (tripId) => createdIds.push(tripId),
  });

  assert.equal(result.tripId, 'trip_fresh');
  assert.deepEqual(createdIds, ['trip_fresh']);
});
