import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/server/index.js' },
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
