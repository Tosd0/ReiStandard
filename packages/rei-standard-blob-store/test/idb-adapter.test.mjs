import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdbAdapter } from '../src/idb-adapter.js';
import { createBlobStore } from '../src/store.js';

test('put/get/keys/delete 走真 IDB 语义往返', async () => {
  const adapter = createIdbAdapter('blob-store-test-1');
  const blob = new Blob(['idb'], { type: 'text/plain' });
  await adapter.put('a1', blob);
  const back = await adapter.get('a1');
  assert.equal(await back.text(), 'idb');
  assert.deepEqual(await adapter.keys(), ['a1']);
  await adapter.delete('a1');
  assert.equal(await adapter.get('a1'), null);
  assert.deepEqual(await adapter.keys(), []);
});

test('get 不存在的 id 返回 null（不是 undefined）', async () => {
  const adapter = createIdbAdapter('blob-store-test-2');
  assert.equal(await adapter.get('nope'), null);
});

test('与 createBlobStore 组合成完整闭环', async () => {
  const store = createBlobStore({ adapter: createIdbAdapter('blob-store-test-3') });
  const token = await store.put(new Blob(['e2e'], { type: 'text/plain' }));
  assert.equal(await (await store.get(token)).text(), 'e2e');
});

test('外部删库触发 versionchange 后放掉缓存，下次调用自动重开', async () => {
  const adapter = createIdbAdapter('blob-store-test-4');
  await adapter.put('a1', new Blob(['gone']));
  // 宿主的「清空本地数据」把库删了：已开连接不放手的话 deleteDatabase 会一直 blocked
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('blob-store-test-4');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('deleteDatabase 被旧连接挡住：versionchange 没放掉缓存'));
  });
  assert.deepEqual(await adapter.keys(), []);
  await adapter.put('a2', new Blob(['fresh']));
  assert.deepEqual(await adapter.keys(), ['a2']);
});

test('dbName 缺失或非字符串直接抛（编程错误）', () => {
  assert.throws(() => createIdbAdapter(), { name: 'TypeError', message: /dbName/ });
});
