import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledTick } from '../src/server/lib/run-tick.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const VAPID = { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' };

async function seed(adapter, { uuid, recurrenceType, nextSendAt, payload = {} }) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const enc = await encryptForStorage(JSON.stringify({
    contactName: 'Rei',
    messageType: 'fixed',
    userMessage: 'hi',
    recurrenceType,
    pushSubscription: { endpoint: 'https://example.com/x', keys: { p256dh: 'k', auth: 'a' } },
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

/**
 * 让 getPendingTasks 每次都返回同一批预先读好的行，其余方法照常走真适配器。
 * 用来复现「上一跳还在跑，下一跳已经把同一行捞出来了」的时序。
 */
function replayingPendingTasks(adapter, rows) {
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'getPendingTasks') return async () => rows.map((row) => ({ ...row }));
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

/** 模拟没实现 claimTask 的自定义适配器。 */
function withoutClaimTask(adapter) {
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'claimTask') return undefined;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

test('one-off task: delivered then deleted', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'once', recurrenceType: 'none', nextSendAt: '2020-01-01T00:00:00.000Z' });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.successCount, 1);
  assert.equal(res.details.deletedOnceOffTasks, 1);
  assert.ok(webpush.sent.length >= 1);
  assert.equal((await adapter.getPendingTasks(50)).length, 0);
});

// 基准是排程时的触发时刻，不是占位时写进库的租期时间——否则这里会变成
// 「现在 + 租期 + 24h」。
test('daily task: delivered then rescheduled +24h, retry reset', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'daily', recurrenceType: 'daily', nextSendAt: '2020-01-01T00:00:00.000Z' });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.successCount, 1);
  assert.equal(res.details.updatedRecurringTasks, 1);
  const row = await adapter.getTaskByUuidOnly('daily');
  assert.equal(row.next_send_at, '2020-01-02T00:00:00.000Z');
  assert.equal(row.retry_count, 0);
});

test('delivery failure increments retry_count', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'fail', recurrenceType: 'none', nextSendAt: '2020-01-01T00:00:00.000Z' });

  const webpush = { async sendNotification() { throw new Error('push failed'); } };
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.failedCount, 1);
  const row = await adapter.getTaskByUuidOnly('fail');
  assert.equal(row.retry_count, 1);
});

// cron 每分钟一跳、跳与跳之间互不相让，一次投递跑过 60 秒就会被下一跳再捞
// 一遍。占位（CAS next_send_at）就是拦这个的。
test('上一跳还在推送时，下一跳捞到同一条任务也不会重复发', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'race', recurrenceType: 'daily', nextSendAt: '2020-01-01T00:00:00.000Z' });

  // 两跳读到的是同一批行（第二跳在第一跳占位之前就把行捞出来了）。
  const rows = await adapter.getPendingTasks(50);
  const db = replayingPendingTasks(adapter, rows);

  let sends = 0;
  let markPushing;
  const pushing = new Promise((resolve) => { markPushing = resolve; });
  let releasePush;
  const held = new Promise((resolve) => { releasePush = resolve; });
  // 只卡住第一条推送：没有占位时第二跳会照发不误，测试要在断言上挂掉，
  // 而不是两跳一起等门闩把自己等死。
  const webpush = {
    async sendNotification() {
      sends++;
      if (sends === 1) {
        markPushing();
        await held;
      }
    }
  };

  const firstTick = runScheduledTick({ db, masterKey: MASTER_KEY, vapid: VAPID, webpush });
  await pushing; // 第一跳卡在推送里

  const second = await runScheduledTick({ db, masterKey: MASTER_KEY, vapid: VAPID, webpush });
  assert.equal(second.details.claimSkippedTasks, 1);
  assert.equal(second.successCount, 0);

  releasePush();
  const first = await firstTick;
  assert.equal(first.successCount, 1);
  assert.equal(sends, 1);

  // 第一跳跑完后仍按原始触发时刻推进到下一次。
  const row = await adapter.getTaskByUuidOnly('race');
  assert.equal(row.next_send_at, '2020-01-02T00:00:00.000Z');
});

test('占位期间库里的 next_send_at 被顶到未来，投递完才回到正常排期', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'lease', recurrenceType: 'daily', nextSendAt: '2020-01-01T00:00:00.000Z' });

  let leasedAt = null;
  const webpush = {
    async sendNotification() {
      leasedAt = (await adapter.getTaskByUuidOnly('lease')).next_send_at;
    }
  };
  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, claimLeaseMs: 60_000
  });

  assert.ok(new Date(leasedAt).getTime() > Date.now(), '推送期间这一行不该再是「到点待发」');
  assert.equal((await adapter.getTaskByUuidOnly('lease')).next_send_at, '2020-01-02T00:00:00.000Z');
});

test('适配器没实现 claimTask 时照常投递（自定义适配器兼容）', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'noclaim', recurrenceType: 'none', nextSendAt: '2020-01-01T00:00:00.000Z' });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({
    db: withoutClaimTask(adapter), masterKey: MASTER_KEY, vapid: VAPID, webpush
  });

  assert.equal(res.successCount, 1);
  assert.equal(res.details.claimSkippedTasks, 0);
  assert.ok(webpush.sent.length >= 1);
});

test('hook 拿到的 nextSendAt 是原始触发时刻，不是占位后的租期', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, {
    uuid: 'hooked',
    recurrenceType: 'daily',
    nextSendAt: '2020-01-01T00:00:00.000Z',
    payload: { messageType: 'prompted', completePrompt: 'p', apiUrl: 'https://x', apiKey: 'k', primaryModel: 'm' }
  });

  let seenNextSendAt = null;
  const hooks = {
    async onBeforeFire(hookCtx) {
      seenNextSendAt = hookCtx.task.nextSendAt;
      return { skip: true };
    },
    async onLLMOutput() { throw new Error('不该走到这里'); }
  };

  const webpush = fakeWebpush();
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, hooks });

  assert.equal(res.successCount, 1);
  assert.equal(seenNextSendAt, '2020-01-01T00:00:00.000Z');
});
