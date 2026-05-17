import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.js',
    'adapters/cloudflare': 'src/adapters/cloudflare.js',
    'adapters/node': 'src/adapters/node.js',
    'adapters/netlify': 'src/adapters/netlify.js',
    'adapters/vercel': 'src/adapters/vercel.js'
  },
  format: ['cjs', 'esm'],
  dts: true,
  outDir: 'dist',
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
  platform: 'neutral',
  target: 'node20',
  splitting: false,
  clean: true,
  // Only the Node adapter touches `node:crypto` (lazily, for the Node 18
  // WebCrypto polyfill). Keep it externalized so the bundler doesn't try
  // to inline a non-existent module on Workers / Edge.
  external: ['node:crypto']
});
