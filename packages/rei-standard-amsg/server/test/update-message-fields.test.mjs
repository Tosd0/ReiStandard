/**
 * 排程 / 更新两个入口对字段的口径：收得下的必须是投递时用得了的，回报里说改
 * 了的必须是真的改了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleUserServer } from '../src/server/single-user.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptPayload, decryptFromStorage } from '../src/server/lib/encryption.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

const HEADERS = {
  'X-User-Id': USER,
  'X-Payload-Encrypted': 'true',
  'X-Encryption-Version': '1'
};

async function makeServer() {
  const db = createD1Adapter(createTestD1());
  await db.initSchema();
  await seedPushSubscription(db, USER, MASTER_KEY);
  return { server: createSingleUserServer({ db, masterKey: MASTER_KEY }), db };
}

async function encBody(obj) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return JSON.stringify(await encryptPayload(obj, userKey));
}

async function readStoredPayload(db, uuid) {
  const row = await db.getTaskByUuid(uuid, USER);
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return JSON.parse(await decryptFromStorage(row.encrypted_payload, userKey));
}

async function scheduleFixed(server, overrides = {}) {
  const created = await server.handlers.scheduleMessage.POST(HEADERS, await encBody({
    contactName: 'Rei',
    messageType: 'fixed',
    userMessage: '原文。',
    firstSendTime: '2999-01-01T00:00:00.000Z',
    recurrenceType: 'none',
    ...overrides
  }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data.uuid;
}

// userMessage 到点要过正则切分。不是字符串的话这一步收得下、投递时才炸在
// `chunk.split` 上——那时早已离开 HTTP 请求，用户只看到任务莫名其妙失败。
test('POST /schedule-message 打回不是字符串的 userMessage', async () => {
  const { server } = await makeServer();
  const created = await server.handlers.scheduleMessage.POST(HEADERS, await encBody({
    contactName: 'Rei',
    messageType: 'fixed',
    userMessage: 12345,
    firstSendTime: '2999-01-01T00:00:00.000Z',
    recurrenceType: 'none'
  }));
  assert.equal(created.status, 400);
  assert.equal(created.body.error.code, 'INVALID_PARAMETERS');
});

test('PUT /update-message 打回不是字符串的 userMessage', async () => {
  const { server } = await makeServer();
  const uuid = await scheduleFixed(server);

  const updated = await server.handlers.updateMessage.PUT(
    `/update-message?id=${uuid}`,
    HEADERS,
    await encBody({ userMessage: 12345 })
  );
  assert.equal(updated.status, 400);
  assert.equal(updated.body.error.code, 'INVALID_UPDATE_DATA');
});

test('PUT /update-message 认 messageSubtype 与 llmExtraBody', async () => {
  const { server, db } = await makeServer();
  const uuid = await scheduleFixed(server, { messageSubtype: 'chat' });

  const updated = await server.handlers.updateMessage.PUT(
    `/update-message?id=${uuid}`,
    HEADERS,
    await encBody({ messageSubtype: 'forum', llmExtraBody: { thinking: { type: 'enabled' } } })
  );
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.data.updatedFields.sort(), ['llmExtraBody', 'messageSubtype']);

  const stored = await readStoredPayload(db, uuid);
  assert.equal(stored.messageSubtype, 'forum');
  assert.deepEqual(stored.llmExtraBody, { thinking: { type: 'enabled' } });
});

test('PUT /update-message 打回形状不对的 messageSubtype / llmExtraBody', async () => {
  const { server } = await makeServer();
  const uuid = await scheduleFixed(server);

  for (const patch of [{ messageSubtype: 42 }, { llmExtraBody: ['not', 'an', 'object'] }]) {
    const updated = await server.handlers.updateMessage.PUT(
      `/update-message?id=${uuid}`,
      HEADERS,
      await encBody(patch)
    );
    assert.equal(updated.status, 400, JSON.stringify(patch));
    assert.equal(updated.body.error.code, 'INVALID_UPDATE_DATA');
  }
});

// updatedFields 是调用方判断「我这次改生效了没有」的唯一依据。照单把请求里的
// 键报回去，等于对没应用的字段说了假话。
test('PUT /update-message 的 updatedFields 只报真正落库的字段', async () => {
  const { server, db } = await makeServer();
  const uuid = await scheduleFixed(server);

  const updated = await server.handlers.updateMessage.PUT(
    `/update-message?id=${uuid}`,
    HEADERS,
    await encBody({
      contactName: '改过的名字',
      // 拼错的键：库不认，不该被报成改了
      contactname: '不会生效',
      // 传 null 只是「不改」，不是清空——同样不该报成改了
      apiUrl: null
    })
  );

  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.data.updatedFields, ['contactName']);

  const stored = await readStoredPayload(db, uuid);
  assert.equal(stored.contactName, '改过的名字');
  assert.equal('contactname' in stored, false);
});
