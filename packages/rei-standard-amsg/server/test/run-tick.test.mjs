import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledTick } from '../src/server/lib/run-tick.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptForStorage, decryptFromStorage } from '../src/server/lib/encryption.js';
import { projectTask } from '../src/server/lib/task-projection.js';
import { sendWebPush } from '../src/server/lib/webpush-webcrypto.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

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
  // 用户级订阅：投递时现读这一份，任务行不携带订阅。
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

// 重试的退避写在 retry_after 上，next_send_at 保持名义时刻不动，租约当场放
// 掉。这样退避既不会被默认 10 分钟的租期压住（2 分钟一到，捞取条件里的
// retry_after 过滤自然放行），也不会污染循环任务的推进基准；租约放掉是因为
// 它只表示「这条正在跑」，等重试的任务并没有在跑。
test('投递失败后的重试退避写在 retry_after 上，租约当场放掉', async () => {
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
  // 退避时刻在 retry_after 上，且是 2 分钟上下，不是 600 秒的占位租期。
  const backoffMs = Date.parse(row.retry_after) - before;
  assert.ok(backoffMs > 0, '退避还没到点');
  assert.ok(backoffMs <= 2 * MINUTE + 30_000, `退避该是 2 分钟上下，实际 ${backoffMs}ms`);
  // 租约不能继续占着：占着的话分组串行会把同组别的任务一起堵住一轮退避。
  assert.equal(row.lease_until, null);
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

// ─── 分组串行（serializeBy）─────────────────────────────────────────────
// 同一个角色可能有好几条定时任务。撞在一起并发跑的话，用户一口气收到两条互
// 不知情的消息，而宿主在 hook 里维护的「我刚才说过什么」台账是读进内存 → 改
// → 整份写回，两条各改各的再写回，后写的必然盖掉前面那条——有一句说过的话没
// 记上账，下次角色会换个说法再讲一遍。

const byCharId = (task) => (task.metadata && task.metadata.charId) || null;

test('同一分组的两条任务：一跳只放行一条，另一条行原样留到下一跳', async () => {
  const d1 = createTestD1();
  const adapter = createD1Adapter(d1);
  await adapter.initSchema();
  const firstDue = new Date(Date.now() - 60_000).toISOString();
  const secondDue = new Date(Date.now() - 30_000).toISOString();
  await seed(adapter, { uuid: 'c1-a', recurrenceType: 'none', nextSendAt: firstDue, payload: { metadata: { charId: 'char-1' } } });
  await seed(adapter, { uuid: 'c1-b', recurrenceType: 'none', nextSendAt: secondDue, payload: { metadata: { charId: 'char-1' } } });

  const webpush = fakeWebpush();
  const first = await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, serializeBy: byCharId
  });

  assert.equal(first.successCount, 1, '同一分组一跳只发一条');
  assert.equal(first.details.serializeSkippedTasks, 1);

  // 被拦下的那条是推迟不是丢弃：一个字段都没被动过（连租约都没写过）。
  const held = await d1.prepare('SELECT * FROM scheduled_messages WHERE uuid = ?').bind('c1-b').first();
  assert.equal(held.status, 'pending');
  assert.equal(held.next_send_at, secondDue);
  assert.equal(held.retry_count, 0);
  assert.equal(held.lease_until, null);
  assert.equal(held.retry_after, null);

  // 下一跳照常把它发出去。
  const second = await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, serializeBy: byCharId
  });
  assert.equal(second.successCount, 1);
  assert.equal((await adapter.getPendingTasks(50)).length, 0);
});

// 同组放行哪一条不能看运气：分组串行要的就是「同一个角色的消息按时间顺序一
// 条一条来」，晚的那条抢在早的前面发出去，正是它要避免的事。这条把「先到点的
// 先跑」钉住——建表顺序故意和到点顺序相反。
test('同一分组里放行的是到点更早的那条', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const later = new Date(Date.now() - 30_000).toISOString();
  const earlier = new Date(Date.now() - 90_000).toISOString();
  await seed(adapter, { uuid: 'later', recurrenceType: 'none', nextSendAt: later, payload: { metadata: { charId: 'char-5' }, userMessage: 'second' } });
  await seed(adapter, { uuid: 'earlier', recurrenceType: 'none', nextSendAt: earlier, payload: { metadata: { charId: 'char-5' }, userMessage: 'first' } });

  const webpush = fakeWebpush();
  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, serializeBy: byCharId
  });

  assert.equal(webpush.sent.length, 1);
  assert.match(webpush.sent[0], /first/, '先发到点更早的那条');
  assert.ok(await adapter.getTaskByUuidOnly('later'), '晚的那条留到下一跳');
});

