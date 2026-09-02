import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1, createSpyD1 } from './helpers/sqlite-d1.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';

async function freshAdapter() {
  const db = createTestD1();
  const adapter = createD1Adapter(db);
  await adapter.initSchema();
  return { adapter, db };
}

function baseTask(overrides = {}) {
  return {
    user_id: USER,
    uuid: overrides.uuid || 'uuid-1',
    encrypted_payload: 'enc',
    next_send_at: overrides.next_send_at || '2026-01-01T00:00:00.000Z',
    message_type: overrides.message_type || 'fixed'
  };
}

test('initSchema creates table and indexes', async () => {
  const { adapter } = await freshAdapter();
  const res = await adapter.initSchema(); // idempotent (IF NOT EXISTS)
  assert.equal(res.indexesFailed, 0);
  // scheduled_messages 6 + client_state 1 + message_outbox 4
  assert.equal(res.indexesCreated, 11);
});

test('createTask returns id/uuid/status/created_at and normalizes next_send_at', async () => {
  const { adapter } = await freshAdapter();
  // input uses +08:00 offset — must be normalized to Z form on store
  const row = await adapter.createTask(baseTask({ next_send_at: '2026-01-01T08:00:00+08:00' }));
  assert.equal(typeof row.id, 'number');
  assert.equal(row.uuid, 'uuid-1');
  assert.equal(row.status, 'pending');
  assert.equal(row.next_send_at, '2026-01-01T00:00:00.000Z');
});

test('getPendingTasks respects next_send_at <= now with mixed-offset inputs', async () => {
  const { adapter } = await freshAdapter();
  await adapter.createTask(baseTask({ uuid: 'due', next_send_at: '2020-01-01T00:00:00.000Z' }));      // past → due
  await adapter.createTask(baseTask({ uuid: 'future', next_send_at: '2999-01-01T00:00:00+00:00' }));   // future → not due
  const pending = await adapter.getPendingTasks(50);
  const uuids = pending.map((t) => t.uuid);
  assert.deepEqual(uuids, ['due']);
});

test('getTaskByUuid / getTaskByUuidOnly find pending tasks', async () => {
  const { adapter } = await freshAdapter();
  await adapter.createTask(baseTask({ uuid: 'a' }));
  assert.ok(await adapter.getTaskByUuid('a', USER));
  assert.equal(await adapter.getTaskByUuid('a', 'other-user'), null);
  assert.ok(await adapter.getTaskByUuidOnly('a'));
});

test('updateTaskById updates fields + bumps updated_at', async () => {
  const { adapter } = await freshAdapter();
  const row = await adapter.createTask(baseTask({ uuid: 'u' }));
  const updated = await adapter.updateTaskById(row.id, { status: 'failed', retry_count: 2 });
  assert.equal(updated.status, 'failed');
  assert.equal(updated.retry_count, 2);
});

test('updateTaskByUuid updates only pending rows and returns {uuid, updated_at}', async () => {
  const { adapter } = await freshAdapter();
  await adapter.createTask(baseTask({ uuid: 'u' }));
  const res = await adapter.updateTaskByUuid('u', USER, 'enc2', { next_send_at: '2027-01-01T00:00:00.000Z' });
  assert.equal(res.uuid, 'u');
  assert.ok(res.updated_at);
  assert.equal(await adapter.updateTaskByUuid('missing', USER, 'enc2'), null);
});

// lease_until 是占位用的内部列，适配器的取任务方法不返回它，测试直接读行。
function readRow(db, uuid) {
  return db._raw.prepare('SELECT next_send_at, lease_until FROM scheduled_messages WHERE uuid = ?').get(uuid);
}

test('claimTask 领到一次后，租约没到期之前别人领不到', async () => {
  const { adapter, db } = await freshAdapter();
  const row = await adapter.createTask(baseTask({ uuid: 'c', next_send_at: '2020-01-01T00:00:00.000Z' }));
  const lease = new Date(Date.now() + 600_000).toISOString();

  assert.equal(await adapter.claimTask(row.id, '2020-01-01T00:00:00.000Z', lease), true);
  // 第二个 tick 拿着同一批读到的旧值来领 —— 租约还在别人手上，领不到。
  assert.equal(await adapter.claimTask(row.id, '2020-01-01T00:00:00.000Z', lease), false);

  // 占位只写租约，用户设的触发时刻原样不动。
  const after = readRow(db, 'c');
  assert.equal(after.next_send_at, '2020-01-01T00:00:00.000Z');
  assert.equal(after.lease_until, lease);
});

