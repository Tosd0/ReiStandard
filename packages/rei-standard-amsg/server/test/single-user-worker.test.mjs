import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { deriveUserEncryptionKey, encryptPayload, encryptForStorage } from '../src/server/lib/encryption.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

function makeWorker(d1) {
  return createSingleUserCloudflareWorker((env) => ({
    db: createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} }
  }));
}

test('fetch routes init + schedule + messages, unknown → 404', async () => {
  const d1 = createTestD1();
  const worker = makeWorker(d1);
  const env = { DB: d1 };

  // build tables via the init route
  const initRes = await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
  assert.equal(initRes.status, 200);

  const userKey = deriveUserEncryptionKey(USER, MASTER_KEY);
  const body = JSON.stringify(encryptPayload({
    contactName: 'Rei', messageType: 'fixed', userMessage: 'hi',
    firstSendTime: '2999-01-01T00:00:00.000Z', recurrenceType: 'none',
    pushSubscription: { endpoint: 'https://e.com/x', keys: { p256dh: 'k', auth: 'a' } }
  }, userKey));

  const schedRes = await worker.fetch(new Request('https://w.dev/schedule-message', {
    method: 'POST',
    headers: { 'X-User-Id': USER, 'X-Payload-Encrypted': 'true', 'X-Encryption-Version': '1' },
    body
  }), env);
  assert.equal(schedRes.status, 201);

  const listRes = await worker.fetch(new Request('https://w.dev/messages?status=all', {
    method: 'GET', headers: { 'X-User-Id': USER }
  }), env);
  assert.equal(listRes.status, 200);

  const notFound = await worker.fetch(new Request('https://w.dev/nope', { method: 'GET' }), env);
  assert.equal(notFound.status, 404);
});

test('scheduled() runs the tick over env.DB', async () => {
  const d1 = createTestD1();
  const adapter = createD1Adapter(d1);
  await adapter.initSchema();
  const userKey = deriveUserEncryptionKey(USER, MASTER_KEY);
  const enc = encryptForStorage(JSON.stringify({
    contactName: 'Rei', messageType: 'fixed', userMessage: 'hi', recurrenceType: 'none',
    pushSubscription: { endpoint: 'https://e.com/x', keys: { p256dh: 'k', auth: 'a' } }
  }), userKey);
  await adapter.createTask({ user_id: USER, uuid: 'due', encrypted_payload: enc, next_send_at: '2020-01-01T00:00:00.000Z', message_type: 'fixed' });

  let sent = 0;
  const worker = createSingleUserCloudflareWorker(() => ({
    db: adapter,
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() { sent++; } }
  }));

  await worker.scheduled({}, { DB: d1 });
  assert.ok(sent >= 1);
  assert.equal((await adapter.getPendingTasks(50)).length, 0);
});

test('fetch() turns an unexpected error into a JSON 500 (not the runtime error page)', async () => {
  const worker = createSingleUserCloudflareWorker(() => { throw new Error('config boom'); });
  const origErr = console.error;
  let logged = 0;
  console.error = () => { logged++; };
  let res;
  try {
    res = await worker.fetch(new Request('https://w.dev/messages', { method: 'GET' }), {});
  } finally {
    console.error = origErr;
  }
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.ok(logged >= 1); // logged, not silently swallowed
});

test('scheduled() logs and swallows a tick failure so the next cron retries', async () => {
  const worker = createSingleUserCloudflareWorker(() => ({
    db: { async getPendingTasks() { throw new Error('db down'); } },
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} }
  }));
  const origErr = console.error;
  let logged = 0;
  console.error = () => { logged++; };
  try {
    await worker.scheduled({}, { DB: null }); // must NOT throw
  } finally {
    console.error = origErr;
  }
  assert.ok(logged >= 1);
});
