import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSpyD1 } from './helpers/sqlite-d1.mjs';
import { resumeCloudDataCleanups } from '../src/server/lib/cloud-data-cleanup.js';
import { encryptForStorage, deriveUserEncryptionKey } from '../src/server/lib/encryption.js';
import { ensureSchema } from '../src/server/lib/schema-version.js';
import { createSingleUserServer } from '../src/server/single-user.js';
import { decryptPayload } from '../src/server/lib/encryption.js';

async function fresh() {
  const raw = createSpyD1();
  const db = createD1Adapter(raw.db);
  await db.initSchema();
  raw.calls.length = 0;
  return { db, raw };
}

const state = (key, namespace = 'n') => ({ namespace, key, value: 'cipher', updatedAt: 1, encryptedCloudMetadata: 'metadata' });
const task = uuid => ({ user_id: 'u', uuid, encrypted_payload: 'cipher', next_send_at: '2020-01-01', message_type: 'fixed' });

test('ordinary deletion removes exactly its metadata in the same transaction', async () => {
  const { db, raw } = await fresh();
  try {
    await db.upsertClientState('u', [state('one'), state('two')]);
    await db.upsertClientState('other', [state('one')]);
    await db.upsertClientState('u', [], [{ namespace: 'n', key: 'one', updatedAt: 2 }]);
    assert.equal(await db.getCloudResourceMetadata('u', '["state","n","one"]'), null);
    assert.equal(await db.getCloudResourceMetadata('u', '["state","n","two"]'), 'metadata');
    assert.equal(await db.getCloudResourceMetadata('other', '["state","n","one"]'), 'metadata');
    await db.createTask({ ...task('task'), encryptedCloudMetadata: 'task-meta' });
    await db.deleteTaskByUuid('task', 'u');
    assert.equal(await db.getCloudResourceMetadata('u', '["task","task"]'), null);
  } finally { raw._raw.close(); }
});

test('rootless chunks keep their logical metadata until the last chunk is removed', async () => {
  const { db, raw } = await fresh();
  try {
    await db.upsertClientState('u', [state('root')]);
    await db.upsertClientState('u', [
      { namespace: '\x1famsg-chunks\x1fn', key: 'root\x1f0', value: 'part', updatedAt: 1 },
      { namespace: '\x1famsg-chunks\x1fn', key: 'root\x1f1', value: 'part', updatedAt: 1 },
    ]);
    await db.upsertClientState('u', [], [{ namespace: 'n', key: 'root', updatedAt: 2 }]);
    assert.equal(await db.getCloudResourceMetadata('u', '["state","n","root"]'), 'metadata');
    await db.upsertClientState('u', [], [{ namespace: '\x1famsg-chunks\x1fn', key: 'root\x1f0', updatedAt: 2 }]);
    assert.equal(await db.getCloudResourceMetadata('u', '["state","n","root"]'), 'metadata');
    await db.upsertClientState('u', [], [{ namespace: '\x1famsg-chunks\x1fn', key: 'root\x1f1', updatedAt: 2 }]);
    assert.equal(await db.getCloudResourceMetadata('u', '["state","n","root"]'), null);
  } finally { raw._raw.close(); }
});

test('metadata deletion rolls back when the rest of a write batch fails', async () => {
  const { db, raw } = await fresh();
  try {
    await db.upsertClientState('u', [state('one')]);
    await assert.rejects(raw.db.batch([
      raw.db.prepare('DELETE FROM client_state WHERE user_id=? AND namespace=? AND key=?').bind('u', 'n', 'one'),
      raw.db.prepare('INSERT INTO cloud_guard_assertions (allowed) VALUES (0)'),
    ]));
    assert.equal(await db.getCloudResourceMetadata('u', '["state","n","one"]'), 'metadata');
    assert.equal((await db.getClientState('u', 'n')).length, 1);
  } finally { raw._raw.close(); }
});

