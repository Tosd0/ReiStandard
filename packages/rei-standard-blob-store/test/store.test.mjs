import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlobStore } from '../src/store.js';
import { memoryAdapter, brokenAdapter } from './helpers.mjs';

const blobOf = (s) => new Blob([s], { type: 'text/plain' });

test('put 返回带前缀令牌，get 取回同内容', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  assert.equal(store.prefix, 'blobref:');
  const token = await store.put(blobOf('hello'));
  assert.ok(store.isRef(token));
  assert.match(token, /^blobref:b_/);
  assert.equal(await (await store.get(token)).text(), 'hello');
});

test('get：非令牌 / 不存在 / 适配器抛错 → null，不抛', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  assert.equal(await store.get('data:image/png;base64,AAAA'), null);
  assert.equal(await store.get('blobref:b_missing_0_aaaaaa'), null);
  const broken = createBlobStore({ adapter: brokenAdapter() });
  assert.equal(await broken.get('blobref:b_1_0_aaaaaa'), null);
});

test('get：适配器返回 undefined 时归一化为 null（?? null 兜底，别让 undefined 泄漏给调用方）', async () => {
  const adapter = { get: async () => undefined, put: async () => {}, delete: async () => {}, keys: async () => [] };
  const store = createBlobStore({ adapter });
  assert.equal(await store.get('blobref:b_1_0_aaaaaa'), null);
});

test('put 失败向上抛（调用方必须知道图没存进去）', async () => {
  const store = createBlobStore({ adapter: brokenAdapter() });
  await assert.rejects(() => store.put(blobOf('x')));
});

test('delete best-effort：非令牌不动、适配器抛错吞掉', async () => {
  const adapter = memoryAdapter();
  const store = createBlobStore({ adapter });
  const token = await store.put(blobOf('bye'));
  await store.delete('data:xxx'); // 不抛
  assert.equal(adapter.map.size, 1); // 非令牌没有误伤真数据
  await store.delete(token);
  assert.equal(adapter.map.size, 0);
  await createBlobStore({ adapter: brokenAdapter() }).delete('blobref:b_1_0_aaaaaa'); // 不抛
});

test('delete：非令牌根本不碰适配器', async () => {
  const calls = [];
  const adapter = { get: async () => null, put: async () => {}, delete: async (id) => { calls.push(id); }, keys: async () => [] };
  await createBlobStore({ adapter }).delete('data:xxx');
  assert.deepEqual(calls, []);
});

test('resolveToDataUrl：令牌→data URL、非令牌透传、丢图→空串', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.put(blobOf('pic'));
  assert.match(await store.resolveToDataUrl(token), /^data:text\/plain;base64,/);
  assert.equal(await store.resolveToDataUrl('https://a/b.png'), 'https://a/b.png');
  assert.equal(await store.resolveToDataUrl('blobref:b_gone_0_aaaaaa'), '');
});

test('resolveToDataUrl：适配器返回的不是真正的 Blob，编码失败也不 reject，按丢图处理返回空串', async () => {
  const adapter = { get: async () => ({}), put: async () => {}, delete: async () => {}, keys: async () => [] };
  const store = createBlobStore({ adapter });
  assert.equal(await store.resolveToDataUrl('blobref:b_1_0_aaaaaa'), '');
});

test('migrateDataUrl：成功返回令牌且字节不丢，坏输入回退原串', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.migrateDataUrl('data:text/plain;base64,aGk=');
  assert.ok(store.isRef(token));
  assert.equal(await (await store.get(token)).text(), 'hi');
  assert.equal(await store.migrateDataUrl('not-a-data-url'), 'not-a-data-url');
});

test('migrateDataUrl：存储失败也回退原串（区别于坏输入分支）', async () => {
  const store = createBlobStore({ adapter: brokenAdapter() });
  const dataUrl = 'data:text/plain;base64,aGk=';
  assert.equal(await store.migrateDataUrl(dataUrl), dataUrl);
});

test('自定义前缀贯穿 put/isRef/get', async () => {
  const store = createBlobStore({ adapter: memoryAdapter(), prefix: 'pic:' });
  assert.equal(store.prefix, 'pic:');
  const token = await store.put(blobOf('p'));
  assert.match(token, /^pic:b_/);
  assert.ok(store.isRef(token));
  assert.ok(!store.isRef('blobref:b_1_0_aaaaaa'));
  assert.equal(await (await store.get(token)).text(), 'p');
});

test('空前缀在工厂阶段直接抛（否则 isRef 会匹配一切字符串，resolveToDataUrl 把真实 data URL 都清空）', () => {
  assert.throws(
    () => createBlobStore({ adapter: memoryAdapter(), prefix: '' }),
    { name: 'TypeError', message: /prefix/ }
  );
});

test('缺 adapter 直接抛（编程错误）', () => {
  assert.throws(() => createBlobStore({}), { name: 'TypeError', message: /adapter/ });
});

