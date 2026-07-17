import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReiClient } from '../src/index.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const USER_KEY_HEX = 'ab'.repeat(32); // 64 hex chars → 32-byte AES key

/** Build a client and feed it a userKey via a mocked init() round trip. */
async function makeInitializedClient(config = {}) {
  const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER, ...config });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ success: true, data: { userKey: USER_KEY_HEX } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
  try {
    await client.init();
  } finally {
    globalThis.fetch = original;
  }
  return client;
}

test('putClientState() PUTs an encrypted batch and returns the server verdict', async () => {
  const client = await makeInitializedClient({ serverToken: 's3cret' });
  const entries = [
    { namespace: 'profile', key: 'display', value: '{"name":"A"}', updatedAt: 1700000000000 },
    { namespace: 'profile', key: 'locale', value: '"zh-CN"', updatedAt: 1700000000001 }
  ];

  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    return new Response(JSON.stringify({ success: true, data: { upserted: 2, skipped: 0 } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  let result;
  try {
    result = await client.putClientState(entries);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://w.dev/client-state');
  assert.equal(captured[0].method, 'PUT');
  assert.equal(captured[0].headers['X-User-Id'], USER);
  assert.equal(captured[0].headers['X-Payload-Encrypted'], 'true');
  assert.equal(captured[0].headers['X-Encryption-Version'], '1');
  assert.equal(captured[0].headers['X-Client-Token'], 's3cret');

  // Body is the encrypted envelope, not plaintext — and decrypts back to the batch.
  const body = JSON.parse(captured[0].body);
  assert.equal(typeof body.iv, 'string');
  assert.equal(typeof body.authTag, 'string');
  assert.equal(typeof body.encryptedData, 'string');
  assert.ok(!captured[0].body.includes('zh-CN'), 'plaintext must not appear in the request body');
  const roundtripped = await client._decrypt(body);
  assert.deepEqual(roundtripped, { entries });

  assert.deepEqual(result, { success: true, data: { upserted: 2, skipped: 0 } });
});

test('getClientState() decrypts the encrypted-response envelope', async () => {
  const client = await makeInitializedClient({ serverToken: 's3cret' });
  const payload = {
    namespace: 'char:42:persona',
    entries: [{ namespace: 'char:42:persona', key: 'card', value: 'hello', updatedAt: 1700000000000 }]
  };
  const encrypted = await client._encrypt(JSON.stringify(payload));

  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), method: init.method, headers: init.headers });
    return new Response(
      JSON.stringify({ success: true, encrypted: true, version: 1, data: encrypted }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };
  let result;
  try {
    result = await client.getClientState('char:42:persona');
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(captured[0].url, `https://w.dev/client-state?namespace=${encodeURIComponent('char:42:persona')}`);
  assert.equal(captured[0].method, 'GET');
  assert.equal(captured[0].headers['X-User-Id'], USER);
  assert.equal(captured[0].headers['X-Response-Encrypted'], 'true');
  assert.equal(captured[0].headers['X-Client-Token'], 's3cret');
  assert.equal(result.success, true);
  assert.deepEqual(result.data, payload);
});

test('getClientState() passes a non-success response through untouched', async () => {
  const client = await makeInitializedClient();
  const failure = { success: false, error: { code: 'NAMESPACE_REQUIRED', message: '必须提供 namespace 查询参数' } };

  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(failure), {
    status: 400, headers: { 'Content-Type': 'application/json' }
  });
  let result;
  try {
    result = await client.getClientState('profile');
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(result, failure);
});

test('clearClientState() DELETEs /client-state with user + token headers', async () => {
  const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER, serverToken: 's3cret' });

  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), method: init.method, headers: init.headers });
    return new Response(JSON.stringify({ success: true, data: { deleted: 5 } }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  let result;
  try {
    result = await client.clearClientState();
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(captured[0].url, 'https://w.dev/client-state');
  assert.equal(captured[0].method, 'DELETE');
  assert.equal(captured[0].headers['X-User-Id'], USER);
  assert.equal(captured[0].headers['X-Client-Token'], 's3cret');
  assert.deepEqual(result, { success: true, data: { deleted: 5 } });
});

test('putClientState() before init() throws Not initialised', async () => {
  const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
  await assert.rejects(
    () => client.putClientState([{ namespace: 'a', key: 'b', value: 'c', updatedAt: 1 }]),
    /Not initialised/
  );
});
