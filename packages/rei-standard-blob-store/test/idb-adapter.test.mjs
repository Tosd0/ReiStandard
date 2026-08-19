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