// 一次 fire 常常要跑十几秒到几分钟（组 prompt → 调 LLM → 跑工具 → 分段推
// 送），所以危险窗口不止「同一跳」：上一跳的 fire 还在跑时，下一跳捞到同角色
// 的另一条任务，照样读到的是那份还没写回的旧台账。
test('上一跳的同分组任务还在跑时，下一跳的另一条也不放行', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'x-a', recurrenceType: 'none', nextSendAt: new Date(Date.now() - 60_000).toISOString(), payload: { metadata: { charId: 'char-9' } } });
  await seed(adapter, { uuid: 'x-b', recurrenceType: 'none', nextSendAt: new Date(Date.now() - 30_000).toISOString(), payload: { metadata: { charId: 'char-9' } } });

  let sends = 0;
  let markPushing;
  const pushing = new Promise((resolve) => { markPushing = resolve; });
  let releasePush;
  const held = new Promise((resolve) => { releasePush = resolve; });
  const webpush = {
    async sendNotification() {
      sends++;
      if (sends === 1) { markPushing(); await held; }
    }
  };

  const firstTick = runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, serializeBy: byCharId
  });
  await pushing; // 第一跳卡在推送里，x-a 的租约还拿着

  const second = await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, serializeBy: byCharId
  });
  // 第二跳捞到的是 x-b（x-a 正被租约挡着），但同分组正忙，占位不给过。
  assert.equal(second.successCount, 0, '同分组还有任务在跑，这一跳一条都不该发');
  assert.equal(second.details.claimSkippedTasks, 1);
  assert.equal(sends, 1);

  releasePush();
  assert.equal((await firstTick).successCount, 1);

  const stillPending = await adapter.getTaskByUuidOnly('x-b');
  assert.equal(stillPending.status, 'pending');
  assert.equal(stillPending.retry_count, 0);
});

// 退避中的任务其实闲着。退避要是和「正在跑」共用 lease_until 那一列，同分组
// 别的任务就得白等一轮退避（最长 6 分钟）才动得了。
test('同分组里有任务在退避重试，不挡住这一组的其他任务', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'r-a', recurrenceType: 'none', nextSendAt: new Date(Date.now() - 60_000).toISOString(), payload: { metadata: { charId: 'char-3' } } });

  // 第一跳：r-a 投递失败 → 进退避。
  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, serializeBy: byCharId,
    webpush: { async sendNotification() { throw new Error('push failed'); } }
  });
  assert.equal((await adapter.getPendingTasks(50)).length, 0, '退避期间 r-a 捞不出来');

  // 同一个角色的另一条任务到点了。
  await seed(adapter, { uuid: 'r-b', recurrenceType: 'none', nextSendAt: new Date(Date.now() - 30_000).toISOString(), payload: { metadata: { charId: 'char-3' } } });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, serializeBy: byCharId
  });
  assert.equal(res.successCount, 1, '退避中的任务不该把同分组的其他任务一起堵住');
  assert.ok(webpush.sent.length >= 1);
});

test('serializeBy 返回 null 的任务不参与串行，照常并发', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'free-a', recurrenceType: 'none', nextSendAt: new Date(Date.now() - 60_000).toISOString() });
  await seed(adapter, { uuid: 'free-b', recurrenceType: 'none', nextSendAt: new Date(Date.now() - 30_000).toISOString() });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, serializeBy: byCharId
  });
  assert.equal(res.successCount, 2);
  assert.equal(res.details.serializeSkippedTasks, 0);
});

test('不配 serializeBy 时同角色的多条任务照旧一起跑', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'p-a', recurrenceType: 'none', nextSendAt: new Date(Date.now() - 60_000).toISOString(), payload: { metadata: { charId: 'char-1' } } });
  await seed(adapter, { uuid: 'p-b', recurrenceType: 'none', nextSendAt: new Date(Date.now() - 30_000).toISOString(), payload: { metadata: { charId: 'char-1' } } });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });
  assert.equal(res.successCount, 2);
  assert.equal(res.details.serializeSkippedTasks, 0);
});

test('serializeBy 抛错时这条任务这一跳不跑，行也不动', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const dueAt = recentDue();
  await seed(adapter, { uuid: 'boom', recurrenceType: 'daily', nextSendAt: dueAt });

  const origWarn = console.warn;
  let warned = 0;
  console.warn = () => { warned++; };
  const webpush = fakeWebpush();
  let res;
  try {
    res = await runScheduledTick({
      db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush,
      serializeBy: () => { throw new Error('分组算不出来'); }
    });
  } finally {
    console.warn = origWarn;
  }

  assert.equal(webpush.sent.length, 0, '分不清属于哪一组就不该冒险跑');
  assert.equal(res.details.serializeSkippedTasks, 1);
  assert.ok(warned >= 1);

  const row = await adapter.getTaskByUuidOnly('boom');
  assert.equal(row.status, 'pending');
  assert.equal(row.next_send_at, dueAt);
  assert.equal(row.retry_count, 0);
});

test('serializeBy 拿到的是剔掉凭据的任务视图（与 onBeforeFire 的 ctx.task 同款）', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const dueAt = recentDue();
  await seed(adapter, {
    uuid: 'view', recurrenceType: 'daily', nextSendAt: dueAt,
    payload: {
      metadata: { charId: 'char-42' },
      messageType: 'prompted', completePrompt: 'p',
      apiUrl: 'https://x', apiKey: 'sk-super-secret', primaryModel: 'm'
    }
  });

  const seen = [];
  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush(),
    hooks: {
      async onBeforeFire() { return { skip: true }; },
      async onLLMOutput() { throw new Error('不该走到这里'); }
    },
    serializeBy: (task) => { seen.push(task); return byCharId(task); }
  });

  assert.equal(seen.length, 1);
  const view = seen[0];
  assert.deepEqual(view.metadata, { charId: 'char-42' });
  assert.equal(view.uuid, 'view');
  assert.equal(view.nextSendAt, dueAt, 'nextSendAt 是名义触发时刻，不是占位租期');
  // 防泄漏钉子：凭据不能出现在分组函数拿到的视图里。
  assert.ok(!('apiKey' in view) && !('pushSubscription' in view));
  assert.ok(!JSON.stringify(view).includes('sk-super-secret'));
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
  assert.equal(staleCalls.length, 1);
  assert.equal(staleCalls[0].uuid, 'stale-once');
  const info = staleCalls[0].info;
  assert.equal(info.reason, 'stale');
  assert.equal(info.action, 'expired');
  assert.equal(info.metadata, null);
  assert.equal(info.recurrenceType, 'none');
  assert.equal(info.skippedCount, 1);
  assert.equal(info.nextSendAt, null);
  assert.deepEqual(info.skippedOccurrences, [Date.parse(missedAt)]);
  // 状态读写口跟着回执一起来：服务停摆恢复后的第一跳可能一次 fire 都没跑过，
  // 宿主此时也得写得下这条痕迹。
  assert.equal(typeof info.readState, 'function');
  assert.equal(typeof info.writeState, 'function');
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
  assert.deepEqual(info.metadata, { charId: 'char-42' });

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

  // 第一跳失败 → 退避写在 retry_after 上。
  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID,
    webpush: { async sendNotification() { throw new Error('push failed'); } }
  });
  // 手动把退避时刻调成已过去，等价于「退避时间到了」。
  const [pending] = (await adapter.listTasks(USER, { status: 'all' })).tasks;
  await adapter.updateTaskById(pending.id, { retry_after: new Date(Date.now() - 1000).toISOString() });

  // 第二跳成功 → 推进到名义时刻 + 24h，而不是（名义 + 退避）+ 24h。
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush() });
  assert.equal(res.successCount, 1);
  const row = await adapter.getTaskByUuidOnly('no-drift');
  assert.equal(row.next_send_at, plusMs(dueAt, DAY));
  assert.equal(row.retry_count, 0);
});

