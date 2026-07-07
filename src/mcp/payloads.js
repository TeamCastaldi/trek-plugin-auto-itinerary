/**
 * Pure builders that turn normalized `.ics` event data (from `src/parse.js`/`src/classify.js`)
 * into MCP `tools/call` argument objects. Every field name below is verified against a live TREK
 * instance's `tools/list` `inputSchema`s (2026-07-07) — id casing is inconsistent per tool (not a
 * single convention), so match each builder's fields literally rather than assuming a pattern.
 * Deferred/out of scope: `create_transport`'s structured `endpoints` array (needs parsing a
 * free-text `LOCATION` into named origin/destination points) and any `create_reservation` `type`
 * finer than the `'other'` fallback (the classifier can't distinguish restaurant/event/tour/activity
 * from a plain calendar invite).
 */

function toDateOnly(date) {
  if (!date) return undefined;
  return date.toISOString().slice(0, 10);
}

function toTimestamp(date, allDay) {
  if (!date) return undefined;
  return allDay ? toDateOnly(date) : date.toISOString();
}

/** `create_accommodation`/`create_reservation`'s check_in/check_out are "HH:MM" time-of-day
 * strings, not timestamps — an all-day event has no time-of-day to report. */
function toTimeOnly(date, allDay) {
  if (!date || allDay) return undefined;
  return date.toISOString().slice(11, 16);
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

function buildCreateTripPayload({ title, startDate, endDate }) {
  return {
    title,
    start_date: toDateOnly(startDate),
    end_date: toDateOnly(endDate),
  };
}

/** `create_and_assign_place`: tripId/dayId are camelCase; there is no raw-date field — place
 * assignment is per-day (dayId), not per-timestamp. */
function buildCreatePlacePayload({ name, tripId, dayId }) {
  return {
    tripId,
    dayId,
    name,
  };
}

/** `create_accommodation`: tripId is camelCase; place_id/start_day_id/end_day_id are snake_case.
 * There is no `title` field — the accommodation is described by its linked place. */
function buildCreateAccommodationPayload({ tripId, placeId, startDayId, endDayId, event }) {
  return {
    tripId,
    place_id: placeId,
    start_day_id: startDayId,
    end_day_id: endDayId,
    check_in: toTimeOnly(event.start, event.allDay),
    check_out: toTimeOnly(event.end, event.allDay),
    notes: event.description || undefined,
  };
}

/** `create_transport`: tripId is camelCase; start_day_id/end_day_id are snake_case. There is no
 * `place_id` field — location data belongs in the (currently unpopulated, see file header)
 * `endpoints` array instead. `reservation_time`/`reservation_end_time` replace the guessed
 * `departure_time`/`arrival_time`. */
function buildCreateTransportPayload({ tripId, startDayId, endDayId, event, transportType }) {
  return {
    tripId,
    type: transportType,
    title: event.summary,
    start_day_id: startDayId,
    end_day_id: endDayId,
    reservation_time: toTimestamp(event.start, event.allDay),
    reservation_end_time: toTimestamp(event.end, event.allDay),
    notes: event.description || undefined,
  };
}

/** `create_reservation`: tripId is camelCase; day_id is snake_case. `type` must be one of the
 * verified enum values — this plugin's classifier can't distinguish finer than `'other'`.
 * `place_id`/`start_day_id`/`end_day_id`/`check_in`/`check_out` are documented "hotel type only"
 * (hotels go through create_accommodation instead), so the generic path uses the free-text
 * `location` field rather than a place reference. */
function buildCreateReservationPayload({ tripId, dayId, event }) {
  return {
    tripId,
    title: event.summary,
    type: 'other',
    day_id: dayId,
    reservation_time: toTimestamp(event.start, event.allDay),
    location: event.location || undefined,
    notes: event.description || undefined,
  };
}

/** `create_share_link`: tripId is camelCase. No other fields needed — the schema's
 * share_map/share_bookings defaults (both true) already match the desired default behavior. */
function buildCreateShareLinkPayload({ tripId }) {
  return { tripId };
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
