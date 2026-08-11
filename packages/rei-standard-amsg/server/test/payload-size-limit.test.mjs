/**
 * 任务正文的大小闸门（D1 的单行 2,000,000 字节上限）。
 *
 * 这条限制本地测不出来：better-sqlite3 的单值上限是十亿字节，Postgres 的 text
 * 上限 1GB，只有线上 D1 会在写入时回 `D1_ERROR: string or blob too big`。所以
 * 这里的断言盯的是「发给适配器的东西」——超限时那条 INSERT / UPDATE 根本没发
 * 出去，贴着上限时绑上去的密文仍在 2,000,000 字节以内——而不是执行结果。
 * （同一路数：test/d1-adapter.test.mjs 的 LIKE pattern 长度、
 * test/client-state.test.mjs 的绑定参数个数。）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSpyD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { deriveUserEncryptionKey, encryptPayload, encryptForStorage } from '../src/server/lib/encryption.js';
import { MAX_TASK_PAYLOAD_BYTES } from '../src/server/index.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
// D1 的单个字符串 / 单行上限（https://developers.cloudflare.com/d1/platform/limits/）。
const D1_MAX_ROW_BYTES = 2_000_000;

const ENC_HEADERS = {
  'X-User-Id': USER,
  'X-Payload-Encrypted': 'true',
  'X-Encryption-Version': '1',
};

const utf8ByteLength = (value) => new TextEncoder().encode(value).length;

/** 落库密文的形态：`hex(iv):hex(tag):hex(密文)`。 */
const STORAGE_CIPHERTEXT_RE = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]*$/;

async function freshWorker() {
  const spy = createSpyD1();
  const worker = createSingleUserCloudflareWorker(() => ({
    db: createD1Adapter(spy.db),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} },
  }));
  const env = { DB: spy.db };
  await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
  // 排程要求这个用户已经登记过推送订阅（任务行不携带订阅了）。
  await seedPushSubscription(createD1Adapter(spy.db), USER, MASTER_KEY);
  spy.calls.length = 0;
  return { worker, env, calls: spy.calls };
}

async function encBody(obj) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return JSON.stringify(await encryptPayload(obj, userKey));
}

function schedule(worker, env, payload) {
  return (async () => worker.fetch(new Request('https://w.dev/schedule-message', {
    method: 'POST',
    headers: ENC_HEADERS,
    body: await encBody(payload),
  }), env))();
}

function update(worker, env, uuid, updates) {
  return (async () => worker.fetch(new Request(`https://w.dev/update-message?id=${uuid}`, {
    method: 'PUT',
    headers: ENC_HEADERS,
    body: await encBody(updates),
  }), env))();
}

/** 这批语句里绑给 encrypted_payload 的那个密文（没有就是没写过库）。 */
function storedCiphertexts(calls, sqlPattern) {
  return calls
    .filter((call) => sqlPattern.test(call.sql))
    .flatMap((call) => call.args.filter((arg) => typeof arg === 'string' && STORAGE_CIPHERTEXT_RE.test(arg)));
}

const basePayload = {
  contactName: 'Rei',
  messageType: 'fixed',
  firstSendTime: '2999-01-01T00:00:00.000Z',
  recurrenceType: 'none',
};

