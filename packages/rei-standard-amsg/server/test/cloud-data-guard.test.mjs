import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { deriveUserEncryptionKey, encryptForStorage, decryptFromStorage } from '../src/server/lib/encryption.js';
import { createCloudGuardedAdapter, captureCloudTaskGuard, assertCloudGuard } from '../src/server/lib/cloud-data-guard.js';
import { chunkNamespaceFor, chunkKeyFor, buildChunkedRootValue } from '../src/server/lib/state-chunks.js';

const owner = { type: 'character', id: 'one', label: 'Private name' };
const other = { type: 'character', id: 'two' };
const masterKey = 'guard-test-key';
async function setup() {
  const raw = createTestD1(); const db = createD1Adapter(raw); await db.initSchema();
  const key = await deriveUserEncryptionKey('u', masterKey);
  const wrapped = createCloudGuardedAdapter(db, { masterKey });
  const task = async (uuid, payload) => ({ user_id: 'u', uuid, encrypted_payload: await encryptForStorage(JSON.stringify(payload), key), next_send_at: '2020-01-01', message_type: 'fixed' });
  return { raw, db, key, wrapped, task };
}

test('task insertion persists encrypted owner guard and refuses stale generation after restore', async () => {
  const { raw, db, wrapped, key, task } = await setup();
  try {
    await wrapped.createTask(await task('before', { owner, kind: 'chat' }));
    const saved = await db.getTaskByUuid('before', 'u');
    const payload = JSON.parse(await decryptFromStorage(saved.encrypted_payload, key));
    assert.deepEqual(payload.__cloudOwnerGuard, { owner, generation: 0 });
    const rows = await db.listCloudResourceRows('u');
    assert.ok(!rows.metadata[0].encrypted_value.includes('Private name'));
    assert.deepEqual(JSON.parse(await decryptFromStorage(rows.metadata[0].encrypted_value, key)), { owner, kind: 'chat', generation: 0 });
    await db.setCloudOwnerActive('u', owner, false);
    await assert.rejects(wrapped.createTask(await task('retired', { owner })), { code: 'CLOUD_OWNER_RETIRED' });
    const restored = await db.setCloudOwnerActive('u', owner, true);
    await assert.rejects(wrapped.createTask(await task('stale', { owner })), { code: 'CLOUD_OWNER_RETIRED' });
    await wrapped.createTask(await task('restored', { owner, ownerGeneration: restored.generation }));
    await assert.rejects(assertCloudGuard(db, 'u', payload.__cloudOwnerGuard), { code: 'CLOUD_OWNER_RETIRED' });
  } finally { raw.close(); }
});

test('inherited task guard cannot be replaced by output owner or forged internal field', async () => {
  const { raw, db, key, task } = await setup();
  const guard = { owner, generation: 0 };
  const wrapped = createCloudGuardedAdapter(db, { masterKey, guard });
  try {
    await wrapped.createTask(await task('child', { owner: other, __cloudOwnerGuard: { owner: other, generation: 100 } }));
    const saved = await db.getTaskByUuid('child', 'u');
    assert.deepEqual(JSON.parse(await decryptFromStorage(saved.encrypted_payload, key)).__cloudOwnerGuard, guard);
    await db.setCloudOwnerActive('u', owner, false);
    await assert.rejects(wrapped.upsertClientState('u', [{ namespace: 'n', key: 'k', owner, value: await encryptForStorage('secret', key), updatedAt: 1 }]), { code: 'CLOUD_OWNER_RETIRED' });
    await assert.rejects(wrapped.upsertLlmCredentials('u', [{ credId: 'c', owner, encryptedValue: await encryptForStorage('{}', key) }]), { code: 'CLOUD_OWNER_RETIRED' });
    await assert.rejects(wrapped.appendOutboxMessages('u', [{ message_id: 'm', payload: await encryptForStorage(JSON.stringify({ owner: other }), key), created_at: 1 }]), { code: 'CLOUD_OWNER_RETIRED' });
    const rows = await db.listCloudResourceRows('u');
    assert.equal(rows.state.length + rows.credential.length + rows.outbox.length, 0);
  } finally { raw.close(); }
});

