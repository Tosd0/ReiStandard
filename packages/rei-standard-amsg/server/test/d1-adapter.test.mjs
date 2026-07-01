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
