const ical = require('node-ical');

/**
 * node-ical returns a plain string for an unparameterized property (e.g. `SUMMARY:Flight to NYC`),
 * but `{ params, val }` for one with parameters (e.g. Google Calendar's
 * `SUMMARY;LANGUAGE=en:Flight to NYC`) — confirmed against a real Google Calendar-generated invite,
 * not assumed from the spec. Every text field must unwrap `.val` in that case.
 */
function textValue(field) {
  if (field && typeof field === 'object' && 'val' in field) return field.val || '';
  return field || '';
}

/**
 * Parses `.ics` text into normalized VEVENT objects. Cancellation is detected from either the
 * calendar-level METHOD:CANCEL or the per-event STATUS:CANCELLED.
 */
function parseEvents(icsText) {
  const parsed = ical.parseICS(icsText);

  return Object.values(parsed)
    .filter((component) => component.type === 'VEVENT')
    .map((event) => ({
      uid: event.uid,
      sequence: event.sequence || 0,
      summary: textValue(event.summary),
      description: textValue(event.description),
      location: textValue(event.location),
      start: event.start,
      end: event.end,
      allDay: Boolean(event.start && event.start.dateOnly),
      cancelled: event.method === 'CANCEL' || event.status === 'CANCELLED',
    }));
}

module.exports = { parseEvents };