test('state roots and chunk cleanup inherit ownership and reject deletion after retirement', async () => {
  const { raw, db, key } = await setup();
  const wrapped = createCloudGuardedAdapter(db, { masterKey, resolveOwner: ({ namespace }) => namespace === 'char:one' ? { owner, kind: 'context' } : null });
  try {
    const entries = [
      { namespace: 'char:one', key: 'blob', value: buildChunkedRootValue(1), updatedAt: 1 },
      { namespace: chunkNamespaceFor('char:one'), key: chunkKeyFor('blob', 0), value: await encryptForStorage('part', key), updatedAt: 1 },
    ];
    await wrapped.upsertClientState('u', entries);
    await db.setCloudOwnerActive('u', owner, false);
    await assert.rejects(wrapped.upsertClientState('u', [], [{ namespace: 'char:one', key: 'blob', updatedAt: 2 }]), { code: 'CLOUD_OWNER_RETIRED' });
    assert.equal((await db.listCloudResourceRows('u')).state.length, 2);
  } finally { raw.close(); }
});

test('task guard capture resolves legacy cloud metadata and invalid owner generations fail closed', async () => {
  const { raw, db } = await setup();
  try {
    assert.deepEqual(await captureCloudTaskGuard(db, 'u', { metadata: { cloudOwner: owner } }), { owner, generation: 0 });
    assert.deepEqual(await captureCloudTaskGuard(db, 'u', { metadata: { charId: 'one' } }, () => ({ owner })), { owner, generation: 0 });
    await assert.rejects(captureCloudTaskGuard(db, 'u', { owner, ownerGeneration: -1 }), { code: 'INVALID_CLOUD_OWNER_GENERATION' });
    assert.equal(await captureCloudTaskGuard(db, 'u', {}), null);
  } finally { raw.close(); }
});

test('shared state written by an active task stays global and retirement at commit blocks the whole batch', async () => {
  const { raw, db, key } = await setup();
  const guard = { owner, generation: 0 };
  const wrapped = createCloudGuardedAdapter(db, { masterKey, guard, userId: 'u' });
  try {
    await wrapped.upsertClientState('u', [{ namespace: 'global', key: 'settings', value: await encryptForStorage('{}', key), updatedAt: 1 }]);
    const stored = (await db.listCloudResourceRows('u')).metadata.find(row => row.resource_key === JSON.stringify(['state', 'global', 'settings']));
    assert.equal(JSON.parse(await decryptFromStorage(stored.encrypted_value, key)).owner, null);
    const originalUpsert = db.upsertClientState.bind(db);
    db.upsertClientState = async (...args) => {
      await db.setCloudOwnerActive('u', owner, false);
      return originalUpsert(...args);
    };
    await assert.rejects(wrapped.upsertClientState('u', [{ namespace: 'global', key: 'late', value: await encryptForStorage('late', key), updatedAt: 2 }]), { code: 'CLOUD_OWNER_RETIRED' });
    assert.equal((await db.listCloudResourceRows('u')).state.length, 1);
  } finally { raw.close(); }
});

test('new task rejects forged internal guard and asynchronous legacy resolver supplies ownership', async () => {
  const { raw, db, key, task } = await setup();
  const wrapped = createCloudGuardedAdapter(db, { masterKey, resolveOwner: async ({ payload }) => payload?.metadata?.charId === 'one' ? { owner, kind: 'legacy' } : null });
  try {
    await wrapped.createTask(await task('legacy', { metadata: { charId: 'one' }, __cloudOwnerGuard: { owner: other, generation: 999 } }));
    const saved = await db.getTaskByUuid('legacy', 'u');
    assert.deepEqual(JSON.parse(await decryptFromStorage(saved.encrypted_payload, key)).__cloudOwnerGuard, { owner, generation: 0 });
    await db.setCloudOwnerActive('u', owner, false);
    await db.setCloudOwnerActive('u', owner, true);
    await assert.rejects(captureCloudTaskGuard(db, 'u', { metadata: { charId: 'one' } }, async () => ({ owner })), { code: 'CLOUD_OWNER_RETIRED' });
  } finally { raw.close(); }
});

