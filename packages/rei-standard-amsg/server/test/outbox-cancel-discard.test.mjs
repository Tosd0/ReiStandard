/**
 * 取消 / 顶替一条任务时，它留在 message_outbox 里没投递出去的分段要跟着撤掉；
 * 已经推到设备上的分段照旧留着让客户端 ack。
 *
 * 场景：一条任务的几段 push 在发送前先落进 outbox，推送服务在第二段上挂了，
 * 第二段往后的 delivered_at 仍是 null 等重试。用户在这个窗口里取消（或用
 * supersedesUuid 顶替）了这条消息，接口回 200 说取消成功——但 GET /outbox 只
 * 按「未 ack」选行，客户端下一次补收照样把这几段拉回去并上屏。
 *
 * 顺带钉住 instant 响应对 reasoningError 的透传（有就带上、没有就不出现）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptForStorage, encryptPayload, decryptPayload } from '../src/server/lib/encryption.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';
import { withoutOutbox } from './helpers/no-outbox.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const VAPID = { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' };
const ENC_HEADERS = { 'X-User-Id': USER, 'X-Payload-Encrypted': 'true', 'X-Encryption-Version': '1' };

const TARGET_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1';
const OTHER_UUID = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaa2';
const REPLACEMENT_UUID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffff03';

function inFuture(ms = 3600_000) {
  return new Date(Date.now() + ms).toISOString();
}

async function encBody(payload) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return JSON.stringify(await encryptPayload(payload, userKey));
}

async function decResponse(body) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return decryptPayload(body.data, userKey);
}

/** 起一个 worker + 同一份库的适配器，schema 建好、推送订阅登记好。 */
async function bootstrap(extra = {}) {
  // noOutbox：把适配器包成没有 message_outbox 的样子（内置 pg / neon 的现状）。
  const { noOutbox, ...config } = extra;
  const d1 = createTestD1();
  const worker = createSingleUserCloudflareWorker((env) => {
    const db = createD1Adapter(env.DB);
    return {
      db: noOutbox ? withoutOutbox(db) : db,
      masterKey: MASTER_KEY,
      vapid: VAPID,
      webpush: config.webpush || { async sendNotification() {} },
      ...config,
    };
  });
  const env = { DB: d1 };
  await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
  const adapter = createD1Adapter(d1);
  await seedPushSubscription(adapter, USER, MASTER_KEY);
  return { d1, worker, env, adapter };
}

/** 建一条待发的任务行（内容不重要，这里只关心它的 outbox 分段）。 */
async function seedTask(adapter, uuid) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  await adapter.createTask({
    user_id: USER,
    uuid,
    encrypted_payload: await encryptForStorage(JSON.stringify({
      contactName: 'Rei', messageType: 'fixed', userMessage: 'hi', recurrenceType: 'none'
    }), userKey),
    next_send_at: inFuture(),
    message_type: 'fixed'
  });
}

/**
 * 往 outbox 里塞几段。`delivered` = 已经推到设备上，`acked` = 客户端已确认收到。
 *
 * @param {Array<{ messageId: string, taskUuid: string, delivered?: boolean, acked?: boolean }>} segments
 */
async function seedOutbox(adapter, segments) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const now = Date.now();
  await adapter.appendOutboxMessages(USER, await Promise.all(segments.map(async (seg, i) => ({
    message_id: seg.messageId,
    task_uuid: seg.taskUuid,
    session_id: 'sess_x',
    message_index: i + 1,
    total_messages: segments.length,
    payload: await encryptForStorage(JSON.stringify({
      messageKind: 'content', messageId: seg.messageId, taskUuid: seg.taskUuid, message: `第 ${i + 1} 段`
    }), userKey),
    created_at: now,
  }))));

  const delivered = segments.filter((seg) => seg.delivered || seg.acked).map((seg) => seg.messageId);
  if (delivered.length) await adapter.markOutboxDelivered(USER, delivered, now);
  const acked = segments.filter((seg) => seg.acked).map((seg) => seg.messageId);
  if (acked.length) await adapter.ackOutboxMessages(USER, acked, now);
}

