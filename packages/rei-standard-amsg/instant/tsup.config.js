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
  external: ['web-push', 'node:crypto', 'crypto']
});