test('1440 idle ticks stop scanning metadata and completed history after bounded legacy repair', async () => {
  const { db, raw } = await fresh();
  try {
    const key = await deriveUserEncryptionKey('u', 'master');
    for (let i = 0; i < 210; i++) {
      await db.upsertClientState('u', [state('s' + i)]);
      await db.putCloudDataRecord('u', 'operation', 'op' + i, await encryptForStorage(JSON.stringify({ id: 'op' + i, status: 'completed', updatedAt: Date.now() }), key));
    }
    // A large live mirror and outbox must not add work to an idle day.
    raw._raw.transaction(() => {
      const putState = raw._raw.prepare('INSERT INTO client_state VALUES (?,?,?,?,?)');
      const putOutbox = raw._raw.prepare('INSERT INTO message_outbox (user_id,message_id,payload,created_at) VALUES (?,?,?,?)');
      for (let i = 0; i < 2000; i++) putState.run('u','large','live'+i,'cipher',Date.now());
      for (let i = 0; i < 15000; i++) putOutbox.run('u','live'+i,'cipher',Date.now());
    })();
    for (let i = 0; i < 10; i++) await resumeCloudDataCleanups({ db, masterKey: 'master' });
    raw.calls.length = 0;
    for (let i = 0; i < 1440; i++) await resumeCloudDataCleanups({ db, masterKey: 'master' });
    const heavy = raw.calls.filter(({ sql }) => /DELETE FROM cloud_resource_metadata|SELECT \* FROM cloud_data_records WHERE kind=/.test(sql));
    assert.equal(heavy.length, 0, 'idle time must not repeatedly enumerate metadata or historical ciphertext');
    const historyReads = raw.calls.filter(({ sql }) => /FROM cloud_data_records/.test(sql) && !/(FROM|JOIN) cloud_data_work/.test(sql));
    assert.equal(historyReads.length, 0);
    assert.equal(raw.calls.filter(({ sql }) => /^\s*(INSERT|UPDATE)/.test(sql)).length, 0, 'an idle day must not rewrite maintenance markers');
    assert.equal(raw.calls.length, 1440 * 4, 'only two completed-marker lookups, one indexed expiry lookup and one due-operation lookup per tick');
  } finally { raw._raw.close(); }
});

test('indexed operation scheduling skips finished, future, and leased operations', async () => {
  const { db, raw } = await fresh();
  try {
    await db.putCloudDataRecord('u', 'operation', 'due', 'cipher', { work: { nextRunAt: 1, expiresAt: null } });
    await db.putCloudDataRecord('u', 'operation', 'future', 'cipher', { work: { nextRunAt: Date.now() + 60000, expiresAt: null } });
    await db.putCloudDataRecord('u', 'operation', 'finished', 'cipher', { work: { nextRunAt: null, expiresAt: Date.now() + 60000 } });
    await db.putCloudDataRecord('u', 'operation', 'leased', 'cipher', { work: { nextRunAt: 1, expiresAt: null } });
    await db.claimCloudDataRecord('u', 'operation', 'leased', 60000, 'lease');
    const rows = await db.listDueCloudDataOperations(Date.now(), 25);
    assert.deepEqual(rows.map(row => row.id), ['due']);
  } finally { raw._raw.close(); }
});

test('expired records are reclaimed in bounded batches and never while leased', async () => {
  const { db, raw } = await fresh();
  try {
    for (const id of ['one', 'two', 'leased', 'live']) await db.putCloudDataRecord('u', 'plan', id, 'cipher', { work: { nextRunAt: null, expiresAt: id === 'live' ? Date.now() + 60000 : 1 } });
    await db.claimCloudDataRecord('u', 'plan', 'leased', 60000, 'lease');
    assert.equal(await db.cleanupExpiredCloudDataRecords(Date.now(), 1), 1);
    assert.equal(await db.cleanupExpiredCloudDataRecords(Date.now(), 10), 1);
    assert.ok(await db.getCloudDataRecord('u', 'plan', 'leased'));
    assert.ok(await db.getCloudDataRecord('u', 'plan', 'live'));
  } finally { raw._raw.close(); }
});

