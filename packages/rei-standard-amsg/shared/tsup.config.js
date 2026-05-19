import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.js' },
  format: ['cjs', 'esm'],
  // dts is emitted by a separate `tsc --allowJs --emitDeclarationOnly`
  // step in the build script — tsup's bundled dts plugin does not
  // extract JSDoc `@typedef`s from .js entries, so it would otherwise
  // ship the JS source verbatim as the .d.ts and TS consumers would
  // see zero types.
  dts: false,
  outDir: 'dist',
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
  platform: 'neutral',
  target: 'es2020',
  splitting: false,
  clean: true
});
