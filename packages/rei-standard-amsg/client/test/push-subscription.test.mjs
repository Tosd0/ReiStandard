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

// ─── subscribePush()：僵尸 endpoint 检测 ─────────────────────────

const VAPID = 'BFakeKeyForTests'.padEnd(88, 'A'); // base64url，内容不重要
const ZOMBIE_ENDPOINT = 'https://permanently-removed.invalid/fEEr7Xz9';
const LIVE_ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc123';

/**
 * 造一个 registration.pushManager，按 endpoints 顺序吐订阅。
 * `endpoints` 里放 Error 就表示这次 subscribe() 抛错。
 */
function makeRegistration(endpoints) {
  const calls = { subscribe: [], unsubscribed: [] };
  let i = 0;
  return {
    calls,
    pushManager: {
      subscribe: async (opts) => {
        calls.subscribe.push(opts);
        const next = endpoints[i++];
        if (next instanceof Error) throw next;
        return {
          endpoint: next,
          keys: { p256dh: 'k', auth: 'a' },
          unsubscribe: async () => { calls.unsubscribed.push(next); return true; }
        };
      }
    }
  };
}

/** 换掉退避等待，不让测试真的睡 800/1600ms；返回记下的等待时长。 */
function stubSleep(client) {
  const waits = [];
  client._pushSubscribeSleep = (ms) => { waits.push(ms); return Promise.resolve(); };
  return waits;
}

test('subscribePush() 第一次就拿到活 endpoint：只订一次，直接返回', async () => {
  const client = await makeInitializedClient();
  const waits = stubSleep(client);
  const registration = makeRegistration([LIVE_ENDPOINT]);

  const subscription = await client.subscribePush(VAPID, registration);

  assert.equal(subscription.endpoint, LIVE_ENDPOINT);
  assert.equal(registration.calls.subscribe.length, 1);
  assert.equal(registration.calls.subscribe[0].userVisibleOnly, true);
  assert.deepEqual(registration.calls.unsubscribed, []);
  assert.deepEqual(waits, []);
});

test('subscribePush() 首次僵尸、二次活的：返回活的那个，僵尸那条被退订', async () => {
  const client = await makeInitializedClient();
  const waits = stubSleep(client);
  const registration = makeRegistration([ZOMBIE_ENDPOINT, LIVE_ENDPOINT]);

  const subscription = await client.subscribePush(VAPID, registration);

  assert.equal(subscription.endpoint, LIVE_ENDPOINT);
  assert.equal(registration.calls.subscribe.length, 2);
  assert.deepEqual(registration.calls.unsubscribed, [ZOMBIE_ENDPOINT]);
  assert.deepEqual(waits, [800]);
});

test('subscribePush() 三次全僵尸：抛 PUSH_ENDPOINT_ZOMBIE，中间按 800/1600 退避', async () => {
  const client = await makeInitializedClient();
  const waits = stubSleep(client);
  const registration = makeRegistration([ZOMBIE_ENDPOINT, ZOMBIE_ENDPOINT, ZOMBIE_ENDPOINT]);

  await assert.rejects(
    () => client.subscribePush(VAPID, registration),
    (err) => {
      assert.equal(err.code, 'PUSH_ENDPOINT_ZOMBIE');
      assert.equal(err.details.attempts, 3);
      assert.equal(err.details.endpoint, ZOMBIE_ENDPOINT);
      return true;
    }
  );

  assert.equal(registration.calls.subscribe.length, 3);
  assert.equal(registration.calls.unsubscribed.length, 3);
  // 最后一次失败后不再等待。
  assert.deepEqual(waits, [800, 1600]);
});

test('subscribePush() 僵尸那条退订失败也照样重试', async () => {
  const client = await makeInitializedClient();
  stubSleep(client);
  const registration = makeRegistration([ZOMBIE_ENDPOINT, LIVE_ENDPOINT]);
  const realSubscribe = registration.pushManager.subscribe;
  registration.pushManager.subscribe = async (opts) => {
    const sub = await realSubscribe(opts);
    sub.unsubscribe = async () => { throw new Error('unsubscribe blew up'); };
    return sub;
  };

  const subscription = await client.subscribePush(VAPID, registration);
  assert.equal(subscription.endpoint, LIVE_ENDPOINT);
  assert.equal(registration.calls.subscribe.length, 2);
});

test('subscribePush() 里 subscribe() 自己抛错时原样往外抛，不重试', async () => {
  const client = await makeInitializedClient();
  const waits = stubSleep(client);
  const denied = new Error('Registration failed - permission denied');
  denied.name = 'NotAllowedError';
  const registration = makeRegistration([denied, LIVE_ENDPOINT]);

  await assert.rejects(
    () => client.subscribePush(VAPID, registration),
    (err) => {
      assert.equal(err, denied);
      assert.equal(err.code, undefined);
      return true;
    }
  );

  assert.equal(registration.calls.subscribe.length, 1);
  assert.deepEqual(waits, []);
});
