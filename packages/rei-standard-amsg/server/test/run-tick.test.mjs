import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledTick } from '../src/server/lib/run-tick.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptForStorage, decryptFromStorage } from '../src/server/lib/encryption.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const VAPID = { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' };

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// 「刚到点」的触发时刻：过了 30 秒，远没到补发新鲜度上限（60 分钟），
// 照常投递。
function recentDue() {
  return new Date(Date.now() - 30_000).toISOString();
}

function plusMs(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

// getTaskByUuidOnly 只认 pending 行；读终态（failed/sent）的行走 listTasks。
async function findTaskAnyStatus(adapter, uuid) {
  const { tasks } = await adapter.listTasks(USER, { status: 'all', limit: 50 });
  return tasks.find((t) => t.uuid === uuid);
}

async function decryptPayloadOf(row) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return JSON.parse(await decryptFromStorage(row.encrypted_payload, userKey));
}

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

/** 模拟占位这一步就报错（库挂了、适配器有 bug）。 */
function claimTaskThrows(adapter, error) {
  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'claimTask') return async () => { throw error; };
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

test('one-off task: delivered then deleted', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'once', recurrenceType: 'none', nextSendAt: recentDue() });

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
  const dueAt = recentDue();
  await seed(adapter, { uuid: 'daily', recurrenceType: 'daily', nextSendAt: dueAt });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.successCount, 1);
  assert.equal(res.details.updatedRecurringTasks, 1);
  const row = await adapter.getTaskByUuidOnly('daily');
  assert.equal(row.next_send_at, plusMs(dueAt, DAY));
  assert.equal(row.retry_count, 0);
});

test('delivery failure increments retry_count', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'fail', recurrenceType: 'none', nextSendAt: recentDue() });

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
  const dueAt = recentDue();
  await seed(adapter, { uuid: 'race', recurrenceType: 'daily', nextSendAt: dueAt });

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
  assert.equal(row.next_send_at, plusMs(dueAt, DAY));
});

// 占位写的是 lease_until，next_send_at 全程不动——投递期间任务列表读到的
// 还是用户设的那个时刻，不是租期末尾。
test('投递期间库里的 next_send_at 保持原本的触发时刻', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const dueAt = recentDue();
  await seed(adapter, { uuid: 'lease', recurrenceType: 'daily', nextSendAt: dueAt });

  let seenDuringSend = null;
  const webpush = {
    async sendNotification() {
      seenDuringSend = (await adapter.getTaskByUuidOnly('lease')).next_send_at;
    }
  };
  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, claimLeaseMs: 600_000
  });

  assert.equal(seenDuringSend, dueAt);

  // 投递收尾时租约要放掉：下一次的时间一到就能被领走，而不是干等租期结束。
  const row = await adapter.getTaskByUuidOnly('lease');
  assert.equal(row.next_send_at, plusMs(dueAt, DAY));
  assert.equal(
    await adapter.claimTask(row.id, row.next_send_at, new Date(Date.now() + 600_000).toISOString()),
    true
  );
});

// 领了任务的那一跳中途没了（Worker 被回收、进程被杀），投递和后续写库都没
// 发生。租约过期后这条任务由后面的 tick 接手，推进排期的基准必须还是用户设
// 的那个时刻——按租期末尾去推，每断一次就永久往后挪一个租期。
test('投递中途断掉后，接手的 tick 仍按原始触发时刻推进排期', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const dueAt = recentDue();
  await seed(adapter, { uuid: 'abandoned', recurrenceType: 'daily', nextSendAt: dueAt });

  const [row] = await adapter.getPendingTasks(50);
  // 租期末尾用一个已经过去的时刻，等价于「租约早就到期了」。
  assert.equal(await adapter.claimTask(row.id, row.next_send_at, new Date(Date.now() - 10_000).toISOString()), true);

  const webpush = fakeWebpush();
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.successCount, 1);
  assert.equal((await adapter.getTaskByUuidOnly('abandoned')).next_send_at, plusMs(dueAt, DAY));
});

