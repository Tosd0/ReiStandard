import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { runScheduledTick } from '../src/server/lib/run-tick.js';
import {
  deriveUserEncryptionKey,
  encryptPayload,
  encryptForStorage,
} from '../src/server/lib/encryption.js';
import { seedPushSubscription, TEST_PUSH_SUBSCRIPTION } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const SUB = { endpoint: 'https://push.example.com/first', keys: { p256dh: 'k', auth: 'a' } };
const SUB2 = { endpoint: 'https://push.example.com/second', keys: { p256dh: 'k2', auth: 'a2' } };

const ENC_HEADERS = {
  'X-User-Id': USER,
  'X-Payload-Encrypted': 'true',
  'X-Encryption-Version': '1',
};

function makeWorker(d1, extra = {}) {
  return createSingleUserCloudflareWorker(() => ({
    db: createD1Adapter(d1),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} },
    ...extra,
  }));
}

async function encBody(obj) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return JSON.stringify(await encryptPayload(obj, userKey));
}

async function freshWorker() {
  const d1 = createTestD1();
  const adapter = createD1Adapter(d1);
  await adapter.initSchema();
  return { d1, adapter, worker: makeWorker(d1), env: { DB: d1 } };
}

async function putSubscription(worker, env, subscription) {
  return worker.fetch(
    new Request('https://w.dev/push-subscription', {
      method: 'PUT',
      headers: ENC_HEADERS,
      body: await encBody({ subscription }),
    }),
    env
  );
}

describe('PUT/GET/DELETE /push-subscription', () => {
  test('登记 → 读回 → 覆盖 → 删除', async () => {
    const { worker, env } = await freshWorker();

    const before = await (await worker.fetch(
      new Request('https://w.dev/push-subscription', { method: 'GET', headers: { 'X-User-Id': USER } }), env
    )).json();
    assert.deepEqual(before.data, { exists: false, updatedAt: null, endpoint: null });

    const put = await putSubscription(worker, env, SUB);
    assert.equal(put.status, 200);
    assert.ok((await put.json()).data.updatedAt > 0);

    const got = await (await worker.fetch(
      new Request('https://w.dev/push-subscription', { method: 'GET', headers: { 'X-User-Id': USER } }), env
    )).json();
    assert.equal(got.data.exists, true);
    assert.equal(got.data.endpoint, SUB.endpoint);

    // 覆盖写：一个用户一份，新的直接顶掉旧的。
    await putSubscription(worker, env, SUB2);
    const after = await (await worker.fetch(
      new Request('https://w.dev/push-subscription', { method: 'GET', headers: { 'X-User-Id': USER } }), env
    )).json();
    assert.equal(after.data.endpoint, SUB2.endpoint);

    const del = await worker.fetch(
      new Request('https://w.dev/push-subscription', { method: 'DELETE', headers: { 'X-User-Id': USER } }), env
    );
    assert.equal(del.status, 200);
    assert.equal((await del.json()).data.deleted, true);

    const gone = await (await worker.fetch(
      new Request('https://w.dev/push-subscription', { method: 'GET', headers: { 'X-User-Id': USER } }), env
    )).json();
    assert.equal(gone.data.exists, false);
  });

  test('订阅落库是密文：明文 endpoint 不出现在表里', async () => {
    const { d1, worker, env } = await freshWorker();
    await putSubscription(worker, env, SUB);

    const row = await d1.prepare('SELECT subscription FROM push_subscriptions WHERE user_id = ?').bind(USER).first();
    assert.ok(row);
    assert.ok(!row.subscription.includes('push.example.com'));
  });

  test('形状不对的订阅 → 400', async () => {
    const { worker, env } = await freshWorker();
    for (const bad of [null, 'string', {}, { endpoint: '' }, { endpoint: 42 }]) {
      const res = await putSubscription(worker, env, bad);
      assert.equal(res.status, 400, `${JSON.stringify(bad)} 应被拒`);
      assert.equal((await res.json()).error.code, 'INVALID_PUSH_SUBSCRIPTION');
    }
  });

  test('PUT 必须加密 body', async () => {
    const { worker, env } = await freshWorker();
    const res = await worker.fetch(new Request('https://w.dev/push-subscription', {
      method: 'PUT',
      headers: { 'X-User-Id': USER },
      body: JSON.stringify({ subscription: SUB }),
    }), env);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'ENCRYPTION_REQUIRED');
  });

  test('serverToken 配置后三个方法都要 X-Client-Token', async () => {
    const d1 = createTestD1();
    await createD1Adapter(d1).initSchema();
    const worker = makeWorker(d1, { serverToken: 's3cret' });
    const env = { DB: d1 };
    for (const method of ['GET', 'DELETE']) {
      const res = await worker.fetch(
        new Request('https://w.dev/push-subscription', { method, headers: { 'X-User-Id': USER } }), env
      );
      assert.equal(res.status, 401, `${method} 应要求 token`);
    }
    const put = await worker.fetch(new Request('https://w.dev/push-subscription', {
      method: 'PUT', headers: ENC_HEADERS, body: await encBody({ subscription: SUB }),
    }), env);
    assert.equal(put.status, 401);
  });
});

