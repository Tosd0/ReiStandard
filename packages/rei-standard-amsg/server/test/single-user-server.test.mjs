import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleUserServer } from '../src/server/single-user.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptPayload, encryptForStorage, decryptFromStorage, decryptPayload } from '../src/server/lib/encryption.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

async function makeServer() {
  const db = createD1Adapter(createTestD1());
  await db.initSchema();
  // 排程要求这个用户已经登记过推送订阅（任务行不携带订阅了）。
  await seedPushSubscription(db, USER, MASTER_KEY);
  const server = createSingleUserServer({ db, masterKey: MASTER_KEY });
  return server;
}

async function encBody(obj) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return JSON.stringify(await encryptPayload(obj, userKey));
}

test('createSingleUserServer exposes the reused handlers + init', async () => {
  const server = await makeServer();
  for (const k of ['init', 'getUserKey', 'scheduleMessage', 'updateMessage', 'cancelMessage', 'messages']) {
    assert.ok(server.handlers[k], `missing handler ${k}`);
  }
  assert.equal(server.handlers.sendNotifications, undefined); // NOT exposed in single-user
});

test('schedule → list → cancel round-trips through single-user server over D1', async () => {
  const server = await makeServer();
  const headers = {
    'X-User-Id': USER,
    'X-Payload-Encrypted': 'true',
    'X-Encryption-Version': '1'
  };

  const payload = {
    contactName: 'Rei',
    messageType: 'fixed',
    userMessage: 'hi',
    firstSendTime: '2999-01-01T00:00:00.000Z',
    recurrenceType: 'none'
  };
  const created = await server.handlers.scheduleMessage.POST(headers, await encBody(payload));
  assert.equal(created.status, 201);
  const uuid = created.body.data.uuid;

  const listed = await server.handlers.messages.GET(`/messages?status=all`, { 'X-User-Id': USER });
  assert.equal(listed.status, 200);

  const cancelled = await server.handlers.cancelMessage.DELETE(`/cancel-message?id=${uuid}`, { 'X-User-Id': USER });
  assert.equal(cancelled.status, 200);
});

// GET /messages projects the task's charId / clientTaskId (taken from the
// stored payload's metadata) so the host can filter tasks by character
// ownership — contactName alone is ambiguous (characters can share a name).
const SCHEDULE_HEADERS = {
  'X-User-Id': USER,
  'X-Payload-Encrypted': 'true',
  'X-Encryption-Version': '1',
};

function basePayload(overrides = {}) {
  return {
    contactName: 'Rei',
    messageType: 'fixed',
    userMessage: 'hi',
    firstSendTime: '2999-01-01T00:00:00.000Z',
    recurrenceType: 'none',
    ...overrides,
  };
}

// Decrypt the encrypted GET /messages response back into { tasks, pagination }.
async function listTasksDecrypted(server) {
  const listed = await server.handlers.messages.GET('/messages?status=all', { 'X-User-Id': USER });
  assert.equal(listed.status, 200);
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return decryptPayload(listed.body.data, userKey);
}

test('GET /messages projects charId / clientTaskId from task metadata', async () => {
  const server = await makeServer();
  const clientTaskId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'; // uuid v4
  const created = await server.handlers.scheduleMessage.POST(
    SCHEDULE_HEADERS,
    await encBody(basePayload({ metadata: { charId: 'char-1', amsgClientTaskId: clientTaskId } }))
  );
  assert.equal(created.status, 201);
  const uuid = created.body.data.uuid;

  const { tasks } = await listTasksDecrypted(server);
  const row = tasks.find(t => t.uuid === uuid);
  assert.ok(row, 'scheduled task should appear in the list');
  assert.equal(row.charId, 'char-1');
  assert.equal(row.clientTaskId, clientTaskId);
  // the whole metadata object must NOT leak onto the response
  assert.equal('metadata' in row, false);
});

test('GET /messages: charId / clientTaskId are null when metadata is absent', async () => {
  const server = await makeServer();
  const created = await server.handlers.scheduleMessage.POST(SCHEDULE_HEADERS, await encBody(basePayload()));
  assert.equal(created.status, 201);
  const uuid = created.body.data.uuid;

  const { tasks } = await listTasksDecrypted(server);
  const row = tasks.find(t => t.uuid === uuid);
  assert.ok(row, 'scheduled task should appear in the list');
  assert.equal(row.charId, null);
  assert.equal(row.clientTaskId, null);
});

test('masterKey wiring: storage encrypt/decrypt round-trips', async () => {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const round = JSON.parse(await decryptFromStorage(await encryptForStorage(JSON.stringify({ a: 1 }), userKey), userKey));
  assert.equal(round.a, 1);
});
