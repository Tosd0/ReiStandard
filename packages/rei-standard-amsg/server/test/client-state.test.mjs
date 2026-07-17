import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { deriveUserEncryptionKey, encryptPayload, decryptPayload, encryptForStorage } from '../src/server/lib/encryption.js';

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
    assert.deepEqual(r, { upserted: 2, skipped: 0 });

    // older than stored → skip; equal-or-newer → overwrite
    r = await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'k1', value: 'enc-old', updatedAt: 50 },
      { namespace: 'notes', key: 'k2', value: 'enc-new', updatedAt: 200 },
    ]);
    assert.deepEqual(r, { upserted: 1, skipped: 1 });

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
    assert.deepEqual(r, { upserted: 2, skipped: 1 });
    assert.equal(batchCalls, 1);

    // fallback path: binding without batch() gives identical results
    const d1b = createTestD1();
    const adapter2 = createD1Adapter({ prepare: d1b.prepare });
    await adapter2.initSchema();
    const r2 = await adapter2.upsertClientState(USER, [
      { namespace: 'n', key: 'a', value: 'v1', updatedAt: 2 },
      { namespace: 'n', key: 'a', value: 'old', updatedAt: 1 },
    ]);
    assert.deepEqual(r2, { upserted: 1, skipped: 1 });
    assert.deepEqual(
      (await adapter2.getClientState(USER, 'n')).map((x) => [x.key, x.value]),
      [['a', 'v1']]
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
    assert.deepEqual((await putRes2.json()).data, { upserted: 0, skipped: 1 });

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

  test('value over 200KB → 413 with a clear error code', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const res = await putState(worker, env, [
      { namespace: 'n', key: 'big', value: 'x'.repeat(200 * 1024 + 1), updatedAt: 1 },
    ]);
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'STATE_VALUE_TOO_LARGE');
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
