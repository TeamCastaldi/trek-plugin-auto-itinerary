const path = require('path');
const { execFileSync } = require('child_process');
const { spawn } = require('child_process');
const http = require('http');

/**
 * Smoke-tests `trek-plugin-sdk dev` against the built plugin + dev-fixtures.json: confirms
 * onLoad/manifest/permissions load cleanly under the real SDK, AND — since the ingestion path is
 * now a `routes` handler rather than a `jobs` handler — actually POSTs a sample Resend
 * `email.received` payload at `/api/resend-webhook` to prove the route is reachable and rejects a
 * bad secret. It does not exercise the real Resend attachment-fetch (no network calls are made;
 * this only checks route wiring/auth, not `extractCalendar`), which is why the request body carries
 * no attachments and the plugin is expected to log-and-no-op rather than build a trip.
 */
const PORT = 41317; // fixed, unlikely-used dev port so failures are unambiguous, not a race

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function post(url, jsonBody) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(jsonBody));
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': data.length },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end(data);
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await get(url);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw lastErr || new Error('timed out waiting for dev server');
}

async function main() {
  console.log('[smoke-dev] building...');
  execFileSync('node', [path.join(__dirname, 'build.js')], { stdio: 'inherit' });

  console.log(`[smoke-dev] starting trek-plugin-sdk dev --port ${PORT}...`);
  const repoRoot = path.join(__dirname, '..');
  const child = spawn('npx', ['trek-plugin-sdk', 'dev', repoRoot, '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));

  try {
    const { status, body } = await waitForServer(`http://localhost:${PORT}/`, 10000);
    if (status !== 200) {
      throw new Error(`dashboard returned status ${status}`);
    }
    if (/failed to load/i.test(body) || /failed to load/i.test(stdout) || /failed to load/i.test(stderr)) {
      throw new Error(`plugin failed to load — dev output:\n${stdout}\n${stderr}`);
    }
    if (!body.includes('auto-itinerary')) {
      throw new Error(`dashboard did not mention the plugin id — body:\n${body}`);
    }
    console.log('[smoke-dev] dashboard responded 200, no load failure, plugin id present');

    const noOpPayload = { type: 'email.received', data: { email_id: 'smoke_1', attachments: [] } };

    const rejected = await post(`http://localhost:${PORT}/api/resend-webhook?secret=wrong`, noOpPayload);
    if (rejected.status !== 401) {
      throw new Error(`expected 401 for a bad webhook secret, got ${rejected.status}: ${rejected.body}`);
    }
    console.log('[smoke-dev] /api/resend-webhook rejects a bad secret with 401');

    const accepted = await post(`http://localhost:${PORT}/api/resend-webhook?secret=dev-secret`, noOpPayload);
    if (accepted.status !== 200) {
      throw new Error(`expected 200 for a valid webhook secret, got ${accepted.status}: ${accepted.body}`);
    }
    console.log('[smoke-dev] /api/resend-webhook accepts a valid secret and processes the payload');

    console.log('[smoke-dev] PASS');
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('[smoke-dev] FAIL:', err.message);
  process.exitCode = 1;
});