/** 直接看库里还剩哪些行（含已 ack 的——GET /outbox 看不到它们）。 */
function outboxRows(d1, taskUuid) {
  return d1._raw.prepare(
    'SELECT message_id, delivered_at, acked_at FROM message_outbox WHERE task_uuid = ? ORDER BY id'
  ).all(taskUuid);
}

/** 客户端补收拿到的那一页。 */
async function fetchOutbox(worker, env) {
  const res = await worker.fetch(new Request('https://w.dev/outbox?since=0&limit=100', {
    method: 'GET', headers: { 'X-User-Id': USER }
  }), env);
  assert.equal(res.status, 200);
  return decResponse(await res.json());
}

describe('取消 / 顶替时清 outbox', () => {
  test('DELETE /cancel-message：没投递出去的分段不再被补收拉回来', async () => {
    const { d1, worker, env, adapter } = await bootstrap();
    await seedTask(adapter, TARGET_UUID);
    // 第一段推出去了，第二段起推送服务挂了，剩下几段还等着重试。
    await seedOutbox(adapter, [
      { messageId: 'seg-1', taskUuid: TARGET_UUID, delivered: true },
      { messageId: 'seg-2', taskUuid: TARGET_UUID },
      { messageId: 'seg-3', taskUuid: TARGET_UUID },
      { messageId: 'seg-4', taskUuid: TARGET_UUID },
      { messageId: 'seg-5', taskUuid: TARGET_UUID },
      // 另一条任务的未投递分段：取消这条不该殃及它。
      { messageId: 'other-1', taskUuid: OTHER_UUID },
    ]);

    const res = await worker.fetch(new Request(`https://w.dev/cancel-message?id=${TARGET_UUID}`, {
      method: 'DELETE', headers: { 'X-User-Id': USER }
    }), env);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);

    const page = await fetchOutbox(worker, env);
    assert.deepEqual(
      page.entries.map((e) => e.messageId).sort(),
      ['other-1', 'seg-1'],
      '取消后只该剩已经推出去的那一段，和别的任务的分段'
    );
    assert.deepEqual(outboxRows(d1, OTHER_UUID).map((r) => r.message_id), ['other-1']);
  });

  test('supersedesUuid 顶替：旧任务没投递出去的分段同样撤掉', async () => {
    const { d1, worker, env, adapter } = await bootstrap();
    await seedTask(adapter, TARGET_UUID);
    await seedOutbox(adapter, [
      { messageId: 'old-1', taskUuid: TARGET_UUID, delivered: true },
      { messageId: 'old-2', taskUuid: TARGET_UUID },
      { messageId: 'old-3', taskUuid: TARGET_UUID },
      { messageId: 'other-1', taskUuid: OTHER_UUID },
    ]);

    const res = await worker.fetch(new Request('https://w.dev/schedule-message', {
      method: 'POST', headers: ENC_HEADERS,
      body: await encBody({
        contactName: 'Rei', messageType: 'fixed', userMessage: '改了主意',
        firstSendTime: inFuture(),
        uuid: REPLACEMENT_UUID,
        supersedesUuid: TARGET_UUID
      })
    }), env);
    assert.equal(res.status, 201);
    assert.equal((await res.json()).data.superseded, true);

    const page = await fetchOutbox(worker, env);
    assert.deepEqual(
      page.entries.map((e) => e.messageId).sort(),
      ['old-1', 'other-1'],
      '被顶替的那条只该剩已经推出去的那一段'
    );
    assert.equal(outboxRows(d1, TARGET_UUID).length, 1);
  });

  test('已投递 / 已 ack 的分段不受影响（取消不是把收到的消息撤回去）', async () => {
    const { d1, worker, env, adapter } = await bootstrap();
    await seedTask(adapter, TARGET_UUID);
    await seedOutbox(adapter, [
      { messageId: 'kept-acked', taskUuid: TARGET_UUID, acked: true },
      { messageId: 'kept-delivered', taskUuid: TARGET_UUID, delivered: true },
      { messageId: 'dropped', taskUuid: TARGET_UUID },
    ]);

    const res = await worker.fetch(new Request(`https://w.dev/cancel-message?id=${TARGET_UUID}`, {
      method: 'DELETE', headers: { 'X-User-Id': USER }
    }), env);
    assert.equal(res.status, 200);

    const rows = outboxRows(d1, TARGET_UUID);
    assert.deepEqual(rows.map((r) => r.message_id), ['kept-acked', 'kept-delivered']);
    assert.ok(rows[0].acked_at != null, '已 ack 的行是终态，取消不该动它');
    assert.ok(rows[1].delivered_at != null, '已经推到设备上的撤不回来，留着让客户端 ack');
  });

  test('适配器不支持 outbox 时，取消照常成功', async () => {
    // 自定义适配器可能一个 outbox 方法都没有；清理是旁路，缺了不该把取消弄挂。
    const { env, adapter } = await bootstrap();
    await seedTask(adapter, TARGET_UUID);
    const bare = new Proxy(adapter, {
      get(target, prop) {
        if (prop === 'listUnackedOutbox' || prop === 'discardOutboxMessages') return undefined;
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const worker = createSingleUserCloudflareWorker(() => ({
      db: bare, masterKey: MASTER_KEY, vapid: VAPID, webpush: { async sendNotification() {} }
    }));

    const res = await worker.fetch(new Request(`https://w.dev/cancel-message?id=${TARGET_UUID}`, {
      method: 'DELETE', headers: { 'X-User-Id': USER }
    }), env);
    assert.equal(res.status, 200);
    // 只是没清 outbox，任务行确实删掉了。
    assert.equal(await adapter.getTaskByUuid(TARGET_UUID, USER), null);
  });
});

// ─── instant 响应透传 reasoningError ────────────────────────────────────────

/** 让 LLM 那一跳回一段带 reasoning_content 的响应。 */
function stubLlm(content, reasoningContent) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content, reasoning_content: reasoningContent } }] };
    }
  });
  return () => { globalThis.fetch = originalFetch; };
}

