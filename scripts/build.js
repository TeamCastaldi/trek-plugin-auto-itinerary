const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

function generateManifest() {
  const templatePath = path.join(__dirname, '..', 'trek-plugin.template.json');
  const outPath = path.join(__dirname, '..', 'trek-plugin.json');
  const manifest = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

  const hosts = (process.env.EGRESS_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  if (hosts.length === 0) {
    console.warn(
      '[build] EGRESS_HOSTS not set — generating manifest with no egress permissions. ' +
        'Set EGRESS_HOSTS (comma-separated hostnames) before `npm run pack` for a real deployment.'
    );
  } else {
    manifest.egress = hosts;
    for (const host of hosts) {
      const perm = `http:outbound:${host}`;
      if (!manifest.permissions.includes(perm)) {
        manifest.permissions.push(perm);
      }
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[build] wrote trek-plugin.json (egress hosts: ${hosts.length ? hosts.join(', ') : 'none'})`);
}

generateManifest();

esbuild.buildSync({
  entryPoints: ['src/index.js'],
  outfile: 'server/index.js',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  external: ['trek-plugin-sdk'],
  logLevel: 'info',
});