// 重试的退避写在租约上（lease_until = 现在 + 退避），next_send_at 保持名义
// 时刻不动。这样退避既不会被默认 10 分钟的租期压住（2 分钟一到，捞取条件里
// 的 lease 过滤自然放行），也不会污染循环任务的推进基准。
test('投递失败后的重试退避不会被租约压住', async () => {
  const d1 = createTestD1();
  const adapter = createD1Adapter(d1);
  await adapter.initSchema();
  await seed(adapter, { uuid: 'retry', recurrenceType: 'none', nextSendAt: recentDue() });

  const before = Date.now();
  const webpush = { async sendNotification() { throw new Error('push failed'); } };
  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, claimLeaseMs: 600_000
  });

  const row = await d1.prepare('SELECT * FROM scheduled_messages WHERE uuid = ?').bind('retry').first();
  assert.equal(row.retry_count, 1);
  // 租约末尾是 2 分钟的退避，不是 600 秒的占位租期。
  const leaseMs = Date.parse(row.lease_until) - before;
  assert.ok(leaseMs > 0, '退避期间租约还没到期');
  assert.ok(leaseMs <= 2 * MINUTE + 30_000, `退避该是 2 分钟上下，实际 ${leaseMs}ms`);
  // 退避期间这条任务不该被捞出来。
  assert.equal((await adapter.getPendingTasks(50)).length, 0);
});

// 占位失败时宁可不发：此时不知道有没有别的 tick 正在跑这条。
test('占位这一步报错时一条都不投递，任务行保持原样等下一跳', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const dueAt = recentDue();
  await seed(adapter, { uuid: 'claimerr', recurrenceType: 'daily', nextSendAt: dueAt });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({
    db: claimTaskThrows(adapter, new Error('db down')),
    masterKey: MASTER_KEY, vapid: VAPID, webpush
  });

  assert.equal(webpush.sent.length, 0);
  assert.equal(res.successCount, 0);
  assert.equal(res.failedCount, 1);
  assert.equal(res.details.failedTasks[0].status, 'claim_failed');

  const row = await adapter.getTaskByUuidOnly('claimerr');
  assert.equal(row.status, 'pending');
  assert.equal(row.next_send_at, dueAt);
  assert.equal(row.retry_count, 0);
});

test('适配器没实现 claimTask 时照常投递（自定义适配器兼容）', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'noclaim', recurrenceType: 'none', nextSendAt: recentDue() });

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
  const dueAt = recentDue();
  await seed(adapter, {
    uuid: 'hooked',
    recurrenceType: 'daily',
    nextSendAt: dueAt,
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
  assert.equal(seenNextSendAt, dueAt);
});

// ─── 补发新鲜度守卫（stale guard）───────────────────────────────────────
// 服务停摆几天恢复后，攒下的旧任务不该照常补发。

test('过期的一次性任务不补发：标 failed、payload 记 lastError、onStaleSkip 收到回执', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const missedAt = new Date(Date.now() - 2 * 24 * 60 * MINUTE).toISOString(); // 两天前
  await seed(adapter, { uuid: 'stale-once', recurrenceType: 'none', nextSendAt: missedAt });

  const staleCalls = [];
  const webpush = fakeWebpush();
  const res = await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush,
    onStaleSkip: async (task, info) => { staleCalls.push({ uuid: task.uuid, info }); }
  });

  // 一条都没发出去。
  assert.equal(webpush.sent.length, 0);
  assert.equal(res.successCount, 0);
  assert.deepEqual(res.details.staleTasks.map((t) => t.action), ['expired']);

  // 行进了 failed 终态，原因记在 payload 的 lastError 上（GET /messages 透出）。
  const row = await findTaskAnyStatus(adapter, 'stale-once');
  assert.equal(row.status, 'failed');
  const payload = await decryptPayloadOf(row);
  assert.equal(payload.lastError.reason, 'stale');
  assert.equal(payload.lastError.occurrence, missedAt);

  // 消费方靠这个 hook 写「错过了」回执；payload 里没有 metadata 时给 null。
  assert.deepEqual(staleCalls, [{ uuid: 'stale-once', info: { reason: 'stale', metadata: null } }]);
});