// ─── 循环任务按角色时区的墙钟推进 ─────────────────────────────────────────

// 固定 +86400000ms 的推进跨过夏令时切换点之后，用户设的「每天早八点」会永久
// 变成早九点。这条钉住「任务行上的 tzId 真的被读到、并且一路传到写库」。
test('daily 任务带 tzId：快进之后纽约的墙钟时刻不变', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();

  // 2026-03-08 是美国春令时切换日。3 月 7 日 08:00 EST = 13:00Z。
  const missedAt = '2026-03-07T13:00:00.000Z';
  await seed(adapter, {
    uuid: 'tz-daily', recurrenceType: 'daily', nextSendAt: missedAt,
    payload: { tzId: 'America/New_York' }
  });

  await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush() });

  const row = await adapter.getTaskByUuidOnly('tz-daily');
  const wall = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date(row.next_send_at));
  assert.equal(wall, '08:00', `墙钟应保持早八点，实际 ${wall}（${row.next_send_at}）`);
});

test('不带 tzId 的 daily 任务维持固定周期推进', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const dueAt = recentDue();
  await seed(adapter, { uuid: 'tz-absent', recurrenceType: 'daily', nextSendAt: dueAt });

  await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush() });

  assert.equal((await adapter.getTaskByUuidOnly('tz-absent')).next_send_at, plusMs(dueAt, DAY));
});

// ─── 循环任务的过期跳过也有回执 ───────────────────────────────────────────

test('循环任务快进也调 onStaleSkip：带 action / 跳过次数 / 被跳过的名义时刻', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const missedMs = Date.now() - 3 * DAY - 5 * MINUTE;
  const missedAt = new Date(missedMs).toISOString();
  await seed(adapter, {
    uuid: 'stale-daily-hook', recurrenceType: 'daily', nextSendAt: missedAt,
    payload: { metadata: { charId: 'char-7' } }
  });

  const calls = [];
  const res = await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush(),
    onStaleSkip: async (task, info) => { calls.push({ task, info }); }
  });

  assert.deepEqual(res.details.staleTasks.map((t) => t.action), ['fast_forwarded']);
  assert.equal(res.details.staleTasks[0].skippedCount, 4);

  assert.equal(calls.length, 1, '循环任务的快进以前一声不吭，现在必须有回执');
  const { info } = calls[0];
  assert.equal(info.reason, 'stale');
  assert.equal(info.action, 'fast_forwarded');
  assert.equal(info.recurrenceType, 'daily');
  assert.deepEqual(info.metadata, { charId: 'char-7' });
  // 名义那次 + 之后三次 = 4 次没响。
  assert.equal(info.skippedCount, 4);
  assert.deepEqual(info.skippedOccurrences, [
    missedMs, missedMs + DAY, missedMs + 2 * DAY, missedMs + 3 * DAY
  ]);
  assert.equal(info.skippedTruncated, false);
  assert.equal(info.nextSendAt, new Date(missedMs + 4 * DAY).toISOString());
  assert.equal(typeof info.readState, 'function');
  assert.equal(typeof info.writeState, 'function');

  // 行还活着、排期已快进，同时 payload 上留下了「上次为什么没响」。
  const row = await adapter.getTaskByUuidOnly('stale-daily-hook');
  assert.equal(row.status, 'pending');
  assert.equal(row.next_send_at, new Date(missedMs + 4 * DAY).toISOString());
  const payload = await decryptPayloadOf(row);
  assert.equal(payload.lastError.reason, 'stale');
  assert.equal(payload.lastError.occurrence, missedAt);
  assert.equal(payload.lastError.skippedCount, 4);
});

// 服务停摆恢复后的第一跳里，这个 tick 可能一次 fire 都没跑过。回执 hook 必须
// 自带一个能用的写口，否则「过期跳过」这件事一条痕迹都留不下——而那正是这个
// hook 存在的意义。
test('onStaleSkip 自带的 writeState 能直接落库（本跳没有任何 fire 跑过）', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, {
    uuid: 'stale-write', recurrenceType: 'none',
    nextSendAt: new Date(Date.now() - 2 * 60 * MINUTE).toISOString()
  });

  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush(),
    onStaleSkip: async (_task, info) => {
      await info.writeState('missed', [{ key: 'char-7', value: JSON.stringify({ at: info.occurrenceMs }) }]);
    }
  });

  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const rows = await adapter.getClientState(USER, 'missed');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'char-7');
  assert.ok(JSON.parse(await decryptFromStorage(rows[0].value, userKey)).at > 0);
});