describe('instant 响应里的 reasoningError', () => {
  test('思考过程没发出去时带上原因，正文照常算成功', async () => {
    const sent = [];
    const webpush = {
      async sendNotification(_sub, payload) {
        const push = JSON.parse(payload);
        if (push.messageKind === 'reasoning') throw new Error('推送服务拒收');
        sent.push(push);
      }
    };
    // 有收件箱时思考过程只落行、不推送（见 lib/push-policy.js）。这条用例要验
    // 的是「推送失败时把原因说出来」，得站在没有收件箱的部署上。
    const { worker, env } = await bootstrap({ webpush, noOutbox: true });
    const restore = stubLlm('回答。', '先想想');
    try {
      const res = await worker.fetch(new Request('https://w.dev/schedule-message', {
        method: 'POST', headers: ENC_HEADERS,
        body: await encBody({
          contactName: 'Rei', messageType: 'instant',
          firstSendTime: inFuture(),
          completePrompt: 'x',
          apiUrl: 'https://api.example.com/v1/chat/completions',
          apiKey: 's',
          primaryModel: 'm'
        })
      }), env);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.data.status, 'sent');
      assert.equal(body.data.messagesSent, 1);
      assert.equal(sent.length, 1, '正文照发');
      assert.match(body.data.reasoningError, /拒收/, '思考过程没到，得说出原因');
    } finally {
      restore();
    }
  });

  test('没有这个字段时响应里也不出现', async () => {
    const { worker, env } = await bootstrap();
    const res = await worker.fetch(new Request('https://w.dev/schedule-message', {
      method: 'POST', headers: ENC_HEADERS,
      body: await encBody({
        contactName: 'Rei', messageType: 'instant',
        firstSendTime: inFuture(),
        userMessage: '你好。'
      })
    }), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, 'sent');
    assert.equal('reasoningError' in body.data, false, '没原因就别凭空造一个字段出来');
  });
});
