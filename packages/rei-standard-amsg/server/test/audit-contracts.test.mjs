import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { deriveUserEncryptionKey, encryptPayload, decryptFromStorage, encryptForStorage } from '../src/server/lib/encryption.js';
import { runAgenticFire } from '../src/server/lib/agentic-fire.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const OTHER = '550e8400-e29b-41d4-a716-446655440001';
const MASTER = 'a'.repeat(64);
const key = await deriveUserEncryptionKey(USER, MASTER);
const due = '2026-10-19T00:00:00.000Z';
const now = Date.parse(due);
const base = { contactName: 'Rei', messageType: 'auto', apiUrl: 'https://llm.test/v1/chat/completions', apiKey: 'secret', primaryModel: 'model', completePrompt: 'prompt', recurrenceType: 'none', metadata: { charId: 'char-a' } };
async function setup(t) {
  const raw = createTestD1();
  t.after(() => raw.close());
  const db = createD1Adapter(raw);
  await db.initSchema();
  return { raw, db };
}
async function seed(db, uuid, payload = base, userId = USER) {
  const userKey = await deriveUserEncryptionKey(userId, MASTER);
  await db.createTask({ user_id: userId, uuid, encrypted_payload: await encryptForStorage(JSON.stringify(payload), userKey), next_send_at: due, message_type: payload.messageType });
  return db.getTaskByUuid(uuid, userId);
}
async function fire(db, row, hooks, context = {}) {
  const payload = JSON.parse(await decryptFromStorage(row.encrypted_payload, key));
  return runAgenticFire({ task: row, decryptedPayload: payload, userKey: key, ctx: { db, hooks, _agenticNow: () => now, _agenticSleep: async () => {}, ...context } });
}

test('accepted taskInput is bound to its task; failed replacement leaves original input intact', async (t) => {
  const { raw, db } = await setup(t);
  await seedPushSubscription(db, USER, MASTER);
  const worker = createSingleUserCloudflareWorker(() => ({ db, masterKey: MASTER }));
  const schedule = async (payload) => worker.fetch(new Request('https://w.test/schedule-message', { method: 'POST', headers: { 'X-User-Id': USER, 'X-Payload-Encrypted': 'true', 'X-Encryption-Version': '1' }, body: JSON.stringify(await encryptPayload(payload, key)) }), { DB: raw });
  const uuid = '650e8400-e29b-41d4-a716-446655440000';
  const response = await schedule({ ...base, uuid, firstSendTime: '2999-01-01T00:00:00.000Z', taskInput: { firePack: { messages: ['first'] } } });
  assert.equal(response.status, 201);
  const accepted = await db.getTaskByUuid(uuid, USER);
  assert.deepEqual(JSON.parse(await decryptFromStorage(accepted.encrypted_payload, key)).taskInput, { firePack: { messages: ['first'] } });
  const rejected = await schedule({ ...base, apiKey: null, apiUrl: null, primaryModel: null, credRefs: { chat: 'missing' }, uuid: '750e8400-e29b-41d4-a716-446655440000', supersedesUuid: uuid, firstSendTime: '2999-01-01T00:00:00.000Z', taskInput: { firePack: { messages: ['second'] } } });
  assert.equal(rejected.status, 409);
  let seen;
  await fire(db, await db.getTaskByUuid(uuid, USER), { onBeforeFire(ctx) { seen = ctx.task.taskInput; return { skip: true }; }, onLLMOutput() {} });
  assert.deepEqual(seen, { firePack: { messages: ['first'] } });
});

test('taskInput rejects arrays instead of silently accepting an unusable snapshot', async (t) => {
  const { raw, db } = await setup(t);
  await seedPushSubscription(db, USER, MASTER);
  const worker = createSingleUserCloudflareWorker(() => ({ db, masterKey: MASTER }));
  const response = await worker.fetch(new Request('https://w.test/schedule-message', { method: 'POST', headers: { 'X-User-Id': USER, 'X-Payload-Encrypted': 'true', 'X-Encryption-Version': '1' }, body: JSON.stringify(await encryptPayload({ ...base, firstSendTime: '2999-01-01T00:00:00.000Z', taskInput: [] }, key)) }), { DB: raw });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_TASK_INPUT');
});