test('onStaleSkip 自带的 readState 读得到客户端同步上来的状态', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  await adapter.upsertClientState(USER, [
    { namespace: 'notes', key: 'k', value: await encryptForStorage('hello', userKey), updatedAt: 42 }
  ]);
  await seed(adapter, {
    uuid: 'stale-read', recurrenceType: 'none',
    nextSendAt: new Date(Date.now() - 2 * 60 * MINUTE).toISOString()
  });

  let seen = null;
  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush(),
    onStaleSkip: async (_task, info) => { seen = await info.readState('notes'); }
  });

  assert.deepEqual(seen, [{ namespace: 'notes', key: 'k', value: 'hello', updatedAt: 42 }]);
});

// ─── 推送服务判死刑的订阅（410 / 404） ───────────────────────────────────

/**
 * 推送服务硬失败：错误形状与 shared 的 sendWebPush 一致（code + statusCode）。
 */
function webpushRejectingWithStatus(statusCode, statusText) {
  const calls = { count: 0 };
  return {
    calls,
    async sendNotification() {
      calls.count++;
      const error = new Error(
        `Web Push delivery failed: ${statusCode} ${statusText} — push subscription is no longer valid`
      );
      error.code = 'PUSH_SEND_FAILED';
      error.statusCode = statusCode;
      throw error;
    }
  };
}

// 投递是先生成后推送。410 要是留在 2/4/6 分钟的退避阶梯里，同一条消息会被重
// 新生成四轮（首次 + 三次重试），每轮都真花 LLM 的钱，而那条订阅已经注销了，
// 一句也发不出去。
test('推送回 410：一次性任务当场进终态，不再走 2/4/6 分钟的重试梯子', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'gone-once', recurrenceType: 'none', nextSendAt: recentDue() });

  const webpush = webpushRejectingWithStatus(410, 'Gone');
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.failedCount, 1);
  assert.equal(res.details.failedTasks[0].status, 'permanently_failed');
  assert.equal(res.details.failedTasks[0].permanent, true);
  assert.equal(res.details.failedTasks[0].nextRetryAt, undefined, '不该排下一次重试');

  const row = await findTaskAnyStatus(adapter, 'gone-once');
  assert.equal(row.status, 'failed');
  assert.equal(row.retry_count, 0, '410 一次都不该进退避阶梯');
  assert.equal(webpush.calls.count, 1, '这一跳只推一次，之后不再重跑生成');
});

// 订阅失效不等于「用户没登记过设备」：把行删掉的话，客户端的体检面板会显示
// 「云端没有收件设备」，把用户引去重新登记——而重新登记只是把同一条死订阅再
// 写一遍。这个事实靠 last_error 里的 pushStatus 传给下游，不靠删行表达。
test('410 判终态不动 push_subscriptions 里那行订阅', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'gone-keeps-sub', recurrenceType: 'none', nextSendAt: recentDue() });
  const before = await adapter.getPushSubscription(USER);

  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID,
    webpush: webpushRejectingWithStatus(410, 'Gone')
  });

  const after = await adapter.getPushSubscription(USER);
  assert.ok(after, '订阅行还在');
  assert.equal(after.subscription, before.subscription);
});

test('410 的失败记录带 pushStatus: 410，reason 仍是那句人话摘要', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'gone-detail', recurrenceType: 'none', nextSendAt: recentDue() });

  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID,
    webpush: webpushRejectingWithStatus(410, 'Gone')
  });

  const row = await findTaskAnyStatus(adapter, 'gone-detail');
  const rowLastError = JSON.parse(row.last_error);
  assert.equal(rowLastError.pushStatus, 410);
  assert.match(rowLastError.reason, /Web Push delivery failed: 410 Gone/);

  // 投影优先读 payload 里那份 lastError，所以两处都得有——只写行上那一列的
  // 话，GET /messages 交出去的记录里 pushStatus 会凭空消失。
  const payload = await decryptPayloadOf(row);
  assert.equal(payload.lastError.pushStatus, 410);
  assert.equal(payload.lastError.reason, rowLastError.reason);
  assert.equal(projectTask(row, payload).lastError.pushStatus, 410);
});

test('推送回 404（端点压根不存在）同样当终态', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'missing-endpoint', recurrenceType: 'none', nextSendAt: recentDue() });

  const res = await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID,
    webpush: webpushRejectingWithStatus(404, 'Not Found')
  });

  assert.equal(res.details.failedTasks[0].status, 'permanently_failed');
  assert.equal(res.details.failedTasks[0].permanent, true);
  const row = await findTaskAnyStatus(adapter, 'missing-endpoint');
  assert.equal(row.status, 'failed');
  assert.equal(row.retry_count, 0);
  assert.equal(JSON.parse(row.last_error).pushStatus, 404);
});

