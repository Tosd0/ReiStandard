import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserServer } from '../src/server/single-user.js';
import {
  encryptPayload,
  decryptPayload,
  deriveUserEncryptionKey
} from '../src/server/lib/encryption.js';
const userId = '00000000-0000-4000-8000-000000000001';
const masterKey = 'cloud-management-test-master-key';
async function setup() {
  const raw = createTestD1();
  const db = createD1Adapter(raw);
  await db.initSchema();
  const server = createSingleUserServer({ db, masterKey });
  const key = await deriveUserEncryptionKey(userId, masterKey);
  const headers = {
    'x-user-id': userId,
    'x-payload-encrypted': 'true',
    'x-encryption-version': '1'
  };
  return { raw, db, server, key, headers };
}
test('cloud management exposes encrypted empty inventory and rejects empty purge selection', async () => {
  const { raw, server, key, headers } = await setup();
  try {
    assert.ok(server.handlers.cloudData, 'cloud-data handler must exist');
    const result = await server.handlers.cloudData.GET(
      '/cloud-data/resources',
      headers
    );
    assert.equal(result.status, 200);
    const page = await decryptPayload(result.body.data, key);
    assert.deepEqual(page.resources, []);
    assert.equal(page.complete, true);
    const rejected = await server.handlers.cloudData.POST(
      '/cloud-data/cleanup-plans',
      headers,
      JSON.stringify(
        await encryptPayload({ mode: 'purge', resourceIds: [] }, key)
      )
    );
    assert.equal(rejected.status, 400);
  } finally {
    raw.close();
  }
});
async function post(server, key, headers, path, value) {
  const result = await server.handlers.cloudData.POST(
    path,
    headers,
    JSON.stringify(await encryptPayload(value, key))
  );
  return {
    status: result.status,
    data: result.body.encrypted
      ? await decryptPayload(result.body.data, key)
      : result.body
  };
}
async function get(server, key, headers, path) {
  const result = await server.handlers.cloudData.GET(path, headers);
  return {
    status: result.status,
    data: result.body.encrypted
      ? await decryptPayload(result.body.data, key)
      : result.body
  };
}
test('pagination exceeds 200 namespaces and a cursor cannot cross users', async () => {
  const { raw, db, server, key, headers } = await setup();
  try {
    for (let i = 0; i < 205; i++)
      await db.upsertClientState(userId, [
        { namespace: `ns${i}`, key: 'a', value: 'bad-cipher', updatedAt: 1 }
      ]);
    let cursor = null,
      resources = [];
    do {
      const page = await get(
        server,
        key,
        headers,
        '/cloud-data/resources?limit=100' +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : '')
      );
      assert.equal(page.status, 200);
      resources.push(...page.data.resources);
      cursor = page.data.nextCursor;
    } while (cursor);
    assert.equal(resources.length, 205);
    assert.equal(new Set(resources.map((r) => r.id)).size, 205);
    const first = await get(
      server,
      key,
      headers,
      '/cloud-data/resources?limit=100'
    );
    const other = await get(
      server,
      key,
      { ...headers, 'x-user-id': '00000000-0000-4000-8000-000000000002' },
      '/cloud-data/resources?cursor=' +
        encodeURIComponent(first.data.nextCursor)
    );
    assert.equal(other.status, 404);
  } finally {
    raw.close();
  }
});
test('purge rejects stale previews and repeated operation requests are idempotent', async () => {
  const { raw, db, server, key, headers } = await setup();
  try {
    await db.upsertClientState(userId, [
      { namespace: 'ns', key: 'a', value: 'old-cipher', updatedAt: 1 }
    ]);
    let page = await get(server, key, headers, '/cloud-data/resources');
    let plan = await post(server, key, headers, '/cloud-data/cleanup-plans', {
      mode: 'purge',
      resourceIds: [page.data.resources[0].id]
    });
    assert.equal(plan.status, 200);
    await db.upsertClientState(userId, [
      { namespace: 'ns', key: 'a', value: 'new-cipher', updatedAt: 2 }
    ]);
    const stale = await post(
      server,
      key,
      headers,
      '/cloud-data/cleanup-operations',
      { planId: plan.data.id, idempotencyKey: 'one' }
    );
    assert.equal(stale.status, 409);
    plan = await post(server, key, headers, '/cloud-data/cleanup-plans', {
      mode: 'purge',
      resourceIds: [page.data.resources[0].id]
    });
    const op = await post(
      server,
      key,
      headers,
      '/cloud-data/cleanup-operations',
      { planId: plan.data.id, idempotencyKey: 'two' }
    );
    assert.equal(op.status, 200);
    assert.equal(op.data.status, 'completed');
    const repeated = await post(
      server,
      key,
      headers,
      '/cloud-data/cleanup-operations',
      { planId: plan.data.id, idempotencyKey: 'two' }
    );
    assert.equal(repeated.data.id, op.data.id);
    assert.equal(
      (await get(server, key, headers, '/cloud-data/resources')).data.resources
        .length,
      0
    );
  } finally {
    raw.close();
  }
});
test('retirement stops future writes, spans batches and resumes without the browser', async () => {
  const { raw, db, key, headers } = await setup();
  const owner = { type: 'character', id: 'a' };
  const cloudData = {
    resolveOwner: async (input) =>
      input.namespace === 'owned' ? { owner, kind: 'context' } : null
  };
  const server = createSingleUserServer({ db, masterKey, cloudData });
  try {
    for (let i = 0; i < 30; i++)
      await db.upsertClientState(userId, [
        { namespace: 'owned', key: String(i), value: 'cipher', updatedAt: 1 }
      ]);
    await db.upsertClientState(userId, [
      { namespace: 'shared', key: 'keep', value: 'cipher', updatedAt: 1 }
    ]);
    const plan = await post(server, key, headers, '/cloud-data/cleanup-plans', {
      mode: 'retire-owner',
      owner
    });
    const started = await post(
      server,
      key,
      headers,
      '/cloud-data/cleanup-operations',
      { planId: plan.data.id, idempotencyKey: 'retire' }
    );
    assert.equal(started.data.status, 'pending');
    assert.equal(
      (
        await get(
          server,
          key,
          headers,
          '/cloud-data/owner?ownerType=character&ownerId=a'
        )
      ).data.retired,
      true
    );
    const { resumeCloudDataCleanups } = await import(
      '../src/server/lib/cloud-data-cleanup.js'
    );
    await resumeCloudDataCleanups({ db, masterKey, cloudData });
    const done = await get(
      server,
      key,
      headers,
      '/cloud-data/cleanup-operations/' + started.data.id
    );
    assert.equal(done.data.status, 'completed');
    assert.equal(done.data.counts.find((c) => c.type === 'state').deleted, 30);
    const remaining = await get(server, key, headers, '/cloud-data/resources');
    assert.equal(remaining.data.resources.length, 1);
    assert.equal(remaining.data.resources[0].owner, null);
    const restored = await post(server, key, headers, '/cloud-data/owner', {
      action: 'restore',
      owner
    });
    assert.equal(restored.data.retired, false);
    assert.equal(restored.data.generation, 2);
  } finally {
    raw.close();
  }
});
test('state HTTP writes reject a retired owner and generation zero after restore', async () => {
  const { raw, db, key, headers } = await setup();
  const owner = { type: 'character', id: 'a' };
  const cloudData = {
    resolveOwner: (input) =>
      input.namespace === 'owned' ? { owner, kind: 'context' } : null
  };
  const server = createSingleUserServer({ db, masterKey, cloudData });
  async function write(generation) {
    return server.handlers.clientState.PUT(
      headers,
      JSON.stringify(
        await encryptPayload(
          {
            entries: [
              {
                namespace: 'owned',
                key: 'a',
                value: 'secret',
                updatedAt: Date.now(),
                ownerGeneration: generation
              }
            ]
          },
          key
        )
      )
    );
  }
  try {
    await write();
    await db.setCloudOwnerActive(userId, owner, false);
    await assert.rejects(() => write(), { code: 'CLOUD_OWNER_RETIRED' });
    await db.setCloudOwnerActive(userId, owner, true);
    await assert.rejects(() => write(), { code: 'CLOUD_OWNER_RETIRED' });
    assert.equal((await write(2)).status, 200);
  } finally {
    raw.close();
  }
});
test('retirement during generation blocks late state, derived tasks, outbox and push after restore', async () => {
  const { raw, db, key, headers } = await setup();
  const { encryptForStorage } = await import('../src/server/lib/encryption.js');
  const { processSingleMessage } = await import(
    '../src/server/lib/message-processor.js'
  );
  const { seedPushSubscription } = await import(
    './helpers/push-subscription.mjs'
  );
  const { createCloudGuardedAdapter } = await import(
    '../src/server/lib/cloud-data-guard.js'
  );
  const owner = { type: 'character', id: 'a' };
  const cloudData = {
    resolveOwner: (input) =>
      input.payload?.owner
        ? { owner: input.payload.owner, kind: 'task' }
        : input.namespace === 'owned'
        ? { owner, kind: 'context' }
        : null
  };
  const guarded = createCloudGuardedAdapter(db, {
    masterKey,
    resolveOwner: cloudData.resolveOwner
  });
  await seedPushSubscription(db, userId, masterKey);
  const payload = {
    owner,
    contactName: 'A',
    messageType: 'auto',
    completePrompt: 'hi',
    apiUrl: 'https://llm.example/v1/chat/completions',
    apiKey: 'secret',
    primaryModel: 'test',
    recurrenceType: 'none'
  };
  await guarded.createTask({
    user_id: userId,
    uuid: 'inflight',
    encrypted_payload: await encryptForStorage(JSON.stringify(payload), key),
    next_send_at: new Date().toISOString(),
    message_type: 'auto'
  });
  const task = await db.getTaskByUuid('inflight', userId);
  const originalFetch = globalThis.fetch;
  let pushes = 0;
  let blockedState = false;
  let blockedTask = false;
  globalThis.fetch = async () => {
    await db.setCloudOwnerActive(userId, owner, false);
    await db.setCloudOwnerActive(userId, owner, true);
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { role: 'assistant', content: 'late reply' } }]
        };
      }
    };
  };
  try {
    const result = await processSingleMessage(task, {
      db,
      masterKey,
      cloudData,
      webpush: {
        async sendNotification() {
          pushes++;
        }
      },
      hooks: {
        onBeforeFire: async () => [{ role: 'user', content: 'hi' }],
        onLLMOutput: async (ctx) => {
          try {
            await ctx.writeState('owned', [{ key: 'late', value: 'late' }]);
          } catch (error) {
            blockedState = error.code === 'CLOUD_OWNER_RETIRED';
          }
          try {
            await ctx.scheduleTask({
              messageType: 'fixed',
              userMessage: 'late child',
              firstSendTime: new Date(Date.now() + 300000).toISOString(),
              contactName: 'A'
            });
          } catch (error) {
            blockedTask = error.code === 'CLOUD_OWNER_RETIRED';
          }
          return {
            decision: 'finish',
            pushPayloads: [{ messageKind: 'content', message: 'late reply' }]
          };
        }
      }
    });
    assert.equal(result.success, false);
    assert.equal(blockedState, true);
    assert.equal(blockedTask, true);
    assert.equal(pushes, 0);
    const rows = await db.listCloudResourceRows(userId);
    assert.equal(rows.outbox.length, 0);
    assert.equal(rows.state.length, 0);
    assert.equal(rows.task.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    raw.close();
  }
});
test('retired owners remain discoverable after data removal and restore is idempotent', async () => {
  const { raw, db, server, key, headers } = await setup();
  const owner = { type: 'character', id: 'gone' };
  try {
    await db.setCloudOwnerActive(userId, owner, false);
    const list = await get(server, key, headers, '/cloud-data/owners');
    assert.equal(list.status, 200);
    assert.equal(list.data.owners[0].owner.id, 'gone');
    assert.equal(list.data.owners[0].retired, true);
    const first = await post(server, key, headers, '/cloud-data/owner', {
      action: 'restore',
      owner
    });
    const repeated = await post(server, key, headers, '/cloud-data/owner', {
      action: 'restore',
      owner
    });
    assert.equal(first.data.generation, 2);
    assert.equal(repeated.data.generation, 2);
  } finally {
    raw.close();
  }
});
test('retire preview cannot disable an owner restored after preview', async () => {
  const { raw, db, server, key, headers } = await setup();
  const owner = { type: 'character', id: 'changed' };
  try {
    const plan = await post(server, key, headers, '/cloud-data/cleanup-plans', {
      mode: 'retire-owner',
      owner
    });
    await db.setCloudOwnerActive(userId, owner, false);
    await db.setCloudOwnerActive(userId, owner, true);
    const result = await post(
      server,
      key,
      headers,
      '/cloud-data/cleanup-operations',
      { planId: plan.data.id, idempotencyKey: 'old-preview' }
    );
    assert.equal(result.status, 409);
    assert.equal((await db.getCloudOwner(userId, owner)).active, true);
  } finally {
    raw.close();
  }
});
test('retirement never acknowledges acceptance if persistent fencing fails', async () => {
  const { raw, db, server, key, headers } = await setup();
  const owner = { type: 'character', id: 'fence-failure' };
  try {
    const plan = await post(server, key, headers, '/cloud-data/cleanup-plans', {
      mode: 'retire-owner',
      owner
    });
    const setter = db.setCloudOwnerActive.bind(db);
    db.setCloudOwnerActive = async () => {
      throw new Error('database unavailable');
    };
    const result = await post(
      server,
      key,
      headers,
      '/cloud-data/cleanup-operations',
      { planId: plan.data.id, idempotencyKey: 'fence' }
    );
    assert.equal(result.status, 503);
    assert.equal(result.data.error.code, 'CLOUD_RETIREMENT_NOT_CONFIRMED');
    assert.equal((await db.getCloudOwner(userId, owner)).active, true);
    const operations = await get(
      server,
      key,
      headers,
      '/cloud-data/cleanup-operations'
    );
    assert.equal(operations.data.operations.length, 1);
    assert.equal(operations.data.operations[0].status, 'pending');
    db.setCloudOwnerActive = setter;
  } finally {
    raw.close();
  }
});
test('retirement at result push boundary retracts its outbox row and reports failure', async () => {
  const { raw, db, key } = await setup();
  const { createResultEmitter } = await import(
    '../src/server/lib/result-emitter.js'
  );
  const { seedPushSubscription } = await import(
    './helpers/push-subscription.mjs'
  );
  await seedPushSubscription(db, userId, masterKey);
  const { emitResult } = createResultEmitter({
    db,
    task: { user_id: userId, uuid: 'result-task' },
    userKey: key,
    decryptedPayload: { messageType: 'auto' },
    messageIdBase: 'result',
    sessionId: 'session',
    occurrenceMs: 1,
    webpush: {
      async sendNotification() {
        throw Object.assign(new Error('retired'), {
          code: 'CLOUD_OWNER_RETIRED'
        });
      }
    }
  });
  try {
    await assert.rejects(
      () =>
        emitResult({
          resultKind: 'test',
          data: { message: 'late' },
          notification: { show: 'always' }
        }),
      { code: 'CLOUD_OWNER_RETIRED' }
    );
    assert.equal((await db.listCloudResourceRows(userId)).outbox.length, 0);
  } finally {
    raw.close();
  }
});
