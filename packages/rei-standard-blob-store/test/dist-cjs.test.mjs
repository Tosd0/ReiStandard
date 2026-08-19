// 对着 dist/index.cjs 跑的产物契约测试：CJS 构建必须以严格模式运行。
// esbuild（platform: neutral）降级 ESM→CJS 不会自带 "use strict"，Node 的 CJS 包裹
// 默认 sloppy mode——resolveDeep「frozen 节点会抛」的护栏在那里会静默失效：赋值 no-op、
// 不报错、令牌无声留在「备份」里，违反「备份文件里永远没有令牌」的核心不变量，
// 且 ESM 消费端（Vite 产线）和 CJS 消费端（Jest 测试）会拿到两种行为。
// tsup.config.js 用 cjs banner 补 pragma，这条测试钉住产物行为本身，源码测试抓不到它。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { memoryAdapter } from './helpers.mjs';

const distCjs = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.cjs');

test('dist/index.cjs 以严格模式运行：resolveDeep 遇 frozen 节点吵着抛，不静默漏令牌', async () => {
  assert.ok(existsSync(distCjs), '没找到 dist/index.cjs——先 npm run build 再跑测试（仓库根 npm run ci 自带构建）');
  // 变量名刻意不叫 require：check:esm 的 CJS token 扫描是逐行正则，不认「这里就是要加载 CJS 产物」的用途
  const requireDist = createRequire(import.meta.url);
  const { createBlobStore } = requireDist(distCjs);
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.put(new Blob(['x'], { type: 'text/plain' }));
  const frozen = Object.freeze({ wallpaper: token });
  await assert.rejects(() => store.resolveDeep(frozen), TypeError);
  assert.equal(frozen.wallpaper, token); // 抛了就没动过：令牌还在原字段，没有半还原的中间态
});
