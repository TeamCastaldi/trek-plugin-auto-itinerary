const { extractCalendarFromWebhook } = require('./resend');

/**
 * Given a Resend `email.received` webhook payload and plugin config, returns the embedded `.ics`
 * calendar text, or null if the message has no calendar attachment. Thin wrapper over
 * `resend.js` so callers (and tests) keep the same `extractCalendar` entry point IMAP-era code used.
 */
async function extractCalendar(payload, config) {
  return extractCalendarFromWebhook(payload, config);
}

module.exports = { extractCalendar };
