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

/** Builds a fake get_trip_summary result: `days` is a flat sibling of `trip`, per the real
 * live shape — pairs are [date, dayId]. */
function daysResult(...pairs) {
  return { days: pairs.map(([date, id]) => ({ id, date })) };
}

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
      get_trip_summary: daysResult(['2026-08-01', 100]),
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
    ['create_trip', 'get_trip_summary', 'create_and_assign_place', 'create_transport']
  );
  const transportCall = session.calls.find((c) => c.name === 'create_transport');
  assert.equal(transportCall.args.type, 'flight');
  assert.equal(transportCall.args.tripId, 'trip_1');
  assert.equal(transportCall.args.start_day_id, 100);
  assert.equal(transportCall.args.place_id, undefined);
});

test('folds a multi-VEVENT message into exactly one trip, sharing the trip id across sub-calls', async () => {
  const classifiedEvents = loadClassifiedEvents('multi-vevent.ics');
  const session = fakeSession({
    results: {
      create_trip: { tripId: 'trip_multi' },
      get_trip_summary: daysResult(
        ['2026-08-05', 1],
        ['2026-08-06', 2],
        ['2026-08-07', 3],
        ['2026-08-08', 4]
      ),
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
  assert.equal(transportCall.args.tripId, 'trip_multi');
  assert.equal(transportCall.args.start_day_id, 1);
  assert.equal(accommodationCall.args.tripId, 'trip_multi');
  // The hotel VEVENT spans the all-day range 2026-08-05..2026-08-08 (DTEND exclusive).
  assert.equal(accommodationCall.args.start_day_id, 1);
  assert.equal(accommodationCall.args.end_day_id, 4);
});

test('calls create_share_link when auto_share is yes', async () => {
  const classifiedEvents = loadClassifiedEvents('train.ics');
  const session = fakeSession({
    results: {
      create_trip: { tripId: 'trip_1' },
      get_trip_summary: daysResult(['2026-08-02', 1]),
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
      get_trip_summary: daysResult(['2026-08-01', 1]),
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
      get_trip_summary: daysResult(
        ['2026-08-05', 1],
        ['2026-08-06', 2],
        ['2026-08-07', 3],
        ['2026-08-08', 4]
      ),
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
    results: {
      create_trip: { tripId: 'trip_1' },
      get_trip_summary: daysResult(['2026-08-01', 1]),
      create_reservation: {},
    },
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

test('throws a descriptive error when an event date has no matching resolved day', async () => {
  const classifiedEvents = loadClassifiedEvents('generic.ics'); // 2026-08-01
  const session = fakeSession({
    results: {
      create_trip: { tripId: 'trip_1' },
      get_trip_summary: daysResult(['2099-01-01', 1]), // deliberately wrong date
    },
  });

  await assert.rejects(
    buildTripForMessage(session, { uid: 12 }, classifiedEvents, {}),
    /no day found on trip trip_1 for date 2026-08-01/
  );
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
      get_trip_summary: daysResult(['2026-08-01', 1]),
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
  assert.ok(session.calls.some((c) => c.name === 'get_trip_summary'));
  const transportCall = session.calls.find((c) => c.name === 'create_transport');
  assert.equal(transportCall.args.tripId, 'trip_resumed');
});

test('extracts the trip id and place id from the real live { <entity>: { id, ... } } response shape', async () => {
  // Captured from a live TREK instance (2026-07-07): create_trip nests the full created row
  // under `trip`, not a bare `{ tripId }` as originally guessed; place/share_link are assumed
  // (not yet verified) to follow the same convention.
  const classifiedEvents = loadClassifiedEvents('hotel.ics');
  const session = fakeSession({
    results: {
      create_trip: {
        trip: {
          id: 3,
          user_id: 2,
          title: 'Flight UA123 to SFO',
          start_date: '2026-08-01',
          end_date: '2026-08-03',
          currency: 'EUR',
          is_owner: 1,
          owner_username: 'Nathan',
        },
      },
      get_trip_summary: daysResult(['2026-08-01', 10], ['2026-08-02', 11], ['2026-08-03', 12]),
      create_and_assign_place: { place: { id: 7 } },
      create_accommodation: {},
    },
  });

  const result = await buildTripForMessage(session, { uid: 11 }, classifiedEvents, {});

  assert.equal(result.tripId, 3);
  const accommodationCall = session.calls.find((c) => c.name === 'create_accommodation');
  assert.equal(accommodationCall.args.tripId, 3);
  assert.equal(accommodationCall.args.place_id, 7);
  assert.equal(accommodationCall.args.start_day_id, 10);
  assert.equal(accommodationCall.args.end_day_id, 12);
});

test('onTripCreated fires exactly once, right after a fresh create_trip succeeds', async () => {
  const classifiedEvents = loadClassifiedEvents('flight.ics');
  const session = fakeSession({
    results: {
      create_trip: { tripId: 'trip_fresh' },
      get_trip_summary: daysResult(['2026-08-01', 1]),
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