test('omitting or changing ownership cannot strip an existing state or credential guard', async () => {
  const { raw, db, wrapped, key } = await setup();
  try {
    const state = { namespace: 'custom', key: 'state', value: await encryptForStorage('first', key), updatedAt: 1 };
    const credential = { credId: 'custom-key', encryptedValue: await encryptForStorage('{}', key) };
    await wrapped.upsertClientState('u', [{ ...state, owner }]);
    await wrapped.upsertLlmCredentials('u', [{ ...credential, owner }]);
    await assert.rejects(wrapped.upsertClientState('u', [{ ...state, owner: other, updatedAt: 2 }]), { code: 'CLOUD_OWNER_IMMUTABLE' });
    await db.setCloudOwnerActive('u', owner, false);
    await assert.rejects(wrapped.upsertClientState('u', [{ ...state, updatedAt: 3 }]), { code: 'CLOUD_OWNER_RETIRED' });
    await assert.rejects(wrapped.upsertLlmCredentials('u', [credential]), { code: 'CLOUD_OWNER_RETIRED' });
    const restored = await db.setCloudOwnerActive('u', owner, true);
    await assert.rejects(wrapped.upsertClientState('u', [{ ...state, updatedAt: 4 }]), { code: 'CLOUD_OWNER_RETIRED' });
    await wrapped.upsertClientState('u', [{ ...state, updatedAt: 5, ownerGeneration: restored.generation }]);
    const metadata = (await db.listCloudResourceRows('u')).metadata.find(row => row.resource_key === JSON.stringify(['state', 'custom', 'state']));
    assert.equal(JSON.parse(await decryptFromStorage(metadata.encrypted_value, key)).owner.id, 'one');
  } finally { raw.close(); }
});

test('updating a scheduled task retains its stored guard and rejects a retired owner', async () => {
  const { raw, db, wrapped, key, task } = await setup();
  try {
    await wrapped.createTask(await task('update', { owner }));
    await wrapped.updateTaskByUuid('update', 'u', await encryptForStorage(JSON.stringify({ owner: other, __cloudOwnerGuard: { owner: other, generation: 0 } }), key));
    const current = await db.getTaskByUuid('update', 'u');
    assert.deepEqual(JSON.parse(await decryptFromStorage(current.encrypted_payload, key)).__cloudOwnerGuard, { owner, generation: 0 });
    await db.setCloudOwnerActive('u', owner, false);
    await assert.rejects(wrapped.updateTaskByUuid('update', 'u', await encryptForStorage('{}', key)), { code: 'CLOUD_OWNER_RETIRED' });
  } finally { raw.close(); }
});

test('task-scoped wrapper over the configured wrapper keeps the restored task generation', async () => {
  const { raw, db, wrapped, key, task } = await setup();
  try {
    await db.setCloudOwnerActive('u', owner, false);
    const restored = await db.setCloudOwnerActive('u', owner, true);
    const guard = { owner, generation: restored.generation };
    const scoped = createCloudGuardedAdapter(wrapped, { masterKey, guard, userId: 'u' });
    await scoped.createTask(await task('child-restored', { metadata: {} }));
    const child = await db.getTaskByUuid('child-restored', 'u');
    assert.deepEqual(JSON.parse(await decryptFromStorage(child.encrypted_payload, key)).__cloudOwnerGuard, guard);
    await scoped.upsertClientState('u', [{ namespace: 'char-state', key: 'k', owner, value: await encryptForStorage('value', key), updatedAt: 1 }]);
    assert.equal((await db.listCloudResourceRows('u')).state.length, 1);
  } finally { raw.close(); }
});

test('unowned write cannot overwrite ownership assigned concurrently after metadata lookup', async () => {
  const { raw, db, wrapped, key } = await setup();
  try {
    const originalUpsert = db.upsertClientState.bind(db);
    db.upsertClientState = async (...args) => {
      await originalUpsert('u', [{ namespace: 'race', key: 'k', value: await encryptForStorage('owned', key), updatedAt: 1,
        encryptedCloudMetadata: await encryptForStorage(JSON.stringify({ owner, kind: null, generation: 0 }), key) }]);
      return originalUpsert(...args);
    };
    await assert.rejects(wrapped.upsertClientState('u', [{ namespace: 'race', key: 'k', value: await encryptForStorage('unowned', key), updatedAt: 2 }]), { code: 'CLOUD_RESOURCE_CHANGED' });
    assert.equal(await decryptFromStorage((await db.getClientState('u', 'race'))[0].value, key), 'owned');
  } finally { raw.close(); }
});
