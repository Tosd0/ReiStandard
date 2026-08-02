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

// 列表投影只给 charId / clientTaskId 两个 metadata 子字段（上面那条测试钉着
// 「整份 metadata 不上列表」）。而 PUT /update-message 对 metadata 是整体替换，
// 于是「只改 metadata 里的一个键」必须先读回完整的那份——那条路径走单条查询。
async function getMessageDecrypted(server, uuid) {
  const res = await server.handlers.getMessage.GET(`/message?id=${uuid}`, { 'X-User-Id': USER });
  if (res.status !== 200) return res;
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return { status: res.status, data: await decryptPayload(res.body.data, userKey) };
}

test('GET /message 单条：带完整 metadata，凭据仍然不出现', async () => {
  const server = await makeServer();
  const metadata = { charId: 'char-1', beat: 'followup', anchorMs: 1735689600000, expirePolicy: 'drop' };
  const created = await server.handlers.scheduleMessage.POST(
    SCHEDULE_HEADERS,
    await encBody(basePayload({
      metadata,
      messageType: 'prompted',
      completePrompt: 'p',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'sk-super-secret',
      primaryModel: 'm',
    }))
  );
  assert.equal(created.status, 201);
  const uuid = created.body.data.uuid;

  const { status, data } = await getMessageDecrypted(server, uuid);
  assert.equal(status, 200);
  assert.deepEqual(data.task.metadata, metadata, '完整 metadata 必须原样回来');
  assert.equal(data.task.uuid, uuid);
  assert.equal(data.task.charId, 'char-1');
  assert.equal(data.task.contactName, 'Rei');
  // 投影是白名单式的，凭据一个都不该出现。
  assert.ok(!JSON.stringify(data.task).includes('sk-super-secret'));
  assert.ok(!('apiKey' in data.task) && !('apiUrl' in data.task));
});

test('GET /message：没有这条任务 404，缺 id 400', async () => {
  const server = await makeServer();
  const missing = await server.handlers.getMessage.GET('/message?id=nope', { 'X-User-Id': USER });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'TASK_NOT_FOUND');

  const noId = await server.handlers.getMessage.GET('/message', { 'X-User-Id': USER });
  assert.equal(noId.status, 400);
  assert.equal(noId.body.error.code, 'TASK_ID_REQUIRED');
});

// 这条钉的是「读-改-写真的做得到」：拿不回完整 metadata 的话，宿主只能盲传一
// 部分字段，把任务指令、锚点时间戳这些一起冲掉，下次 fire 直接硬失败。
test('metadata 单个子字段的读-改-写：其余键一个都不丢', async () => {
  const server = await makeServer();
  const created = await server.handlers.scheduleMessage.POST(
    SCHEDULE_HEADERS,
    await encBody(basePayload({ metadata: { charId: 'char-1', instruction: '聊聊今天', anchorMs: 42 } }))
  );
  const uuid = created.body.data.uuid;

  const { data } = await getMessageDecrypted(server, uuid);
  const patched = await server.handlers.updateMessage.PUT(
    `/update-message?id=${uuid}`,
    SCHEDULE_HEADERS,
    await encBody({ metadata: { ...data.task.metadata, instruction: '换个话题' } })
  );
  assert.equal(patched.status, 200);

  const after = await getMessageDecrypted(server, uuid);
  assert.deepEqual(after.data.task.metadata, { charId: 'char-1', instruction: '换个话题', anchorMs: 42 });
});

// 用户给角色改了名之后，之前排的任务推送出来的通知标题（「来自 <contactName>」）
// 还得跟着改。
test('PUT /update-message 认 contactName', async () => {
  const server = await makeServer();
  const created = await server.handlers.scheduleMessage.POST(SCHEDULE_HEADERS, await encBody(basePayload()));
  const uuid = created.body.data.uuid;

  const patched = await server.handlers.updateMessage.PUT(
    `/update-message?id=${uuid}`,
    SCHEDULE_HEADERS,
    await encBody({ contactName: '零' })
  );
  assert.equal(patched.status, 200);

  const { data } = await getMessageDecrypted(server, uuid);
  assert.equal(data.task.contactName, '零');
});

test('PUT /update-message 打回空的 contactName（否则写出一条标题是「来自 undefined」的任务）', async () => {
  const server = await makeServer();
  const created = await server.handlers.scheduleMessage.POST(SCHEDULE_HEADERS, await encBody(basePayload()));
  const uuid = created.body.data.uuid;

  for (const bad of ['', '   ', null, 42]) {
    const res = await server.handlers.updateMessage.PUT(
      `/update-message?id=${uuid}`,
      SCHEDULE_HEADERS,
      await encBody({ contactName: bad })
    );
    assert.equal(res.status, 400, `contactName ${JSON.stringify(bad)} 应该被打回`);
    assert.deepEqual(res.body.error.details.invalidFields, ['contactName']);
  }

  // 打回之后存的还是原来的名字。
  const { data } = await getMessageDecrypted(server, uuid);
  assert.equal(data.task.contactName, 'Rei');
});

test('masterKey wiring: storage encrypt/decrypt round-trips', async () => {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const round = JSON.parse(await decryptFromStorage(await encryptForStorage(JSON.stringify({ a: 1 }), userKey), userKey));
  assert.equal(round.a, 1);
});
