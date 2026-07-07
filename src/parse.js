const ical = require('node-ical');

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
      summary: event.summary || '',
      description: event.description || '',
      location: event.location || '',
      start: event.start,
      end: event.end,
      allDay: Boolean(event.start && event.start.dateOnly),
      cancelled: event.method === 'CANCEL' || event.status === 'CANCELLED',
    }));
}

module.exports = { parseEvents };