// 推送服务抖一下（500 / 502 之类）跟订阅失效是两回事，别一起判死。
test('推送回 500：照旧走重试梯子，不当订阅失效处理', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'push-500', recurrenceType: 'none', nextSendAt: recentDue() });

  const res = await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID,
    webpush: webpushRejectingWithStatus(500, 'Internal Server Error')
  });

  assert.equal(res.details.failedTasks[0].retryCount, 1);
  assert.ok(res.details.failedTasks[0].nextRetryAt, '排了下一次重试');
  assert.equal(res.details.failedTasks[0].permanent, undefined);

  const pending = await adapter.getTaskByUuidOnly('push-500');
  assert.equal(pending.status, 'pending');
  assert.equal(pending.retry_count, 1);
  assert.ok(pending.retry_after, '退避写在 retry_after 上');

  const lastError = JSON.parse((await adapter.getTaskStatusInfo('push-500', USER)).last_error);
  assert.equal(lastError.pushStatus, 500);
  assert.ok(lastError.pushStatus !== 410 && lastError.pushStatus !== 404);
});

test('循环任务撞上 410：跳到下一次 occurrence，不进 failed 终态', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  const dueAt = recentDue();
  await seed(adapter, { uuid: 'gone-daily', recurrenceType: 'daily', nextSendAt: dueAt });

  const res = await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID,
    webpush: webpushRejectingWithStatus(410, 'Gone')
  });

  assert.equal(res.details.failedTasks[0].status, 'occurrence_skipped');
  assert.equal(res.details.failedTasks[0].permanent, true);

  const row = await adapter.getTaskByUuidOnly('gone-daily');
  assert.equal(row.status, 'pending', '循环任务不该进 failed 终态');
  assert.equal(row.next_send_at, plusMs(dueAt, DAY));
  assert.equal(row.retry_count, 0);
  assert.equal(JSON.parse((await adapter.getTaskStatusInfo('gone-daily', USER)).last_error).pushStatus, 410);
});

// ─── 成功之后失败记录要清干净 ───────────────────────────────────────────

/** 等一个条件成立，到点还不成立就当断言失败——别让测试挂死在 while 里。 */
async function waitUntil(predicate, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// 循环任务失败一次（订阅回 410）之后，用户重新登记订阅、之后天天正常送达——
// GET /message 里不该永远挂着那次 410。客户端就是按 pushStatus 判断「要不要
// 提示用户重建订阅」的，挂着就会在一切正常时无限提示。
test('循环任务成功一次之后，lastError 不再挂着上一轮的 410', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'recovered', recurrenceType: 'daily', nextSendAt: recentDue() });

  await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID,
    webpush: webpushRejectingWithStatus(410, 'Gone')
  });
  const failed = await adapter.getTaskByUuid('recovered', USER);
  assert.equal(projectTask(failed, await decryptPayloadOf(failed)).lastError.pushStatus, 410);
  assert.equal((await decryptPayloadOf(failed)).lastError.pushStatus, 410, '密文 payload 里也留了一份');

  // 排期已经跳到明天，拨回到点再跑一跳——这次正常送达。
  await adapter.updateTaskById(failed.id, { next_send_at: recentDue() });
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush() });
  assert.equal(res.successCount, 1);

  const row = await adapter.getTaskByUuid('recovered', USER);
  assert.equal(row.last_error, null, '行上的失败记录成功时被清掉');
  // 密文里那份成功时没人清（只为一条记录重写整份密文不划算），所以投影必须以
  // 行上那一列为准——反过来的话这里会读到那条早就过去的 410。
  assert.equal(projectTask(row, await decryptPayloadOf(row)).lastError, null);
});

// 没有 last_error 列的适配器（自定义适配器），失败原因只落在密文 payload 里，
// 那它就是权威的那一份，成功时也得擦掉。
test('没有 last_error 列的适配器：成功之后 payload 里的 lastError 也清掉', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'no-column', recurrenceType: 'daily', nextSendAt: recentDue() });
  const db = withoutClaimTask(adapter);

  await runScheduledTick({
    db, masterKey: MASTER_KEY, vapid: VAPID,
    webpush: webpushRejectingWithStatus(410, 'Gone')
  });
  const failed = await adapter.getTaskByUuid('no-column', USER);
  assert.equal((await decryptPayloadOf(failed)).lastError.pushStatus, 410);

  await adapter.updateTaskById(failed.id, { next_send_at: recentDue() });
  const res = await runScheduledTick({ db, masterKey: MASTER_KEY, vapid: VAPID, webpush: fakeWebpush() });
  assert.equal(res.successCount, 1);

  const row = await adapter.getTaskByUuid('no-column', USER);
  assert.equal((await decryptPayloadOf(row)).lastError, undefined, '成功之后不该还留着上一轮的失败');
});

// ─── 内容装不下（PUSH_PAYLOAD_TOO_LARGE / 413） ─────────────────────────

/** 走真正的大小护栏：超限的 payload 在加密之前就抛，fetch 永远不会被调用。 */
function webpushWithRealSizeGuard() {
  const calls = { count: 0 };
  return {
    calls,
    async sendNotification(subscription, payload) {
      calls.count++;
      return sendWebPush({
        subscription,
        payload,
        vapid: VAPID,
        fetch: () => { throw new Error('超限的 payload 不该发出去'); }
      });
    }
  };
}