test('metadata repair uses full state indexes and is resumable instead of repeating the global sweep', async () => {
  const { db, raw } = await fresh();
  try {
    for (let i = 0; i < 205; i++) raw._raw.prepare('INSERT INTO cloud_resource_metadata VALUES (?,?,?)').run('u', JSON.stringify(['state', 'n', 'gone' + i]), 'meta');
    await db.upsertClientState('u', [state('live')]);
    for (let i = 0; i < 4; i++) await db.repairCloudResourceMetadata(100);
    assert.equal(raw._raw.prepare('SELECT count(*) n FROM cloud_resource_metadata').get().n, 1);
    raw.calls.length = 0;
    await db.repairCloudResourceMetadata(100);
    assert.equal(raw.calls.filter(({ sql }) => /DELETE FROM cloud_resource_metadata/.test(sql)).length, 0);
    // Also exercise the public repair SQL while checking its actual query plan.
    raw.calls.length = 0;
    await db.cleanupCloudResourceMetadata('u');
    const statement = raw.calls.find(({ sql }) => /DELETE FROM cloud_resource_metadata/.test(sql) && /FROM client_state/.test(sql));
    const plan = raw._raw.prepare('EXPLAIN QUERY PLAN ' + statement.sql).all(...statement.args);
    const stateSearches = plan.filter(row => /SEARCH r/.test(row.detail));
    assert.equal(stateSearches.length, 2);
    assert.ok(stateSearches.every(row => /user_id=\? AND namespace=\? AND key/.test(row.detail)));
  } finally { raw._raw.close(); }
});

test('legacy schema upgrade restores required triggers and resumes an existing unfinished operation', async () => {
  const { db, raw } = await fresh();
  try {
    for (const row of raw._raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) raw._raw.exec(`DROP TRIGGER ${row.name}`);
    raw._raw.exec('DROP TABLE cloud_data_work; DROP TABLE cloud_data_maintenance;');
    const key = await deriveUserEncryptionKey('u', 'master');
    const operation = { id: 'legacy', status: 'pending', updatedAt: Date.now(), nextAttemptAt: Date.now() + 60000 };
    raw._raw.prepare('INSERT INTO cloud_data_records (user_id,kind,id,data,updated_at) VALUES (?,?,?,?,?)')
      .run('u', 'operation', 'legacy', await encryptForStorage(JSON.stringify(operation), key), Date.now());
    const result = await ensureSchema(db);
    assert.equal(result.ok, true);
    assert.equal(result.migrated, true);
    await resumeCloudDataCleanups({ db, masterKey: 'master' });
    assert.equal((await db.listDueCloudDataOperations(Date.now())).length, 0);
    assert.deepEqual((await db.listDueCloudDataOperations(Date.now() + 120000)).map(row => row.id), ['legacy']);
    assert.equal((await ensureSchema(db)).migrated, false);
  } finally { raw._raw.close(); }
});

test('page summary and pagination share the same inventory without a second scan', async () => {
  const { db, raw } = await fresh();
  try {
    await db.upsertClientState('00000000-0000-4000-8000-000000000001', [state('one'), state('two')]);
    const server = createSingleUserServer({ db, masterKey: 'master' });
    const key = await deriveUserEncryptionKey('00000000-0000-4000-8000-000000000001', 'master');
    raw.calls.length = 0;
    const first = await server.handlers.cloudData.GET('/cloud-data/resources?limit=1', { 'x-user-id': '00000000-0000-4000-8000-000000000001' });
    const page = await decryptPayload(first.body.data, key);
    assert.equal(page.summary.total, 2);
    assert.equal(page.resources.length, 1);
    const scanCount = raw.calls.filter(({ sql }) => /SELECT \* FROM client_state WHERE user_id/.test(sql)).length;
    const second = await server.handlers.cloudData.GET('/cloud-data/resources?limit=1&cursor=' + encodeURIComponent(page.nextCursor), { 'x-user-id': '00000000-0000-4000-8000-000000000001' });
    const next = await decryptPayload(second.body.data, key);
    assert.deepEqual(next.summary, page.summary);
    assert.equal(raw.calls.filter(({ sql }) => /SELECT \* FROM client_state WHERE user_id/.test(sql)).length, scanCount);
  } finally { raw._raw.close(); }
});

