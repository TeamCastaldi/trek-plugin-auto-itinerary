const crypto = require('node:crypto');

const RESEND_API_BASE = 'https://api.resend.com';

/**
 * Constant-time shared-secret check for the inbound webhook route (`auth: false` in
 * `src/index.js`, since Resend can't carry a TREK user session).
 *
 * `trek-plugin-sdk`'s `PluginRequest` (confirmed against the installed `dist/index.d.ts` and the
 * real route dispatcher in `dist/cli/dev.js`) only carries `{method, path, query, body, user}` —
 * there is no `headers` field at all, in dev or (per the same contract) in production. So a
 * header-based secret (the usual webhook pattern, and Resend's own Svix-style `svix-signature`
 * scheme) is not available to a TREK plugin route; the shared secret has to travel in the query
 * string instead. Configure Resend's webhook URL as
 * `https://<trek-host>/api/resend-webhook?secret=<webhook_secret>`.
 */
function verifyWebhookSecret(req, config) {
  const expected = config.webhook_secret;
  if (!expected) return false;

  const provided = req.query && req.query.secret;
  if (!provided) return false;

  const expectedBuf = Buffer.from(String(expected));
  const providedBuf = Buffer.from(String(provided));
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * SCHEMA-GUESS scope note: field *names* below (`email_id`, `attachments[].id/filename/
 * content_type`, `download_url`) are confirmed against Resend's own docs/skills reference, not
 * guessed — see docs/PLAN.md. What's unverified until a live webhook is observed: whether the
 * signed `download_url` host resolves under `api.resend.com` or a separate host, which affects the
 * egress allowlist (see trek-plugin.template.json's `resend_api_key`/egress note).
 *
 * Fetches one attachment's raw bytes: `GET /emails/receiving/{emailId}/attachments/{attachmentId}`
 * for a short-lived signed `download_url`, then `GET`s that URL for the content.
 */
async function fetchAttachmentContent(config, emailId, attachmentId) {
  const metaRes = await fetch(
    `${RESEND_API_BASE}/emails/receiving/${emailId}/attachments/${attachmentId}`,
    { headers: { authorization: `Bearer ${config.resend_api_key}` } }
  );
  if (!metaRes.ok) {
    const text = await metaRes.text().catch(() => '');
    throw new Error(`resend: attachment metadata fetch failed: ${metaRes.status} ${text.slice(0, 500)}`);
  }
  const meta = await metaRes.json();
  if (!meta.download_url) {
    throw new Error('resend: attachment metadata response missing download_url');
  }

  const contentRes = await fetch(meta.download_url);
  if (!contentRes.ok) {
    throw new Error(`resend: attachment download failed: ${contentRes.status}`);
  }
  return contentRes.text();
}

/**
 * Finds the `.ics` attachment in a webhook payload's `data.attachments[]` metadata list (by
 * `content_type === 'text/calendar'` or a `.ics` filename) and downloads its content. Returns null
 * if no calendar attachment is present.
 */
async function extractCalendarFromWebhook(payload, config) {
  const data = payload && payload.data;
  const attachments = (data && data.attachments) || [];

  const calendarAttachment = attachments.find((att) => {
    const contentType = (att.content_type || '').toLowerCase();
    const filename = (att.filename || '').toLowerCase();
    return contentType === 'text/calendar' || filename.endsWith('.ics');
  });
  if (!calendarAttachment) return null;

  return fetchAttachmentContent(config, data.email_id, calendarAttachment.id);
}

module.exports = { verifyWebhookSecret, fetchAttachmentContent, extractCalendarFromWebhook };