test('fire task view is user scoped, paginated, and reflects creates, renewals, and cancellations', async (t) => {
  const { db } = await setup(t);
  const current = await seed(db, 'current', { ...base, taskInput: { privateInput: 'parent' } });
  await seed(db, 'foreign', base, OTHER);
  await fire(db, current, { async onBeforeFire(ctx) {
    const created = await ctx.scheduleTask({ uuid: 'child', firstSendTime: '2026-10-19T00:05:00.000Z' });
    assert.equal(created.task.uuid, 'child');
    assert.equal(created.task.nextSendAt, '2026-10-19T00:05:00.000Z');
    const first = await ctx.listTasks({ limit: 1 });
    assert.equal(first.tasks.length, 1);
    assert.deepEqual(first.pagination, { total: 2, limit: 1, offset: 0, hasMore: true });
    const second = await ctx.listTasks({ limit: 1, offset: 1 });
    assert.equal(second.tasks[0].uuid, 'child');
    assert.equal(second.tasks[0].apiKey, undefined);
    assert.equal(second.tasks[0].taskInput, undefined);
    const childPayload = JSON.parse(await decryptFromStorage((await db.getTaskByUuid('child', USER)).encrypted_payload, key));
    assert.equal(childPayload.taskInput, null, 'a newly scheduled task must not inherit its parent input');
    const renewed = await ctx.renewTask('child', '2026-10-19T00:10:00.000Z');
    assert.equal(renewed.task.nextSendAt, '2026-10-19T00:10:00.000Z');
    assert.equal((await ctx.listTasks()).tasks.find(item => item.uuid === 'child').nextSendAt, '2026-10-19T00:10:00.000Z');
    await ctx.cancelTask('child');
    assert.deepEqual((await ctx.listTasks()).tasks.map(item => item.uuid), ['current']);
    return { skip: true };
  }, onLLMOutput() {} });
});

test('execution allowlist blocks synthesized tools while permitted text tools work without native tools', async (t) => {
  const { db } = await setup(t);
  const current = await seed(db, 'tools');
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'text protocol' } }] }));
  };
  t.after(() => { globalThis.fetch = original; });
  const executed = [];
  let round = 0;
  await fire(db, current, {
    onBeforeFire() { return { messages: [{ role: 'user', content: 'hello' }], allowedToolNames: ['read_notes'] }; },
    onLLMOutput() { return round++ === 0 ? { decision: 'tool-request', toolCalls: ['read_notes', 'delete_notes'].map((name, i) => ({ id: String(i), type: 'function', function: { name, arguments: '{}' } })) } : { decision: 'skip-push' }; },
    executeToolCalls(calls) { executed.push(...calls.map(call => call.function.name)); return calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'read ok' })); }
  });
  assert.deepEqual(executed, ['read_notes']);
  assert.equal(requests[0].tools, undefined);
  const denied = requests[1].messages.find(message => message.role === 'tool' && message.tool_call_id === '1');
  assert.equal(JSON.parse(denied.content).error.code, 'TOOL_NOT_ALLOWED');
});

