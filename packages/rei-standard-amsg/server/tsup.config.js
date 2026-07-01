import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries: the root (multi-tenant, Node) and a Cloudflare/D1-only entry
  // that omits the pg/neon/web-push graph so Worker bundles resolve on a
  // D1-only install. See src/server/cloudflare.js.
  entry: {
    index: 'src/server/index.js',
    cloudflare: 'src/server/cloudflare.js'
  },
  format: ['cjs', 'esm'],
  dts: true,
  outDir: 'dist',
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
  platform: 'node',
  target: 'node20',
  splitting: true,
  clean: true
});
