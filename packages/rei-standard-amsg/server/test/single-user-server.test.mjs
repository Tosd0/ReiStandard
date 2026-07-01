import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleUserServer } from '../src/server/single-user.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptPayload, encryptForStorage, decryptFromStorage } from '../src/server/lib/encryption.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

async function makeServer() {
  const db = createD1Adapter(createTestD1());
  await db.initSchema();
  const server = createSingleUserServer({ db, masterKey: MASTER_KEY });
  return server;
}

function encBody(obj) {
  const userKey = deriveUserEncryptionKey(USER, MASTER_KEY);
  return JSON.stringify(encryptPayload(obj, userKey));
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
    recurrenceType: 'none',
    pushSubscription: { endpoint: 'https://example.com/x', keys: { p256dh: 'k', auth: 'a' } }
  };
  const created = await server.handlers.scheduleMessage.POST(headers, encBody(payload));
  assert.equal(created.status, 201);
  const uuid = created.body.data.uuid;

  const listed = await server.handlers.messages.GET(`/messages?status=all`, { 'X-User-Id': USER });
  assert.equal(listed.status, 200);

  const cancelled = await server.handlers.cancelMessage.DELETE(`/cancel-message?id=${uuid}`, { 'X-User-Id': USER });
  assert.equal(cancelled.status, 200);
});

test('masterKey wiring: storage encrypt/decrypt round-trips', () => {
  const userKey = deriveUserEncryptionKey(USER, MASTER_KEY);
  const round = JSON.parse(decryptFromStorage(encryptForStorage(JSON.stringify({ a: 1 }), userKey), userKey));
  assert.equal(round.a, 1);
});