test('attachments keep separate occurrence identities and remain readable across retries until expiry', async (t) => {
  const { db, raw } = await setup(t);
  const current = await seed(db, 'attachment-task');
  const refs = [];
  for (const occurrence of [due, '2026-10-20T00:00:00.000Z']) {
    await fire(db, { ...current, next_send_at: occurrence }, { async onBeforeFire(ctx) {
      refs.push(await ctx.storeAttachment('界'.repeat(80_000), { ttlMs: 60_000 }));
      return { skip: true };
    }, onLLMOutput() {} });
  }
  assert.notEqual(refs[0].key, refs[1].key);
  assert.notEqual(refs[0].occurrenceMs, refs[1].occurrenceMs);
  const { ReiClient } = await import('../../client/src/index.js');
  const worker = createSingleUserCloudflareWorker(() => ({ db, masterKey: MASTER }));
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  globalThis.fetch = (url, init) => worker.fetch(new Request(url, init), { DB: raw });
  Date.now = () => now;
  t.after(() => { globalThis.fetch = originalFetch; Date.now = originalNow; });
  const client = new ReiClient({ baseUrl: 'https://w.test', userId: USER });
  await client.init();
  assert.equal(await client.getAttachment(refs[0]), '界'.repeat(80_000));
  assert.equal(await client.getAttachment(refs[0]), '界'.repeat(80_000));
  assert.equal(await client.getAttachment({ ...refs[0], occurrenceMs: refs[1].occurrenceMs }), null);
  assert.equal(await client.getAttachment({ ...refs[0], taskUuid: 'another' }), null);
  const otherClient = new ReiClient({ baseUrl: 'https://w.test', userId: OTHER });
  await otherClient.init();
  assert.equal(await otherClient.getAttachment(refs[0]), null);
  Date.now = () => now + 60_001;
  assert.equal(await client.getAttachment(refs[0]), null);
});

test('public encryption helpers let custom acceptance routes bind taskInput without importing private files', async () => {
  const publicSdk = await import('../src/server/index.js');
  assert.equal(typeof publicSdk.encryptPayload, 'function');
  const encrypted = await publicSdk.encryptPayload({ taskInput: { request: 'one' } }, key);
  assert.deepEqual(await publicSdk.decryptPayload(encrypted, key), { taskInput: { request: 'one' } });
});

test('attachment state and its chunks are reclaimed by cron even without app TTL configuration', async (t) => {
  const { db, raw } = await setup(t);
  const current = await seed(db, 'attachment-cleanup');
  await fire(db, current, { async onBeforeFire(ctx) {
    await ctx.storeAttachment('x'.repeat(240_000));
    return { skip: true };
  }, onLLMOutput() {} });
  assert.ok(raw._raw.prepare('SELECT COUNT(*) AS n FROM client_state').get().n > 1);
  await db.deleteTaskByUuid(current.uuid, USER);
  raw._raw.prepare('UPDATE client_state SET updated_at = ?').run(Date.now() - 31 * 86400_000);
  const { runScheduledTick } = await import('../src/server/lib/run-tick.js');
  await runScheduledTick({ db, masterKey: MASTER });
  assert.equal(raw._raw.prepare('SELECT COUNT(*) AS n FROM client_state').get().n, 0);
});

test('attachment lookup selects only its root and chunks, leaving other large values unread', async (t) => {
  const { db, raw } = await setup(t);
  const current = await seed(db, 'lookup');
  let ref;
  await fire(db, current, { async onBeforeFire(ctx) {
    ref = await ctx.storeAttachment('x'.repeat(240_000));
    await ctx.storeAttachment('y'.repeat(240_000));
    return { skip: true };
  }, onLLMOutput() {} });
  assert.equal((await db.getClientState(USER, ref.namespace, { key: ref.key })).length, 1);
  const { chunkNamespaceFor, chunkKeyPrefixFor } = await import('../src/server/lib/state-chunks.js');
  const chunks = await db.getClientState(USER, chunkNamespaceFor(ref.namespace), { keyPrefix: chunkKeyPrefixFor(ref.key) });
  assert.ok(chunks.every(row => row.key.startsWith(`${ref.key}\u001f`)));
  const worker = createSingleUserCloudflareWorker(() => ({ db, masterKey: MASTER }));
  const response = await worker.fetch(new Request(`https://w.test/client-state?namespace=${ref.namespace}&key=${ref.key}`, { headers: { 'X-User-Id': USER } }), { DB: raw });
  const { decryptPayload } = await import('../src/server/lib/encryption.js');
  const result = await decryptPayload((await response.json()).data, key);
  assert.deepEqual(result.entries.map(item => item.key), [ref.key]);
});

