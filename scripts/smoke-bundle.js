const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Proves the esbuild output in server/index.js is truly self-contained: TREK's runtime never runs
 * `npm install` and only injects `trek-plugin-sdk` (see CLAUDE.md's load-bearing facts), so anything
 * this bundle still `require()`s from a real node_modules tree would fail in production. This runs
 * the built bundle from a scratch directory with NO node_modules other than a stub `trek-plugin-sdk`
 * — a stray unbundled `require('imap-simple')`/`mailparser`/`node-ical` throws MODULE_NOT_FOUND here
 * exactly as it would inside TREK.
 */
function main() {
  console.log('[smoke-bundle] building...');
  execFileSync('node', [path.join(__dirname, 'build.js')], { stdio: 'inherit' });

  const bundlePath = path.join(__dirname, '..', 'server', 'index.js');
  if (!fs.existsSync(bundlePath)) {
    throw new Error('server/index.js was not produced by the build');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-itinerary-smoke-'));
  try {
    fs.copyFileSync(bundlePath, path.join(tmpDir, 'index.js'));

    const sdkStubDir = path.join(tmpDir, 'node_modules', 'trek-plugin-sdk');
    fs.mkdirSync(sdkStubDir, { recursive: true });
    fs.writeFileSync(
      path.join(sdkStubDir, 'package.json'),
      JSON.stringify({ name: 'trek-plugin-sdk', version: '0.0.0-stub', main: 'index.js' })
    );
    fs.writeFileSync(
      path.join(sdkStubDir, 'index.js'),
      'module.exports = { definePlugin: (def) => def, PLUGIN_API_VERSION: 1 };'
    );

    const checkScript = `
      const plugin = require('./index.js');
      if (typeof plugin.onLoad !== 'function') throw new Error('onLoad is not a function');
      if (!Array.isArray(plugin.jobs) || plugin.jobs.length !== 1) throw new Error('expected exactly one job');
      const job = plugin.jobs[0];
      if (job.id !== 'poll-inbox') throw new Error(\`unexpected job id: \${job.id}\`);
      if (job.schedule !== '*/5 * * * *') throw new Error(\`unexpected job schedule: \${job.schedule}\`);
      if (typeof job.handler !== 'function') throw new Error('job.handler is not a function');
      console.log('[smoke-bundle] bundle loaded cleanly: onLoad + jobs[0]=poll-inbox present');
    `;
    execFileSync('node', ['-e', checkScript], { cwd: tmpDir, stdio: 'inherit' });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('[smoke-bundle] PASS');
}

try {
  main();
} catch (err) {
  console.error('[smoke-bundle] FAIL:', err.message);
  process.exitCode = 1;
}