// 投递是先跑 LLM 再推送。「这条内容装不下」跟这一轮生成出来的内容绑死，退避两
// 分钟后重来只会把生成整轮重跑一次，再撞同一堵墙。
test('payload 超限（PUSH_PAYLOAD_TOO_LARGE）当场判终态，不走 2/4/6 分钟的梯子', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, {
    uuid: 'too-large', recurrenceType: 'none', nextSendAt: recentDue(),
    payload: { userMessage: 'x'.repeat(5000) }
  });

  const webpush = webpushWithRealSizeGuard();
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.details.failedTasks[0].status, 'permanently_failed');
  assert.equal(res.details.failedTasks[0].permanent, true);
  assert.equal(res.details.failedTasks[0].nextRetryAt, undefined, '不该排下一次重试');
  assert.equal(webpush.calls.count, 1, '只试一次，不重跑一轮生成');

  const row = await findTaskAnyStatus(adapter, 'too-large');
  assert.equal(row.status, 'failed');
  assert.equal(row.retry_count, 0);
  // 下游要知道「为什么发不出去」才能去裁短内容，读的是 errorCode 不是 reason。
  assert.equal(JSON.parse(row.last_error).errorCode, 'PUSH_PAYLOAD_TOO_LARGE');
  assert.equal(
    projectTask(row, await decryptPayloadOf(row)).lastError.errorCode,
    'PUSH_PAYLOAD_TOO_LARGE'
  );
});

// 密文超限时推送服务回 413，说的是同一件事，只是发现得晚一步。
test('推送服务回 413（密文超限）同样当终态', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'too-large-413', recurrenceType: 'none', nextSendAt: recentDue() });

  const res = await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID,
    webpush: webpushRejectingWithStatus(413, 'Payload Too Large')
  });

  assert.equal(res.details.failedTasks[0].status, 'permanently_failed');
  assert.equal(res.details.failedTasks[0].permanent, true);
  const row = await findTaskAnyStatus(adapter, 'too-large-413');
  assert.equal(row.retry_count, 0);
  assert.equal(JSON.parse(row.last_error).pushStatus, 413);
});

// VAPID 配错（400 / 401 / 403）重试同样好不了，但那是整个部署级别的故障：判终
// 态会把这段时间内每一条一次性任务都永久标 failed，配置修好也回不来了。这类
// 失败留在退避阶梯里，原因靠 last_error 里的机读字段说清楚。
test('推送回 401（VAPID 配置错）照旧走重试梯子，不判终态', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'vapid-401', recurrenceType: 'none', nextSendAt: recentDue() });

  const res = await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID,
    webpush: webpushRejectingWithStatus(401, 'Unauthorized')
  });

  assert.equal(res.details.failedTasks[0].retryCount, 1);
  assert.ok(res.details.failedTasks[0].nextRetryAt, '排了下一次重试');
  assert.equal(res.details.failedTasks[0].permanent, undefined);

  const pending = await adapter.getTaskByUuidOnly('vapid-401');
  assert.equal(pending.status, 'pending');
  const lastError = JSON.parse((await adapter.getTaskStatusInfo('vapid-401', USER)).last_error);
  assert.equal(lastError.pushStatus, 401);
  assert.equal(lastError.errorCode, 'PUSH_SEND_FAILED');
});

// ─── 投递期间任务被取消 ─────────────────────────────────────────────────

// DELETE /message 是无条件删行 + 当场回「任务已成功取消」。投递侧从占位到推送
// 之间不再读库，唯一能知道「这条已经不归我了」的信号就是续租的条件写扑空。
test('投递期间任务被取消：剩下的推送不再发出，也不算成功', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'cancel-mid', recurrenceType: 'none', nextSendAt: recentDue() });

  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  let markInside;
  const inside = new Promise((resolve) => { markInside = resolve; });
  let renewMisses = 0;

  const db = new Proxy(adapter, {
    get(target, prop) {
      // 读订阅是推送前的最后一步：卡在这里等于「内容都备好了，还没推出去」。
      if (prop === 'getPushSubscription') {
        return async (...args) => {
          markInside();
          await gate;
          return target.getPushSubscription(...args);
        };
      }
      if (prop === 'renewTaskLease') {
        return async (...args) => {
          const renewed = await target.renewTaskLease(...args);
          if (!renewed) renewMisses++;
          return renewed;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  const webpush = fakeWebpush();
  const tick = runScheduledTick({
    db, masterKey: MASTER_KEY, vapid: VAPID, webpush, leaseHeartbeatMs: 10
  });
  await inside;

  // 用户这时候点了取消，接口当场回 200「任务已成功取消」。
  assert.equal(await adapter.deleteTaskByUuid('cancel-mid', USER), true);
  await waitUntil(() => renewMisses > 0, '续租一直没扑空，取消信号没传到投递侧');
  openGate();

  const res = await tick;
  assert.equal(webpush.sent.length, 0, '回了「已取消」就不能再把消息发出去');
  assert.equal(res.successCount, 0);
  assert.equal(res.failedCount, 0, '取消不是投递失败，不该混进 failedTasks');
  assert.deepEqual(res.details.cancelledTasks.map((t) => t.status), ['cancelled_mid_delivery']);
});

// 心跳的间隔盖不住的那段窗口：推送已经发完，收尾删行才发现行早没了。消息确实
// 送达了，但这一跳不能记成功——记成功的话 summary 里一点痕迹都没有。
test('推送发完才发现任务已被取消：不算成功，summary 里看得见', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'cancel-late', recurrenceType: 'none', nextSendAt: recentDue() });

  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  let markSending;
  const sending = new Promise((resolve) => { markSending = resolve; });
  const sent = [];
  const webpush = {
    async sendNotification(_subscription, payload) {
      sent.push(payload);
      markSending();
      await gate;
    }
  };

  // 心跳关掉：这条走的是「收尾写库匹配不到行」那条路，与心跳无关。
  const tick = runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, leaseHeartbeatMs: 0
  });
  await sending;
  assert.equal(await adapter.deleteTaskByUuid('cancel-late', USER), true);
  openGate();

  const res = await tick;
  assert.equal(sent.length, 1, '这条已经发出去了，改不了');
  assert.equal(res.successCount, 0);
  assert.equal(res.details.deletedOnceOffTasks, 0);
  assert.deepEqual(res.details.cancelledTasks.map((t) => t.status), ['cancelled_after_delivery']);
});