test('attachments carry explicit cloud ownership and cannot be written after the task owner retires', async (t) => {
  const { db } = await setup(t);
  const owner = { type: 'character', id: 'a' };
  const { createCloudGuardedAdapter } = await import('../src/server/lib/cloud-data-guard.js');
  const guarded = createCloudGuardedAdapter(db, { masterKey: MASTER, guard: { owner, generation: 0 }, userId: USER });
  const current = await seed(db, 'owned-attachment');
  await fire(guarded, current, { async onBeforeFire(ctx) {
    const ref = await ctx.storeAttachment('owned', { owner, kind: 'attachment', ownerGeneration: 0 });
    const metadata = (await db.listCloudResourceRows(USER)).metadata.find(row => row.resource_key === JSON.stringify(['state', ref.namespace, ref.key]));
    assert.deepEqual(JSON.parse(await decryptFromStorage(metadata.encrypted_value, key)).owner, owner);
    await db.setCloudOwnerActive(USER, owner, false);
    await assert.rejects(ctx.storeAttachment('late', { owner, ownerGeneration: 0 }), { code: 'CLOUD_OWNER_RETIRED' });
    return { skip: true };
  }, onLLMOutput() {} });
});

test('hook readState by key reads only the requested D1 root and chunks', async (t) => {
  const { db, raw } = await setup(t);
  const current = await seed(db, 'input-lookup');
  const namespace = 'instant-inputs';
  const selectedKey = 'input_%';
  const value = '界'.repeat(90_000);
  const queries = [];
  const prepare = raw.prepare.bind(raw);
  raw.prepare = (sql) => {
    if (/SELECT namespace, key, value, updated_at/.test(sql)) queries.push(sql);
    return prepare(sql);
  };
  await fire(db, current, { async onBeforeFire(ctx) {
    await ctx.writeState(namespace, [
      { key: selectedKey, value },
      { key: 'input_other', value: 'x'.repeat(250_000) },
      { key: 'small', value: 'plain input' },
    ]);
    const rows = await ctx.readState(namespace, { key: selectedKey });
    assert.deepEqual(rows.map(row => row.key), [selectedKey]);
    assert.equal(rows[0].value, value);
    assert.equal(queries.length, 2);
    assert.match(queries[0], /AND key = \?/);
    assert.match(queries[1], /AND key >= \? AND key < \?/);
    queries.length = 0;
    assert.deepEqual((await ctx.readState(namespace, { key: 'small' })).map(row => [row.key, row.value]), [['small', 'plain input']]);
    assert.equal(queries.length, 1, 'a plain root must not load a chunk namespace');
    queries.length = 0;
    assert.deepEqual(await ctx.readState(namespace, { key: 'missing' }), []);
    assert.equal(queries.length, 1, 'a missing root must not load a chunk namespace');
    assert.equal((await ctx.readState(namespace)).length, 3, 'the existing namespace read stays compatible');
    return { skip: true };
  }, onLLMOutput() {} });
});

test('hook readState key selection filters legacy adapters that ignore selector options', async (t) => {
  const { db } = await setup(t);
  const { createStateAccessors } = await import('../src/server/lib/state-accessors.js');
  const access = createStateAccessors({ db, userId: USER, userKey: key, now: () => now });
  await access.writeState('legacy', [{ key: 'first', value: 'one' }, { key: 'second', value: 'two' }]);
  const legacy = createStateAccessors({
    db: { getClientState: (userId, namespace) => db.getClientState(userId, namespace) },
    userId: USER, userKey: key,
  });
  assert.deepEqual((await legacy.readState('legacy', { key: 'second' })).map(row => [row.key, row.value]), [['second', 'two']]);
  assert.deepEqual(await legacy.readState('legacy', { key: 'absent' }), []);
});

