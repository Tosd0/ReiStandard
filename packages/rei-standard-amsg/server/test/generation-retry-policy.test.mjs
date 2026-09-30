import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTask, runScheduledTick } from '../src/server/lib/run-tick.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

async function fixture(options = {}) {
  const db = createD1Adapter(createTestD1());
  await db.initSchema();
  await seedPushSubscription(db, USER, MASTER_KEY);
  const payload = {
    messageType: 'auto', contactName: 'Rei', recurrenceType: 'none',
    completePrompt: 'hello', apiUrl: 'https://api.example.com/v1/chat/completions',
    apiKey: 'secret-key', primaryModel: 'test', metadata: { interactive: true },
    ...options.payload,
  };
  const key = await deriveUserEncryptionKey(USER, MASTER_KEY);
  await db.createTask({
    uuid: 'generation-policy', user_id: USER, message_type: payload.messageType,
    next_send_at: new Date(Date.now() - 1000).toISOString(),
    encrypted_payload: await encryptForStorage(JSON.stringify(payload), key),
  });
  const settled = [];
  const ctx = {
    db, masterKey: MASTER_KEY,
    vapid: { email: 'mailto:test@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} },
    hooks: {
      onBeforeFire: async () => [{ role: 'user', content: 'hello' }],
      onLLMOutput: async () => ({ decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'hello' }] }),
    },
    onFireSettled: async info => settled.push(info),
    maxGenerationRetries: task => task.metadata?.interactive ? 0 : undefined,
    ...options.ctx,
  };
  return { db, ctx, settled, async row() { return (await db.listTasks(USER, { status: 'all', limit: 50 })).tasks[0]; } };
}

const failures = [
  ['HTTP 200 error body', () => Response.json({ error: { message: 'no balance', code: 'provider_private_code' } })],
  ['HTTP 429', () => Response.json({ error: { message: 'no balance' } }, { status: 429 })],
  ['HTTP 503', () => new Response('upstream unavailable', { status: 503 })],
  ['network failure', () => { throw new TypeError('fetch failed'); }],
];

for (const [label, response] of failures) {
  test(`no generation retries: ${label} is terminal on first run`, async t => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests++; return response(); });
    const { ctx, row, settled } = await fixture();
    await runTask(ctx, 'generation-policy');
    assert.equal((await row()).status, 'failed');
    assert.equal((await row()).retry_count, 0);
    assert.equal(settled[0].willRetry, false);
    assert.equal(settled[0].failureStage, 'generation');
    assert.equal(settled[0].error.permanent, undefined, 'policy must not mutate provider errors');
    await runTask(ctx, 'generation-policy');
    assert.equal(requests, 1);
  });
}

test('pre-generation hook failure follows task policy and passes credential-free task', async () => {
  let selected;
  const { ctx, row, settled } = await fixture({ ctx: {
    maxGenerationRetries: task => { selected = task; return 0; },
    hooks: { onBeforeFire: async () => { throw new Error('pack read failed'); }, onLLMOutput: async () => ({ decision: 'skip-push' }) },
  } });
  await runScheduledTick(ctx);
  assert.equal((await row()).status, 'failed');
  assert.equal(selected.metadata.interactive, true);
  assert.equal(selected.apiKey, undefined);
  assert.equal(selected.encrypted_payload, undefined);
  assert.equal(settled[0].willRetry, false);
});

test('default task still enters delivery retry backoff', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  const { ctx, row, settled } = await fixture({ payload: { metadata: { interactive: false } } });
  await runTask(ctx, 'generation-policy');
  assert.equal((await row()).status, 'pending');
  assert.equal((await row()).retry_count, 1);
  assert.ok((await ctx.db.getTaskByUuidOnly('generation-policy')).retry_after);
  assert.equal(settled[0].willRetry, true);
});

test('committed batch keeps push retries and never regenerates with generation limit zero', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return Response.json({ choices: [{ message: { content: 'hello' } }] }); });
  let pushes = 0;
  const { db, ctx, row, settled } = await fixture({ ctx: {
    webpush: { async sendNotification() { pushes++; if (pushes === 1) throw new Error('push network failed'); } },
  } });
  await runTask(ctx, 'generation-policy');
  const retry = await row();
  assert.equal(retry.status, 'pending');
  assert.equal(retry.retry_count, 1);
  assert.equal(settled[0].outboxed, true);
  assert.equal(settled[0].failureStage, 'delivery');
  assert.equal(settled[0].willRetry, true);
  await db.updateTaskById(retry.id, { retry_after: new Date(Date.now() - 1000).toISOString() });
  await runTask(ctx, 'generation-policy');
  assert.equal(await row(), undefined);
  assert.equal(requests, 1);
  assert.equal(pushes, 2);
  assert.equal(settled.length, 1);
});