// 取消只挡住 Web Push 是不够的：整批 push 在发送前就已经落进 message_outbox
// （补收的事实来源），剩下没发出去的那几行不撤掉，客户端下一次 GET /outbox 会
// 照样把它们拉回去——用户看到的就是「取消接口回了成功，消息还是来了」。
test('投递期间被取消：没发出去的那几条从 outbox 里撤掉，补收拉不到', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, {
    uuid: 'cancel-outbox',
    recurrenceType: 'none',
    nextSendAt: recentDue(),
    // 拆成两句：第一句发得出去，取消发生在第二句之前。
    payload: { userMessage: '第一句。第二句。' }
  });

  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  let markSending;
  const sending = new Promise((resolve) => { markSending = resolve; });
  let renewMisses = 0;
  const sent = [];

  const db = new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'renewTaskLease') {
        return async (...args) => {
          const renewed = await target.renewTaskLease(...args);
          if (!renewed) renewMisses++;
          return renewed;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  const webpush = {
    async sendNotification(_subscription, payload) {
      sent.push(payload);
      if (sent.length === 1) {
        markSending();
        await gate;
      }
    }
  };

  const tick = runScheduledTick({
    db, masterKey: MASTER_KEY, vapid: VAPID, webpush, leaseHeartbeatMs: 10
  });
  await sending;

  // 第一句已经推出去了，用户这时候点了取消。
  assert.equal(await adapter.deleteTaskByUuid('cancel-outbox', USER), true);
  await waitUntil(() => renewMisses > 0, '续租一直没扑空，取消信号没传到投递侧');
  openGate();

  const res = await tick;
  assert.equal(sent.length, 1, '第二句被拦下了');
  assert.deepEqual(res.details.cancelledTasks.map((t) => t.status), ['cancelled_mid_delivery']);

  const unacked = await adapter.listUnackedOutbox(USER, 0, 50);
  assert.equal(unacked.length, 1, '只剩已经推出去的那一条，第二句不能留在补收队列里');
  assert.equal(unacked[0].message_index, 1);
  assert.ok(unacked[0].delivered_at, '留下的那条是真发出去过的');
});

// 冻结的 webpush 对象：宿主按常见写法传 Object.freeze({ sendNotification })。
// 取消检查那一层要是用 Proxy 包，get trap 返回包装函数会踩 Proxy 不变式当场抛
// TypeError——那个部署下每一条定时消息都发不出去，还照常走 2/4/6 分钟的梯子。
test('宿主传冻结的 webpush 对象：消息照常发得出去', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'frozen-webpush', recurrenceType: 'none', nextSendAt: recentDue() });

  const sent = [];
  const webpush = Object.freeze({
    async sendNotification(_subscription, payload) { sent.push(payload); }
  });

  const res = await runScheduledTick({
    db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush, leaseHeartbeatMs: 10
  });

  assert.equal(res.successCount, 1, `冻结的 webpush 不该把投递打挂：${JSON.stringify(res.details.failedTasks)}`);
  assert.equal(res.failedCount, 0);
  assert.equal(sent.length, 1);
});

// 跟着包内 schema 建表、但没实现可选的 claimTask 的自定义适配器：行上有
// last_error 这一列，投影也认它权威，写入侧却按「实现了 claimTask 才写」跳过
// ——结果 GET /message 的 lastError 永远是 null，客户端看不到上次为什么没发出去。
test('没实现 claimTask 但有 last_error 列的适配器：失败原因照样读得到', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'no-claim-lasterror', recurrenceType: 'none', nextSendAt: recentDue() });

  const db = withoutClaimTask(adapter);
  const webpush = {
    async sendNotification() {
      const error = new Error('subscription gone');
      error.statusCode = 410;
      throw error;
    }
  };

  const res = await runScheduledTick({ db, masterKey: MASTER_KEY, vapid: VAPID, webpush });
  assert.equal(res.failedCount, 1);

  const row = await findTaskAnyStatus(adapter, 'no-claim-lasterror');
  const projected = projectTask(row, await decryptPayloadOf(row));
  assert.ok(projected.lastError, '行上有 last_error 列，投影认它权威，写入侧就必须往里写');
  assert.equal(projected.lastError.pushStatus, 410);
});

// 投递跑 LLM 的几十秒里用户 PUT 改了任务。收尾清 lastError 时若把领取时的
// payload 快照原样写回去，那次修改会被静默回滚——界面上再查还是旧内容。
test('成功收尾清 lastError：不覆盖投递期间用户改过的正文', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, {
    uuid: 'concurrent-put',
    recurrenceType: 'daily',
    nextSendAt: recentDue(),
    // 上一轮失败留下的记录：成功收尾时要清掉它，才会走到重写密文那一步。
    payload: { userMessage: '旧的正文。', lastError: { at: '2026-01-01T00:00:00.000Z', reason: 'push failed' } }
  });

  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  let markSending;
  const sending = new Promise((resolve) => { markSending = resolve; });

  const webpush = {
    async sendNotification() {
      markSending();
      await gate;
    }
  };

  // 心跳关掉：这条测的是密文覆盖，跟租约无关（没实现 claimTask 的适配器本来
  // 就没有租约拦着）。
  const tick = runScheduledTick({
    db: withoutClaimTask(adapter), masterKey: MASTER_KEY, vapid: VAPID, webpush, leaseHeartbeatMs: 0
  });
  await sending;

  // 用户这时候把正文改了，接口回了 200。
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const updated = await encryptForStorage(JSON.stringify({
    contactName: 'Rei',
    messageType: 'fixed',
    userMessage: '用户刚改的正文。',
    recurrenceType: 'daily'
  }), userKey);
  assert.ok(await adapter.updateTaskByUuid('concurrent-put', USER, updated, { retry_count: 0 }));
  openGate();

  await tick;

  const row = await findTaskAnyStatus(adapter, 'concurrent-put');
  const payload = await decryptPayloadOf(row);
  assert.equal(payload.userMessage, '用户刚改的正文。', '投递收尾不能把用户刚保存的改动写回旧值');
});