test('hook readState rejects invalid key selectors before querying storage', async () => {
  const { createStateAccessors } = await import('../src/server/lib/state-accessors.js');
  const { readState } = createStateAccessors({ db: {}, userId: USER, userKey: key });
  for (const invalid of ['', ' ', null, 2, 'x'.repeat(257), 'internal\u001fkey']) {
    await assert.rejects(readState('inputs', { key: invalid }), TypeError);
  }
});


test('attachments report a specific unsupported-storage code on adapters without client state', async (t) => {
  const { db } = await setup(t);
  const current = await seed(db, 'unsupported-attachment');
  await fire({}, current, { async onBeforeFire(ctx) {
    await assert.rejects(ctx.storeAttachment('result'), { code: 'ATTACHMENT_STORAGE_UNSUPPORTED' });
    return { skip: true };
  }, onLLMOutput() {} });
});


for (const allowedToolNames of [['allowed'], [], undefined]) {
  test(`malformed tool calls keep valid transcript identities with allowlist ${JSON.stringify(allowedToolNames)}`, async (t) => {
    const { db } = await setup(t);
    const current = await seed(db, 'malformed-tools');
    const calls = [null,
      { type: 'function', function: { name: 'blocked', arguments: '{}' } },
      { id: 'call_1_1', type: 'function', function: { name: 'allowed', arguments: '{}' } },
    ];
    const requests = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: requests.length === 1 ? calls : undefined } }] });
    };
    t.after(() => { globalThis.fetch = original; });
    const executed = [];
    let round = 0;
    await fire(db, current, {
      onBeforeFire() { return { messages: [{ role: 'user', content: 'hello' }], ...(allowedToolNames === undefined ? {} : { allowedToolNames }) }; },
      onLLMOutput() { return round++ === 0 ? { decision: 'tool-request', toolCalls: calls } : { decision: 'skip-push' }; },
      executeToolCalls(permitted) { executed.push(...permitted.map(call => call.function.name)); return permitted.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'ok' })); },
    });
    assert.deepEqual(executed, allowedToolNames === undefined ? ['blocked', 'allowed'] : allowedToolNames);
    const transcript = requests[1].messages;
    const declaration = transcript.find(message => message.role === 'assistant').tool_calls;
    const results = transcript.filter(message => message.role === 'tool');
    assert.equal(results.length, 3);
    assert.ok(results.every(result => typeof result.tool_call_id === 'string' && result.tool_call_id.length > 0));
    assert.equal(new Set(results.map(result => result.tool_call_id)).size, 3);
    assert.deepEqual(declaration.map(call => call.id).sort(), results.map(result => result.tool_call_id).sort());
    assert.ok(declaration.every(call => call.type === 'function' && typeof call.function.name === 'string'));
  });
}


test('chunked attachments accept complete physical-row receipts from legacy adapters', async (t) => {
  const { db } = await setup(t);
  const current = await seed(db, 'legacy-attachment');
  const receipts = [];
  const legacy = { getClientState: (...args) => db.getClientState(...args), async upsertClientState(...args) {
    const { upserted, skipped } = await db.upsertClientState(...args);
    receipts.push({ upserted, skipped });
    return { upserted, skipped };
  } };
  const value = '界'.repeat(136_533);
  let ref;
  await fire(legacy, current, { async onBeforeFire(ctx) {
    ref = await ctx.storeAttachment(value);
    const rows = await ctx.readState(ref.namespace, { key: ref.key });
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].value).value, value);
    return { skip: true };
  }, onLLMOutput() {} });
  assert.equal(receipts[0].upserted, 4, 'three complete codepoint chunks plus the root');
  assert.equal(receipts[0].skipped, 0);
});


