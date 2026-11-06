// 换了主密钥（AMSG_MASTER_KEY）之后，库里旧密钥写的数据解不开。这里用 OLD_KEY
// 写、NEW_KEY 读来模拟重新部署换密钥，钉住：解不开时报 STORED_DATA_UNDECRYPTABLE
// 而不是通用 500；列表接口一条坏了不连累其余；写入和删除照常可用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { createCloudGuardedAdapter } from '../src/server/lib/cloud-data-guard.js';
import { runAgenticFire } from '../src/server/lib/agentic-fire.js';
import {
  deriveUserEncryptionKey,
  encryptPayload,
  decryptPayload,
  encryptForStorage,
  decryptFromStorage
} from '../src/server/lib/encryption.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const OLD_KEY = 'a'.repeat(64);
const NEW_KEY = 'b'.repeat(64);
const oldUserKey = await deriveUserEncryptionKey(USER, OLD_KEY);
const newUserKey = await deriveUserEncryptionKey(USER, NEW_KEY);
const CODE = 'STORED_DATA_UNDECRYPTABLE';

async function setup(t) {
  const raw = createTestD1();
  t.after(() => raw.close());
  const db = createD1Adapter(raw);
  await db.initSchema();
  const workerFor = (masterKey) => {
    const worker = createSingleUserCloudflareWorker(() => ({
      db,
      masterKey,
      vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
      webpush: { async sendNotification() {} }
    }));
    const userKey = masterKey === OLD_KEY ? oldUserKey : newUserKey;
    const call = async (method, path, payload) => {
      const headers = { 'X-User-Id': USER };
      let body;
      if (payload !== undefined) {
        Object.assign(headers, { 'X-Payload-Encrypted': 'true', 'X-Encryption-Version': '1' });
        body = JSON.stringify(await encryptPayload(payload, userKey));
      }
      const res = await worker.fetch(new Request(`https://w.test${path}`, { method, headers, body }), { DB: raw });
      const json = await res.json();
      const data = json.encrypted ? await decryptPayload(json.data, userKey) : json.data;
      return { status: res.status, json, data };
    };
    return { worker, call };
  };
  return { raw, db, before: workerFor(OLD_KEY), after: workerFor(NEW_KEY) };
}

const task = (uuid) => ({
  uuid,
  contactName: 'Rei',
  messageType: 'fixed',
  userMessage: 'hi',
  firstSendTime: '2999-01-01T00:00:00.000Z',
  recurrenceType: 'none'
});

test('decryptFromStorage 用错的密钥：抛带 code 和 409 的错误，原始异常留在 cause', async () => {
  const stored = await encryptForStorage('secret', oldUserKey);
  await assert.rejects(decryptFromStorage(stored, newUserKey), (error) => {
    assert.equal(error.code, CODE);
    assert.equal(error.status, 409);
    assert.match(error.message, /AMSG_MASTER_KEY/);
    assert.ok(error.cause, '底层 WebCrypto 异常要留在 cause 里');
    assert.notEqual(error.permanent, true, '换回原密钥能恢复，不能判成永久失败');
    return true;
  });
  // 密文本身坏了（不是 iv:tag:data 形状）也归这一类。
  await assert.rejects(decryptFromStorage('not-ciphertext', newUserKey), { code: CODE });
});

test('PUT /client-state：旧归属记录解不开时照常写入，用新密钥重写归属记录', async (t) => {
  const { db, before, after } = await setup(t);
  assert.equal((await before.call('PUT', '/client-state', { entries: [{ namespace: 'n', key: 'k', value: 'old', updatedAt: 1 }] })).status, 200);

  const put = await after.call('PUT', '/client-state', { entries: [{ namespace: 'n', key: 'k', value: 'new', updatedAt: 2 }] });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(put.json.data.upserted, 1);

  const read = await after.call('GET', '/client-state?namespace=n');
  assert.deepEqual(read.data.entries.map((e) => [e.key, e.value]), [['k', 'new']]);
  assert.equal(read.data.undecryptable, undefined, '全部能解开时不带 undecryptable 字段');
  const { metadata } = await db.listCloudResourceRows(USER);
  for (const row of metadata) await decryptFromStorage(row.encrypted_value, newUserKey);
});