// 领了任务的 tick 中途没了，没人来放租约。租约到期后这条任务要能被接手，
// 否则它就永远卡在那儿再也不触发。
test('租约到期后这条任务可以被重新领取', async () => {
  const { adapter } = await freshAdapter();
  const row = await adapter.createTask(baseTask({ uuid: 'expired', next_send_at: '2020-01-01T00:00:00.000Z' }));

  assert.equal(await adapter.claimTask(row.id, '2020-01-01T00:00:00.000Z', '2020-01-01T00:10:00.000Z'), true);
  const lease = new Date(Date.now() + 600_000).toISOString();
  assert.equal(await adapter.claimTask(row.id, '2020-01-01T00:00:00.000Z', lease), true);
});

// 租约没到期的行不该再出现在待发列表里：每跳都把它捞出来再领一次失败，
// 白占 limit 名额，还会把真正到点的任务挤掉。
test('getPendingTasks 跳过租约还没到期的行', async () => {
  const { adapter } = await freshAdapter();
  const row = await adapter.createTask(baseTask({ uuid: 'held', next_send_at: '2020-01-01T00:00:00.000Z' }));
  await adapter.createTask(baseTask({ uuid: 'free', next_send_at: '2020-01-01T00:00:00.000Z' }));

  await adapter.claimTask(row.id, '2020-01-01T00:00:00.000Z', new Date(Date.now() + 600_000).toISOString());

  const uuids = (await adapter.getPendingTasks(50)).map((t) => t.uuid);
  assert.deepEqual(uuids, ['free']);
});

// 退避没到点的行同样不该出现在待发列表里。退避和租约分开两列：租约=「有人正
// 在跑」，退避=「上次没发成，等着重试」。
test('getPendingTasks 跳过退避还没到点的行', async () => {
  const { adapter } = await freshAdapter();
  const row = await adapter.createTask(baseTask({ uuid: 'backoff', next_send_at: '2020-01-01T00:00:00.000Z' }));
  await adapter.createTask(baseTask({ uuid: 'ready', next_send_at: '2020-01-01T00:00:00.000Z' }));

  await adapter.updateTaskById(row.id, { retry_after: new Date(Date.now() + 120_000).toISOString() });

  assert.deepEqual((await adapter.getPendingTasks(50)).map((t) => t.uuid), ['ready']);
});

// 分组串行：同一个角色的两条任务撞在一起时，只放行一条。
test('claimTask 带分组：同组有任务正拿着租约时领不走，租约一放就能领', async () => {
  const { adapter } = await freshAdapter();
  const due = '2020-01-01T00:00:00.000Z';
  const a = await adapter.createTask(baseTask({ uuid: 'g-a', next_send_at: due }));
  const b = await adapter.createTask(baseTask({ uuid: 'g-b', next_send_at: due }));
  const lease = new Date(Date.now() + 600_000).toISOString();

  assert.equal(await adapter.claimTask(a.id, due, lease, 'grp'), true);
  assert.equal(await adapter.claimTask(b.id, due, lease, 'grp'), false, '同一分组同时只跑一条');
  // 别的分组不受影响。
  assert.equal(await adapter.claimTask(b.id, due, lease, 'other'), true);

  // a 的租约放掉之后，同组又可以放行了。
  await adapter.updateTaskById(a.id, { lease_until: null });
  await adapter.updateTaskById(b.id, { lease_until: null });
  assert.equal(await adapter.claimTask(b.id, due, lease, 'grp'), true);
});