test('normal credential, subscription, and retention deletion clean only matching metadata', async () => {
  const { db, raw } = await fresh();
  try {
    await db.upsertLlmCredentials('u', [{ credId: 'c', encryptedValue: 'cipher', encryptedCloudMetadata: 'meta' }]);
    await db.deleteLlmCredentials('u', ['c']);
    assert.equal(await db.getCloudResourceMetadata('u', '["credential","c"]'), null);
    await db.upsertPushSubscription('u', 'cipher', 1);
    raw._raw.prepare('INSERT INTO cloud_resource_metadata VALUES (?,?,?)').run('u', '["subscription","u"]', 'meta');
    await db.deletePushSubscription('u');
    assert.equal(await db.getCloudResourceMetadata('u', '["subscription","u"]'), null);
    await db.appendOutboxMessages('u', [{ message_id: 'm', payload: 'cipher', created_at: 1, encryptedCloudMetadata: 'meta' }]);
    await db.cleanupOutbox({ allBeforeMs: 2 });
    assert.equal(await db.getCloudResourceMetadata('u', '["outbox","m"]'), null);
  } finally { raw._raw.close(); }
});


test('retention limits each tick while preserving live state, pending tasks and unexpired outbox', async () => {
  const { db, raw } = await fresh();
  try {
    for (let i = 0; i < 205; i++) {
      await db.upsertClientState('u', [state('old' + i)]);
      await db.createTask(task('old' + i));
      raw._raw.prepare("UPDATE scheduled_messages SET status='sent',updated_at='2020-01-01' WHERE uuid=?").run('old' + i);
      await db.appendOutboxMessages('u', [{ message_id: 'old' + i, payload: 'cipher', created_at: 1 }]);
    }
    await db.upsertClientState('u', [{ ...state('live'), updatedAt: Date.now() }]);
    await db.createTask(task('pending'));
    await db.appendOutboxMessages('u', [{ message_id: 'live', payload: 'cipher', created_at: Date.now() }]);
    assert.equal(await db.cleanupClientState([{ namespace: 'n', updatedBefore: 2 }]), 100);
    assert.equal(await db.cleanupOldTasks(7), 100);
    assert.equal(await db.cleanupOutbox({ allBeforeMs: 2 }), 100);
    for (let i = 0; i < 2; i++) {
      await db.cleanupClientState([{ namespace: 'n', updatedBefore: 2 }]);
      await db.cleanupOldTasks(7);
      await db.cleanupOutbox({ allBeforeMs: 2 });
    }
    assert.deepEqual((await db.getClientState('u', 'n')).map(row => row.key), ['live']);
    assert.equal(raw._raw.prepare('SELECT uuid FROM scheduled_messages').get().uuid, 'pending');
    assert.equal(raw._raw.prepare('SELECT message_id FROM message_outbox').get().message_id, 'live');
  } finally { raw._raw.close(); }
});


test('idempotency, create-only conflicts and stale backfill cannot change the live work schedule', async () => {
  const { db, raw } = await fresh();
  try {
    const schedule = { nextRunAt: 100, expiresAt: null };
    await db.putCloudDataRecord('u', 'operation', 'one', 'original', { idempotencyKey: 'key', work: schedule });
    const staleToken = raw._raw.prepare('SELECT write_token FROM cloud_data_records WHERE id=?').get('one').write_token;
    await db.putCloudDataRecord('u', 'operation', 'other', 'duplicate', { idempotencyKey: 'key', work: { nextRunAt: 0, expiresAt: 1 } });
    await db.putCloudDataRecord('u', 'operation', 'one', 'duplicate', { createOnly: true, work: { nextRunAt: 0, expiresAt: 1 } });
    assert.deepEqual(raw._raw.prepare('SELECT next_run_at,expires_at FROM cloud_data_work').all(), [{ next_run_at: 100, expires_at: null }]);
    await db.putCloudDataRecord('u', 'operation', 'one', 'new', { work: { nextRunAt: 200, expiresAt: null } });
    await db.indexCloudDataRecordWorkBatch([{ userId: 'u', kind: 'operation', id: 'one', work: { nextRunAt: 0, expiresAt: 1 }, writeToken: staleToken }]);
    assert.equal(raw._raw.prepare('SELECT next_run_at FROM cloud_data_work').get().next_run_at, 200);
  } finally { raw._raw.close(); }
});