test('partial legacy physical-row receipts cannot masquerade as a logical attachment success', async (t) => {
  const { db } = await setup(t);
  const current = await seed(db, 'partial-legacy-attachment');
  for (const receipt of [{ upserted: 1, skipped: 0 }, { upserted: 3, skipped: 1 }]) {
    await fire({ async upsertClientState() { return receipt; } }, current, { async onBeforeFire(ctx) {
      const value = '界'.repeat(136_533);
      const result = await ctx.writeState('partial', [{ key: 'large', value }]);
      assert.equal(result.upserted, 0);
      assert.equal(result.unknown, 1);
      await assert.rejects(ctx.storeAttachment(value), /ATTACHMENT_WRITE_INCOMPLETE/);
      return { skip: true };
    }, onLLMOutput() {} });
  }
});


for (const retireOwner of [false, true]) {
  test(`cancelled settlement state and attachments share owner guards (retired: ${retireOwner})`, async (t) => {
    const { db } = await setup(t);
    const owner = { type: 'character', id: 'settlement-owner' };
    const { createCloudGuardedAdapter } = await import('../src/server/lib/cloud-data-guard.js');
    const guarded = createCloudGuardedAdapter(db, { masterKey: MASTER, guard: { owner, generation: 0 }, userId: USER });
    const current = await seed(db, 'cancelled-settlement');
    const controller = new AbortController();
    let activeWrites;
    let settledWrites;
    let status;
    const writeBoth = ctx => Promise.allSettled([
      ctx.writeState('terminal', [{ key: 'cancelled', value: 'record', owner, ownerGeneration: 0 }]),
      ctx.storeAttachment('terminal attachment', { owner, ownerGeneration: 0 }),
    ]);
    await assert.rejects(fire(guarded, current, {
      async onBeforeFire(ctx) {
        if (retireOwner) await db.setCloudOwnerActive(USER, owner, false);
        controller.abort();
        activeWrites = await writeBoth(ctx);
        return { skip: true };
      }, onLLMOutput() {},
    }, { signal: controller.signal, async onFireSettled(ctx) {
      status = ctx.status;
      settledWrites = await writeBoth(ctx);
    } }), { code: 'TASK_CANCELLED' });
    assert.equal(status, 'cancelled');
    assert.deepEqual(activeWrites.map(result => [result.status, result.reason?.code]), [['rejected', 'TASK_CANCELLED'], ['rejected', 'TASK_CANCELLED']]);
    if (retireOwner) {
      assert.deepEqual(settledWrites.map(result => [result.status, result.reason?.code]), [['rejected', 'CLOUD_OWNER_RETIRED'], ['rejected', 'CLOUD_OWNER_RETIRED']]);
    } else {
      assert.deepEqual(settledWrites.map(result => result.status), ['fulfilled', 'fulfilled']);
      assert.equal(settledWrites[0].value.upserted, 1);
      const ref = settledWrites[1].value;
      assert.equal((await db.getClientState(USER, ref.namespace, { key: ref.key })).length, 1);
    }
  });
}


test('scheduleTask duplicate receipts project the same metadata and safe task fields as creation', async (t) => {
  const { db } = await setup(t);
  const current = await seed(db, 'receipt-parent');
  await fire(db, current, { async onBeforeFire(ctx) {
    const input = { uuid: 'receipt-child', firstSendTime: '2026-10-19T00:05:00.000Z', metadata: { purpose: 'followup', nested: { value: 1 } }, taskInput: { secretInput: true } };
    const created = await ctx.scheduleTask(input);
    const duplicate = await ctx.scheduleTask(input);
    assert.equal(created.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.reason, 'duplicate');
    assert.deepEqual(Object.keys(duplicate.task).sort(), Object.keys(created.task).sort());
    // Creation adapters can omit updated_at; the duplicate path reads the
    // current stored row. Compare the stable fields, not that observation time.
    assert.deepEqual({ ...duplicate.task, updatedAt: null }, { ...created.task, updatedAt: null });
    assert.deepEqual(duplicate.task.metadata, input.metadata);
    assert.equal(duplicate.task.apiKey, undefined);
    assert.equal(duplicate.task.taskInput, undefined);
    return { skip: true };
  }, onLLMOutput() {} });
});