describe('任务不再携带订阅', () => {
  async function schedule(worker, env, overrides = {}) {
    return worker.fetch(new Request('https://w.dev/schedule-message', {
      method: 'POST',
      headers: ENC_HEADERS,
      body: await encBody({
        contactName: 'Rei',
        messageType: 'fixed',
        userMessage: 'hi',
        firstSendTime: '2999-01-01T00:00:00.000Z',
        recurrenceType: 'none',
        ...overrides,
      }),
    }), env);
  }

  test('没登记订阅就排程 → 409 PUSH_SUBSCRIPTION_MISSING', async () => {
    const { worker, env } = await freshWorker();
    const res = await schedule(worker, env);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).error.code, 'PUSH_SUBSCRIPTION_MISSING');
  });

  test('登记过就能排程，且落库的 payload 里没有订阅', async () => {
    const { adapter, worker, env } = await freshWorker();
    await putSubscription(worker, env, SUB);

    const res = await schedule(worker, env, { uuid: '11111111-2222-4333-8444-555555555555' });
    assert.equal(res.status, 201);

    const row = await adapter.getTaskByUuidOnly('11111111-2222-4333-8444-555555555555');
    const { decryptFromStorage } = await import('../src/server/lib/encryption.js');
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const payload = JSON.parse(await decryptFromStorage(row.encrypted_payload, userKey));
    assert.equal('pushSubscription' in payload, false);
  });

  test('排程请求里还带 pushSubscription → 400，不静默丢弃', async () => {
    const { worker, env } = await freshWorker();
    await putSubscription(worker, env, SUB);
    const res = await schedule(worker, env, { pushSubscription: SUB });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'PUSH_SUBSCRIPTION_NOT_ACCEPTED');
  });
});

describe('投递时现读用户级订阅', () => {
  async function seedDueTask(adapter, uuid = 'due') {
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    await adapter.createTask({
      user_id: USER,
      uuid,
      encrypted_payload: await encryptForStorage(JSON.stringify({
        contactName: 'Rei', messageType: 'fixed', userMessage: 'hi', recurrenceType: 'none',
      }), userKey),
      next_send_at: new Date(Date.now() - 30_000).toISOString(),
      message_type: 'fixed',
    });
  }

  // 这条是这块改动的核心：换订阅只要覆盖用户级的那一份，已有任务（包括角色
  // 在 fire 里给自己排的、客户端根本不知道存在的那些）下次触发时读到的就是
  // 新订阅——不用逐条 PUT 刷任务。
  test('换订阅之后，老任务推到的是新 endpoint', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, USER, MASTER_KEY, SUB);
    await seedDueTask(adapter);

    const sentTo = [];
    const webpush = { async sendNotification(sub) { sentTo.push(sub.endpoint); } };

    // 客户端换了设备 → 覆盖用户级订阅（任务一条都没碰）。
    await seedPushSubscription(adapter, USER, MASTER_KEY, SUB2);

    await runScheduledTick({
      db: adapter, masterKey: MASTER_KEY,
      vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
      webpush,
    });

    assert.deepEqual(sentTo, [SUB2.endpoint]);
  });

  test('订阅被删掉之后，任务投递失败并记下原因，不静默算成功', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, USER, MASTER_KEY, SUB);
    await seedDueTask(adapter);
    await adapter.deletePushSubscription(USER);

    let sent = 0;
    const res = await runScheduledTick({
      db: adapter, masterKey: MASTER_KEY,
      vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
      webpush: { async sendNotification() { sent++; } },
    });

    assert.equal(sent, 0);
    assert.equal(res.successCount, 0);
    assert.equal(res.failedCount, 1);
    assert.match(res.details.failedTasks[0].reason, /PUSH_SUBSCRIPTION_MISSING/);
  });

  test('fire 里自排的任务同样不带订阅，到点读用户级那一份', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, USER, MASTER_KEY, TEST_PUSH_SUBSCRIPTION);

    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    await adapter.createTask({
      user_id: USER,
      uuid: 'fire-parent',
      encrypted_payload: await encryptForStorage(JSON.stringify({
        contactName: 'Rei', messageType: 'auto', completePrompt: 'frozen',
        apiUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'sk-secret',
        primaryModel: 'model-x', recurrenceType: 'none',
      }), userKey),
      next_send_at: new Date(Date.now() - 30_000).toISOString(),
      message_type: 'auto',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, async json() { return { choices: [{ message: { content: 'hi' } }] }; } });
    const worker = createSingleUserCloudflareWorker(() => ({
      db: adapter,
      masterKey: MASTER_KEY,
      vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
      webpush: { async sendNotification() {} },
      hooks: {
        onBeforeFire: async (ctx) => {
          await ctx.scheduleTask({
            firstSendTime: new Date(Date.now() + 90 * 60_000).toISOString(),
            uuid: 'fire-child',
          });
          return [{ role: 'user', content: 'U' }];
        },
        onLLMOutput: async () => ({ decision: 'skip-push' }),
      },
    }));
    try {
      await worker.scheduled({}, { DB: d1 });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const { decryptFromStorage } = await import('../src/server/lib/encryption.js');
    const child = await adapter.getTaskByUuidOnly('fire-child');
    assert.ok(child, '自排的任务应该建出来了');
    const payload = JSON.parse(await decryptFromStorage(child.encrypted_payload, userKey));
    assert.equal('pushSubscription' in payload, false);
  });
});
