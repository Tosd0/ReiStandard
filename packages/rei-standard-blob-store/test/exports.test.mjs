import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as api from '../src/index.js';
import * as reactApi from '../src/react.js';

test('公共出口恰好是这些（加导出要有意识地改这里）', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'DEFAULT_PREFIX',
    'blobToDataUrl',
    'createBlobStore',
    'createIdbAdapter',
    'dataUrlToBlob',
    'extractRefs',
  ]);
});

test('store 实例的方法表面', async () => {
  const store = api.createBlobStore({
    adapter: { get: async () => null, put: async () => {}, delete: async () => {}, keys: async () => [] },
  });
  assert.deepEqual(Object.keys(store).sort(), ['delete', 'gc', 'get', 'isRef', 'migrateDataUrl', 'prefix', 'put', 'resolveDeep', 'resolveToDataUrl', 'restore']);
  assert.equal(store.prefix, 'blobref:');
});

test('./react 子路径的公共出口', () => {
  assert.deepEqual(Object.keys(reactApi).sort(), ['useBlobUrl']);
});

test('exports map：import 分支的 types 接 .d.ts、require 分支接 .d.cts，且 types 放分支第一位（TS 按条件顺序取第一个命中的，types 靠后会被运行时条件盖掉；require 分支若指 .d.ts，node16 的 CJS 消费端编译报 TS1479）', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const subpath of ['.', './react']) {
    const entry = pkg.exports[subpath];
    for (const [cond, ext] of [['import', '.d.ts'], ['require', '.d.cts']]) {
      const branch = entry[cond];
      assert.equal(typeof branch, 'object', `${subpath} 的 ${cond} 分支应是带 types 的对象，不是裸文件路径`);
      assert.equal(Object.keys(branch)[0], 'types', `${subpath} 的 ${cond} 分支 types 必须在第一位`);
      assert.ok(branch.types.endsWith(ext), `${subpath} 的 ${cond} 分支 types 应以 ${ext} 结尾，拿到 ${branch.types}`);
      assert.ok(branch.default, `${subpath} 的 ${cond} 分支要有 default 运行时入口`);
    }
  }
});

test('dist 的 .d.cts 里不许残留指向 .js 的相对引用——包是 type:module，那会解析回 ESM 口味的 .d.ts，CJS 消费端照样 TS1479（钉住 scripts/emit-dcts.mjs 的改写，防退化回逐字拷贝）', () => {
  const distDir = fileURLToPath(new URL('../dist/', import.meta.url));
  assert.ok(existsSync(`${distDir}index.d.cts`), '没找到 dist/index.d.cts——先 npm run build 再跑测试（仓库根 npm run ci 自带构建）');
  for (const f of readdirSync(distDir)) {
    if (!f.endsWith('.d.cts')) continue;
    const text = readFileSync(`${distDir}${f}`, 'utf8');
    assert.ok(!/["']\.\.?\/[^"']*\.js["']/.test(text), `${f} 里还有指向 .js 的相对引用（应改写成 .cjs 指向孪生 .d.cts）`);
  }
});
