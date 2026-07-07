/**
 * Pure builders that turn normalized `.ics` event data (from `src/parse.js`/`src/classify.js`)
 * into MCP `tools/call` argument objects. Every field name below is a guess based on
 * `docs/PLAN.md` §3's mapping table — the real `inputSchema`s are only knowable via a live
 * `tools/list` call (see docs/PLAN.md's R3). If a live instance disagrees, this is the only file
 * that should need to change; grep for `SCHEMA-GUESS` to find every assumption.
 */

function toDateOnly(date) {
  if (!date) return undefined;
  return date.toISOString().slice(0, 10);
}

function toTimestamp(date, allDay) {
  if (!date) return undefined;
  return allDay ? toDateOnly(date) : date.toISOString();
}

/** Spans a message's non-cancelled events for the overall trip date range (create_trip dates). */
function computeTripDateRange(events) {
  const starts = events.map((event) => event.start).filter(Boolean);
  const ends = events.map((event) => event.end).filter(Boolean);

  const startDate = new Date(Math.min(...starts.map((date) => date.getTime())));
  const endDate = new Date(Math.max(...ends.map((date) => date.getTime())));
  return { startDate, endDate };
}

/** classify.js's 'flight'/'train' -> the transport `type` field create_transport expects. */
function transportTypeForClassification(type) {
  if (type === 'flight') return 'flight';
  if (type === 'train') return 'train';
  return 'other';
}

// SCHEMA-GUESS: docs/PLAN.md §3 — DTSTART/DTEND -> create_trip dates, SUMMARY -> create_trip.title.
function buildCreateTripPayload({ title, startDate, endDate }) {
  return {
    title,
    start_date: toDateOnly(startDate),
    end_date: toDateOnly(endDate),
  };
}

// SCHEMA-GUESS: docs/PLAN.md §3 — LOCATION -> place (name), via create_and_assign_place.
function buildCreatePlacePayload({ name, tripId, date, allDay }) {
  return {
    trip_id: tripId,
    name,
    date: toTimestamp(date, allDay),
  };
}

// SCHEMA-GUESS: docs/PLAN.md §3 — hotel check-in/check-out -> create_accommodation.
function buildCreateAccommodationPayload({ tripId, placeId, event }) {
  return {
    trip_id: tripId,
    place_id: placeId,
    title: event.summary,
    check_in: toTimestamp(event.start, event.allDay),
    check_out: toTimestamp(event.end, event.allDay),
    notes: event.description || undefined,
  };
}

// SCHEMA-GUESS: docs/PLAN.md §3 — flight/train -> create_transport(type).
function buildCreateTransportPayload({ tripId, placeId, event, transportType }) {
  return {
    trip_id: tripId,
    place_id: placeId,
    type: transportType,
    title: event.summary,
    departure_time: toTimestamp(event.start, event.allDay),
    arrival_time: toTimestamp(event.end, event.allDay),
    notes: event.description || undefined,
  };
}

// SCHEMA-GUESS: docs/PLAN.md §3 — generic fallback (restaurant/event/tour/meeting) -> create_reservation.
function buildCreateReservationPayload({ tripId, placeId, event }) {
  return {
    trip_id: tripId,
    place_id: placeId,
    title: event.summary,
    start_time: toTimestamp(event.start, event.allDay),
    end_time: toTimestamp(event.end, event.allDay),
    notes: event.description || undefined,
  };
}

// SCHEMA-GUESS: docs/PLAN.md §3 — auto_share -> create_share_link.
function buildCreateShareLinkPayload({ tripId }) {
  return { trip_id: tripId };
}

module.exports = {
  computeTripDateRange,
  transportTypeForClassification,
  buildCreateTripPayload,
  buildCreatePlacePayload,
  buildCreateAccommodationPayload,
  buildCreateTransportPayload,
  buildCreateReservationPayload,
  buildCreateShareLinkPayload,
};
