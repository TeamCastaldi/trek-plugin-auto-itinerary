const { definePlugin } = require('trek-plugin-sdk');
const { verifyWebhookSecret } = require('./resend');
const { extractCalendar } = require('./extract');
const { parseEvents } = require('./parse');
const { classifyEvent } = require('./classify');
const { createSession } = require('./mcp/client');
const { filterActiveEvents, buildTripForMessage } = require('./mcp/orchestrate');
const ledger = require('./ledger');

const LEDGER_SCHEMA = `
CREATE TABLE IF NOT EXISTS processed_invites (
  uid TEXT PRIMARY KEY,
  message_id TEXT,
  sequence INTEGER NOT NULL DEFAULT 0,
  trip_id TEXT,
  share_url TEXT,
  status TEXT NOT NULL DEFAULT 'in_progress',
  payload_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

module.exports = definePlugin({
  async onLoad(ctx) {
    await ctx.db.migrate('001_processed_invites', LEDGER_SCHEMA);
    ctx.log.info('auto-itinerary loaded');
  },

  routes: [
    {
      method: 'POST',
      path: '/resend-webhook',
      // Public: Resend can't carry a TREK user session, so this route runs unauthenticated and
      // relies on the shared `webhook_secret` query-param check below instead (PluginRequest has
      // no headers — see src/resend.js).
      auth: false,
      async handler(req, ctx) {
        if (!verifyWebhookSecret(req, ctx.config)) {
          ctx.log.warn('resend-webhook: rejected request with missing/invalid webhook secret');
          return { status: 401, body: { error: 'unauthorized' } };
        }

        const payload = req.body;
        if (!payload || payload.type !== 'email.received') {
          // Resend also sends delivery/bounce/etc. events to the same endpoint if configured that
          // way; anything that isn't an inbound message is a no-op ack, not an error.
          return { status: 200, body: { ok: true, skipped: true } };
        }

        const result = await processMessage(ctx, payload);
        return {
          status: result.ok ? 200 : 500,
          body: result.ok ? { ok: true } : { ok: false, error: result.error },
        };
      },
    },
  ],
});

module.exports.processMessage = processMessage;

/**
 * `deps` lets tests inject a fake MCP session factory / orchestrator without a live TREK server;
 * production call sites (the route handler above) rely on the real defaults. Returns `{ ok, error }`
 * so the route handler can choose an HTTP status (a non-2xx response makes Resend retry delivery —
 * there's no polling loop to retry on anymore, so this is now the only retry mechanism).
 */
async function processMessage(
  ctx,
  payload,
  { createSession: createSessionFn = createSession, buildTripForMessage: buildTripFn = buildTripForMessage } = {}
) {
  const emailId = payload.data && payload.data.email_id;
  const messageId = (payload.data && payload.data.headers && payload.data.headers['message-id']) || emailId;

  try {
    const icsText = await extractCalendar(payload, ctx.config);
    if (!icsText) {
      ctx.log.info(`resend-webhook: email_id=${emailId} has no calendar attachment, skipping`);
      return { ok: true };
    }

    const events = parseEvents(icsText);
    if (!events.length) {
      ctx.log.info(`resend-webhook: email_id=${emailId} calendar has no VEVENTs, skipping`);
      return { ok: true };
    }

    const classifiedEvents = events.map((event) => classifyEvent(event));
    const activeEvents = filterActiveEvents(classifiedEvents);
    const key = activeEvents.length ? activeEvents[0].event.uid : classifiedEvents[0].event.uid;
    const entry = await ledger.getEntry(ctx, key);

    if (!activeEvents.length) {
      if (entry && entry.status === 'done') {
        await ledger.markCancelled(ctx, entry.uid);
        ctx.log.info(
          `resend-webhook: email_id=${emailId} invite cancelled; trip ${entry.trip_id} left as-is, ledger marked cancelled`
        );
      } else {
        ctx.log.info(`resend-webhook: email_id=${emailId} all events cancelled, no prior trip, skipping`);
      }
      return { ok: true };
    }

    const maxSequence = Math.max(...activeEvents.map(({ event }) => event.sequence || 0));
    const payloadHash = ledger.computePayloadHash(activeEvents);

    if (entry && entry.status === 'done') {
      if (maxSequence > entry.sequence || payloadHash !== entry.payload_hash) {
        ctx.log.warn(
          `resend-webhook: email_id=${emailId} invite re-sent with changed content/sequence; ` +
            `trip ${entry.trip_id} may need manual reconciliation (no auto-update in this milestone)`
        );
        await ledger.markDone(ctx, entry.uid, { sequence: maxSequence, payloadHash });
      }
      return { ok: true };
    }

    if (entry && entry.status === 'cancelled') {
      return { ok: true };
    }

    // entry is undefined, or status is 'in_progress'/'error' — new build or crash-recovery resume.
    const existingTripId = entry && entry.trip_id ? entry.trip_id : null;
    await ledger.beginProcessing(ctx, {
      uid: key,
      messageId,
      sequence: maxSequence,
      payloadHash,
    });

    try {
      const session = await createSessionFn(ctx.config);
      const result = await buildTripFn(session, payload, classifiedEvents, ctx.config, {
        existingTripId,
        onTripCreated: (tripId) => ledger.recordTripCreated(ctx, key, tripId),
      });
      await ledger.markDone(ctx, key, { tripId: result.tripId, shareUrl: result.shareUrl });
      ctx.log.info(
        `resend-webhook: email_id=${emailId} built trip ${result.tripId} (${result.entityCount} entries)` +
          (result.shareUrl ? ` share=${result.shareUrl}` : '')
      );
      for (const traceEntry of result.trace) {
        if (!traceEntry.ok) {
          ctx.log.warn(`resend-webhook: email_id=${emailId} ${traceEntry.step}: ${traceEntry.error}`);
        }
      }
      return { ok: true };
    } catch (err) {
      await ledger.markError(ctx, key);
      ctx.log.error(`resend-webhook: email_id=${emailId} failed, will retry on next Resend delivery: ${err.message}`);
      return { ok: false, error: err.message };
    }
  } catch (err) {
    ctx.log.error(`resend-webhook: email_id=${emailId} failed, will retry on next Resend delivery: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