describe('任务正文大小上限', () => {
  test('POST /schedule-message 超限 → 400 + 字节数，INSERT 一条都没发出去', async () => {
    const { worker, env, calls } = await freshWorker();

    const res = await schedule(worker, env, {
      ...basePayload,
      userMessage: 'a'.repeat(MAX_TASK_PAYLOAD_BYTES + 1),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'TASK_PAYLOAD_TOO_LARGE');
    // 机读字段：下游拿 bytes / maxBytes 判断，不去解析 message 那句人话。
    assert.ok(body.error.details.bytes > MAX_TASK_PAYLOAD_BYTES);
    assert.equal(body.error.details.maxBytes, MAX_TASK_PAYLOAD_BYTES);

    assert.deepEqual(
      calls.filter((call) => /INSERT\s+INTO\s+scheduled_messages/i.test(call.sql)),
      [],
      '超限的任务不该有任何一条 INSERT 发给适配器'
    );
  });

  test('按 UTF-8 字节算，不是字符数：全中文正文字符数没到上限也要拦', async () => {
    const { worker, env, calls } = await freshWorker();

    // 每个汉字 3 字节：字符数只有上限的一半，字节数是上限的 1.5 倍。
    const text = '好'.repeat(Math.floor(MAX_TASK_PAYLOAD_BYTES / 2));
    assert.ok(text.length < MAX_TASK_PAYLOAD_BYTES, '字符数要落在上限以内，才测得到字节口径');
    assert.ok(utf8ByteLength(text) > MAX_TASK_PAYLOAD_BYTES);

    const res = await schedule(worker, env, { ...basePayload, userMessage: text });

    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'TASK_PAYLOAD_TOO_LARGE');
    assert.deepEqual(
      calls.filter((call) => /INSERT\s+INTO\s+scheduled_messages/i.test(call.sql)),
      []
    );
  });

  test('贴着上限的任务照常建成，绑给 encrypted_payload 的密文仍在 D1 的单行上限内', async () => {
    const { worker, env, calls } = await freshWorker();

    // 留出正文骨架（联系人、时间、各字段的 null）的余量，其余全塞进 userMessage。
    const res = await schedule(worker, env, {
      ...basePayload,
      userMessage: 'a'.repeat(MAX_TASK_PAYLOAD_BYTES - 2000),
    });
    assert.equal(res.status, 201);

    const stored = storedCiphertexts(calls, /INSERT\s+INTO\s+scheduled_messages/i);
    assert.equal(stored.length, 1);
    assert.ok(
      utf8ByteLength(stored[0]) <= D1_MAX_ROW_BYTES,
      `落库密文 ${utf8ByteLength(stored[0])} 字节，超过了 D1 的 ${D1_MAX_ROW_BYTES}`
    );
  });

  test('PUT /update-message 把存量任务撑爆 → 400，UPDATE 一条都没发出去', async () => {
    const { worker, env, calls } = await freshWorker();

    const created = await schedule(worker, env, { ...basePayload, userMessage: 'hi' });
    assert.equal(created.status, 201);
    const { uuid } = (await created.json()).data;
    calls.length = 0;

    const res = await update(worker, env, uuid, {
      userMessage: 'a'.repeat(MAX_TASK_PAYLOAD_BYTES + 1),
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'TASK_PAYLOAD_TOO_LARGE');
    assert.equal(body.error.details.maxBytes, MAX_TASK_PAYLOAD_BYTES);
    assert.deepEqual(
      calls.filter((call) => /UPDATE\s+scheduled_messages/i.test(call.sql)),
      [],
      '超限的更新不该有任何一条 UPDATE 发给适配器'
    );
  });

  // 上限本身是从 D1 的 2,000,000 字节反推的：明文加密后走 hex 会翻倍，还要给
  // 行里其他列、以及 run-tick 投递失败时补写的 lastError 留出余量。把这个换算
  // 钉在这里——上限被调大到「密文塞不下」的那一刻，这条会红。
  test('上限的换算：顶格正文加密后（含 fire 时补写的 lastError）仍装得进 D1 的一行', async () => {
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);

    const skeleton = { userMessage: '' };
    const padding = MAX_TASK_PAYLOAD_BYTES - utf8ByteLength(JSON.stringify(skeleton));
    const atLimit = { userMessage: 'a'.repeat(padding) };
    const serialized = JSON.stringify(atLimit);
    assert.equal(utf8ByteLength(serialized), MAX_TASK_PAYLOAD_BYTES);

    const ciphertext = await encryptForStorage(serialized, userKey);
    // hex 让字节数翻倍，加上 iv / tag 的 hex 与两个冒号。
    assert.equal(utf8ByteLength(ciphertext), MAX_TASK_PAYLOAD_BYTES * 2 + 66);
    assert.ok(utf8ByteLength(ciphertext) <= D1_MAX_ROW_BYTES);

    // run-tick 投递失败时会往正文里补一段 lastError 再加密回写（reason 可能很
    // 长）。补完还得装得下，否则卡在边界的任务是建得进去、fire 时才炸。
    const withLastError = JSON.stringify({
      ...atLimit,
      lastError: {
        at: new Date().toISOString(),
        occurrence: '2999-01-01T00:00:00.000Z',
        reason: 'x'.repeat(1024),
        errorCode: 'PUSH_SEND_FAILED',
        pushStatus: 410,
      },
    });
    const retried = await encryptForStorage(withLastError, userKey);
    assert.ok(
      utf8ByteLength(retried) <= D1_MAX_ROW_BYTES,
      `补写 lastError 之后 ${utf8ByteLength(retried)} 字节，顶穿了 D1 的 ${D1_MAX_ROW_BYTES}`
    );
    // 行里还有 uuid / user_id / 时间戳 / last_error 那几列要放。
    assert.ok(D1_MAX_ROW_BYTES - utf8ByteLength(retried) >= 4096);
  });
});
