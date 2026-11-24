/**
 * `messageType: 'instant'`：落库即回 202，投递交给起跳器（Durable Object 的
 * alarm 里跑 runTask），客户端不用挂着连接等生成。
 *
 * 钉住的行为：
 *   - 请求返回时一条推送都还没发（投递不在请求里跑）；
 *   - 起跳器的 alarm 跑完，推送送达、一次性任务删行；
 *   - 起跳器没配 / 叫醒失败都照样 202，任务留给 cron；
 *   - 起跳器和 cron 同时扫到同一条，只发一次（两边都要先抢租约）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { INSTANT_TICK_BINDING } from '../src/server/cloudflare/instant-tick.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptPayload } from '../src/server/lib/encryption.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const VAPID = { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' };
const ENC_HEADERS = { 'X-User-Id': USER, 'X-Payload-Encrypted': 'true', 'X-Encryption-Version': '1' };

async function encBody(payload) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return JSON.stringify(await encryptPayload(payload, userKey));
}

/** Durable Object 的实例存储：KV 读写 + 一个 alarm 槽。 */
function fakeState() {
  const store = new Map();
  let alarm = null;
  return {
    storage: {
      async get(key) { return store.get(key); },
      async put(key, value) { store.set(key, value); },
      async delete(key) { return store.delete(key); },
      async getAlarm() { return alarm; },
      async setAlarm(at) { alarm = at; }
    },
    get alarm() { return alarm; },
    clearAlarm() { alarm = null; }
  };
}

/** Durable Object namespace binding：按名字懒建实例，stub.fetch 直通实例的 fetch。 */
function fakeTickNamespace() {
  const instances = new Map();
  let TickClass = null;
  let env = null;
  return {
    bind(cls, workerEnv) { TickClass = cls; env = workerEnv; },
    idFromName(name) { return name; },
    get(id) {
      return {
        async fetch(url, init) {
          if (!instances.has(id)) {
            const state = fakeState();
            instances.set(id, { state, object: new TickClass(state, env) });
          }
          return instances.get(id).object.fetch(new Request(url, init));
        }
      };
    },
    instances,
    /** 模拟 alarm 到点：Cloudflare 触发前会把 alarm 槽清掉。 */
    async fireAlarm(id) {
      const instance = instances.get(id);
      instance.state.clearAlarm();
      await instance.object.alarm();
    }
  };
}

/**
 * 起一个 worker + 同一份库，schema 建好、推送订阅登记好。
 * `tick: false` 表示 env 里没有起跳器 binding。
 */
async function bootstrap({ tick = true, webpush, config = {} } = {}) {
  const d1 = createTestD1();
  const sent = [];
  const worker = createSingleUserCloudflareWorker((env) => ({
    db: createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: VAPID,
    webpush: webpush || { async sendNotification(_sub, payload) { sent.push(JSON.parse(payload)); } },
    ...config
  }));
  const env = { DB: d1 };
  const namespace = tick ? fakeTickNamespace() : null;
  if (namespace) {
    env[INSTANT_TICK_BINDING] = namespace;
    namespace.bind(worker.InstantTick, env);
  }
  await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
  const adapter = createD1Adapter(d1);
  await seedPushSubscription(adapter, USER, MASTER_KEY);
  return { worker, env, adapter, namespace, sent };
}

async function postInstant(worker, env, extra = {}) {
  const res = await worker.fetch(new Request('https://w.dev/schedule-message', {
    method: 'POST',
    headers: ENC_HEADERS,
    body: await encBody({ contactName: 'Rei', messageType: 'instant', userMessage: '你好。', ...extra })
  }), env);
  return { status: res.status, body: await res.json() };
}