test('onStaleSkip 透传解密 payload 的 metadata，凭据字段不外漏', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, {
    uuid: 'stale-meta', recurrenceType: 'none',
    nextSendAt: new Date(Date.now() - 2 * 60 * MINUTE).toISOString(),
    payload: {
      metadata: { charId: 'char-42' },
      messageType: 'prompted', completePrompt: 'p',
      apiUrl: 'https://x', apiKey: 'sk-super-secret', primaryModel: 'm'
    }
  });

  const staleCalls = [];
  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush(),
    onStaleSkip: async (task, info) => { staleCalls.push({ task, info }); }
  });

  assert.equal(staleCalls.length, 1);
  const { task, info } = staleCalls[0];

  // metadata 原样透传：task 是 D1 行原样（payload 是密文），hook 靠 info.metadata
  // 才知道这是哪个角色的任务。
  assert.deepEqual(info, { reason: 'stale', metadata: { charId: 'char-42' } });

  // 防泄漏钉子：解密 payload 里的凭据绝不能递给 hook——只准透传 metadata
  // 这一个子字段，别把整个 decryptedPayload 递出去。
  assert.ok(!('apiKey' in info) && !('pushSubscription' in info));
  const serialized = JSON.stringify([task, info]);
  assert.ok(!serialized.includes('sk-super-secret'));
  assert.ok(!serialized.includes('https://example.com/x')); // pushSubscription.endpoint
});

test('onStaleSkip 抛错只记日志，不影响过期任务标终态', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, {
    uuid: 'stale-hook-throws', recurrenceType: 'none',
    nextSendAt: new Date(Date.now() - 3 * 60 * MINUTE).toISOString()
  });

  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  let res;
  try {
    res = await runScheduledTick({
      db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush(),
      onStaleSkip: async () => { throw new Error('hook boom'); }
    });
  } finally {
    console.warn = origWarn;
  }

  assert.equal(res.details.staleTasks.length, 1);
  assert.equal((await findTaskAnyStatus(adapter, 'stale-hook-throws')).status, 'failed');
  assert.ok(warned >= 1);
});

test('过期的循环任务不补发：排期快进到未来第一个名义时刻，不逐条重放积压', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  // 名义时刻在 3 天 5 分钟前：中间积压了 3 个 occurrence，全都不发。
  const missedMs = Date.now() - 3 * DAY - 5 * MINUTE;
  const missedAt = new Date(missedMs).toISOString();
  await seed(adapter, { uuid: 'stale-daily', recurrenceType: 'daily', nextSendAt: missedAt });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(webpush.sent.length, 0);
  assert.deepEqual(res.details.staleTasks.map((t) => t.action), ['fast_forwarded']);

  // 未来第一个名义时刻 = 名义 + 4 天（保持钟点不变），retry 归零，行还是 pending。
  const row = await adapter.getTaskByUuidOnly('stale-daily');
  assert.equal(row.status, 'pending');
  assert.equal(row.next_send_at, new Date(missedMs + 4 * DAY).toISOString());
  assert.equal(row.retry_count, 0);
});

test('正在重试链上的任务（retry_count > 0）不算过期，照常投递', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, {
    uuid: 'retrying-late', recurrenceType: 'none',
    nextSendAt: new Date(Date.now() - 2 * 60 * MINUTE).toISOString()
  });
  const [seeded] = await adapter.getPendingTasks(50);
  await adapter.updateTaskById(seeded.id, { retry_count: 1 });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.successCount, 1);
  assert.ok(webpush.sent.length >= 1);
});

// ─── 循环任务永不永久死 ─────────────────────────────────────────────────

