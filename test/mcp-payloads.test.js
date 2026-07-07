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

test('buildCreatePlacePayload carries the camelCase trip/day ids and name', () => {
  const [event] = loadEvents('flight.ics');
  const payload = buildCreatePlacePayload({ name: event.location, tripId: 42, dayId: 7 });

  assert.deepEqual(payload, { tripId: 42, dayId: 7, name: 'San Francisco International Airport' });
});

test('buildCreateAccommodationPayload uses snake_case day ids and no title field', () => {
  const [event] = loadEvents('hotel.ics');
  const payload = buildCreateAccommodationPayload({
    tripId: 42,
    placeId: 5,
    startDayId: 10,
    endDayId: 12,
    event,
  });

  assert.equal(payload.tripId, 42);
  assert.equal(payload.place_id, 5);
  assert.equal(payload.start_day_id, 10);
  assert.equal(payload.end_day_id, 12);
  assert.equal(payload.title, undefined);
  // hotel.ics is an all-day event: no time-of-day to report.
  assert.equal(payload.check_in, undefined);
  assert.equal(payload.check_out, undefined);
  assert.match(payload.notes, /Confirmation GH-99887/);
});

test('buildCreateAccommodationPayload reports check_in/check_out as HH:MM for a timed event', () => {
  const [event] = loadEvents('flight.ics'); // not all-day, has real start/end times
  const payload = buildCreateAccommodationPayload({
    tripId: 42,
    placeId: 5,
    startDayId: 10,
    endDayId: 10,
    event,
  });

  assert.equal(payload.check_in, event.start.toISOString().slice(11, 16));
  assert.equal(payload.check_out, event.end.toISOString().slice(11, 16));
});

test('buildCreateTransportPayload maps the classified type and uses reservation_time fields', () => {
  const [event] = loadEvents('flight.ics');
  const { type } = classifyEvent(event);
  const payload = buildCreateTransportPayload({
    tripId: 42,
    startDayId: 10,
    endDayId: 10,
    event,
    transportType: transportTypeForClassification(type),
  });

  assert.equal(payload.tripId, 42);
  assert.equal(payload.type, 'flight');
  assert.equal(payload.start_day_id, 10);
  assert.equal(payload.end_day_id, 10);
  assert.equal(payload.reservation_time, '2026-08-01T12:00:00.000Z');
  assert.equal(payload.reservation_end_time, '2026-08-01T14:00:00.000Z');
  assert.equal(payload.place_id, undefined);
});

test('buildCreateReservationPayload is the generic fallback shape', () => {
  const [event] = loadEvents('generic.ics');
  const payload = buildCreateReservationPayload({ tripId: 42, dayId: 10, event });

  assert.equal(payload.tripId, 42);
  assert.equal(payload.day_id, 10);
  assert.equal(payload.title, event.summary);
  assert.equal(payload.type, 'other');
  assert.equal(payload.location, event.location);
});

test('buildCreateShareLinkPayload only needs the camelCase trip id', () => {
  assert.deepEqual(buildCreateShareLinkPayload({ tripId: 42 }), { tripId: 42 });
});

test('transportTypeForClassification falls back to other for non-transport types', () => {
  assert.equal(transportTypeForClassification('flight'), 'flight');
  assert.equal(transportTypeForClassification('train'), 'train');
  assert.equal(transportTypeForClassification('hotel'), 'other');
  assert.equal(transportTypeForClassification('reservation'), 'other');
});
