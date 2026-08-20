/**
 * 2.7.0 的一批上游能力：
 *   - client_state 条件写护栏（version / builtAt）
 *   - POST /schedule-message 的 immediate / supersedesUuid
 *   - 租约心跳（renewTaskLease）与 runTask 单任务入口
 *   - last_error 列 + GET /message 对失败行透出原因
 *   - NonRetryableError：确定性失败不重试
 *   - fire ctx 的 cancelTask / renewTask
 *   - message_outbox + GET /outbox / POST /outbox/ack
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledTick, runTask } from '../src/server/lib/run-tick.js';
import { NonRetryableError } from '../src/server/lib/errors.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptForStorage, encryptPayload, decryptPayload } from '../src/server/lib/encryption.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const VAPID = { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' };
const ENC_HEADERS = { 'X-User-Id': USER, 'X-Payload-Encrypted': 'true', 'X-Encryption-Version': '1' };

function recentDue() {
  return new Date(Date.now() - 30_000).toISOString();
}

async function freshAdapter() {
  const raw = createTestD1();
  const adapter = createD1Adapter(raw);
  await adapter.initSchema();
  return { raw, adapter };
}

async function seed(adapter, { uuid, recurrenceType = 'none', nextSendAt, payload = {} }) {
  await seedPushSubscription(adapter, USER, MASTER_KEY);
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const enc = await encryptForStorage(JSON.stringify({
    contactName: 'Rei',
    messageType: 'fixed',
    userMessage: 'hi',
    recurrenceType,
    ...payload
  }), userKey);
  await adapter.createTask({
    user_id: USER,
    uuid,
    encrypted_payload: enc,
    next_send_at: nextSendAt,
    message_type: payload.messageType || 'fixed'
  });
}

function fakeWebpush() {
  const sent = [];
  return { sent, async sendNotification(sub, payload) { sent.push(payload); } };
}

function makeWorker(extra = {}) {
  return createSingleUserCloudflareWorker((env) => ({
    db: createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: VAPID,
    webpush: extra.webpush || { async sendNotification() {} },
    ...extra,
  }));
}

async function encBody(payload) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return JSON.stringify(await encryptPayload(payload, userKey));
}

async function decResponse(body) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return decryptPayload(body.data, userKey);
}

// ─── client_state 条件写护栏 ────────────────────────────────────────────────

describe('client_state version guard', () => {
  test('晚到的旧包（builtAt 更小）盖不掉先到的新包，即便 updatedAt 更新', async () => {
    const d1 = createTestD1();
    const worker = makeWorker();
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const put = async (entries) => worker.fetch(new Request('https://w.dev/client-state', {
      method: 'PUT', headers: ENC_HEADERS, body: await encBody({ entries })
    }), env);

    // 新包先到：builtAt 2000（updatedAt 是它被 flush 的时刻，较早）。
    let res = await put([{ namespace: 'fire', key: 'fire_pack', value: 'NEW', updatedAt: 100, builtAt: 2000 }]);
    assert.deepEqual((await res.json()).data, { upserted: 1, skipped: 0 });

    // 旧包慢网晚到：flush 时刻更晚（updatedAt 300），但内容是旧的（builtAt 1000）。
    res = await put([{ namespace: 'fire', key: 'fire_pack', value: 'OLD', updatedAt: 300, builtAt: 1000 }]);
    assert.deepEqual((await res.json()).data, {
      upserted: 0, skipped: 1,
      skippedEntries: [{ namespace: 'fire', key: 'fire_pack' }]
    });

    const getRes = await worker.fetch(new Request('https://w.dev/client-state?namespace=fire', {
      method: 'GET', headers: { 'X-User-Id': USER }
    }), env);
    const data = await decResponse(await getRes.json());
    assert.deepEqual(data.entries.map((e) => e.value), ['NEW']);
  });

  test('非法的 version / builtAt 只拒那一条', async () => {
    const d1 = createTestD1();
    const worker = makeWorker();
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const res = await worker.fetch(new Request('https://w.dev/client-state', {
      method: 'PUT', headers: ENC_HEADERS,
      body: await encBody({ entries: [
        { namespace: 'n', key: 'bad', value: 'x', updatedAt: 100, version: -1 },
        { namespace: 'n', key: 'good', value: 'y', updatedAt: 100 },
      ] })
    }), env);
    const data = (await res.json()).data;
    assert.equal(data.upserted, 1);
    assert.equal(data.rejected.length, 1);
    assert.equal(data.rejected[0].code, 'INVALID_STATE_VERSION');
    assert.equal(data.rejected[0].key, 'bad');
  });
});

// ─── POST /schedule-message: immediate + supersedesUuid ─────────────────────

describe('schedule-message immediate / supersede', () => {
  test('immediate: true 不要求 firstSendTime 在未来，next_send_at 落在当下', async () => {
    const d1 = createTestD1();
    const worker = makeWorker();
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const adapter = createD1Adapter(d1);
    await seedPushSubscription(adapter, USER, MASTER_KEY);

    const before = Date.now();
    const res = await worker.fetch(new Request('https://w.dev/schedule-message', {
      method: 'POST', headers: ENC_HEADERS,
      body: await encBody({
        contactName: 'Rei', messageType: 'fixed', userMessage: 'now!',
        immediate: true, uuid: '11111111-2222-4333-8444-555555555555'
      })
    }), env);
    assert.equal(res.status, 201);
    const body = await res.json();
    const at = Date.parse(body.data.nextSendAt);
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, 'next_send_at 应是当下');

    // 立刻就能被 tick 捞走（不用等未来时刻）。
    const webpush = fakeWebpush();
    const tick = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });
    assert.equal(tick.successCount, 1);
  });

  test('immediate 对 instant 类型明确拒绝', async () => {
    const d1 = createTestD1();
    const worker = makeWorker();
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const res = await worker.fetch(new Request('https://w.dev/schedule-message', {
      method: 'POST', headers: ENC_HEADERS,
      body: await encBody({ contactName: 'Rei', messageType: 'instant', userMessage: 'x', immediate: true })
    }), env);
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'INVALID_PARAMETERS');
  });

  test('supersedesUuid：同一请求里取消旧任务、建新任务（D1 原子路径）', async () => {
    const d1 = createTestD1();
    const worker = makeWorker();
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const adapter = createD1Adapter(d1);
    const oldUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await seed(adapter, { uuid: oldUuid, nextSendAt: new Date(Date.now() + 3600_000).toISOString() });

    const res = await worker.fetch(new Request('https://w.dev/schedule-message', {
      method: 'POST', headers: ENC_HEADERS,
      body: await encBody({
        contactName: 'Rei', messageType: 'fixed', userMessage: 'v2',
        firstSendTime: new Date(Date.now() + 3600_000).toISOString(),
        uuid: '99999999-8888-4777-8666-555555555554',
        supersedesUuid: oldUuid
      })
    }), env);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.data.superseded, true);
    assert.equal(await adapter.getTaskByUuid(oldUuid, USER), null);
    assert.ok(await adapter.getTaskByUuid('99999999-8888-4777-8666-555555555554', USER));

    // 旧行不存在时 superseded: false，新任务照建。
    const res2 = await worker.fetch(new Request('https://w.dev/schedule-message', {
      method: 'POST', headers: ENC_HEADERS,
      body: await encBody({
        contactName: 'Rei', messageType: 'fixed', userMessage: 'v3',
        firstSendTime: new Date(Date.now() + 3600_000).toISOString(),
        supersedesUuid: oldUuid
      })
    }), env);
    assert.equal(res2.status, 201);
    assert.equal((await res2.json()).data.superseded, false);
  });

  test('supersedesUuid 撞新任务自己的 uuid 被拒', async () => {
    const d1 = createTestD1();
    const worker = makeWorker();
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const res = await worker.fetch(new Request('https://w.dev/schedule-message', {
      method: 'POST', headers: ENC_HEADERS,
      body: await encBody({
        contactName: 'Rei', messageType: 'fixed', userMessage: 'x',
        firstSendTime: new Date(Date.now() + 3600_000).toISOString(),
        uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        supersedesUuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      })
    }), env);
    assert.equal(res.status, 400);
  });
});

// ─── 租约心跳 + runTask ────────────────────────────────────────────────────

describe('lease heartbeat / runTask', () => {
  test('心跳可用时占位只写短租约（不再是 10 分钟死租约）', async () => {
    const { raw, adapter } = await freshAdapter();
    await seed(adapter, { uuid: 'hb', nextSendAt: recentDue() });

    let leaseDuringDelivery = null;
    const webpush = {
      async sendNotification() {
        const row = raw._raw.prepare('SELECT lease_until FROM scheduled_messages LIMIT 1').get();
        leaseDuringDelivery = Date.parse(row.lease_until);
      }
    };
    await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });
    assert.ok(leaseDuringDelivery != null);
    const ttl = leaseDuringDelivery - Date.now();
    assert.ok(ttl > 0 && ttl <= 2 * 60 * 1000, `滚动租约应在 ~90s 量级，实际 ${ttl}ms`);
  });

  test('leaseHeartbeatMs: 0 退回一次性长租约', async () => {
    const { raw, adapter } = await freshAdapter();
    await seed(adapter, { uuid: 'legacy', nextSendAt: recentDue() });
    let leaseDuringDelivery = null;
    const webpush = {
      async sendNotification() {
        const row = raw._raw.prepare('SELECT lease_until FROM scheduled_messages LIMIT 1').get();
        leaseDuringDelivery = Date.parse(row.lease_until);
      }
    };
    await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, leaseHeartbeatMs: 0 });
    const ttl = leaseDuringDelivery - Date.now();
    assert.ok(ttl > 5 * 60 * 1000, `关掉心跳应是长租约，实际 ${ttl}ms`);
  });

  test('renewTaskLease：持有租约时续得动，放掉之后续不动', async () => {
    const { adapter } = await freshAdapter();
    await seed(adapter, { uuid: 'rn', nextSendAt: recentDue() });
    const [task] = await adapter.getPendingTasks(1);
    assert.ok(await adapter.claimTask(task.id, task.next_send_at, new Date(Date.now() + 90_000).toISOString()));
    assert.equal(await adapter.renewTaskLease(task.id, new Date(Date.now() + 180_000).toISOString()), true);
    await adapter.updateTaskById(task.id, { lease_until: null });
    // 收尾放掉租约之后，迟到的心跳不能把它复活。
    assert.equal(await adapter.renewTaskLease(task.id, new Date(Date.now() + 180_000).toISOString()), false);
  });

  test('runTask：到点的任务按完整投递链跑；没到点/不存在的不跑', async () => {
    const { adapter } = await freshAdapter();
    await seed(adapter, { uuid: 'rt-due', nextSendAt: recentDue() });
    await seed(adapter, { uuid: 'rt-future', nextSendAt: new Date(Date.now() + 3600_000).toISOString() });

    const webpush = fakeWebpush();
    const ctx = { db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush };

    assert.deepEqual(await runTask(ctx, 'rt-missing'), { ran: false, reason: 'not_found' });

    const notDue = await runTask(ctx, 'rt-future');
    assert.equal(notDue.ran, false);
    assert.equal(notDue.reason, 'not_due');

    const ran = await runTask(ctx, 'rt-due');
    assert.equal(ran.ran, true);
    assert.equal(ran.summary.successCount, 1);
    assert.ok(webpush.sent.length >= 1);
    // 一次性任务发完即删；future 那条原样躺着。
    assert.equal(await adapter.getTaskByUuid('rt-due', USER), null);
    assert.ok(await adapter.getTaskByUuid('rt-future', USER));
  });
});

// ─── NonRetryableError + last_error + GET /message 透出 ────────────────────

describe('NonRetryableError / last_error', () => {
  test('hook 抛 NonRetryableError → 直接标 failed，不进重试阶梯，last_error 落列', async () => {
    const { raw, adapter } = await freshAdapter();
    await seed(adapter, {
      uuid: 'nr', nextSendAt: recentDue(),
      payload: { messageType: 'auto', apiUrl: 'https://x', apiKey: 'sk-fake', primaryModel: 'm', completePrompt: 'p' }
    });
    const hooks = {
      onBeforeFire: async () => { throw new NonRetryableError('fire_pack 缺 chat 段', { code: 'FIRE_PACK_INVALID' }); },
      onLLMOutput: async () => ({ decision: 'skip-push' }),
    };
    const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush(), hooks });
    assert.equal(res.failedCount, 1);
    assert.equal(res.details.failedTasks[0].status, 'permanently_failed');
    assert.equal(res.details.failedTasks[0].permanent, true);

    const row = raw._raw.prepare('SELECT status, retry_count, last_error FROM scheduled_messages').get();
    assert.equal(row.status, 'failed');
    assert.equal(row.retry_count, 0);
    const lastError = JSON.parse(row.last_error);
    assert.match(lastError.reason, /fire_pack/);
  });

  test('普通失败在等重试期间也写 last_error；成功后清掉', async () => {
    const { raw, adapter } = await freshAdapter();
    await seed(adapter, { uuid: 'lr', recurrenceType: 'daily', nextSendAt: recentDue() });

    let fail = true;
    const webpush = { async sendNotification() { if (fail) throw new Error('push endpoint 503'); } };
    await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });
    let row = raw._raw.prepare('SELECT retry_count, retry_after, last_error FROM scheduled_messages').get();
    assert.equal(row.retry_count, 1);
    assert.ok(row.retry_after);
    assert.match(JSON.parse(row.last_error).reason, /503/);

    // 到点重试成功 → last_error 清掉、排期推进。
    fail = false;
    raw._raw.prepare('UPDATE scheduled_messages SET retry_after = ?').run(new Date(Date.now() - 1000).toISOString());
    await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });
    row = raw._raw.prepare('SELECT retry_count, last_error FROM scheduled_messages').get();
    assert.equal(row.retry_count, 0);
    assert.equal(row.last_error, null);
  });

  test('GET /message 对已失败的行透出 lastError（409 details）', async () => {
    const d1 = createTestD1();
    const worker = makeWorker();
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const adapter = createD1Adapter(d1);
    const uuid = 'ffffffff-0000-4111-8222-333333333333';
    await seed(adapter, { uuid, nextSendAt: recentDue() });
    const [task] = await adapter.getPendingTasks(1);
    await adapter.updateTaskById(task.id, {
      status: 'failed',
      last_error: JSON.stringify({ at: new Date().toISOString(), occurrence: task.next_send_at, reason: '任务载荷解析失败' })
    });

    const res = await worker.fetch(new Request(`https://w.dev/message?id=${uuid}`, {
      method: 'GET', headers: { 'X-User-Id': USER }
    }), env);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'TASK_ALREADY_COMPLETED');
    assert.equal(body.error.details.status, 'failed');
    assert.match(body.error.details.lastError.reason, /解析失败/);
  });
});

// ─── fire ctx 的 cancelTask / renewTask ────────────────────────────────────

describe('fire ctx cancelTask / renewTask', () => {
  async function fireCtxOf(adapter, hooksFn) {
    await seed(adapter, {
      uuid: 'fire-self', nextSendAt: recentDue(),
      payload: { messageType: 'auto', apiUrl: 'https://x', apiKey: 'sk-fake', primaryModel: 'm', completePrompt: 'p' }
    });
    const hooks = {
      onBeforeFire: async (ctx) => { await hooksFn(ctx); return { skip: true }; },
      onLLMOutput: async () => ({ decision: 'skip-push' }),
    };
    return runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush(), hooks });
  }

  test('cancelTask 删掉别的任务；取消当前任务被拒', async () => {
    const { adapter } = await freshAdapter();
    const otherUuid = '12121212-3434-4565-8787-909090909090';
    await seed(adapter, { uuid: otherUuid, nextSendAt: new Date(Date.now() + 3600_000).toISOString() });

    let selfCancelError = null;
    const res = await fireCtxOf(adapter, async (ctx) => {
      assert.deepEqual(await ctx.cancelTask(otherUuid), { cancelled: true });
      assert.deepEqual(await ctx.cancelTask(otherUuid), { cancelled: false });
      try { await ctx.cancelTask('fire-self'); } catch (e) { selfCancelError = e; }
    });
    assert.equal(res.successCount, 1);
    assert.equal(await adapter.getTaskByUuid(otherUuid, USER), null);
    assert.match(String(selfCancelError), /当前正在 fire/);
  });

  test('cancelTask 取消的任务：outbox 里没发出去的分段跟着撤掉（与 DELETE /cancel-message 同一收尾）', async () => {
    const { adapter } = await freshAdapter();
    const otherUuid = '13131313-2424-4343-8565-676767676767';
    await seed(adapter, { uuid: otherUuid, nextSendAt: new Date(Date.now() + 3600_000).toISOString() });
    // 那条任务此前投递到一半失败过：一段推出去了，剩下的还躺在 outbox 里等重试。
    const now = Date.now();
    await adapter.appendOutboxMessages(USER, [
      { message_id: 'b-sent', task_uuid: otherUuid, session_id: 's', payload: 'cipher', created_at: now },
      { message_id: 'b-pending', task_uuid: otherUuid, session_id: 's', payload: 'cipher', created_at: now },
    ]);
    await adapter.markOutboxDelivered(USER, ['b-sent'], now);

    const res = await fireCtxOf(adapter, async (ctx) => {
      assert.deepEqual(await ctx.cancelTask(otherUuid), { cancelled: true });
    });
    assert.equal(res.successCount, 1);
    assert.equal(await adapter.getTaskByUuid(otherUuid, USER), null);

    const rows = await adapter.listUnackedOutbox(USER, 0, 50);
    assert.deepEqual(
      rows.map((r) => r.message_id),
      ['b-sent'],
      '没发出去的分段要跟着撤掉（否则 GET /outbox 会把已取消任务的内容补收回去）；已推出去的留着 ack'
    );
  });

  test('renewTask 改到新时刻（payload 的 firstSendTime 跟着改），太近的时刻被拒', async () => {
    const { adapter } = await freshAdapter();
    const otherUuid = '21212121-4343-4656-8878-808080808080';
    await seed(adapter, { uuid: otherUuid, nextSendAt: new Date(Date.now() + 3600_000).toISOString() });
    const newAt = new Date(Date.now() + 2 * 3600_000).toISOString();

    let tooSoonError = null;
    const res = await fireCtxOf(adapter, async (ctx) => {
      const r = await ctx.renewTask(otherUuid, newAt);
      assert.deepEqual(r, { renewed: true, uuid: otherUuid, nextSendAt: newAt });
      assert.deepEqual(await ctx.renewTask('no-such-uuid', newAt), { renewed: false, reason: 'not_found' });
      try { await ctx.renewTask(otherUuid, new Date(Date.now() + 10_000).toISOString()); } catch (e) { tooSoonError = e; }
    });
    assert.equal(res.successCount, 1);
    const row = await adapter.getTaskByUuid(otherUuid, USER);
    assert.equal(row.next_send_at, newAt);
    assert.match(String(tooSoonError), /至少要比现在晚/);
  });
});

// ─── message_outbox ────────────────────────────────────────────────────────

describe('message outbox', () => {
  test('投递前落行、发出后标 delivered；GET /outbox 拉未 ack 的；ack 后不再返回', async () => {
    const d1 = createTestD1();
    const webpush = fakeWebpush();
    const worker = makeWorker({ webpush });
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const adapter = createD1Adapter(d1);
    // 两句话 → 两条 ContentPush。
    await seed(adapter, { uuid: 'ob', nextSendAt: recentDue(), payload: { userMessage: '早上好。今天降温。' } });
    await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });
    assert.equal(webpush.sent.length, 2);

    // 拉未 ack 的两条：payload 解密后是完整 push（含任务身份）。
    const listRes = await worker.fetch(new Request('https://w.dev/outbox?since=0', {
      method: 'GET', headers: { 'X-User-Id': USER }
    }), env);
    assert.equal(listRes.status, 200);
    const page = await decResponse(await listRes.json());
    assert.equal(page.entries.length, 2);
    assert.equal(page.hasMore, false);
    assert.ok(page.cursor >= page.entries[1].id);
    for (const e of page.entries) {
      assert.ok(e.deliveredAt != null, '发送成功的行应标 delivered');
      assert.equal(e.taskUuid, 'ob');
      assert.equal(e.push.taskUuid, 'ob');
      assert.ok(e.push.message);
    }
    assert.deepEqual(page.entries.map((e) => e.messageIndex), [1, 2]);

    // ack 第一条 → 再拉只剩第二条。
    const ackRes = await worker.fetch(new Request('https://w.dev/outbox/ack', {
      method: 'POST', headers: ENC_HEADERS,
      body: await encBody({ messageIds: [page.entries[0].messageId] })
    }), env);
    assert.equal(ackRes.status, 200);
    assert.deepEqual((await ackRes.json()).data, { acked: 1 });

    const listRes2 = await worker.fetch(new Request('https://w.dev/outbox', {
      method: 'GET', headers: { 'X-User-Id': USER }
    }), env);
    const page2 = await decResponse(await listRes2.json());
    assert.deepEqual(page2.entries.map((e) => e.messageId), [page.entries[1].messageId]);

    // ack 幂等：再 ack 同一条不动。
    const ackAgain = await worker.fetch(new Request('https://w.dev/outbox/ack', {
      method: 'POST', headers: ENC_HEADERS,
      body: await encBody({ messageIds: [page.entries[0].messageId] })
    }), env);
    assert.deepEqual((await ackAgain.json()).data, { acked: 0 });
  });

  test('推送半途失败：发出的段标 delivered，没发出的留着（delivered_at null）', async () => {
    const { raw, adapter } = await freshAdapter();
    await seed(adapter, { uuid: 'ob2', nextSendAt: recentDue(), payload: { userMessage: '一。二。三。' } });
    let calls = 0;
    const webpush = { async sendNotification() { if (++calls === 2) throw new Error('endpoint down'); } };
    await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

    const rows = raw._raw.prepare('SELECT message_id, delivered_at FROM message_outbox ORDER BY id').all();
    assert.equal(rows.length, 3, '三段都在发送前落了行');
    assert.ok(rows[0].delivered_at != null);
    assert.equal(rows[1].delivered_at, null);
    assert.equal(rows[2].delivered_at, null);
  });

  test('重试同一 occurrence 复用 messageId，不产生第二行；已 ack 的行不被重试复活', async () => {
    const { raw, adapter } = await freshAdapter();
    await seed(adapter, { uuid: 'ob3', recurrenceType: 'daily', nextSendAt: recentDue(), payload: { userMessage: '同一句。' } });
    let failFirst = true;
    const webpush = { async sendNotification() { if (failFirst) { failFirst = false; throw new Error('flaky'); } } };
    await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });
    let rows = raw._raw.prepare('SELECT message_id, acked_at FROM message_outbox').all();
    assert.equal(rows.length, 1);
    // 客户端 ack 掉它，然后重试轮再来。
    await adapter.ackOutboxMessages(USER, [rows[0].message_id], Date.now());
    raw._raw.prepare('UPDATE scheduled_messages SET retry_after = ?').run(new Date(Date.now() - 1000).toISOString());
    await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });
    rows = raw._raw.prepare('SELECT message_id, acked_at FROM message_outbox').all();
    assert.equal(rows.length, 1, '同一 (user, messageId) 只有一行');
    assert.ok(rows[0].acked_at != null, '已 ack 的行不被重试拉回未读');
  });
});