test('frozen prompt path also honors generation limit zero', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  const { ctx, row } = await fixture({ ctx: { hooks: null, maxGenerationRetries: 0 } });
  await runTask(ctx, 'generation-policy');
  assert.equal((await row()).status, 'failed');
});

test('nonzero generation limit is independent from delivery retry limit', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  const { db, ctx, row, settled } = await fixture({ ctx: { maxGenerationRetries: 1 } });
  await runTask(ctx, 'generation-policy');
  const first = await row();
  assert.equal(first.retry_count, 1);
  assert.equal(settled[0].willRetry, true);
  await db.updateTaskById(first.id, { retry_after: new Date(Date.now() - 1000).toISOString() });
  await runTask(ctx, 'generation-policy');
  assert.equal((await row()).status, 'failed');
  assert.equal(settled[1].willRetry, false);
});

for (const invalid of [-1, 1.5, null, () => { throw new Error('broken policy'); }]) {
  test(`invalid policy ${String(invalid)} fails before generation using default retry handling`, async t => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('must not call'); });
    const { ctx, row, settled } = await fixture({ ctx: { maxGenerationRetries: invalid } });
    await runTask(ctx, 'generation-policy');
    const stored = await row();
    assert.equal(stored.status, 'pending');
    assert.equal(stored.retry_count, 1);
    assert.equal(JSON.parse(stored.last_error).errorCode, 'GENERATION_RETRY_POLICY_INVALID');
    assert.equal(requests, 0);
    assert.equal(settled.length, 0, 'policy resolution failed before onBeforeFire was entered');
  });
}

test('successful and skipped fire receipts have no failure decision', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: 'hello' } }] }));
  const success = await fixture();
  await runTask(success.ctx, 'generation-policy');
  assert.equal(success.settled[0].willRetry, null);
  assert.equal(success.settled[0].failureStage, null);
  const skipped = await fixture({ ctx: { hooks: { onBeforeFire: async () => ({ skip: true }), onLLMOutput: async () => ({ decision: 'skip-push' }) } } });
  await runTask(skipped.ctx, 'generation-policy');
  assert.equal(skipped.settled[0].willRetry, null);
});

test('delivery retry exhaustion and permanent failures agree with the receipt', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: 'hello' } }] }));
  const delivery = await fixture({ ctx: { maxDeliveryRetries: 0, webpush: { async sendNotification() { throw new Error('push failed'); } } } });
  await runTask(delivery.ctx, 'generation-policy');
  assert.equal((await delivery.row()).status, 'failed');
  assert.equal(delivery.settled[0].willRetry, false);
  assert.equal(delivery.settled[0].failureStage, 'delivery');
});

test('legacy UUID entry point honors the same task policy', async t => {
  const { processMessagesByUuid } = await import('../src/server/lib/message-processor.js');
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new TypeError('fetch failed'); });
  const { ctx, row, settled } = await fixture();
  const result = await processMessagesByUuid('generation-policy', ctx, 2, USER);
  assert.equal(result.success, false);
  assert.equal(result.error.retriesAttempted, 0);
  assert.equal((await row()).status, 'failed');
  assert.equal(settled[0].willRetry, false);
  assert.equal(requests, 1);
});

test('cancelled attempt cannot advertise another retry after an unrelated in-flight error', async () => {
  const { processSingleMessage } = await import('../src/server/lib/message-processor.js');
  let cancelled = false;
  const { ctx, settled } = await fixture({ ctx: {
    maxGenerationRetries: 3,
    isTaskCancelled: () => cancelled,
    hooks: { onBeforeFire: async () => { cancelled = true; throw new Error('in-flight request aborted'); }, onLLMOutput: async () => ({ decision: 'skip-push' }) },
  } });
  const task = await ctx.db.getTaskByUuidOnly('generation-policy');
  const result = await processSingleMessage(task, ctx);
  assert.equal(result.willRetry, false);
  assert.equal(settled[0].willRetry, false);
});

test('Cloudflare worker factory forwards the generation policy to its queued task entrypoint', async t => {
  const { createSingleUserCloudflareWorker } = await import('../src/server/cloudflare/single-user-worker.js');
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  const { ctx, row, settled } = await fixture();
  const worker = createSingleUserCloudflareWorker(() => ctx);
  await worker.runTask('generation-policy', {});
  assert.equal((await row()).status, 'failed');
  assert.equal(settled[0].willRetry, false);
});
