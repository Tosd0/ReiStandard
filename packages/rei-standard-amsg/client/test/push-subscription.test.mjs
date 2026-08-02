import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReiClient } from '../src/index.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const USER_KEY_HEX = 'ab'.repeat(32);
const SUB = { endpoint: 'https://push.example.com/sub', keys: { p256dh: 'k', auth: 'a' } };

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

/** 换掉 fetch，记下这次请求，返回给定的 JSON。 */
async function capture(fn, responseBody) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    return new Response(JSON.stringify(responseBody), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  let result;
  try {
    result = await fn();
  } finally {
    globalThis.fetch = original;
  }
  return { captured, result };
}

test('putPushSubscription() PUTs 加密后的订阅到 /push-subscription', async () => {
  const client = await makeInitializedClient({ serverToken: 's3cret' });
  const { captured, result } = await capture(
    () => client.putPushSubscription(SUB),
    { success: true, data: { updatedAt: 1700000000000 } }
  );

  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://w.dev/push-subscription');
  assert.equal(captured[0].method, 'PUT');
  assert.equal(captured[0].headers['X-User-Id'], USER);
  assert.equal(captured[0].headers['X-Payload-Encrypted'], 'true');
  assert.equal(captured[0].headers['X-Encryption-Version'], '1');
  assert.equal(captured[0].headers['X-Client-Token'], 's3cret');

  // 订阅在网络上是密文：endpoint 不能出现在请求体里。
  assert.ok(!captured[0].body.includes('push.example.com'));
  const roundtripped = await client._decrypt(JSON.parse(captured[0].body));
  assert.deepEqual(roundtripped, { subscription: SUB });
  assert.equal(result.data.updatedAt, 1700000000000);
});

test('putPushSubscription() 认 PushSubscription 的 toJSON()', async () => {
  const client = await makeInitializedClient();
  const browserLike = { toJSON: () => SUB, endpoint: SUB.endpoint };
  const { captured } = await capture(
    () => client.putPushSubscription(browserLike),
    { success: true, data: { updatedAt: 1 } }
  );
  const roundtripped = await client._decrypt(JSON.parse(captured[0].body));
  assert.deepEqual(roundtripped.subscription, SUB);
});

test('putPushSubscription() 带 updatedAt 时透传', async () => {
  const client = await makeInitializedClient();
  const { captured } = await capture(
    () => client.putPushSubscription(SUB, { updatedAt: 42 }),
    { success: true, data: { updatedAt: 42 } }
  );
  const roundtripped = await client._decrypt(JSON.parse(captured[0].body));
  assert.equal(roundtripped.updatedAt, 42);
});

test('putPushSubscription() 拒绝没有 endpoint 的东西（本地就拦下来）', async () => {
  const client = await makeInitializedClient();
  for (const bad of [null, undefined, 'string', {}, { endpoint: '' }]) {
    await assert.rejects(() => client.putPushSubscription(bad), TypeError);
  }
});

test('getPushSubscription() GET /push-subscription，只带 X-User-Id', async () => {
  const client = await makeInitializedClient({ serverToken: 's3cret' });
  const { captured, result } = await capture(
    () => client.getPushSubscription(),
    { success: true, data: { exists: true, updatedAt: 5, endpoint: SUB.endpoint } }
  );
  assert.equal(captured[0].url, 'https://w.dev/push-subscription');
  assert.equal(captured[0].method, 'GET');
  assert.equal(captured[0].headers['X-User-Id'], USER);
  assert.equal(captured[0].headers['X-Client-Token'], 's3cret');
  assert.equal(result.data.endpoint, SUB.endpoint);
});

test('deletePushSubscription() DELETE /push-subscription', async () => {
  const client = await makeInitializedClient();
  const { captured, result } = await capture(
    () => client.deletePushSubscription(),
    { success: true, data: { deleted: true } }
  );
  assert.equal(captured[0].url, 'https://w.dev/push-subscription');
  assert.equal(captured[0].method, 'DELETE');
  assert.equal(result.data.deleted, true);
});