test('due and expiry lookups narrow by execution time rather than scanning historical rows', async () => {
  const { db, raw } = await fresh();
  try {
    await db.listDueCloudDataOperations(100);
    await db.cleanupExpiredCloudDataRecords(100);
    for (const [pattern, narrowing] of [[/SELECT r\.\* FROM cloud_data_work/, 'next_run_at<?'], [/DELETE FROM cloud_data_records WHERE rowid/, 'expires_at<?']]) {
      const call = raw.calls.find(({ sql }) => pattern.test(sql));
      const plan = raw._raw.prepare('EXPLAIN QUERY PLAN ' + call.sql).all(...call.args).map(row => row.detail).join('\n');
      assert.doesNotMatch(plan, /\bSCAN\b/);
      assert.ok(plan.includes(narrowing), plan);
    }
  } finally { raw._raw.close(); }
});

async function withQuietWarnings(run) {
  const original = console.warn;
  console.warn = () => {};
  try { return await run(); } finally { console.warn = original; }
}

const insertLegacyRecord = (raw, kind, id, data) => raw._raw
  .prepare('INSERT INTO cloud_data_records (user_id,kind,id,data,updated_at) VALUES (?,?,?,?,?)')
  .run('u', kind, id, data, Date.now());

test('legacy repair indexes a full batch of small records without a statement per row', async () => {
  const { db, raw } = await fresh();
  try {
    const key = await deriveUserEncryptionKey('u', 'master');
    const finished = await encryptForStorage(JSON.stringify({ id: 'x', status: 'completed', updatedAt: Date.now() }), key);
    for (let i = 0; i < 60; i++) insertLegacyRecord(raw, 'plan', 'plan' + i, 'cipher');
    for (let i = 0; i < 40; i++) insertLegacyRecord(raw, 'operation', 'op' + i, finished);
    raw.calls.length = 0;
    await resumeCloudDataCleanups({ db, masterKey: 'master' });
    assert.equal(raw._raw.prepare('SELECT count(*) n FROM cloud_data_work').get().n, 100);
    assert.ok(raw.calls.length <= 15, `one tick issued ${raw.calls.length} statements`);
    const read = raw.calls.find(({ sql }) => /maintenance_rowid/.test(sql) && /FROM cloud_data_records/.test(sql));
    assert.doesNotMatch(read.sql, /maintenance_rowid,\*/, 'snapshot ciphertext is not loaded for indexing');
  } finally { raw._raw.close(); }
});

test('a legacy operation that cannot be read is still indexed and retried later', async () => {
  const { db, raw } = await fresh();
  try {
    insertLegacyRecord(raw, 'operation', 'unreadable', 'not-ciphertext');
    const before = Date.now();
    await withQuietWarnings(() => resumeCloudDataCleanups({ db, masterKey: 'master' }));
    const work = raw._raw.prepare("SELECT next_run_at,expires_at FROM cloud_data_work WHERE id='unreadable'").get();
    assert.ok(work, 'the operation has a work index entry');
    assert.ok(work.next_run_at > before, 'the failed attempt is retried later, not dropped');
    assert.equal(work.expires_at, null);
    assert.ok(await db.getCloudDataRecord('u', 'operation', 'unreadable'));
  } finally { raw._raw.close(); }
});

