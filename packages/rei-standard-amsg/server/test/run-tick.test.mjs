import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledTick } from '../src/server/lib/run-tick.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptForStorage, decryptFromStorage } from '../src/server/lib/encryption.js';
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
