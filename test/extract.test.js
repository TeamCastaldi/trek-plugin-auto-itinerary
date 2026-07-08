const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractCalendar } = require('../src/extract');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

function webhookPayload({ attachments = [], emailId = 'email_1' } = {}) {
  return {
    type: 'email.received',
    data: {
      email_id: emailId,
      from: 'reservations@example.com',
      to: ['family-inbox@example.com'],
      subject: 'Booking',
      attachments,
    },
  };
}

function fakeFetch(routes) {
  return async (url, opts) => {
    for (const [matcher, respond] of routes) {
      if (typeof matcher === 'string' ? url === matcher : matcher.test(url)) {
        return respond(url, opts);
      }
    }
    throw new Error(`fakeFetch: no route for ${url}`);
  };
}

test('extracts a .ics attachment via the metadata -> download_url two-hop fetch', async (t) => {
  const ics = fixture('generic.ics');
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = fakeFetch([
    [
      'https://api.resend.com/emails/receiving/email_1/attachments/att_1',
      async () => new Response(JSON.stringify({ download_url: 'https://files.example.com/att_1' }), { status: 200 }),
    ],
    ['https://files.example.com/att_1', async () => new Response(ics, { status: 200 })],
  ]);

  const payload = webhookPayload({
    attachments: [{ id: 'att_1', filename: 'invite.ics', content_type: 'text/calendar' }],
  });
  const result = await extractCalendar(payload, { resend_api_key: 'key_1' });

  assert.ok(result);
  assert.match(result, /BEGIN:VCALENDAR/);
});

test('matches on .ics filename even without a text/calendar content_type', async (t) => {
  const ics = fixture('generic.ics');
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });
  global.fetch = fakeFetch([
    [
      'https://api.resend.com/emails/receiving/email_1/attachments/att_2',
      async () => new Response(JSON.stringify({ download_url: 'https://files.example.com/att_2' }), { status: 200 }),
    ],
    ['https://files.example.com/att_2', async () => new Response(ics, { status: 200 })],
  ]);

  const payload = webhookPayload({
    attachments: [{ id: 'att_2', filename: 'invite.ICS', content_type: 'application/octet-stream' }],
  });
  const result = await extractCalendar(payload, { resend_api_key: 'key_1' });

  assert.ok(result);
  assert.match(result, /BEGIN:VCALENDAR/);
});

test('returns null when no calendar attachment is present', async () => {
  const payload = webhookPayload({
    attachments: [{ id: 'att_3', filename: 'receipt.pdf', content_type: 'application/pdf' }],
  });
  const result = await extractCalendar(payload, { resend_api_key: 'key_1' });
  assert.equal(result, null);
});

test('returns null when the message has no attachments at all', async () => {
  const payload = webhookPayload({ attachments: [] });
  const result = await extractCalendar(payload, { resend_api_key: 'key_1' });
  assert.equal(result, null);
});
