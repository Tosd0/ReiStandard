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
  assert.deepEqual(result, { deleted: 1, kept: 1, keptBoundary: 0, aborted: false });
  assert.ok(await store.get(used));
  assert.equal(await store.get(orphan), null);
});

test('新鲜豁免：距创建不足 minAgeMs 的孤儿不删', async () => {
  const { store, adapter } = await seed(1);
  const result = await store.gc({ refSources: [], minAgeMs: 3 * DAY });
  assert.deepEqual(result, { deleted: 0, kept: 1, keptBoundary: 0, aborted: false });
  assert.equal(adapter.map.size, 1);
});

test('反解不出时间的存量 id 按「老」处理，孤儿即删', async () => {
  const { store, adapter } = await seed(0);
  adapter.map.set('img_legacy_0_xyz', blobOf('old'));
  const result = await store.gc({ refSources: [], minAgeMs: 3 * DAY });
  assert.deepEqual(result, { deleted: 1, kept: 0, keptBoundary: 0, aborted: false });
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
  assert.deepEqual(result, { deleted: 0, kept: 1, keptBoundary: 0, aborted: false });
});

test('自定义前缀的 store，GC 按该前缀提取引用', async () => {
  const adapter = memoryAdapter();
  const store = createBlobStore({ adapter, prefix: 'pic:' });
  const used = await store.put(blobOf('u'));
  const orphan = await store.put(blobOf('o'));
  const result = await store.gc({ refSources: [used], minAgeMs: 0 });
  assert.deepEqual(result, { deleted: 1, kept: 1, keptBoundary: 0, aborted: false });
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
  assert.deepEqual(result, { deleted: 0, kept: 0, keptBoundary: 0, aborted: true });
  assert.equal(adapter.map.size, 2);
});

test('refSources 的 [Symbol.iterator] 是「读」就抛的 getter → 仍是安全阀 aborted:true（真正钉住用 in 探测而非 typeof 读属性的选择——普通方法属性「读」不会触发，只有 getter 会）', async () => {
  const { store, adapter } = await seed(2);
  const poison = {
    get [Symbol.iterator]() { throw new Error('boom'); },
  };
  const result = await store.gc({ refSources: poison, minAgeMs: 0 });
  assert.deepEqual(result, { deleted: 0, kept: 0, keptBoundary: 0, aborted: true });
  assert.equal(adapter.map.size, 2);
});

test('minAgeMs 传成 NaN/null 等非「非负有限数字」→ 抛 TypeError，不静默关阀（NaN 让 `now - ts < minAgeMs` 恒 false，刚 put 的图会穿过新鲜豁免被删——正是这道阀要堵的竞态窗口；宿主 cfg.hours*3600000 而 cfg.hours 是 undefined 就会算出 NaN）', async () => {
  for (const bad of [NaN, null, Infinity, -1, '0']) {
    const { store, adapter } = await seed(1); // 刚 put、无引用：豁免一失效就会被删
    await assert.rejects(
      () => store.gc({ refSources: [], minAgeMs: bad }),
      { name: 'TypeError', message: /minAgeMs/ },
      `minAgeMs=${String(bad)} 应当抛 TypeError`,
    );
    assert.equal(adapter.map.size, 1);
  }
});

test('now 传成 NaN → 同款抛 TypeError（now 是 NaN 时 now - ts 也是 NaN，新鲜豁免同样恒不命中）', async () => {
  const { store, adapter } = await seed(1);
  await assert.rejects(() => store.gc({ refSources: [], now: NaN }), { name: 'TypeError', message: /now/ });
  assert.equal(adapter.map.size, 1);
});

test('默认新鲜豁免窗口是 72h：71h 内不删，73h 之后删', async () => {
  const { store, adapter } = await seed(1);
  const H = 3600 * 1000;
  // 不传 minAgeMs：71h 仍在默认豁免期内，73h 已过
  const base = Date.now();
  assert.deepEqual(await store.gc({ refSources: [], now: base + 71 * H }), { deleted: 0, kept: 1, keptBoundary: 0, aborted: false });
  assert.deepEqual(await store.gc({ refSources: [], now: base + 73 * H }), { deleted: 1, kept: 0, keptBoundary: 0, aborted: false });
});

test('adapter.delete 失败按 kept 计入、不抛，图还在', async () => {
  const { store, adapter, tokens } = await seed(1);
  adapter.delete = async () => { throw new Error('delete boom'); };
  const result = await store.gc({ refSources: [], minAgeMs: 0 });
  assert.deepEqual(result, { deleted: 0, kept: 1, keptBoundary: 0, aborted: false });
  assert.ok(await store.get(tokens[0]));
});

