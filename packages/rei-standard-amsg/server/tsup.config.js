import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  // Two entries: the root (multi-tenant, Node) and a Cloudflare/D1-only entry
  // that omits the pg/neon/web-push graph so Worker bundles resolve on a
  // D1-only install. See src/server/cloudflare.js.
  entry: {
    index: 'src/server/index.js',
    cloudflare: 'src/server/cloudflare.js'
  },
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
  platform: 'node',
  target: 'node20',
  splitting: true,
  clean: true,
  // GET /capabilities 的 serverVersion：构建期把版本号焊进产物，
  // 避免手工维护一个会漂移的常量。
  define: {
    __AMSG_SERVER_VERSION__: JSON.stringify(pkg.version)
  }
});
