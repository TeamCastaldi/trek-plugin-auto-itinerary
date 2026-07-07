const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEvents } = require('../src/parse');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

test('parses a single VEVENT', () => {
  const [event] = parseEvents(fixture('flight.ics'));
  assert.equal(event.uid, 'flight-abc123@testairlines.com');
  assert.equal(event.summary, 'Flight UA123 to SFO');
  assert.match(event.description, /PNR: ABC123/);
  assert.equal(event.location, 'San Francisco International Airport');
  assert.equal(event.allDay, false);
  assert.equal(event.cancelled, false);
});

test('marks all-day events with allDay=true', () => {
  const [event] = parseEvents(fixture('allday.ics'));
  assert.equal(event.allDay, true);
});

test('handles timezone-qualified DTSTART/DTEND', () => {
  const [event] = parseEvents(fixture('tz.ics'));
  assert.ok(event.start instanceof Date);
  // 09:00 America/New_York in August (EDT, UTC-4) is 13:00 UTC.
  assert.equal(event.start.toISOString(), '2026-08-03T13:00:00.000Z');
});

test('parses every VEVENT in a multi-event calendar', () => {
  const events = parseEvents(fixture('multi-vevent.ics'));
  assert.equal(events.length, 2);
  const uids = events.map((e) => e.uid).sort();
  assert.deepEqual(uids, ['multi-flight@example.com', 'multi-hotel@example.com']);
});

test('detects cancellation from METHOD:CANCEL and STATUS:CANCELLED', () => {
  const [event] = parseEvents(fixture('cancel.ics'));
  assert.equal(event.cancelled, true);
  assert.equal(event.sequence, 1);
});

test('returns an empty array for a calendar with no VEVENTs', () => {
  const emptyCalendar = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//x//x//EN\r\nEND:VCALENDAR\r\n';
  assert.deepEqual(parseEvents(emptyCalendar), []);
});
