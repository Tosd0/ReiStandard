import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { deriveUserEncryptionKey, encryptPayload, decryptPayload, encryptForStorage } from '../src/server/lib/encryption.js';
import { chunkNamespaceFor, chunkKeyFor, chunkKeyPrefixFor } from '../src/server/lib/state-chunks.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

describe('D1 adapter client_state', () => {
  test('initSchema creates client_state; upsert is last-write-wins on updatedAt', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();

    let r = await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'k1', value: 'enc-v1', updatedAt: 100 },
      { namespace: 'notes', key: 'k2', value: 'enc-v2', updatedAt: 100 },
    ]);
    assert.deepEqual(r, { upserted: 2, skipped: 0, outcomes: [true, true] });

    // older than stored → skip; equal-or-newer → overwrite
    r = await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'k1', value: 'enc-old', updatedAt: 50 },
      { namespace: 'notes', key: 'k2', value: 'enc-new', updatedAt: 200 },
    ]);
    assert.deepEqual(r, { upserted: 1, skipped: 1, outcomes: [false, true] });

    const rows = await adapter.getClientState(USER, 'notes');
    assert.deepEqual(
      rows.map((x) => [x.key, x.value, x.updated_at]),
      [['k1', 'enc-v1', 100], ['k2', 'enc-new', 200]]
    );
    // namespace isolation
    assert.deepEqual(await adapter.getClientState(USER, 'other'), []);
  });

  test('clearClientState wipes only that user', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const OTHER = '660e8400-e29b-41d4-a716-446655440000';
    await adapter.upsertClientState(USER, [{ namespace: 'n', key: 'k', value: 'v', updatedAt: 1 }]);
    await adapter.upsertClientState(OTHER, [{ namespace: 'n', key: 'k', value: 'v', updatedAt: 1 }]);
    assert.equal(await adapter.clearClientState(USER), 1);
    assert.deepEqual(await adapter.getClientState(USER, 'n'), []);
    assert.equal((await adapter.getClientState(OTHER, 'n')).length, 1);
  });

  // The client uploads inside its few-seconds background window, so the
  // whole batch must go out in ONE D1 round trip when the binding supports
  // batch(). Bindings without batch() (custom adapters) must still work.
  test('upsertClientState uses db.batch when available, sequential fallback otherwise', async () => {
    // batch path: spy on the shim's batch — one call for the whole set
    const d1 = createTestD1();
    let batchCalls = 0;
    const origBatch = d1.batch;
    d1.batch = async (statements) => { batchCalls++; return origBatch(statements); };
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    const r = await adapter.upsertClientState(USER, [
      { namespace: 'n', key: 'a', value: 'v1', updatedAt: 2 },
      { namespace: 'n', key: 'b', value: 'v2', updatedAt: 2 },
      { namespace: 'n', key: 'a', value: 'old', updatedAt: 1 }, // stale → skipped
    ]);
    assert.deepEqual(r, { upserted: 2, skipped: 1, outcomes: [true, true, false] });
    assert.equal(batchCalls, 1);

    // fallback path: binding without batch() gives identical results
    const d1b = createTestD1();
    const adapter2 = createD1Adapter({ prepare: d1b.prepare });
    await adapter2.initSchema();
    const r2 = await adapter2.upsertClientState(USER, [
      { namespace: 'n', key: 'a', value: 'v1', updatedAt: 2 },
      { namespace: 'n', key: 'a', value: 'old', updatedAt: 1 },
    ]);
    assert.deepEqual(r2, { upserted: 1, skipped: 1, outcomes: [true, false] });
    assert.deepEqual(
      (await adapter2.getClientState(USER, 'n')).map((x) => [x.key, x.value]),
      [['a', 'v1']]
    );
  });

  test('cleanups：LIKE 前缀删除只删自己 key 的切片、尊重 LWW、% 通配符被转义', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const chunkNs = chunkNamespaceFor('n');
    await adapter.upsertClientState(USER, [
      { namespace: chunkNs, key: chunkKeyFor('a', 0), value: 'c0', updatedAt: 100 },
      { namespace: chunkNs, key: chunkKeyFor('a', 1), value: 'c1', updatedAt: 100 },
      { namespace: chunkNs, key: chunkKeyFor('ab', 0), value: 'other-key', updatedAt: 100 },
      { namespace: chunkNs, key: chunkKeyFor('a%b', 0), value: 'pct-key', updatedAt: 100 },
    ]);

    // 清 key 'a' 的切片：'ab' / 'a%b' 的不受影响（\u001f 分隔符挡住前缀误伤）
    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: chunkKeyPrefixFor('a'), updatedAt: 150 },
    ]);
    let keys = (await adapter.getClientState(USER, chunkNs)).map((r) => r.key).sort();
    assert.deepEqual(keys, [chunkKeyFor('a%b', 0), chunkKeyFor('ab', 0)].sort());

    // 清 'a%b' 的切片：% 不能当通配符把 'ab' 的也带走
    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: chunkKeyPrefixFor('a%b'), updatedAt: 150 },
    ]);
    keys = (await adapter.getClientState(USER, chunkNs)).map((r) => r.key);
    assert.deepEqual(keys, [chunkKeyFor('ab', 0)]);

    // 陈旧批次（updatedAt 更老）的 cleanup 删不动更新的行
    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: chunkKeyPrefixFor('ab'), updatedAt: 50 },
    ]);
    assert.equal((await adapter.getClientState(USER, chunkNs)).length, 1);

    // cleanup + upsert 同批：先删后写，同一 key 的新切片完整落库
    const r = await adapter.upsertClientState(USER, [
      { namespace: chunkNs, key: chunkKeyFor('ab', 0), value: 'new0', updatedAt: 200 },
      { namespace: chunkNs, key: chunkKeyFor('ab', 1), value: 'new1', updatedAt: 200 },
    ], [
      { namespace: chunkNs, keyPrefix: chunkKeyPrefixFor('ab'), updatedAt: 200 },
    ]);
    assert.deepEqual(r, { upserted: 2, skipped: 0, outcomes: [true, true] });
    assert.deepEqual(
      (await adapter.getClientState(USER, chunkNs)).map((x) => [x.key, x.value]),
      [[chunkKeyFor('ab', 0), 'new0'], [chunkKeyFor('ab', 1), 'new1']]
    );
  });
});