test('PUT /llm-credentials：旧归属记录解不开时照常写入', async (t) => {
  const { before, after } = await setup(t);
  const cred = (apiKey) => ({ credentials: [{ credId: 'c1', value: { apiUrl: 'https://llm.test/v1/chat/completions', apiKey, primaryModel: 'm' } }] });
  assert.equal((await before.call('PUT', '/llm-credentials', cred('old'))).status, 200);
  const put = await after.call('PUT', '/llm-credentials', cred('new'));
  assert.equal(put.status, 200, JSON.stringify(put.json));
});

test('归属降级只放过「旧记录解不开」：显式带上已停用的归属照旧被拒', async (t) => {
  const { db } = await setup(t);
  const owner = { type: 'character', id: 'one' };
  const oldWrap = createCloudGuardedAdapter(db, { masterKey: OLD_KEY });
  const newWrap = createCloudGuardedAdapter(db, { masterKey: NEW_KEY });
  await oldWrap.upsertClientState(USER, [{ namespace: 'n', key: 'k', owner, value: await encryptForStorage('v', oldUserKey), updatedAt: 1 }]);
  await db.setCloudOwnerActive(USER, owner, false);
  await assert.rejects(
    newWrap.upsertClientState(USER, [{ namespace: 'n', key: 'k', owner, value: await encryptForStorage('v', newUserKey), updatedAt: 2 }]),
    { code: 'CLOUD_OWNER_RETIRED' }
  );
});

test('GET /client-state：解不开的 key 单列在 undecryptable，其余照常返回，PUT null 能删掉它', async (t) => {
  const { before, after } = await setup(t);
  await before.call('PUT', '/client-state', { entries: [{ namespace: 'n', key: 'stale', value: 'x', updatedAt: 1 }] });
  // 大值走分块：切片也是旧密钥写的。
  await before.call('PUT', '/client-state', { entries: [{ namespace: 'n', key: 'big', value: 'y'.repeat(300_000), updatedAt: 1 }] });
  await after.call('PUT', '/client-state', { entries: [{ namespace: 'n', key: 'fresh', value: 'ok', updatedAt: 2 }] });

  const read = await after.call('GET', '/client-state?namespace=n');
  assert.equal(read.status, 200, JSON.stringify(read.json));
  assert.deepEqual(read.data.entries.map((e) => [e.key, e.value]), [['fresh', 'ok']]);
  assert.deepEqual(
    read.data.undecryptable.map((e) => [e.key, e.updatedAt, e.code]).sort(),
    [['big', 1, CODE], ['stale', 1, CODE]]
  );

  const del = await after.call('PUT', '/client-state', { entries: [{ namespace: 'n', key: 'stale', value: null, updatedAt: 3 }] });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  const again = await after.call('GET', '/client-state?namespace=n&key=stale');
  assert.deepEqual(again.data.entries, []);
  assert.equal(again.data.undecryptable, undefined);
});

test('DELETE /client-state 不解密，换密钥后照常能清', async (t) => {
  const { before, after } = await setup(t);
  await before.call('PUT', '/client-state', { entries: [{ namespace: 'n', key: 'stale', value: 'x', updatedAt: 1 }] });
  assert.equal((await after.call('DELETE', '/client-state?namespace=n')).status, 200);
  assert.deepEqual((await after.call('GET', '/client-state?namespace=n')).data.entries, []);
});

