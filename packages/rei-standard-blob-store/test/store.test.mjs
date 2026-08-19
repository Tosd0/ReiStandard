import test from 'node:test';
import assert from 'node:assert/strict';
import { createBlobStore } from '../src/store.js';
import { memoryAdapter, brokenAdapter } from './helpers.mjs';

const blobOf = (s) => new Blob([s], { type: 'text/plain' });

test('put 返回带前缀令牌，get 取回同内容', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
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

test('put 失败向上抛（调用方必须知道图没存进去）', async () => {
  const store = createBlobStore({ adapter: brokenAdapter() });
  await assert.rejects(() => store.put(blobOf('x')));
});

test('delete best-effort：非令牌不动、适配器抛错吞掉', async () => {
  const adapter = memoryAdapter();
  const store = createBlobStore({ adapter });
  const token = await store.put(blobOf('bye'));
  await store.delete('data:xxx'); // 不抛
  await store.delete(token);
  assert.equal(adapter.map.size, 0);
  await createBlobStore({ adapter: brokenAdapter() }).delete('blobref:b_1_0_aaaaaa'); // 不抛
});

test('resolveToDataUrl：令牌→data URL、非令牌透传、丢图→空串', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.put(blobOf('pic'));
  assert.match(await store.resolveToDataUrl(token), /^data:text\/plain;base64,/);
  assert.equal(await store.resolveToDataUrl('https://a/b.png'), 'https://a/b.png');
  assert.equal(await store.resolveToDataUrl('blobref:b_gone_0_aaaaaa'), '');
});

test('migrateDataUrl：成功返回令牌，坏输入回退原串', async () => {
  const store = createBlobStore({ adapter: memoryAdapter() });
  const token = await store.migrateDataUrl('data:text/plain;base64,aGk=');
  assert.ok(store.isRef(token));
  assert.equal(await store.migrateDataUrl('not-a-data-url'), 'not-a-data-url');
});

test('自定义前缀贯穿 put/isRef/get', async () => {
  const store = createBlobStore({ adapter: memoryAdapter(), prefix: 'pic:' });
  const token = await store.put(blobOf('p'));
  assert.match(token, /^pic:b_/);
  assert.ok(store.isRef(token));
  assert.ok(!store.isRef('blobref:b_1_0_aaaaaa'));
  assert.equal(await (await store.get(token)).text(), 'p');
});

test('缺 adapter 直接抛（编程错误）', () => {
  assert.throws(() => createBlobStore({}));
});
