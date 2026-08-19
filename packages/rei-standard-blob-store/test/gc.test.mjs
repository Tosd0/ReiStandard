import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlobStore } from '../src/store.js';
import { memoryAdapter } from './helpers.mjs';

const blobOf = (s) => new Blob([s], { type: 'text/plain' });
const DAY = 24 * 3600 * 1000;

/** 建一个 store，塞 n 个 blob，返回 { store, adapter, tokens }。 */
async function seed(n) {
  const adapter = memoryAdapter();
  const store = createBlobStore({ adapter });
  const tokens = [];
  for (let i = 0; i < n; i++) tokens.push(await store.put(blobOf('b' + i)));
  return { store, adapter, tokens };
}

test('老孤儿被删，被引用的保留', async () => {
  const { store, adapter, tokens } = await seed(2);
  const [used, orphan] = tokens;
  const result = await store.gc({
    refSources: [JSON.stringify({ wallpaper: used })],
    minAgeMs: 0, // 全部视为老，聚焦引用判定
  });
  assert.deepEqual(result, { deleted: 1, kept: 1, aborted: false });
  assert.ok(await store.get(used));
  assert.equal(await store.get(orphan), null);
});

test('新鲜豁免：距创建不足 minAgeMs 的孤儿不删', async () => {
  const { store, adapter } = await seed(1);
  const result = await store.gc({ refSources: [], minAgeMs: 3 * DAY });
  assert.deepEqual(result, { deleted: 0, kept: 1, aborted: false });
  assert.equal(adapter.map.size, 1);
});

test('反解不出时间的存量 id 按「老」处理，孤儿即删', async () => {
  const { store, adapter } = await seed(0);
  adapter.map.set('img_legacy_0_xyz', blobOf('old'));
  const result = await store.gc({ refSources: [], minAgeMs: 3 * DAY });
  assert.deepEqual(result, { deleted: 1, kept: 0, aborted: false });
});

test('任一 refSource 抛错 → 整轮放弃，一个都不删', async () => {
  const { store, adapter } = await seed(2);
  async function* poison() {
    yield 'something';
    throw new Error('source broke');
  }
  const result = await store.gc({ refSources: poison(), minAgeMs: 0 });
  assert.equal(result.aborted, true);
  assert.equal(result.deleted, 0);
  assert.equal(adapter.map.size, 2);
});

test('refSources 支持 async generator（数组形态首个测试已覆盖）', async () => {
  const { store, tokens } = await seed(1);
  async function* gen() { yield `x ${tokens[0]} y`; }
  const r1 = await store.gc({ refSources: gen(), minAgeMs: 0 });
  assert.deepEqual(r1, { deleted: 0, kept: 1, aborted: false });
});

test('自定义前缀的 store，GC 按该前缀提取引用', async () => {
  const adapter = memoryAdapter();
  const store = createBlobStore({ adapter, prefix: 'pic:' });
  const used = await store.put(blobOf('u'));
  const orphan = await store.put(blobOf('o'));
  const result = await store.gc({ refSources: [used], minAgeMs: 0 });
  assert.deepEqual(result, { deleted: 1, kept: 1, aborted: false });
  assert.ok(await store.get(used));
  assert.equal(await store.get(orphan), null);
});

test('缺 refSources 直接抛（编程错误，不是静默全删）', async () => {
  const { store } = await seed(1);
  await assert.rejects(() => store.gc({}));
});