test('GET /messages：解不开的任务带 uuid 和 error 列出来，不连累整页，能按 uuid 取消', async (t) => {
  const { db, before, after } = await setup(t);
  await seedPushSubscription(db, USER, OLD_KEY);
  assert.equal((await before.call('POST', '/schedule-message', task('650e8400-e29b-41d4-a716-446655440001'))).status, 201);
  await db.upsertPushSubscription(USER, await encryptForStorage(JSON.stringify({ endpoint: 'https://push.example.com/sub', keys: { p256dh: 'k', auth: 'a' } }), newUserKey), Date.now() + 60_000);
  assert.equal((await after.call('POST', '/schedule-message', task('650e8400-e29b-41d4-a716-446655440002'))).status, 201);

  const list = await after.call('GET', '/messages?status=all');
  assert.equal(list.status, 200, JSON.stringify(list.json));
  const byUuid = Object.fromEntries(list.data.tasks.map((item) => [item.uuid, item]));
  assert.equal(byUuid['650e8400-e29b-41d4-a716-446655440002'].contactName, 'Rei');
  assert.equal(byUuid['650e8400-e29b-41d4-a716-446655440002'].error, undefined);
  const broken = byUuid['650e8400-e29b-41d4-a716-446655440001'];
  assert.equal(broken.error.code, CODE);
  assert.equal(broken.status, 'pending');
  assert.equal(broken.contactName, undefined);

  const detail = await after.call('GET', '/message?id=650e8400-e29b-41d4-a716-446655440001');
  assert.equal(detail.status, 409);
  assert.equal(detail.json.error.code, CODE);

  const update = await after.call('PUT', '/update-message?id=650e8400-e29b-41d4-a716-446655440001', { userMessage: 'changed' });
  assert.equal(update.status, 409);
  assert.equal(update.json.error.code, CODE);

  assert.equal((await after.call('DELETE', '/cancel-message?id=650e8400-e29b-41d4-a716-446655440001')).status, 200);
  const remaining = await after.call('GET', '/messages?status=all');
  assert.deepEqual(remaining.data.tasks.map((item) => item.uuid), ['650e8400-e29b-41d4-a716-446655440002']);
});

test('cron 到点投递解不开的任务：last_error 带 errorCode', async (t) => {
  const { raw, db, after } = await setup(t);
  await db.createTask({
    user_id: USER,
    uuid: 'due',
    encrypted_payload: await encryptForStorage(JSON.stringify({ ...task('due'), firstSendTime: undefined }), oldUserKey),
    next_send_at: new Date(Date.now() - 30_000).toISOString(),
    message_type: 'fixed'
  });
  await after.worker.scheduled({}, { DB: raw }, { waitUntil() {} });
  const list = await after.call('GET', '/messages?status=all');
  assert.equal(list.data.tasks[0].lastError.errorCode, CODE);
});

test('hook 的 ctx.listTasks：解不开的任务带 error 列出来，fire 不被拖挂', async (t) => {
  const { db } = await setup(t);
  const payload = { ...task('current'), messageType: 'auto', apiUrl: 'https://llm.test/v1', apiKey: 'k', primaryModel: 'm', completePrompt: 'p' };
  await db.createTask({ user_id: USER, uuid: 'current', encrypted_payload: await encryptForStorage(JSON.stringify(payload), newUserKey), next_send_at: '2026-10-19T00:00:00.000Z', message_type: 'auto' });
  await db.createTask({ user_id: USER, uuid: 'stale', encrypted_payload: await encryptForStorage(JSON.stringify(payload), oldUserKey), next_send_at: '2026-10-19T00:00:00.000Z', message_type: 'auto' });
  const row = await db.getTaskByUuid('current', USER);
  let listed;
  await runAgenticFire({
    task: row,
    decryptedPayload: payload,
    userKey: newUserKey,
    ctx: {
      db,
      _agenticNow: () => Date.parse('2026-10-19T00:00:00.000Z'),
      _agenticSleep: async () => {},
      hooks: { async onBeforeFire(ctx) { listed = await ctx.listTasks(); return { skip: true }; }, onLLMOutput() {} }
    }
  });
  const byUuid = Object.fromEntries(listed.tasks.map((item) => [item.uuid, item]));
  assert.equal(byUuid.current.error, undefined);
  assert.equal(byUuid.stale.error.code, CODE);
});