test('resolveDeep：嵌套对象/数组里的令牌原地变 data URL，丢图置空串', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.put(blobOf('deep'));
  const root = {
    theme: { wallpaper: token, color: '#fff' },
    icons: [token, 'https://a/b.png'],
    dead: 'blobref:b_gone_0_aaaaaa',
  };
  await store.resolveDeep(root);
  assert.match(root.theme.wallpaper, /^data:text\/plain;base64,/);
  assert.equal(root.icons[0], root.theme.wallpaper);
  assert.equal(root.icons[1], 'https://a/b.png');
  assert.equal(root.dead, '');
});

test('resolveDeep：同一令牌只读一次适配器', async () => {
  const adapter = memoryAdapter();
  let reads = 0;
  const counting = { ...adapter, get: async (id) => { reads++; return adapter.get(id); } };
  const store = createBlobStore({ adapter: counting });
  const token = await store.put(blobOf('once'));
  await store.resolveDeep({ a: token, b: { c: token }, d: [token] });
  assert.equal(reads, 1);
});

test('resolveDeep：数组有洞照样走完（备份树里任何一个洞都不该让整份导出失败）', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.put(blobOf('sparse'));
  // structuredClone 会原样保留洞，而「传独立副本」最顺手的做法正是 structuredClone
  const root = structuredClone({ icons: [token, , 'https://a/b.png'], tags: ['x', , 'y'] });
  const dropped = [token, 'gone'];
  delete dropped[1]; // delete 留下的洞是另一条来源
  root.dropped = dropped;
  await store.resolveDeep(root);
  assert.match(root.icons[0], /^data:text\/plain;base64,/);
  assert.equal(root.icons.length, 3);
  assert.equal(root.icons[2], 'https://a/b.png');
  assert.equal(root.tags[2], 'y'); // 跟令牌毫无关系的洞同样不能中断遍历
  assert.match(root.dropped[0], /^data:text\/plain;base64,/);
});

test('resolveDeep：环里的令牌照样还原（防循环不能顺手把子树跳过）', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.put(blobOf('cycle'));
  const a = { name: 'a', pic: token };
  a.self = a;
  await store.resolveDeep(a);
  assert.match(a.pic, /^data:text\/plain;base64,/);
  assert.equal(a.self, a);
});

test('resolveDeep：适配器全挂也不 reject，令牌全部变空串', async () => {
  const store = createBlobStore({ adapter: brokenAdapter() });
  const root = { a: 'blobref:b_1_0_aaaaaa', b: { c: 'blobref:b_2_0_bbbbbb' } };
  await store.resolveDeep(root);
  assert.equal(root.a, '');
  assert.equal(root.b.c, '');
});

test('resolveDeep：死令牌出现 3 次也只读一次适配器（空串同样要走缓存，不能被当成"没缓存过"）', async () => {
  const adapter = memoryAdapter();
  let reads = 0;
  const counting = { ...adapter, get: async (id) => { reads++; return adapter.get(id); } };
  const store = createBlobStore({ adapter: counting });
  const dead = 'blobref:b_gone_0_aaaaaa';
  const root = { a: dead, b: { c: dead }, d: [dead] };
  await store.resolveDeep(root);
  assert.equal(root.a, '');
  assert.equal(root.b.c, '');
  assert.equal(root.d[0], '');
  assert.equal(reads, 1);
});

test('put 传非 Blob（如误传 data URL 字符串 / undefined）抛 TypeError，不产出死令牌', async () => {
  const adapter = memoryAdapter();
  const store = createBlobStore({ adapter });
  await assert.rejects(() => store.put('data:image/png;base64,AAAA'), TypeError);
  await assert.rejects(() => store.put(undefined), TypeError);
  await assert.rejects(() => store.put({ size: 3, type: 'image/png' }), TypeError);
  assert.equal(adapter.map.size, 0); // 什么都没存进去
});

test('中缀含令牌的普通字符串不是令牌（令牌必须在 0 位）：isRef false、resolve 原样透传，resolveDeep 不抹掉这类字段', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const css = 'url(blobref:b_1_0_aaaaaa)'; // CSS 值这类中缀形态，误判成令牌会被 resolve 清成空串
  assert.equal(store.isRef(css), false);
  assert.equal(await store.resolveToDataUrl(css), css);
  const root = { style: css };
  await store.resolveDeep(root);
  assert.equal(root.style, css);
});

test('put 鸭子判定两叉都要真：有 arrayBuffer 没 slice 的冒牌对象同样拒收', async () => {
  const adapter = memoryAdapter();
  const store = createBlobStore({ adapter });
  await assert.rejects(() => store.put({ arrayBuffer: async () => new ArrayBuffer(0) }), TypeError);
  assert.equal(adapter.map.size, 0);
});

test('restore：把 Blob 写回令牌原有的 id 下，get 取回同字节同 type（备份导入不换 id，令牌身份不丢）', async () => {
  const adapter = memoryAdapter();
  const store = createBlobStore({ adapter });
  const token = 'blobref:b_1_0_aaaaaa';
  await store.restore(token, new Blob(['restored'], { type: 'image/png' }));
  assert.ok(adapter.map.has('b_1_0_aaaaaa')); // 写在令牌原 id 下，不是新生成的 id
  const blob = await store.get(token);
  assert.equal(await blob.text(), 'restored');
  assert.equal(blob.type, 'image/png');
});

