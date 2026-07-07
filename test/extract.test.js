const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractCalendar } = require('../src/extract');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

test('extracts a .ics attachment', async () => {
  const ics = await extractCalendar(fixture('attachment.eml'));
  assert.ok(ics);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /UID:flight-abc123@testairlines\.com/);
});

test('extracts an inline text/calendar part', async () => {
  const ics = await extractCalendar(fixture('inline.eml'));
  assert.ok(ics);
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /UID:dinner-reservation-42@thebistro\.com/);
});

test('returns null when no calendar part is present', async () => {
  const plainEmail = [
    'From: someone@example.com',
    'To: family-inbox@castaldifamily.com',
    'Subject: Just saying hi',
    'Content-Type: text/plain',
    '',
    'No calendar here.',
    '',
  ].join('\r\n');

  const ics = await extractCalendar(plainEmail);
  assert.equal(ics, null);
});