test('循环任务重试用尽不进终态：跳过本次 occurrence、从名义时刻推进、错误记 lastError', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const dueAt = recentDue();
  await seed(adapter, { uuid: 'daily-doomed', recurrenceType: 'daily', nextSendAt: dueAt });
  const [seeded] = await adapter.getPendingTasks(50);
  await adapter.updateTaskById(seeded.id, { retry_count: 3 }); // 重试已用尽

  const webpush = { async sendNotification() { throw new Error('push failed'); } };
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.failedCount, 1);
  assert.equal(res.details.failedTasks[0].status, 'occurrence_skipped');

  const row = await adapter.getTaskByUuidOnly('daily-doomed');
  assert.equal(row.status, 'pending', '循环任务不该进 failed 终态');
  assert.equal(row.next_send_at, plusMs(dueAt, DAY));
  assert.equal(row.retry_count, 0);
  const payload = await decryptPayloadOf(row);
  assert.equal(payload.lastError.reason, 'push failed');
  assert.equal(payload.lastError.occurrence, dueAt);
});

test('一次性任务重试用尽维持终态行为：标 failed、错误记 lastError', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'once-doomed', recurrenceType: 'none', nextSendAt: recentDue() });
  const [seeded] = await adapter.getPendingTasks(50);
  await adapter.updateTaskById(seeded.id, { retry_count: 3 });

  const webpush = { async sendNotification() { throw new Error('push failed'); } };
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.details.failedTasks[0].status, 'permanently_failed');
  const row = await findTaskAnyStatus(adapter, 'once-doomed');
  assert.equal(row.status, 'failed');
  assert.equal((await decryptPayloadOf(row)).lastError.reason, 'push failed');
});

test('循环任务发送后写库失败不标 sent：推进到下个周期继续活着', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const dueAt = recentDue();
  await seed(adapter, { uuid: 'daily-hiccup', recurrenceType: 'daily', nextSendAt: dueAt });

  // 发送后的第一笔写库（推进排期）抛错一次，之后恢复正常。
  let updateCalls = 0;
  const db = new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'updateTaskById') {
        return async (...args) => {
          updateCalls++;
          if (updateCalls === 1) throw new Error('d1 hiccup');
          return target.updateTaskById(...args);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({ db, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.ok(webpush.sent.length >= 1, '消息本身发出去了');
  assert.equal(res.details.failedTasks[0].status, 'post_send_cleanup_failed_rescheduled');
  assert.equal(res.details.failedTasks[0].messageDelivered, true);

  const row = await adapter.getTaskByUuidOnly('daily-hiccup');
  assert.equal(row.status, 'pending', "循环任务不该被标成 'sent' 退出捞取");
  assert.equal(row.next_send_at, plusMs(dueAt, DAY));
  assert.equal(row.retry_count, 0);
});

// ─── retry 不污染名义时刻 ───────────────────────────────────────────────

test('重试不改写 next_send_at：名义时刻保持原样', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const dueAt = recentDue();
  await seed(adapter, { uuid: 'nominal-kept', recurrenceType: 'daily', nextSendAt: dueAt });

  const webpush = { async sendNotification() { throw new Error('push failed'); } };
  await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  const [row] = (await adapter.listTasks(USER, { status: 'all' })).tasks;
  assert.equal(row.next_send_at, dueAt, '退避不该写进 next_send_at');
  assert.equal(row.retry_count, 1);
});

test('失败重试后成功，循环推进的基准仍是名义时刻（不带退避漂移）', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const dueAt = recentDue();
  await seed(adapter, { uuid: 'no-drift', recurrenceType: 'daily', nextSendAt: dueAt });

  // 第一跳失败 → 退避写在租约上。
  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID,
    webpush: { async sendNotification() { throw new Error('push failed'); } }
  });
  // 手动把退避租约调成已过期，等价于「退避时间到了」。
  const [pending] = (await adapter.listTasks(USER, { status: 'all' })).tasks;
  await adapter.updateTaskById(pending.id, { lease_until: new Date(Date.now() - 1000).toISOString() });

  // 第二跳成功 → 推进到名义时刻 + 24h，而不是（名义 + 退避）+ 24h。
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush() });
  assert.equal(res.successCount, 1);
  const row = await adapter.getTaskByUuidOnly('no-drift');
  assert.equal(row.next_send_at, plusMs(dueAt, DAY));
  assert.equal(row.retry_count, 0);
});