test('adapter.keys 读不出来 → 整轮放弃，不删', async () => {
  const { store, adapter } = await seed(1);
  adapter.keys = async () => { throw new Error('keys boom'); };
  const result = await store.gc({ refSources: [], minAgeMs: 0 });
  assert.deepEqual(result, { deleted: 0, kept: 0, keptBoundary: 0, aborted: true });
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
  assert.deepEqual(result, { deleted: 0, kept: 1, keptBoundary: 0, aborted: false });
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
  assert.deepEqual(result, { deleted: 0, kept: 2, keptBoundary: 0, aborted: false });
  assert.equal(adapter.map.size, 2);
});

test('refSources 吐出 undefined 与 null 同款跳过，不误触「非字符串」的 TypeError（某些存储 API 对缺失键吐的是 undefined）', async () => {
  const { store, tokens } = await seed(1);
  const [used] = tokens;
  async function* gen() {
    yield undefined;
    yield `wallpaper: ${used}`;
  }
  const result = await store.gc({ refSources: gen(), minAgeMs: 0 });
  assert.deepEqual(result, { deleted: 0, kept: 1, keptBoundary: 0, aborted: false });
});

test('sweep 反解 id 时间戳用的是 GC 注入的钟：相对注入钟落在未来 24h 外的 id 判外来、按「老」删除（内部偷用真实时钟的话会被新鲜豁免错误保护）', async () => {
  const { store, adapter } = await seed(0);
  const ts = Date.now() - 3600 * 1000; // 相对真实时钟只是 1 小时前的「新」id
  adapter.map.set(`b_${ts.toString(36)}_0_aaaaaa`, blobOf('x'));
  // 相对注入的钟，ts 落在 47 小时之后 → 反解判外来返回 null → 按「老」处理 → 无引用即删。
  // 反解若误用 Date.now()，ts 是合法的近期时间，会走进新鲜豁免（age 为负 < minAgeMs）被保留。
  const result = await store.gc({ refSources: [], now: ts - 47 * 3600 * 1000 });
  assert.deepEqual(result, { deleted: 1, kept: 0, keptBoundary: 0, aborted: false });
});

test('安全阀 6：令牌被拼进复合键（`${token}_thumb`）时不删——提取出的 id 比真实 id 长，真实 id 是它的前缀', async () => {
  const { store, tokens } = await seed(1);
  const [token] = tokens;
  // 令牌逐字可见、引用面也全，满足其他宿主义务的字面要求——但按最长词字符段截出的
  // id 是 'b_..._thumb'，真实 id 不在 mark 集里，没有这道阀就会删活图
  const result = await store.gc({
    refSources: [JSON.stringify({ thumbKey: `${token}_thumb` })],
    minAgeMs: 0,
  });
  assert.deepEqual(result, { deleted: 0, kept: 1, keptBoundary: 1, aborted: false });
  assert.ok(await store.get(token));
});

test('安全阀 6：refSources 分块恰好把令牌从 id 中间切开时不删——提出的半截 id 是真实 id 的前缀', async () => {
  const { store, tokens } = await seed(1);
  const [token] = tokens;
  const text = `wallpaper: ${token}`;
  const cut = text.length - 3; // 切在 id 内部：前块提出半截 id，后块提不出任何令牌
  const result = await store.gc({
    refSources: [text.slice(0, cut), text.slice(cut)],
    minAgeMs: 0,
  });
  assert.deepEqual(result, { deleted: 0, kept: 1, keptBoundary: 1, aborted: false });
  assert.ok(await store.get(token));
});

test('安全阀 6 的失效可观测性：引用面里一段杂散的「blobref:b_」文本会让全部 SDK id 命中互为前缀豁免、GC 整轮空转——keptBoundary 单独计数，宿主才分得清「没垃圾」和「阀被杂散文本卡死」', async () => {
  const { store, adapter } = await seed(3);
  // 一句讲解令牌格式的文案就够：提出的 id 'b_' 是每个 SDK 生成 id 的前缀。
  // deleted:0 与正常无垃圾同形，keptBoundary≈库存量是唯一的报警信号。
  const result = await store.gc({
    refSources: ['note: token format is blobref:b_ followed by stuff'],
    minAgeMs: 0,
  });
  assert.deepEqual(result, { deleted: 0, kept: 3, keptBoundary: 3, aborted: false });
  assert.equal(adapter.map.size, 3);
});

test('新鲜豁免先于边界歧义豁免：又新鲜又互为前缀的 id 记 kept 不记 keptBoundary（新鲜保留是常态，不该拉响排查信号）', async () => {
  const { store } = await seed(1); // 刚 put 的 id 新鲜，且 'blobref:b_' 提出的超短在用 id 'b_' 是它的前缀
  const result = await store.gc({
    refSources: ['note: token format is blobref:b_ followed by stuff'],
    minAgeMs: 3 * DAY,
  });
  assert.deepEqual(result, { deleted: 0, kept: 1, keptBoundary: 0, aborted: false });
});
