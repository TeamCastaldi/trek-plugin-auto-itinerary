const { openConnection, searchUnseen } = require('../src/imap');

async function main() {
  const required = ['SMOKE_IMAP_HOST', 'SMOKE_IMAP_PORT', 'SMOKE_IMAP_TLS', 'SMOKE_IMAP_USER', 'SMOKE_IMAP_PASSWORD'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    console.log(`[smoke-imap] skipping — missing env vars: ${missing.join(', ')}`);
    console.log('[smoke-imap] set SMOKE_IMAP_HOST/PORT/TLS/USER/PASSWORD (and optionally SMOKE_IMAP_FOLDER) to run.');
    return;
  }

  const config = {
    imap_host: process.env.SMOKE_IMAP_HOST,
    imap_port: Number(process.env.SMOKE_IMAP_PORT),
    imap_tls: process.env.SMOKE_IMAP_TLS,
    imap_user: process.env.SMOKE_IMAP_USER,
    imap_password: process.env.SMOKE_IMAP_PASSWORD,
    imap_folder: process.env.SMOKE_IMAP_FOLDER || 'INBOX',
    sender_allowlist: process.env.SMOKE_IMAP_SENDER_ALLOWLIST || '',
  };

  console.log(`[smoke-imap] connecting to ${config.imap_host}:${config.imap_port} (${config.imap_tls})...`);
  const connection = await openConnection(config);
  try {
    // searchUnseen never mutates flags — this is a pure read-only diagnostic, safe to run
    // against a real mailbox without affecting what the actual plugin will see.
    const messages = await searchUnseen(connection, config);
    console.log(`[smoke-imap] connected and authenticated. UNSEEN message count in "${config.imap_folder}": ${messages.length}`);
    for (const message of messages) {
      console.log(`  - uid=${message.uid} messageId=${message.messageId || '(none)'}`);
    }
  } finally {
    connection.end();
  }
}

main().catch((err) => {
  console.error('[smoke-imap] failed:', err);
  process.exitCode = 1;
});
