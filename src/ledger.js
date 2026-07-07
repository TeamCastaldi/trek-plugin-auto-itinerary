const crypto = require('node:crypto');

/**
 * All SQL for the `processed_invites` idempotency ledger lives here, per docs/PLAN.md §4. The
 * row's `uid` column is keyed on the *message*, not on every VEVENT's UID: it holds the first
 * active (non-cancelled) event's UID as a stand-in identifier for the whole "one invite -> one
 * trip" build, since a single message can contain multiple VEVENTs with different UIDs (see
 * test/fixtures/multi-vevent.ics). `sequence` holds max(sequence) across the message's active
 * events.
 */

async function getEntry(ctx, uid) {
  const rows = await ctx.db.query('SELECT * FROM processed_invites WHERE uid = ?', [uid]);
  return (rows && rows[0]) || null;
}

/**
 * Starts (or resumes) processing a message. Preserves `trip_id`/`created_at` on a resumed row
 * (stale `in_progress`/`error`) so crash recovery can pick up from a trip that was already
 * created — see docs/PLAN.md §4's two-phase write.
 */
async function beginProcessing(ctx, { uid, messageId, sequence, payloadHash }) {
  await ctx.db.exec(
    `INSERT INTO processed_invites (uid, message_id, sequence, status, payload_hash, updated_at)
     VALUES (?, ?, ?, 'in_progress', ?, datetime('now'))
     ON CONFLICT(uid) DO UPDATE SET
       message_id = excluded.message_id,
       sequence = excluded.sequence,
       payload_hash = excluded.payload_hash,
       status = 'in_progress',
       updated_at = datetime('now')`,
    [uid, messageId, sequence, payloadHash]
  );
}

/** Called immediately after a fresh `create_trip` succeeds, before any sub-entity calls. */
async function recordTripCreated(ctx, uid, tripId) {
  await ctx.db.exec(
    `UPDATE processed_invites SET trip_id = ?, updated_at = datetime('now') WHERE uid = ?`,
    [tripId, uid]
  );
}

async function markDone(ctx, uid, { tripId, shareUrl, sequence, payloadHash } = {}) {
  await ctx.db.exec(
    `UPDATE processed_invites SET
       status = 'done',
       trip_id = COALESCE(?, trip_id),
       share_url = COALESCE(?, share_url),
       sequence = COALESCE(?, sequence),
       payload_hash = COALESCE(?, payload_hash),
       updated_at = datetime('now')
     WHERE uid = ?`,
    [tripId ?? null, shareUrl ?? null, sequence ?? null, payloadHash ?? null, uid]
  );
}

async function markCancelled(ctx, uid) {
  await ctx.db.exec(
    `UPDATE processed_invites SET status = 'cancelled', updated_at = datetime('now') WHERE uid = ?`,
    [uid]
  );
}

async function markError(ctx, uid) {
  await ctx.db.exec(
    `UPDATE processed_invites SET status = 'error', updated_at = datetime('now') WHERE uid = ?`,
    [uid]
  );
}

/**
 * Stable content fingerprint over a message's active events, independent of SEQUENCE (which some
 * senders bump inconsistently) — used to catch re-sent invites whose content changed.
 */
function computePayloadHash(activeEvents) {
  const events = activeEvents
    .map(({ event }) => ({
      uid: event.uid,
      sequence: event.sequence,
      summary: event.summary,
      location: event.location,
      description: event.description,
      start: event.start ? event.start.toISOString() : null,
      end: event.end ? event.end.toISOString() : null,
    }))
    .sort((a, b) => (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));

  return crypto.createHash('sha256').update(JSON.stringify(events)).digest('hex');
}

module.exports = {
  getEntry,
  beginProcessing,
  recordTripCreated,
  markDone,
  markCancelled,
  markError,
  computePayloadHash,
};
