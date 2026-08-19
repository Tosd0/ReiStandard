import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.js', react: 'src/react.js' },
  format: ['cjs', 'esm'],
  // d.ts 由 build 脚本里单独的 tsc --allowJs --emitDeclarationOnly 生成，
  // 原因同 amsg/shared：tsup 的 dts 插件不认 .js 入口里的 JSDoc @typedef。
  dts: false,
  outDir: 'dist',
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
  platform: 'neutral',
  target: 'es2020',
  splitting: false,
  clean: true,
  external: ['react']
});