// 退避中的任务其实闲着，不该把同分组的其他任务一起堵住。
test('claimTask 带分组：同组有任务在退避，不影响这一组的其他任务', async () => {
  const { adapter } = await freshAdapter();
  const due = '2020-01-01T00:00:00.000Z';
  const a = await adapter.createTask(baseTask({ uuid: 'gr-a', next_send_at: due }));
  const b = await adapter.createTask(baseTask({ uuid: 'gr-b', next_send_at: due }));

  await adapter.updateTaskById(a.id, {
    serialize_group: 'grp',
    retry_after: new Date(Date.now() + 120_000).toISOString(),
    lease_until: null
  });

  assert.equal(
    await adapter.claimTask(b.id, due, new Date(Date.now() + 600_000).toISOString(), 'grp'),
    true
  );
});

// 2.5.x 建的表没有 lease_until，initSchema 要把它补上，老数据原样保留。
test('initSchema 给老表补上 lease_until 列', async () => {
  const db = createTestD1();
  await db.prepare(`
    CREATE TABLE scheduled_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      uuid TEXT,
      encrypted_payload TEXT NOT NULL,
      message_type TEXT NOT NULL,
      next_send_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(
    `INSERT INTO scheduled_messages
      (user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count, created_at, updated_at)
     VALUES (?, 'old', 'enc', 'fixed', '2020-01-01T00:00:00.000Z', 'pending', 0, ?, ?)`
  ).bind(USER, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z').run();

  const adapter = createD1Adapter(db);
  await adapter.initSchema();

  const [row] = await adapter.getPendingTasks(50);
  assert.equal(row.uuid, 'old');
  assert.equal(
    await adapter.claimTask(row.id, row.next_send_at, new Date(Date.now() + 600_000).toISOString()),
    true
  );
  // initSchema 跑第二遍不该因为列已存在就炸。
  await adapter.initSchema();
});

test('claimTask 领不动非 pending 的行', async () => {
  const { adapter } = await freshAdapter();
  const row = await adapter.createTask(baseTask({ uuid: 'cf', next_send_at: '2020-01-01T00:00:00.000Z' }));
  await adapter.updateTaskById(row.id, { status: 'failed' });
  assert.equal(
    await adapter.claimTask(row.id, '2020-01-01T00:00:00.000Z', '2020-01-01T00:10:00.000Z'),
    false
  );
});

test('claimTask 按读到的原值比对，不做时区归一化', async () => {
  // 老部署里可能留着没归一化的行；如果比对前先归一化成 Z 形式就永远对不上，
  // 那条任务会一直领不到、再也不触发。
  const { adapter, db } = await freshAdapter();
  const now = '2020-01-01T00:00:00.000Z';
  db._raw.prepare(
    `INSERT INTO scheduled_messages
      (user_id, uuid, encrypted_payload, next_send_at, message_type, status, retry_count, created_at, updated_at)
     VALUES (?, 'legacy', 'enc', '2020-01-01T08:00:00+08:00', 'fixed', 'pending', 0, ?, ?)`
  ).run(USER, now, now);

  const [row] = await adapter.getPendingTasks(50);
  assert.equal(row.uuid, 'legacy');
  assert.equal(await adapter.claimTask(row.id, row.next_send_at, '2020-01-01T00:10:00.000Z'), true);
});

test('delete + getTaskStatus', async () => {
  const { adapter } = await freshAdapter();
  const row = await adapter.createTask(baseTask({ uuid: 'd' }));
  assert.equal(await adapter.getTaskStatus('d', USER), 'pending');
  assert.equal(await adapter.deleteTaskById(row.id), true);
  assert.equal(await adapter.deleteTaskById(row.id), false);
  assert.equal(await adapter.getTaskStatus('d', USER), null);
});

test('deleteTaskByUuid scoped to user', async () => {
  const { adapter } = await freshAdapter();
  await adapter.createTask(baseTask({ uuid: 'd2' }));
  assert.equal(await adapter.deleteTaskByUuid('d2', 'other'), false);
  assert.equal(await adapter.deleteTaskByUuid('d2', USER), true);
});

test('listTasks paginates and counts', async () => {
  const { adapter } = await freshAdapter();
  for (let i = 0; i < 3; i++) await adapter.createTask(baseTask({ uuid: `l${i}` }));
  const page = await adapter.listTasks(USER, { limit: 2, offset: 0 });
  assert.equal(page.total, 3);
  assert.equal(page.tasks.length, 2);
});

test('listTasks status filter counts only matching rows', async () => {
  const { adapter } = await freshAdapter();
  const a = await adapter.createTask(baseTask({ uuid: 'lf1' }));
  await adapter.createTask(baseTask({ uuid: 'lf2' }));
  await adapter.createTask(baseTask({ uuid: 'lf3' }));
  await adapter.updateTaskById(a.id, { status: 'sent' }); // 1 sent, 2 pending
  const sent = await adapter.listTasks(USER, { status: 'sent' });
  assert.equal(sent.total, 1);
  assert.equal(sent.tasks.length, 1);
  assert.equal(sent.tasks[0].status, 'sent');
  const pending = await adapter.listTasks(USER, { status: 'pending' });
  assert.equal(pending.total, 2);
});

test('cleanupOldTasks removes only old sent/failed rows', async () => {
  const { adapter } = await freshAdapter();
  const row = await adapter.createTask(baseTask({ uuid: 'old' }));
  // mark sent with an updated_at far in the past
  await adapter.updateTaskById(row.id, { status: 'sent', updated_at: '2000-01-01T00:00:00.000Z' });
  const removed = await adapter.cleanupOldTasks(7);
  assert.equal(removed, 1);
});

test('updateTaskById rejects an unknown column instead of interpolating it into SQL', async () => {
  const { adapter } = await freshAdapter();
  const row = await adapter.createTask(baseTask({ uuid: 'wl' }));
  await assert.rejects(
    adapter.updateTaskById(row.id, { 'status = 1; DROP TABLE scheduled_messages; --': 'x' }),
    /unknown update column/i
  );
});

test('uuid uniqueness violation surfaces as an error matched by isUniqueViolation', async () => {
  const { adapter } = await freshAdapter();
  await adapter.createTask(baseTask({ uuid: 'dup' }));
  await assert.rejects(
    adapter.createTask(baseTask({ uuid: 'dup' })),
    (err) => /unique constraint/i.test(err.message)
  );
});

// ─── D1 单条语句 100 个绑定参数的上限 ────────────────────────────────────────
//
// D1 对单条语句的绑定参数数量卡死在 100，第 101 个直接报
// `too many SQL variables`（D1_ERROR 7500）。这个数算的是整条语句的参数总数，
// 不只是 IN (...) 里那部分。
//
// 跟 LIKE pattern 那条限制一样，本地跑不出来：better-sqlite3 的
// SQLITE_MAX_VARIABLE_NUMBER 是几百到三万多（看编译参数），喂 202 个照样跑得
// 通，功能测试在修复前也是绿的。所以守卫得盯「发出去的每条语句绑了几个参数」。

const D1_MAX_BOUND_PARAMS = 100;

/** 这一批调用里，每条语句的绑定参数个数都不许超过 D1 的上限。 */
function assertBoundParamBudget(calls) {
  for (const call of calls) {
    assert.ok(
      call.args.length <= D1_MAX_BOUND_PARAMS,
      `单条语句绑了 ${call.args.length} 个参数，超过 D1 的 ${D1_MAX_BOUND_PARAMS} 上限：${call.sql}`
    );
  }
}

/** 造 n 条 outbox 行，返回它们的 messageId。 */
async function seedOutbox(adapter, n) {
  const ids = Array.from({ length: n }, (_, i) => `msg-${String(i).padStart(4, '0')}`);
  await adapter.appendOutboxMessages(USER, ids.map((id) => ({
    message_id: id, payload: 'enc', created_at: 1000,
  })));
  return ids;
}

/** 造 n 条凭据行，返回它们的 credId。 */
async function seedCredentials(adapter, n) {
  const ids = Array.from({ length: n }, (_, i) => `char:${String(i).padStart(4, '0')}/chat`);
  await adapter.upsertLlmCredentials(USER, ids.map((id) => ({ credId: id, encryptedValue: 'enc' })));
  return ids;
}

test('IN (...) 的四个批量口都不给单条语句喂超过 100 个绑定参数', async () => {
  const { db, calls } = createSpyD1();
  const adapter = createD1Adapter(db);
  await adapter.initSchema();

  // MAX_OUTBOX_ACK_IDS = 200，是契约允许的最大值。
  const messageIds = await seedOutbox(adapter, 200);
  const credIds = await seedCredentials(adapter, 200);

  calls.length = 0;
  await adapter.markOutboxDelivered(USER, messageIds, 2000);
  await adapter.ackOutboxMessages(USER, messageIds, 3000);
  await adapter.getLlmCredentials(USER, credIds);
  await adapter.deleteLlmCredentials(USER, credIds);

  assert.ok(calls.length > 0, '这几个调用应该真的发出了语句');
  assertBoundParamBudget(calls);
});

test('切批按语句自己的固定参数算额度，不是写死 100 个 id 一批', async () => {
  const { db, calls } = createSpyD1();
  const adapter = createD1Adapter(db);
  await adapter.initSchema();
  const messageIds = await seedOutbox(adapter, 200);
  const credIds = await seedCredentials(adapter, 200);

  // ack：SET acked_at = ? 和 user_id = ? 占掉 2 个，一批最多 98 个 id
  const ackBatches = async (n) => {
    calls.length = 0;
    await adapter.ackOutboxMessages(USER, messageIds.slice(0, n), 3000);
    return calls.length;
  };
  assert.equal(await ackBatches(98), 1, '98 个 id + 2 个固定参数 = 100，正好一条');
  assert.equal(await ackBatches(99), 2, '再多一个就得拆');
  assert.equal(await ackBatches(100), 2);
  assert.equal(await ackBatches(101), 2);
  assert.equal(await ackBatches(200), 3);

  // 删凭据：只有 user_id = ? 占 1 个，一批能放 99 个，批次划分跟 ack 不一样
  const delBatches = async (n) => {
    calls.length = 0;
    await adapter.deleteLlmCredentials(USER, credIds.slice(0, n));
    return calls.length;
  };
  assert.equal(await delBatches(99), 1, '99 个 id + 1 个固定参数 = 100，正好一条');
  assert.equal(await delBatches(100), 2);
});

test('分批之后返回值是各批合计，不是最后一批', async () => {
  const { adapter } = await freshAdapter();
  const messageIds = await seedOutbox(adapter, 200);
  const credIds = await seedCredentials(adapter, 200);

  assert.equal(await adapter.markOutboxDelivered(USER, messageIds, 2000), 200);
  assert.equal(await adapter.ackOutboxMessages(USER, messageIds, 3000), 200);
  // ack 幂等：已经 ack 过的行不再计数
  assert.equal(await adapter.ackOutboxMessages(USER, messageIds, 4000), 0);

  assert.equal((await adapter.getLlmCredentials(USER, credIds)).length, 200);
  assert.equal(await adapter.deleteLlmCredentials(USER, credIds), 200);
  assert.equal((await adapter.listLlmCredentials(USER)).length, 0);
});

test('分批写仍然原子：中间一批炸了，前面那批也不留痕迹', async () => {
  const raw = createTestD1();
  const seedAdapter = createD1Adapter(raw);
  await seedAdapter.initSchema();
  const messageIds = await seedOutbox(seedAdapter, 200);

  // 第二条 ack 语句执行时抛错，模拟 D1 半路报错
  let ackStatements = 0;
  const flaky = {
    prepare(sql) {
      const inner = raw.prepare(sql);
      const isAck = /UPDATE message_outbox SET acked_at/.test(sql);
      const shouldFail = isAck && ++ackStatements === 2;
      const wrapper = {
        bind(...args) { inner.bind(...args); return wrapper; },
        run: () => (shouldFail ? Promise.reject(new Error('D1_ERROR: boom')) : inner.run()),
        first: () => inner.first(),
        all: () => inner.all(),
      };
      return wrapper;
    },
    batch: raw.batch,
  };
  const adapter = createD1Adapter(flaky);

  await assert.rejects(adapter.ackOutboxMessages(USER, messageIds, 3000), /boom/);

  // 第一批的 98 条不能留下已 ack 的痕迹——整批回滚，一条都不算 ack
  const acked = raw._raw
    .prepare('SELECT COUNT(*) AS n FROM message_outbox WHERE acked_at IS NOT NULL')
    .get().n;
  assert.equal(acked, 0, 'batch 是事务，中途失败必须整批回滚');
  assert.equal((await seedAdapter.listUnackedOutbox(USER, 0, 500)).length, 200);
});
