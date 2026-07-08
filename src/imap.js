const imaps = require('imap-simple');

function parseSenderAllowlist(raw) {
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : null;
}

function messageHeader(message, name) {
  const header = message.parts.find((p) => p.which && p.which.startsWith('HEADER'));
  if (!header) return null;
  const value = header.body[name];
  return Array.isArray(value) ? value[0] : value;
}

function matchesAllowlist(fromHeader, allowlist) {
  if (!allowlist) return true;
  if (!fromHeader) return false;
  const lower = fromHeader.toLowerCase();
  return allowlist.some((addr) => lower.includes(addr));
}

/** Opens an IMAP connection from resolved plugin settings. Caller is responsible for closing it. */
async function openConnection(config) {
  const useImplicitTls = config.imap_tls !== 'starttls';

  const connection = await imaps.connect({
    imap: {
      user: config.imap_user,
      password: config.imap_password,
      host: config.imap_host,
      port: config.imap_port,
      tls: useImplicitTls,
      autotls: useImplicitTls ? undefined : 'required',
      tlsOptions: { servername: config.imap_host },
      authTimeout: 10000,
    },
  });

  await connection.openBox(config.imap_folder || 'INBOX');
  return connection;
}

/**
 * Searches the already-opened connection for UNSEEN messages (optionally filtered by a sender
 * allowlist), returning their raw RFC822 source plus the `Message-Id` header. Does not mutate any
 * mail flags.
 */
async function searchUnseen(connection, config) {
  const allowlist = parseSenderAllowlist(config.sender_allowlist);

  const messages = await connection.search(['UNSEEN'], {
    bodies: ['HEADER', ''],
    markSeen: false,
  });

  const results = [];
  for (const message of messages) {
    const from = messageHeader(message, 'from');
    if (!matchesAllowlist(from, allowlist)) continue;

    const rawPart = message.parts.find((p) => p.which === '');
    if (!rawPart) continue;

    results.push({
      uid: message.attributes.uid,
      source: rawPart.body,
      messageId: messageHeader(message, 'message-id'),
    });
  }
  return results;
}

/**
 * Best-effort mail-flag second guard (docs/PLAN.md §4): marks a message `\Seen` and, if a
 * processed folder is configured, moves it there. Never throws — the DB ledger is the
 * authoritative idempotency guard, this is only the coarse one, so a flag/move failure must not
 * undo a ledger row that already reached `done`/`cancelled`.
 */
async function markProcessed(connection, config, uid, log) {
  try {
    await connection.addFlags(uid, '\\Seen');
    if (config.processed_folder) {
      await connection.moveMessage(uid, config.processed_folder);
    }
  } catch (err) {
    if (log) log.warn(`imap: failed to mark uid=${uid} processed: ${err.message}`);
  }
}

/**
 * Get the underlying node-imap instance from an imap-simple connection.
 * Used by IDLE listener to attach raw event handlers.
 */
function getUnderlyingImap(connection) {
  return connection.imap;
}

module.exports = { openConnection, searchUnseen, markProcessed, getUnderlyingImap };