test('restore 拒收：错误前缀 / 非令牌 / 字符集外 id / 空 id / 非 Blob，各自抛 TypeError 且什么都没写', async () => {
  const adapter = memoryAdapter();
  const store = createBlobStore({ adapter });
  const ok = blobOf('x');
  await assert.rejects(() => store.restore('pic:b_1_0_aaaaaa', ok), TypeError); // 别的 store 的令牌
  await assert.rejects(() => store.restore('b_1_0_aaaaaa', ok), TypeError); // 裸 id 不是令牌
  await assert.rejects(() => store.restore('blobref:550e8400-e29b', ok), TypeError); // 含 `-`：extractRefs 提不全、GC 永不能回收
  await assert.rejects(() => store.restore('blobref:', ok), TypeError); // 空 id
  await assert.rejects(() => store.restore('blobref:b_1_0_aaaaaa', 'data:image/png;base64,AAAA'), TypeError); // 非 Blob
  await assert.rejects(() => store.restore('blobref:b_1_0_aaaaaa', { arrayBuffer: async () => new ArrayBuffer(0) }), TypeError); // 鸭子判定与 put 同款，两叉都要真
  assert.equal(adapter.map.size, 0);
});

test('restore 同 id 二次写入是覆盖（同一份备份导两遍幂等），get 拿到第二次的内容', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = 'blobref:b_1_0_aaaaaa';
  await store.restore(token, blobOf('first'));
  await store.restore(token, blobOf('second'));
  assert.equal(await (await store.get(token)).text(), 'second');
});

test('restore 适配器写失败向上抛（与 put 同族：调用方必须知道没写进去）', async () => {
  const store = createBlobStore({ adapter: brokenAdapter() });
  await assert.rejects(() => store.restore('blobref:b_1_0_aaaaaa', blobOf('x')));
});

test('restore 的老 id 没有新鲜豁免（README「导入期间别并发跑 GC」义务的回归守卫）：引用落盘前撞上 GC 即被删，落盘后才安全', async () => {
  const DAY = 24 * 3600 * 1000;
  // 老时间戳 id：restore 写回的正是备份里的原 id，反解出的创建时间是当年的，不是导入这一刻
  const token = `blobref:b_${(Date.now() - 10 * DAY).toString(36)}_0_aaaaaa`;

  // 引用已落盘：GC 保留
  const safe = createBlobStore({ adapter: memoryAdapter() });
  await safe.restore(token, blobOf('safe'));
  assert.deepEqual(
    await safe.gc({ refSources: [JSON.stringify({ wallpaper: token })] }),
    { deleted: 0, kept: 1, keptBoundary: 0, aborted: false },
  );
  assert.ok(await safe.get(token));

  // 引用尚未落盘：默认 minAgeMs（72h）下照删——新鲜豁免按 id 时间戳算，救不了老 id
  const exposed = createBlobStore({ adapter: memoryAdapter() });
  await exposed.restore(token, blobOf('gone'));
  assert.deepEqual(
    await exposed.gc({ refSources: [] }),
    { deleted: 1, kept: 0, keptBoundary: 0, aborted: false },
  );
  assert.equal(await exposed.get(token), null);
});

test('resolveDeep 覆盖数组上的 expando 属性（structuredClone 会保留它们，漏了令牌就进备份）', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.put(blobOf('x'));
  const arr = [token];
  arr.cover = token;
  const root = { list: arr };
  await store.resolveDeep(root);
  assert.match(root.list[0], /^data:/);
  assert.match(root.list.cover, /^data:/);
});

test('resolveDeep 整块跳过二进制视图（TypedArray/DataView）：不逐下标枚举，令牌照常还原', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.put(blobOf('x'));
  const wave = new Uint8Array(64);
  const view = new DataView(new ArrayBuffer(16));
  const root = { img: token, wave, nested: { view } };
  // 计时断言在快慢机器间不可靠，直接钉「有没有枚举」这个行为本身：实现用 Object.keys
  // 展开节点，拿它当探针——视图进过 Object.keys 就算失守（它对 TypedArray 返回全部
  // 下标键，几十 MB 的波形/纹理会把备份导出拖垮甚至 OOM）。
  const realKeys = Object.keys;
  let enumeratedView = false;
  Object.keys = (o) => {
    if (ArrayBuffer.isView(o)) enumeratedView = true;
    return realKeys(o);
  };
  try {
    await store.resolveDeep(root);
  } finally {
    Object.keys = realKeys;
  }
  assert.equal(enumeratedView, false);
  assert.match(root.img, /^data:/);
  assert.equal(root.wave, wave); // 视图原封不动，同一引用
  assert.equal(root.nested.view, view);
  await store.resolveDeep(new Uint8Array(4)); // 根本身是视图：no-op、不抛
});
