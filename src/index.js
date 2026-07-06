const { definePlugin } = require('trek-plugin-sdk');

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

  jobs: [
    {
      id: 'poll-inbox',
      schedule: '*/5 * * * *',
      async handler(ctx) {
        ctx.log.info('poll-inbox: ingestion not yet implemented');
      },
    },
  ],
});
