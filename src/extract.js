const { simpleParser } = require('mailparser');

/**
 * Parses a raw RFC822 message source and returns the embedded `.ics` calendar text, whether it
 * arrived as a `*.ics` attachment or an inline `text/calendar` part. Returns null if none found.
 */
async function extractCalendar(rawSource) {
  const mail = await simpleParser(rawSource);

  const part = (mail.attachments || []).find((att) => {
    const contentType = (att.contentType || '').toLowerCase();
    const filename = (att.filename || '').toLowerCase();
    return contentType === 'text/calendar' || filename.endsWith('.ics');
  });

  if (!part) return null;
  return part.content.toString('utf8');
}

module.exports = { extractCalendar };
