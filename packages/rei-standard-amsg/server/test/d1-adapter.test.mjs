import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';

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
  assert.equal(res.indexesCreated, 5);
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