describe("messageType: 'instant' 落库即回，投递交给起跳器", () => {
  test('请求返回时还没发推送；alarm 跑完才送达并删行', async () => {
    const { worker, env, adapter, namespace, sent } = await bootstrap();
    const before = Date.now();

    const { status, body } = await postInstant(worker, env);

    assert.equal(status, 202);
    assert.equal(body.data.dispatch, 'kicked');
    assert.equal(body.data.status, 'pending');
    const dueAt = Date.parse(body.data.nextSendAt);
    assert.ok(dueAt >= before - 1000 && dueAt <= Date.now() + 1000, '落库即到期，不用传 firstSendTime');
    assert.equal(sent.length, 0, '投递不在请求里跑');

    const uuid = body.data.uuid;
    const instance = namespace.instances.get(uuid);
    assert.ok(instance, '一条任务一个起跳器实例，实例名就是任务 uuid');
    assert.notEqual(instance.state.alarm, null, '叫醒时设了 alarm');

    await namespace.fireAlarm(uuid);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].message, '你好。');
    assert.equal(sent[0].source, 'instant');
    assert.equal(await adapter.getTaskByUuidOnly(uuid), null, '一次性任务发完即删');
  });

  test('起跳器和 cron 同时扫到同一条：只发一次', async () => {
    let releasePush;
    let pushStarted;
    const started = new Promise((resolve) => { pushStarted = resolve; });
    const sent = [];
    const webpush = {
      async sendNotification(_sub, payload) {
        pushStarted();
        await new Promise((resolve) => { releasePush = resolve; });
        sent.push(JSON.parse(payload));
      }
    };
    const { worker, env, namespace } = await bootstrap({ webpush });
    const { body } = await postInstant(worker, env);

    // alarm 先领到租约、卡在推送上；这时 cron 来扫。
    const alarmRun = namespace.fireAlarm(body.data.uuid);
    await started;
    const tick = await worker.scheduled({}, env);
    releasePush();
    await alarmRun;

    assert.equal(tick.ok, true);
    assert.equal(tick.summary.successCount, 0, '租约在起跳器手里，cron 不碰这条');
    assert.equal(sent.length, 1);
  });

  test('env 里没有起跳器 binding：照样 202，任务留给下一跳 cron', async () => {
    const { worker, env, sent } = await bootstrap({ tick: false });

    const { status, body } = await postInstant(worker, env);

    assert.equal(status, 202);
    assert.equal(body.data.dispatch, 'not_configured');
    assert.equal(sent.length, 0);

    const tick = await worker.scheduled({}, env);
    assert.equal(tick.summary.successCount, 1);
    assert.equal(sent.length, 1);
  });

  test('叫醒失败：不算请求失败，报 kick_failed，任务仍在库里', async () => {
    const { worker, env, adapter } = await bootstrap({ tick: false });
    env[INSTANT_TICK_BINDING] = {
      idFromName: (name) => name,
      get: () => ({ async fetch() { throw new Error('Durable Objects 额度用完了'); } })
    };

    const { status, body } = await postInstant(worker, env);

    assert.equal(status, 202);
    assert.equal(body.data.dispatch, 'kick_failed');
    const row = await adapter.getTaskByUuidOnly(body.data.uuid);
    assert.equal(row.status, 'pending');
  });

  test('config 里配了 dispatchInstant：以宿主的为准，拿到 uuid / userId / tenantId', async () => {
    const calls = [];
    const { worker, env, namespace } = await bootstrap({
      config: { dispatchInstant: (task) => { calls.push(task); } }
    });

    const { status, body } = await postInstant(worker, env);

    assert.equal(status, 202);
    assert.equal(body.data.dispatch, 'kicked');
    assert.deepEqual(calls, [{ uuid: body.data.uuid, userId: USER, tenantId: 'single' }]);
    assert.equal(namespace.instances.size, 0, '没走默认的 Durable Object 起跳器');
  });

  test('instant 传了 firstSendTime 只校验格式，过去的时刻也收', async () => {
    const { worker, env } = await bootstrap();
    const past = new Date(Date.now() - 60_000).toISOString();

    const ok = await postInstant(worker, env, { firstSendTime: past });
    assert.equal(ok.status, 202);

    const bad = await postInstant(worker, env, { firstSendTime: 'tomorrow' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_TIMESTAMP');
  });
});