// 投递跑到一半失败，而用户在这几十秒里 PUT 改了任务。失败收尾要往 payload 里
// 记 lastError，但它写的是领取时的快照——原样写回去，那次修改就被静默回滚了。
// 成功收尾那条路早就有这个守卫，失败这条路走得更勤，一样得有。
test('失败收尾记 lastError：不覆盖投递期间用户改过的正文', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, {
    uuid: 'concurrent-put-on-failure',
    recurrenceType: 'daily',
    nextSendAt: recentDue(),
    payload: { userMessage: '旧的正文。' }
  });

  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  let markSending;
  const sending = new Promise((resolve) => { markSending = resolve; });

  const webpush = {
    async sendNotification() {
      markSending();
      await gate;
      throw new Error('push failed');
    }
  };

  const tick = runScheduledTick({
    db: withoutClaimTask(adapter), masterKey: MASTER_KEY, vapid: VAPID, webpush, leaseHeartbeatMs: 0
  });
  await sending;

  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const updated = await encryptForStorage(JSON.stringify({
    contactName: 'Rei',
    messageType: 'fixed',
    userMessage: '用户刚改的正文。',
    recurrenceType: 'daily'
  }), userKey);
  assert.ok(await adapter.updateTaskByUuid('concurrent-put-on-failure', USER, updated, { retry_count: 0 }));
  openGate();

  await tick;

  const row = await findTaskAnyStatus(adapter, 'concurrent-put-on-failure');
  const payload = await decryptPayloadOf(row);
  assert.equal(payload.userMessage, '用户刚改的正文。', '失败收尾也不能把用户刚保存的改动写回旧值');
  // 行上那一列照常记得下失败原因，跟密文那份互不影响。
  assert.ok(row.last_error, '失败原因该记在行上');
});

// 自建适配器可能既没有 last_error 列、拒绝未知字段时又只回一句自己的话。状态
// 推进不能被这条锦上添花的记录挡住——挡住的话 retry_count 不涨、next_send_at
// 不动，这条任务会被每一跳 cron 重新捞起来，LLM 每次重跑一遍还每次都计费。
test('适配器拒收 last_error 且措辞对不上关键词：状态照样推进', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'opaque-adapter', recurrenceType: 'none', nextSendAt: recentDue() });

  const rejected = [];
  const db = new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'claimTask') return undefined;
      if (prop === 'updateTaskById') {
        return async (taskId, fields) => {
          if (Object.prototype.hasOwnProperty.call(fields, 'last_error')) {
            rejected.push(fields);
            throw new Error('unsupported update field');
          }
          return target.updateTaskById(taskId, fields);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });

  const webpush = { async sendNotification() { throw new Error('push failed'); } };
  const res = await runScheduledTick({ db, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.failedCount, 1);
  assert.notEqual(
    res.details.failedTasks[0].status, 'retry_update_failed',
    `写库不该整笔失败：${JSON.stringify(res.details.failedTasks[0])}`,
  );
  assert.ok(rejected.length >= 1, '得先真的试过写这一列，才谈得上退而求其次');

  const row = await adapter.getTaskByUuidOnly('opaque-adapter');
  assert.equal(row.retry_count, 1, '重试计数必须往前走，不然这条任务永远卡在原地');
  assert.notEqual(row.next_send_at, null);
  // 这一列写不进去就不写了，但重试排期已经落库——下一跳按退避走，不是立刻重跑。
  assert.ok(Date.parse(row.next_send_at) > Date.now(), '退避要真的排出去');
});

// 收尾写库会把 lease_until 置空，之后心跳当然续不上租约——那是我们自己放的
// 手。报成「行被取消或顶替」的话，运维会在 tick 日志里看到一条正常送达的消息
// 带着取消告警，而这个分支存在的意义正是让取消看得见。
test('正常收尾不会被心跳误报成「任务被取消」', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'clean-finish', recurrenceType: 'daily', nextSendAt: recentDue() });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };

  let res;
  try {
    // 心跳每 1ms 敲一次：收尾之后、processTask 停表之前，必然有几次落在中间。
    // onStaleSkip 之类的宿主 hook 会把这段窗口拉得更长，这里用 afterSend 模拟。
    res = await runScheduledTick({
      db: adapter,
      masterKey: MASTER_KEY,
      vapid: VAPID,
      webpush: fakeWebpush(),
      leaseHeartbeatMs: 1,
      onAfterSend: async () => { await new Promise((resolve) => { setTimeout(resolve, 30); }); }
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(res.successCount, 1, '这条消息是正常送达的');
  assert.equal(res.details.cancelledTasks.length, 0);
  assert.equal(
    warnings.filter((line) => line.includes('租约已失效')).length, 0,
    `正常收尾不该报租约失效：${JSON.stringify(warnings)}`,
  );
});
