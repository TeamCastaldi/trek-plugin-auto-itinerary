const { definePlugin } = require('trek-plugin-sdk');
const { openConnection, searchUnseen, markProcessed } = require('./imap');
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

// The hard platform floor for ctx.scheduler.every() — the fastest legal interval, so there's no
// real case for making this configurable.
const POLL_INTERVAL_MS = 60_000;

module.exports = definePlugin({
  async onLoad(ctx) {
    await ctx.db.migrate('001_processed_invites', LEDGER_SCHEMA);
    // Armed at runtime (upsert by name, safe to call on every onLoad/restart) instead of a
    // declared jobs[] cron entry — the host never reliably invoked a declared job on the real
    // instance, but arming returns a real, observable {scheduled} signal a declarative array
    // never gave us. See CLAUDE.md's load-bearing facts for the full history.
    const { scheduled } = await ctx.scheduler.every(POLL_INTERVAL_MS, 'poll-inbox');
    ctx.log.info(`auto-itinerary loaded (poll-inbox scheduler armed: ${scheduled})`);
  },

  async scheduled({ name }, ctx) {
    if (name !== 'poll-inbox') return;
    await pollInbox(ctx);
  },
});

module.exports.processMessage = processMessage;
module.exports.pollInbox = pollInbox;

/** The poll-inbox task body: connect, fetch unseen messages, process each. Called by the
 * `scheduled` handler above in production, and directly by scripts/manual-run.js for the
 * host-cron fallback path. */
async function pollInbox(ctx) {
  const connection = await openConnection(ctx.config);
  try {
    const messages = await searchUnseen(connection, ctx.config);
    ctx.log.info(`poll-inbox: found ${messages.length} unseen message(s)`);

    for (const message of messages) {
      await processMessage(ctx, connection, message);
    }
  } finally {
    connection.end();
  }
}

/**
 * `deps` lets tests inject a fake MCP session factory / orchestrator without a live IMAP or MCP
 * server; production call sites (the job handler above) rely on the real defaults.
 */
async function processMessage(
  ctx,
  connection,
  message,
  { createSession: createSessionFn = createSession, buildTripForMessage: buildTripFn = buildTripForMessage } = {}
) {
  try {
    const icsText = await extractCalendar(message.source);
    if (!icsText) {
      ctx.log.info(`poll-inbox: uid=${message.uid} has no calendar part, skipping`);
      return;
    }

    const events = parseEvents(icsText);
    if (!events.length) {
      ctx.log.info(`poll-inbox: uid=${message.uid} calendar has no VEVENTs, skipping`);
      return;
    }

    const classifiedEvents = events.map((event) => classifyEvent(event));
    const activeEvents = filterActiveEvents(classifiedEvents);
    const key = activeEvents.length ? activeEvents[0].event.uid : classifiedEvents[0].event.uid;
    const entry = await ledger.getEntry(ctx, key);

    if (!activeEvents.length) {
      if (entry && entry.status === 'done') {
        await ledger.markCancelled(ctx, entry.uid);
        ctx.log.info(
          `poll-inbox: uid=${message.uid} invite cancelled; trip ${entry.trip_id} left as-is, ledger marked cancelled`
        );
      } else {
        ctx.log.info(`poll-inbox: uid=${message.uid} all events cancelled, no prior trip, skipping`);
      }
      await markProcessed(connection, ctx.config, message.uid, ctx.log);
      return;
    }

    const maxSequence = Math.max(...activeEvents.map(({ event }) => event.sequence || 0));
    const payloadHash = ledger.computePayloadHash(activeEvents);

    if (entry && entry.status === 'done') {
      if (maxSequence > entry.sequence || payloadHash !== entry.payload_hash) {
        ctx.log.warn(
          `poll-inbox: uid=${message.uid} invite re-sent with changed content/sequence; ` +
            `trip ${entry.trip_id} may need manual reconciliation (no auto-update in this milestone)`
        );
        await ledger.markDone(ctx, entry.uid, { sequence: maxSequence, payloadHash });
      }
      await markProcessed(connection, ctx.config, message.uid, ctx.log);
      return;
    }

    if (entry && entry.status === 'cancelled') {
      await markProcessed(connection, ctx.config, message.uid, ctx.log);
      return;
    }

    // entry is undefined, or status is 'in_progress'/'error' — new build or crash-recovery resume.
    const existingTripId = entry && entry.trip_id ? entry.trip_id : null;
    await ledger.beginProcessing(ctx, {
      uid: key,
      messageId: message.messageId,
      sequence: maxSequence,
      payloadHash,
    });

    try {
      const session = await createSessionFn(ctx.config);
      const result = await buildTripFn(session, message, classifiedEvents, ctx.config, {
        existingTripId,
        onTripCreated: (tripId) => ledger.recordTripCreated(ctx, key, tripId),
      });
      await ledger.markDone(ctx, key, { tripId: result.tripId, shareUrl: result.shareUrl });
      ctx.log.info(
        `poll-inbox: uid=${message.uid} built trip ${result.tripId} (${result.entityCount} entries)` +
          (result.shareUrl ? ` share=${result.shareUrl}` : '')
      );
      for (const traceEntry of result.trace) {
        if (!traceEntry.ok) {
          ctx.log.warn(`poll-inbox: uid=${message.uid} ${traceEntry.step}: ${traceEntry.error}`);
        }
      }
      await markProcessed(connection, ctx.config, message.uid, ctx.log);
    } catch (err) {
      await ledger.markError(ctx, key);
      ctx.log.error(`poll-inbox: uid=${message.uid} failed, will retry next poll: ${err.message}`);
    }
  } catch (err) {
    ctx.log.error(`poll-inbox: uid=${message.uid} failed, skipping: ${err.message}`);
  }
}
