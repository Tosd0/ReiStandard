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
  const { store, tokens } = await seed(2);
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
  const result = await store.gc({ refSources: gen(), minAgeMs: 0 });
  assert.deepEqual(result, { deleted: 0, kept: 1, aborted: false });
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
  await assert.rejects(() => store.gc({}), { name: 'TypeError', message: /refSources/ });
});

test('refSources 传成裸字符串会被逐字符迭代、什么都标记不到——必须抛错，不能静默清库', async () => {
  const { store, adapter, tokens } = await seed(2);
  const [used] = tokens;
  await assert.rejects(
    () => store.gc({ refSources: JSON.stringify({ wallpaper: used }), minAgeMs: 0 }),
    TypeError,
  );
  assert.equal(adapter.map.size, 2);
});

test('refSources 里混进非字符串行对象（忘了 JSON.stringify）→ 抛错，不删', async () => {
  const { store, adapter, tokens } = await seed(2);
  const [used] = tokens;
  async function* gen() { yield { wallpaper: used }; }
  await assert.rejects(() => store.gc({ refSources: gen(), minAgeMs: 0 }), TypeError);
  assert.equal(adapter.map.size, 2);
});

test('refSources 传成不可迭代的真值对象 → 抛错（原先会被 for-await 静默判成来源坏了，返回 aborted:true）', async () => {
  const { store, adapter } = await seed(1);
  await assert.rejects(() => store.gc({ refSources: { a: 1 }, minAgeMs: 0 }), TypeError);
  assert.equal(adapter.map.size, 1);
});

test('refSources 传成没 await 的 Promise → 抛错（同样原先会被静默判成来源坏了）', async () => {
  const { store, adapter } = await seed(1);
  await assert.rejects(() => store.gc({ refSources: Promise.resolve([]), minAgeMs: 0 }), TypeError);
  assert.equal(adapter.map.size, 1);
});

test('refSources 的 [Symbol.iterator] 存在但一调用就抛 → 仍是安全阀 aborted:true，不是被护栏提前拒绝', async () => {
  const { store, adapter } = await seed(2);
  const poison = {
    [Symbol.iterator]() { throw new Error('boom'); },
  };
  const result = await store.gc({ refSources: poison, minAgeMs: 0 });
  assert.deepEqual(result, { deleted: 0, kept: 0, aborted: true });
  assert.equal(adapter.map.size, 2);
});

test('refSources 的 [Symbol.iterator] 是「读」就抛的 getter → 仍是安全阀 aborted:true（真正钉住用 in 探测而非 typeof 读属性的选择——普通方法属性「读」不会触发，只有 getter 会）', async () => {
  const { store, adapter } = await seed(2);
  const poison = {
    get [Symbol.iterator]() { throw new Error('boom'); },
  };
  const result = await store.gc({ refSources: poison, minAgeMs: 0 });
  assert.deepEqual(result, { deleted: 0, kept: 0, aborted: true });
  assert.equal(adapter.map.size, 2);
});

test('默认新鲜豁免窗口是 72h：71h 内不删，73h 之后删', async () => {
  const { store, adapter } = await seed(1);
  const H = 3600 * 1000;
  // 不传 minAgeMs：71h 仍在默认豁免期内，73h 已过
  const base = Date.now();
  assert.deepEqual(await store.gc({ refSources: [], now: base + 71 * H }), { deleted: 0, kept: 1, aborted: false });
  assert.deepEqual(await store.gc({ refSources: [], now: base + 73 * H }), { deleted: 1, kept: 0, aborted: false });
});

test('adapter.delete 失败按 kept 计入、不抛，图还在', async () => {
  const { store, adapter, tokens } = await seed(1);
  adapter.delete = async () => { throw new Error('delete boom'); };
  const result = await store.gc({ refSources: [], minAgeMs: 0 });
  assert.deepEqual(result, { deleted: 0, kept: 1, aborted: false });
  assert.ok(await store.get(tokens[0]));
});

test('adapter.keys 读不出来 → 整轮放弃，不删', async () => {
  const { store, adapter } = await seed(1);
  adapter.keys = async () => { throw new Error('keys boom'); };
  const result = await store.gc({ refSources: [], minAgeMs: 0 });
  assert.deepEqual(result, { deleted: 0, kept: 0, aborted: true });
  assert.equal(adapter.map.size, 1);
});

test('refSources 吐出 null 会被跳过，后续字符串里的令牌照常标记（localStorage.getItem 合法吐 null）', async () => {
  const { store, tokens } = await seed(1);
  const [used] = tokens;
  async function* gen() {
    yield null;
    yield `wallpaper: ${used}`;
  }
  const result = await store.gc({ refSources: gen(), minAgeMs: 0 });
  assert.deepEqual(result, { deleted: 0, kept: 1, aborted: false });
  assert.ok(await store.get(used));
});

test('refSources 里非字符串行对象先出现、后面那句才抛错——先报「传错类型」，不会被后面的抛错吞成 aborted（钉住 break 而非 continue 的选择）', async () => {
  const { store, adapter, tokens } = await seed(2);
  const [used] = tokens;
  async function* gen() {
    yield { wallpaper: used }; // 非字符串，先出现：break 立刻掐断，后面这句永远不会执行到
    throw new Error('source broke'); // 若用 continue 迭代下去，这句才会真正抛出、把误用吞成 aborted:true
  }
  await assert.rejects(() => store.gc({ refSources: gen(), minAgeMs: 0 }), TypeError);
  assert.equal(adapter.map.size, 2);
});

test('超出令牌字符集的 id（如 UUID 带 -）一律保留：extractRefs 会在越界字符处截断，这类 id 不可能被 mark 到，「无引用」不构成孤儿证据', async () => {
  const { store, adapter } = await seed(0);
  const referenced = '550e8400-e29b-41d4-a716-446655440000';
  const stray = 'a1b2c3d4-ffff-0000-8888-123456789abc';
  adapter.map.set(referenced, blobOf('u'));
  adapter.map.set(stray, blobOf('o'));
  // referenced 明明被业务字段引用，但 mark 集里只有截断的半截 'blobref:550e8400'——
  // 没有字符集豁免的话，两个都会被当孤儿删掉（含被引用的活图）
  const result = await store.gc({
    refSources: [JSON.stringify({ wallpaper: 'blobref:' + referenced })],
    minAgeMs: 0,
  });
  assert.deepEqual(result, { deleted: 0, kept: 2, aborted: false });
  assert.equal(adapter.map.size, 2);
});
