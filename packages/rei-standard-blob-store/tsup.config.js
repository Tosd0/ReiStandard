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
  external: ['react'],
  esbuildOptions(options, context) {
    // esbuild 降级 ESM→CJS 不会自动加 "use strict"，而 Node 的 CJS 包裹默认 sloppy mode——
    // resolveDeep「frozen 节点会抛」的护栏在 CJS 消费端会静默失效（赋值 no-op，令牌
    // 无声留在备份里，违反「备份文件里永远没有令牌」）。补 pragma 让双格式行为一致；
    // test/dist-cjs.test.mjs 对着产物钉住这条。
    if (context.format === 'cjs') options.banner = { ...options.banner, js: '"use strict";' };
  }
});
