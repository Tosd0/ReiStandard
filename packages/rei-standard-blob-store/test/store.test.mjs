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
