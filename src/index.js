const { definePlugin } = require('trek-plugin-sdk');
const { fetchUnseenMessages } = require('./imap');
const { extractCalendar } = require('./extract');
const { parseEvents } = require('./parse');
const { classifyEvent } = require('./classify');

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
        const messages = await fetchUnseenMessages(ctx.config);
        ctx.log.info(`poll-inbox: found ${messages.length} unseen message(s)`);

        for (const message of messages) {
          const icsText = await extractCalendar(message.source);
          if (!icsText) {
            ctx.log.info(`poll-inbox: uid=${message.uid} has no calendar part, skipping`);
            continue;
          }

          const events = parseEvents(icsText);
          if (!events.length) {
            ctx.log.info(`poll-inbox: uid=${message.uid} calendar has no VEVENTs, skipping`);
            continue;
          }

          for (const event of events) {
            const { type } = classifyEvent(event);
            ctx.log.info(
              `poll-inbox: uid=${message.uid} event uid=${event.uid} sequence=${event.sequence} ` +
                `type=${type} cancelled=${event.cancelled} summary="${event.summary}" ` +
                `start=${event.start} end=${event.end}`
            );
          }
        }
      },
    },
  ],
});
