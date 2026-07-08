const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Runs the REAL, unmodified production plugin code (`onLoad` + the `poll-inbox` job's `handler`,
 * taken directly off `src/index.js`'s exports — not a reimplementation) against a real IMAP
 * mailbox and a real TREK instance, from this machine. Useful when you want to prove the pipeline
 * itself works without waiting on TREK's own cron scheduler (e.g. while debugging why a sideloaded
 * plugin isn't executing its job at all).
 *
 * Backed by a real local SQLite ledger (`node:sqlite`, Node 22.5+) at
 * scripts/.manual-run-ledger.sqlite so idempotency behaves exactly like production and repeated
 * runs are safe — an already-`done` invite is a no-op on a second run, matching `processMessage`'s
 * real behavior. Calls the real `markProcessed` too, so once this succeeds the message is marked
 * `\Seen` for real — TREK's own cron (once it's working) won't reprocess it and create a duplicate
 * trip.
 *
 * Env vars mirror the plugin's real settings keys directly (uppercased) so there's no translation
 * step: IMAP_HOST, IMAP_PORT, IMAP_TLS, IMAP_USER, IMAP_PASSWORD, IMAP_FOLDER (optional),
 * PROCESSED_FOLDER (optional), SENDER_ALLOWLIST (optional), TREK_BASE_URL, MCP_CLIENT_ID,
 * MCP_CLIENT_SECRET, MCP_SCOPES (optional), AUTO_SHARE (optional, "yes"/"no").
 */
function buildConfig() {
  const required = ['IMAP_HOST', 'IMAP_PORT', 'IMAP_TLS', 'IMAP_USER', 'IMAP_PASSWORD', 'TREK_BASE_URL', 'MCP_CLIENT_ID', 'MCP_CLIENT_SECRET'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.log(`[manual-run] skipping — missing env vars: ${missing.join(', ')}`);
    console.log('[manual-run] set IMAP_HOST/PORT/TLS/USER/PASSWORD, TREK_BASE_URL, MCP_CLIENT_ID/SECRET');
    console.log('[manual-run] (and optionally IMAP_FOLDER/PROCESSED_FOLDER/SENDER_ALLOWLIST/MCP_SCOPES/AUTO_SHARE) to run.');
    return null;
  }
  return {
    imap_host: process.env.IMAP_HOST,
    imap_port: Number(process.env.IMAP_PORT),
    imap_tls: process.env.IMAP_TLS,
    imap_user: process.env.IMAP_USER,
    imap_password: process.env.IMAP_PASSWORD,
    imap_folder: process.env.IMAP_FOLDER || 'INBOX',
    processed_folder: process.env.PROCESSED_FOLDER || '',
    sender_allowlist: process.env.SENDER_ALLOWLIST || '',
    trek_base_url: process.env.TREK_BASE_URL,
    mcp_client_id: process.env.MCP_CLIENT_ID,
    mcp_client_secret: process.env.MCP_CLIENT_SECRET,
    mcp_scopes: process.env.MCP_SCOPES || 'trips:write places:write reservations:write trips:share',
    auto_share: process.env.AUTO_SHARE || 'yes',
  };
}

/** A real, persistent ctx.db backed by node:sqlite — same query/exec/migrate contract src/ledger.js expects. */
function createSqliteDb(dbFile) {
  const sq = new DatabaseSync(dbFile);
  const applied = new Set();
  return {
    close: () => sq.close(),
    db: {
      async query(sql, params = []) {
        return sq.prepare(sql).all(...params);
      },
      async exec(sql, params = []) {
        if (params.length) {
          const r = sq.prepare(sql).run(...params);
          return { changes: Number(r.changes ?? 0) };
        }
        sq.exec(sql);
        return { changes: 0 };
      },
      async migrate(id, sql) {
        if (applied.has(id)) return { applied: false };
        sq.exec(sql);
        applied.add(id);
        return { applied: true };
      },
    },
  };
}

async function main() {
  const config = buildConfig();
  if (!config) return;

  const dbFile = path.join(__dirname, '.manual-run-ledger.sqlite');
  const { db, close } = createSqliteDb(dbFile);
  console.log(`[manual-run] ledger: ${dbFile}`);

  const ctx = {
    config,
    db,
    log: {
      info: (msg) => console.log(`[plugin:info] ${msg}`),
      warn: (msg) => console.warn(`[plugin:warn] ${msg}`),
      error: (msg) => console.error(`[plugin:error] ${msg}`),
    },
  };

  try {
    // The real, unmodified plugin export — not a reimplementation.
    const plugin = require('../src/index');
    await plugin.onLoad(ctx);
    console.log('[manual-run] onLoad complete, running poll-inbox handler for real...');
    await plugin.jobs[0].handler(ctx);
    console.log('[manual-run] poll-inbox handler completed.');
  } finally {
    close();
  }
}

main().catch((err) => {
  console.error('[manual-run] failed:', err);
  process.exitCode = 1;
});
