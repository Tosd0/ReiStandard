import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.js' },
  format: ['cjs', 'esm'],
  dts: true,
  outDir: 'dist',
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
  platform: 'browser',
  target: 'es2020',
  splitting: false,
  clean: true
});
