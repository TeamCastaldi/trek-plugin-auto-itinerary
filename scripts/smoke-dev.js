const path = require('path');
const { execFileSync } = require('child_process');
const { spawn } = require('child_process');
const http = require('http');

/**
 * Smoke-tests `trek-plugin-sdk dev` against the built plugin + dev-fixtures.json. Per docs/PLAN.md
 * §5's corrected "Local run" row: `dev` only calls onLoad and serves plugin.routes — it never runs
 * `jobs` (confirmed by reading the installed SDK's dist/cli/dev.js) — so this only proves the
 * manifest/permissions/onLoad load cleanly under the real SDK, not that poll-inbox executes (that's
 * covered by the processMessage unit/integration tests).
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
    console.log('[smoke-dev] PASS');
  } finally {
    child.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('[smoke-dev] FAIL:', err.message);
  process.exitCode = 1;
});