// ─── /client-state endpoints ─────────────────────────────────────────────────

function makeWorker(d1, extra = {}) {
  return createSingleUserCloudflareWorker((env) => ({
    db: createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} },
    ...extra,
  }));
}

const ENC_HEADERS = { 'X-User-Id': USER, 'X-Payload-Encrypted': 'true', 'X-Encryption-Version': '1' };

async function putState(worker, env, entries, headers = ENC_HEADERS) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const body = JSON.stringify(await encryptPayload({ entries }, userKey));
  return worker.fetch(new Request('https://w.dev/client-state', { method: 'PUT', headers, body }), env);
}

describe('/client-state endpoints', () => {
  test('PUT upsert → GET decrypted roundtrip → DELETE wipes', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const putRes = await putState(worker, env, [
      { namespace: 'notes', key: 'k1', value: JSON.stringify({ a: 1 }), updatedAt: 100 },
      { namespace: 'notes', key: 'k2', value: 'plain text', updatedAt: 100 },
    ]);
    assert.equal(putRes.status, 200);
    assert.deepEqual((await putRes.json()).data, { upserted: 2, skipped: 0 });

    // stale entry is skipped
    const putRes2 = await putState(worker, env, [
      { namespace: 'notes', key: 'k1', value: 'stale', updatedAt: 50 },
    ]);
    assert.deepEqual((await putRes2.json()).data, { upserted: 0, skipped: 1, skippedEntries: [{ namespace: 'notes', key: 'k1' }] });

    const getRes = await worker.fetch(new Request('https://w.dev/client-state?namespace=notes', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.encrypted, true);
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const data = await decryptPayload(getBody.data, userKey);
    assert.deepEqual(
      data.entries.map((e) => [e.namespace, e.key, e.value, e.updatedAt]),
      [['notes', 'k1', JSON.stringify({ a: 1 }), 100], ['notes', 'k2', 'plain text', 100]]
    );

    const delRes = await worker.fetch(new Request('https://w.dev/client-state', {
      method: 'DELETE', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(delRes.status, 200);
    assert.equal((await delRes.json()).data.deleted, 2);

    const getRes2 = await worker.fetch(new Request('https://w.dev/client-state?namespace=notes', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    const data2 = await decryptPayload((await getRes2.json()).data, userKey);
    assert.deepEqual(data2.entries, []);
  });

  // 读一个 namespace 并解密（拼回后的逻辑条目视图）
  async function getEntries(worker, env, namespace) {
    const getRes = await worker.fetch(new Request(
      `https://w.dev/client-state?namespace=${encodeURIComponent(namespace)}`,
      { method: 'GET', headers: { 'X-User-Id': USER } }
    ), env);
    assert.equal(getRes.status, 200);
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const data = await decryptPayload((await getRes.json()).data, userKey);
    return data.entries;
  }

  test('刚超 200KB：不再整批 413，分块入库后 GET 读回原值', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const value = 'x'.repeat(200 * 1024 + 1);
    const res = await putState(worker, env, [
      { namespace: 'n', key: 'big', value, updatedAt: 1 },
    ]);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, { upserted: 1, skipped: 0 });

    const entries = await getEntries(worker, env, 'n');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].value, value);
  });

  test('中文大值分块：GET 拼回原值；物理存储 = 根 marker + 保留 ns 里的加密切片', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const bigValue = JSON.stringify({ v: 1, doc: '记'.repeat(120_000) }); // ~360KB → 2 片
    await putState(worker, env, [
      { namespace: 'notes', key: 'big', value: bigValue, updatedAt: 100 },
      { namespace: 'notes', key: 'small', value: 'tiny', updatedAt: 100 },
    ]);

    const entries = await getEntries(worker, env, 'notes');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].key, 'big');
    assert.equal(entries[0].value, bigValue);
    assert.deepEqual(entries[1], { namespace: 'notes', key: 'small', value: 'tiny', updatedAt: 100 });

    const adapter = createD1Adapter(d1);
    const userRows = await adapter.getClientState(USER, 'notes');
    assert.equal(userRows.length, 2); // 用户 namespace 里只有逻辑条目的行
    const rootRow = userRows.find((r) => r.key === 'big');
    assert.equal(rootRow.value.charCodeAt(0), 0x1f, '分块根行是 marker');
    const chunkRows = await adapter.getClientState(USER, chunkNamespaceFor('notes'));
    assert.equal(chunkRows.length, 2);
    for (const row of chunkRows) assert.match(row.value, /^[0-9a-f]+:[0-9a-f]+:/); // 切片是密文
  });

  test('覆盖写变小 / 缩块：旧切片行清干净，读到的始终是最新值', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const adapter = createD1Adapter(d1);
    const chunkNs = chunkNamespaceFor('n');

    // 大(2片) → 小(单行)：切片全清
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: '记'.repeat(120_000), updatedAt: 100 }]);
    assert.equal((await adapter.getClientState(USER, chunkNs)).length, 2);
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: 'small-now', updatedAt: 200 }]);
    assert.deepEqual(await adapter.getClientState(USER, chunkNs), []);
    let entries = await getEntries(worker, env, 'n');
    assert.deepEqual(entries.map((e) => [e.key, e.value]), [['k', 'small-now']]);

    // 大(3片) → 大(2片)：尾片不残留
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: '记'.repeat(200_000), updatedAt: 300 }]);
    assert.equal((await adapter.getClientState(USER, chunkNs)).length, 3);
    const two = '记'.repeat(120_000);
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: two, updatedAt: 400 }]);
    assert.equal((await adapter.getClientState(USER, chunkNs)).length, 2);
    entries = await getEntries(worker, env, 'n');
    assert.equal(entries[0].value, two);
  });

  test('陈旧的分块写入动不了更新的值（LWW 对分块路径成立）', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: 'fresh', updatedAt: 500 }]);
    const stale = await putState(worker, env, [
      { namespace: 'n', key: 'k', value: '记'.repeat(120_000), updatedAt: 100 },
    ]);
    assert.deepEqual((await stale.json()).data, { upserted: 0, skipped: 1, skippedEntries: [{ namespace: 'n', key: 'k' }] });
    const entries = await getEntries(worker, env, 'n');
    assert.deepEqual(entries.map((e) => [e.key, e.value]), [['k', 'fresh']]);
  });

  test('整批局部失败：坏条目逐条拒绝，好条目照常入库；全成功响应不带 rejected', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const res = await putState(worker, env, [
      { namespace: 'n', key: 'good', value: 'v', updatedAt: 100 },
      { namespace: 'n', key: 'bad-ts', value: 'v', updatedAt: -1 },
      { namespace: 'n', key: 'huge', value: 'x'.repeat(6 * 1024 * 1024), updatedAt: 100 },
      { namespace: 'n\u0000ctl', key: 'k', value: 'v', updatedAt: 100 },
    ]);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.upserted, 1);
    assert.deepEqual(
      body.data.rejected.map((r) => [r.index, r.code]),
      [[1, 'INVALID_STATE_UPDATED_AT'], [2, 'STATE_VALUE_TOO_LARGE'], [3, 'INVALID_STATE_NAMESPACE']]
    );
    const oversized = body.data.rejected.find((r) => r.code === 'STATE_VALUE_TOO_LARGE');
    assert.equal(oversized.maxBytes, 5 * 1024 * 1024);
    assert.equal(oversized.key, 'huge');

    const entries = await getEntries(worker, env, 'n');
    assert.deepEqual(entries.map((e) => e.key), ['good']);

    // 全成功响应形状不变（老客户端无感）
    const okRes = await putState(worker, env, [{ namespace: 'n', key: 'k2', value: 'v', updatedAt: 1 }]);
    assert.deepEqual(Object.keys((await okRes.json()).data).sort(), ['skipped', 'upserted']);
  });

  test('工厂配置 maxStateValueBytes 调总上限；GET 保留 namespace → 400', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1, { maxStateValueBytes: 1024 });
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const res = await putState(worker, env, [
      { namespace: 'n', key: 'over', value: 'x'.repeat(2000), updatedAt: 1 },
      { namespace: 'n', key: 'under', value: 'x'.repeat(500), updatedAt: 1 },
    ]);
    const body = await res.json();
    assert.equal(body.data.upserted, 1);
    assert.deepEqual(
      body.data.rejected.map((r) => [r.key, r.code, r.maxBytes]),
      [['over', 'STATE_VALUE_TOO_LARGE', 1024]]
    );

    const badNs = await worker.fetch(new Request(
      `https://w.dev/client-state?namespace=${encodeURIComponent(chunkNamespaceFor('n'))}`,
      { method: 'GET', headers: { 'X-User-Id': USER } }
    ), env);
    assert.equal(badNs.status, 400);
    assert.equal((await badNs.json()).error.code, 'INVALID_STATE_NAMESPACE');
  });

  test('validation: non-array/empty entries → 400; missing namespace → 400; stored value is ciphertext', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const bad = await putState(worker, env, 'not-an-array');
    assert.equal(bad.status, 400);
    const empty = await putState(worker, env, []);
    assert.equal(empty.status, 400);

    const noNs = await worker.fetch(new Request('https://w.dev/client-state', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(noNs.status, 400);
    assert.equal((await noNs.json()).error.code, 'NAMESPACE_REQUIRED');

    // what lands in the DB is encryptForStorage ciphertext, not plaintext
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: 'SECRET-PLAINTEXT', updatedAt: 1 }]);
    const adapter = createD1Adapter(d1);
    const raw = await adapter.getClientState(USER, 'n');
    assert.equal(raw.length, 1);
    assert.notEqual(raw[0].value, 'SECRET-PLAINTEXT');
    assert.match(raw[0].value, /^[0-9a-f]+:[0-9a-f]+:/); // iv:authTag:cipher
  });

  test('PUT unencrypted body → 400 ENCRYPTION_REQUIRED; serverToken set → all three endpoints 401 without token', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1, { serverToken: 's3cret' });
    const env = { DB: d1 };
    for (const [method, url] of [
      ['PUT', 'https://w.dev/client-state'],
      ['GET', 'https://w.dev/client-state?namespace=n'],
      ['DELETE', 'https://w.dev/client-state'],
    ]) {
      const res = await worker.fetch(new Request(url, { method, headers: { 'X-User-Id': USER } }), env);
      assert.equal(res.status, 401, `${method} without token must be 401`);
    }

    const d1b = createTestD1();
    const worker2 = makeWorker(d1b);
    await worker2.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), { DB: d1b });
    const plain = await worker2.fetch(new Request('https://w.dev/client-state', {
      method: 'PUT', headers: { 'X-User-Id': USER }, body: JSON.stringify({ entries: [] }),
    }), { DB: d1b });
    assert.equal(plain.status, 400);
    assert.equal((await plain.json()).error.code, 'ENCRYPTION_REQUIRED');
  });
});
