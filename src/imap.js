const imaps = require('imap-simple');

function parseSenderAllowlist(raw) {
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.length ? list : null;
}

function messageFrom(message) {
  const header = message.parts.find((p) => p.which && p.which.startsWith('HEADER'));
  if (!header) return null;
  const from = header.body.from;
  return Array.isArray(from) ? from[0] : from;
}

function matchesAllowlist(fromHeader, allowlist) {
  if (!allowlist) return true;
  if (!fromHeader) return false;
  const lower = fromHeader.toLowerCase();
  return allowlist.some((addr) => lower.includes(addr));
}

/**
 * Connects to the configured IMAP inbox, searches for UNSEEN messages (optionally filtered by a
 * sender allowlist), and returns their raw RFC822 source. Does not mutate any mail flags.
 */
async function fetchUnseenMessages(config) {
  const allowlist = parseSenderAllowlist(config.sender_allowlist);
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

  try {
    await connection.openBox(config.imap_folder || 'INBOX');

    const messages = await connection.search(['UNSEEN'], {
      bodies: ['HEADER', ''],
      markSeen: false,
    });

    const results = [];
    for (const message of messages) {
      const from = messageFrom(message);
      if (!matchesAllowlist(from, allowlist)) continue;

      const rawPart = message.parts.find((p) => p.which === '');
      if (!rawPart) continue;

      results.push({ uid: message.attributes.uid, source: rawPart.body });
    }
    return results;
  } finally {
    connection.end();
  }
}

module.exports = { fetchUnseenMessages };
