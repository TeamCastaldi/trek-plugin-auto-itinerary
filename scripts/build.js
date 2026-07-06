const esbuild = require('esbuild');

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
