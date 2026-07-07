const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEvents } = require('../src/parse');
const { classifyEvent } = require('../src/classify');
const {
  computeTripDateRange,
  transportTypeForClassification,
  buildCreateTripPayload,
  buildCreatePlacePayload,
  buildCreateAccommodationPayload,
  buildCreateTransportPayload,
  buildCreateReservationPayload,
  buildCreateShareLinkPayload,
} = require('../src/mcp/payloads');

const loadEvents = (name) => {
  const ics = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  return parseEvents(ics);
};

test('buildCreateTripPayload uses the title and a day-granularity date range', () => {
  const [event] = loadEvents('flight.ics');
  const payload = buildCreateTripPayload({
    title: event.summary,
    startDate: event.start,
    endDate: event.end,
  });

  assert.equal(payload.title, 'Flight UA123 to SFO');
  assert.equal(payload.start_date, '2026-08-01');
  assert.equal(payload.end_date, '2026-08-01');
});

test('computeTripDateRange spans multiple VEVENTs in one message', () => {
  const events = loadEvents('multi-vevent.ics');
  const { startDate, endDate } = computeTripDateRange(events);

  assert.equal(startDate.toISOString().slice(0, 10), '2026-08-05');
  assert.equal(endDate.toISOString().slice(0, 10), '2026-08-08');
});

test('buildCreatePlacePayload carries trip id, name, and date', () => {
  const [event] = loadEvents('flight.ics');
  const payload = buildCreatePlacePayload({
    name: event.location,
    tripId: 'trip_1',
    date: event.start,
    allDay: event.allDay,
  });

  assert.equal(payload.trip_id, 'trip_1');
  assert.equal(payload.name, 'San Francisco International Airport');
  assert.equal(payload.date, '2026-08-01T12:00:00.000Z');
});

test('buildCreateAccommodationPayload uses date-only timestamps for an all-day hotel event', () => {
  const [event] = loadEvents('hotel.ics');
  const payload = buildCreateAccommodationPayload({ tripId: 'trip_1', placeId: 'place_1', event });

  assert.equal(payload.title, 'Grand Hotel San Francisco');
  assert.equal(payload.check_in, '2026-08-01');
  assert.equal(payload.check_out, '2026-08-03');
  assert.match(payload.notes, /Confirmation GH-99887/);
});

test('buildCreateTransportPayload maps the classified type to a transport type', () => {
  const [event] = loadEvents('flight.ics');
  const { type } = classifyEvent(event);
  const payload = buildCreateTransportPayload({
    tripId: 'trip_1',
    placeId: 'place_1',
    event,
    transportType: transportTypeForClassification(type),
  });

  assert.equal(payload.type, 'flight');
  assert.equal(payload.departure_time, '2026-08-01T12:00:00.000Z');
  assert.equal(payload.arrival_time, '2026-08-01T14:00:00.000Z');
});

test('buildCreateReservationPayload is the generic fallback shape', () => {
  const [event] = loadEvents('generic.ics');
  const payload = buildCreateReservationPayload({ tripId: 'trip_1', placeId: 'place_1', event });

  assert.equal(payload.trip_id, 'trip_1');
  assert.equal(payload.title, event.summary);
});

test('buildCreateShareLinkPayload only needs the trip id', () => {
  assert.deepEqual(buildCreateShareLinkPayload({ tripId: 'trip_1' }), { trip_id: 'trip_1' });
});

test('transportTypeForClassification falls back to other for non-transport types', () => {
  assert.equal(transportTypeForClassification('flight'), 'flight');
  assert.equal(transportTypeForClassification('train'), 'train');
  assert.equal(transportTypeForClassification('hotel'), 'other');
  assert.equal(transportTypeForClassification('reservation'), 'other');
});
