import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledTick } from '../src/server/lib/run-tick.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const VAPID = { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' };

async function seed(adapter, { uuid, recurrenceType, nextSendAt }) {
  const userKey = deriveUserEncryptionKey(USER, MASTER_KEY);
  const enc = encryptForStorage(JSON.stringify({
    contactName: 'Rei',
    messageType: 'fixed',
    userMessage: 'hi',
    recurrenceType,
    pushSubscription: { endpoint: 'https://example.com/x', keys: { p256dh: 'k', auth: 'a' } }
  }), userKey);
  await adapter.createTask({ user_id: USER, uuid, encrypted_payload: enc, next_send_at: nextSendAt, message_type: 'fixed' });
}

function fakeWebpush() {
  const sent = [];
  return { sent, async sendNotification(sub, payload) { sent.push(payload); } };
}

test('one-off task: delivered then deleted', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'once', recurrenceType: 'none', nextSendAt: '2020-01-01T00:00:00.000Z' });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.successCount, 1);
  assert.equal(res.details.deletedOnceOffTasks, 1);
  assert.ok(webpush.sent.length >= 1);
  assert.equal((await adapter.getPendingTasks(50)).length, 0);
});

test('daily task: delivered then rescheduled +24h, retry reset', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'daily', recurrenceType: 'daily', nextSendAt: '2020-01-01T00:00:00.000Z' });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.successCount, 1);
  assert.equal(res.details.updatedRecurringTasks, 1);
  const row = await adapter.getTaskByUuidOnly('daily');
  assert.equal(row.next_send_at, '2020-01-02T00:00:00.000Z');
  assert.equal(row.retry_count, 0);
});

test('delivery failure increments retry_count', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'fail', recurrenceType: 'none', nextSendAt: '2020-01-01T00:00:00.000Z' });

  const webpush = { async sendNotification() { throw new Error('push failed'); } };
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.failedCount, 1);
  const row = await adapter.getTaskByUuidOnly('fail');
  assert.equal(row.retry_count, 1);
});
