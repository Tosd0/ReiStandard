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

test('开库同步抛（没有 indexedDB 全局）不会把失败缓存住', async () => {
  const adapter = createIdbAdapter('blob-store-test-5');
  const realIdb = globalThis.indexedDB;
  delete globalThis.indexedDB;
  await assert.rejects(() => adapter.put('a1', new Blob(['x'])));
  globalThis.indexedDB = realIdb;
  await adapter.put('a1', new Blob(['x']));   // 缓存被毒化的话这里还会挂
  assert.deepEqual(await adapter.keys(), ['a1']);
});

test('事务错误保真：error 事件派发时 t.error 还是 null，reject 出来的必须是 request 上的真错（QuotaExceededError 不能退化成笼统的 transaction failed）', async () => {
  // fake-indexeddb 造不出配额错误，这里手工模拟规范时序：error 事件阶段 abort 还没跑，
  // 事务的 error 属性仍是 null，真错只在 request 上。
  const quota = new Error('quota exceeded');
  quota.name = 'QuotaExceededError';
  const fakeIdb = {
    open() {
      const openReq = {};
      queueMicrotask(() => {
        openReq.result = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const t = { error: null };
            t.objectStore = () => ({
              put() {
                const req = { error: quota };
                queueMicrotask(() => { if (t.onerror) t.onerror(); });
                return req;
              },
            });
            return t;
          },
          close() {},
        };
        if (openReq.onsuccess) openReq.onsuccess();
      });
      return openReq;
    },
  };
  const realIdb = globalThis.indexedDB;
  globalThis.indexedDB = fakeIdb;
  try {
    const adapter = createIdbAdapter('blob-store-test-6');
    await assert.rejects(() => adapter.put('a1', new Blob(['x'])), (err) => err === quota);
  } finally {
    globalThis.indexedDB = realIdb;
  }
});

test('同一 dbName 配第二个 storeName：吵着失败并指路，不静默变 NotFoundError（upgradeneeded 只在建库那次触发，第二个 store 永远建不出来）', async () => {
  const first = createIdbAdapter('blob-store-test-7', { storeName: 'avatars' });
  await first.put('a1', new Blob(['x'])); // 建库，store 只有 avatars
  const second = createIdbAdapter('blob-store-test-7', { storeName: 'walls' });
  await assert.rejects(() => second.put('b1', new Blob(['y'])), { message: /换 dbName/ });
});

test('浏览器强制关闭连接（close 事件，非 versionchange 路径）后放掉缓存，下次调用重开而不是复用死连接', async () => {
  // fake-indexeddb 模拟不了浏览器强关连接，手工假 IDB 数 open 次数。
  let opens = 0;
  let lastDb = null;
  const fakeIdb = {
    open() {
      opens++;
      const openReq = {};
      queueMicrotask(() => {
        const db = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const t = {};
            t.objectStore = () => ({
              get() {
                const req = {};
                queueMicrotask(() => { req.result = undefined; if (t.oncomplete) t.oncomplete(); });
                return req;
              },
            });
            return t;
          },
          close() {},
        };
        lastDb = db;
        openReq.result = db;
        if (openReq.onsuccess) openReq.onsuccess();
      });
      return openReq;
    },
  };
  const realIdb = globalThis.indexedDB;
  globalThis.indexedDB = fakeIdb;
  try {
    const adapter = createIdbAdapter('blob-store-test-8');
    await adapter.get('a1');
    assert.equal(opens, 1);
    assert.equal(typeof lastDb.onclose, 'function'); // 自愈钩子必须挂上
    lastDb.onclose(); // 浏览器强关连接
    await adapter.get('a1');
    assert.equal(opens, 2); // 缓存被放掉、重开了
  } finally {
    globalThis.indexedDB = realIdb;
  }
});

test('事务 abort-only 收尾（commit 期配额失败的真实形态：request 上没有 error 事件）也必须 reject——put 悬死不 settle 就违反「失败必须上抛」契约', async () => {
  const abortErr = new Error('quota during commit');
  abortErr.name = 'QuotaExceededError';
  const fakeIdb = {
    open() {
      const openReq = {};
      queueMicrotask(() => {
        openReq.result = {
          objectStoreNames: { contains: () => true },
          transaction() {
            const t = { error: abortErr }; // abort 步骤已给事务赋了错，request 上没有
            t.objectStore = () => ({
              put() {
                const req = { error: null };
                queueMicrotask(() => { if (t.onabort) t.onabort(); }); // 只发 abort，不发 error
                return req;
              },
            });
            return t;
          },
          close() {},
        };
        if (openReq.onsuccess) openReq.onsuccess();
      });
      return openReq;
    },
  };
  const realIdb = globalThis.indexedDB;
  globalThis.indexedDB = fakeIdb;
  try {
    const adapter = createIdbAdapter('blob-store-test-9');
    await assert.rejects(
      () => Promise.race([
        adapter.put('a1', new Blob(['x'])),
        new Promise((_, rej) => setTimeout(() => rej(new Error('put 悬死：onabort 没接住，promise 永不 settle')), 250)),
      ]),
      (err) => err === abortErr,
    );
  } finally {
    globalThis.indexedDB = realIdb;
  }
});