test('operations that cannot be resumed move behind the ones still waiting', async () => {
  const { db, raw } = await fresh();
  try {
    for (let i = 0; i < 30; i++) {
      await db.putCloudDataRecord('u', 'operation', 'bad' + String(i).padStart(2, '0'), 'not-ciphertext', { work: { nextRunAt: i + 1, expiresAt: null } });
    }
    await withQuietWarnings(() => resumeCloudDataCleanups({ db, masterKey: 'master' }));
    const waiting = (await db.listDueCloudDataOperations(Date.now(), 25)).map(row => row.id);
    assert.deepEqual(waiting, ['bad25', 'bad26', 'bad27', 'bad28', 'bad29']);
  } finally { raw._raw.close(); }
});

test('a due entry for a finished operation gets its expiry schedule back', async () => {
  const { db, raw } = await fresh();
  try {
    const key = await deriveUserEncryptionKey('u', 'master');
    const updatedAt = Date.now();
    const data = await encryptForStorage(JSON.stringify({ id: 'done', status: 'completed', updatedAt }), key);
    await db.putCloudDataRecord('u', 'operation', 'done', data, { work: { nextRunAt: 0, expiresAt: null } });
    await resumeCloudDataCleanups({ db, masterKey: 'master' });
    assert.deepEqual(raw._raw.prepare('SELECT next_run_at,expires_at FROM cloud_data_work').get(),
      { next_run_at: null, expires_at: updatedAt + 30 * 86400000 });
  } finally { raw._raw.close(); }
});

test('rescheduling leaves a record alone once it has been rewritten', async () => {
  const { db, raw } = await fresh();
  try {
    await db.putCloudDataRecord('u', 'operation', 'one', 'old', { work: { nextRunAt: 1, expiresAt: null } });
    const [stale] = await db.listDueCloudDataOperations(Date.now());
    await db.putCloudDataRecord('u', 'operation', 'one', 'new', { work: { nextRunAt: 2, expiresAt: null } });
    assert.equal(await db.rescheduleCloudDataRecordWork('u', 'operation', 'one', { nextRunAt: 999, expiresAt: null }, stale.writeToken), false);
    assert.equal(raw._raw.prepare('SELECT next_run_at FROM cloud_data_work').get().next_run_at, 2);
  } finally { raw._raw.close(); }
});

test('an adapter without a work index still gets retention from the per-tick scan', async () => {
  const cleaned = [];
  const deleted = [];
  const key = await deriveUserEncryptionKey('u', 'master');
  const old = { id: 'old', status: 'completed', updatedAt: Date.now() - 31 * 86400000 };
  const db = {
    cloudDataManagement: true,
    cleanupCloudDataRecords: async (kind) => { cleaned.push(kind); },
    listCloudDataRecordsAcrossUsers: async () => [{ id: 'old', userId: 'u', kind: 'operation', data: await encryptForStorage(JSON.stringify(old), key) }],
    deleteCloudDataRecord: async (userId, kind, id) => { deleted.push(id); },
  };
  await resumeCloudDataCleanups({ db, masterKey: 'master' });
  assert.deepEqual(cleaned, ['inventory', 'plan']);
  assert.deepEqual(deleted, ['old']);
});

test('schema check skips triggers for an adapter that does not report them', async () => {
  const { db, raw } = await fresh();
  try {
    const { getSchemaVersion } = await import('../src/server/lib/schema-version.js');
    const withoutTriggers = { describeSchema: async () => { const { triggers, ...rest } = await db.describeSchema(); return rest; } };
    assert.deepEqual((await getSchemaVersion(withoutTriggers)).missing, []);
    for (const row of raw._raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) raw._raw.exec(`DROP TRIGGER ${row.name}`);
    assert.equal((await getSchemaVersion(db)).ok, false, 'an adapter that reports triggers is still checked');
  } finally { raw._raw.close(); }
});

test('an adapter with only part of the work index is treated as having none', async () => {
  const cleaned = [];
  const db = {
    cloudDataManagement: true,
    listDueCloudDataOperations: async () => { throw new Error('the partial index must not be used'); },
    cleanupCloudDataRecords: async (kind) => { cleaned.push(kind); },
    listCloudDataRecordsAcrossUsers: async () => [],
  };
  await resumeCloudDataCleanups({ db, masterKey: 'master' });
  assert.deepEqual(cleaned, ['inventory', 'plan']);
});
