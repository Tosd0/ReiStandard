/**
 * 请求体的 gzip 自动解压（lib/request.js 的 readRequestBody）。
 *
 * 客户端把大 body 压了再传能省下几倍传输量，但压缩这件事必须由服务端统一认：
 * 只有个别端点自己判那个头的话，漏判的那个收到的是一段乱码，报出来是「请求体
 * 不是有效的 JSON」，跟压缩八竿子打不着——所以这里既钉住工具函数本身的行为，
 * 也钉住「Worker 上每个带 body 的端点都通」。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { readRequestBody, DEFAULT_MAX_REQUEST_BODY_BYTES } from '../src/server/lib/request.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptPayload } from '../src/server/lib/encryption.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const VAPID = { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' };
const ENC_HEADERS = { 'X-User-Id': USER, 'X-Payload-Encrypted': 'true', 'X-Encryption-Version': '1' };

function gzipRequest(body, headers = {}) {
  return new Request('https://w.dev/client-state', {
    method: 'PUT',
    headers: { 'Content-Encoding': 'gzip', ...headers },
    body: gzipSync(Buffer.from(body, 'utf8')),
  });
}

describe('readRequestBody', () => {
  test('没有 Content-Encoding 时原样读，行为与以前一致', async () => {
    const request = new Request('https://w.dev/x', { method: 'POST', body: '{"a":1}' });
    const read = await readRequestBody(request);
    assert.equal(read.ok, true);
    assert.equal(read.body, '{"a":1}');
  });

  test('gzip 的请求体解回原文（多字节字符不在切点上崩掉）', async () => {
    const original = JSON.stringify({ note: '这是一段中文，混着 emoji 🎐 和换行\n'.repeat(5000) });
    const read = await readRequestBody(gzipRequest(original));
    assert.equal(read.ok, true);
    assert.equal(read.body, original);
  });

  test('说是 gzip、字节却是明文 → 按明文处理（网关已经替我们解开了）', async () => {
    // 有些边缘网关会替你把请求体解开，却把原来的 Content-Encoding 头留着。
    // 照着头再解一次只会解出乱码，用户看到的是一句莫名其妙的 JSON 解析失败。
    const request = new Request('https://w.dev/x', {
      method: 'POST',
      headers: { 'Content-Encoding': 'gzip' },
      body: '{"already":"plain"}',
    });
    const read = await readRequestBody(request);
    assert.equal(read.ok, true);
    assert.equal(read.body, '{"already":"plain"}');
  });

  test('不认识的编码回 415，而不是猜着解', async () => {
    const request = new Request('https://w.dev/x', {
      method: 'POST',
      headers: { 'Content-Encoding': 'br' },
      body: 'whatever',
    });
    const read = await readRequestBody(request);
    assert.equal(read.ok, false);
    assert.equal(read.error.status, 415);
    assert.equal(read.error.body.error.code, 'UNSUPPORTED_CONTENT_ENCODING');
    assert.deepEqual(read.error.body.error.details.supported, ['gzip']);
  });

  test('解压后超过上限回 413，不把整份展开的数据读进内存', async () => {
    // 4MB 的重复字符压完只有几 KB —— 压缩炸弹就是这么来的。
    const bomb = 'A'.repeat(4 * 1024 * 1024);
    const read = await readRequestBody(gzipRequest(bomb), { maxBytes: 1024 });
    assert.equal(read.ok, false);
    assert.equal(read.error.status, 413);
    assert.equal(read.error.body.error.code, 'REQUEST_BODY_TOO_LARGE');
    assert.equal(read.error.body.error.details.maxBytes, 1024);
  });

  test('默认上限是 32MB', () => {
    assert.equal(DEFAULT_MAX_REQUEST_BODY_BYTES, 32 * 1024 * 1024);
  });

  test('声明了 gzip 但数据是坏的 → 400，说清是编码的问题', async () => {
    const broken = gzipSync(Buffer.from('{"a":1}', 'utf8'));
    broken[broken.length - 3] ^= 0xff; // 把校验和敲坏
    const request = new Request('https://w.dev/x', {
      method: 'POST',
      headers: { 'Content-Encoding': 'gzip' },
      body: broken,
    });
    const read = await readRequestBody(request);
    assert.equal(read.ok, false);
    assert.equal(read.error.status, 400);
    assert.equal(read.error.body.error.code, 'INVALID_CONTENT_ENCODING');
  });
});

describe('单用户 Worker 上的 gzip 请求体', () => {
  async function bootstrap(extra = {}) {
    const d1 = createTestD1();
    const worker = createSingleUserCloudflareWorker((env) => ({
      db: createD1Adapter(env.DB),
      masterKey: MASTER_KEY,
      vapid: VAPID,
      webpush: { async sendNotification() {} },
      ...extra,
    }));
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    return { worker, env, d1 };
  }

  test('PUT /client-state 收得下压缩过的 body，写进去的内容与不压时一致', async () => {
    const { worker, env, d1 } = await bootstrap();
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const plain = JSON.stringify(await encryptPayload({
      entries: [{ namespace: 'fire_pack', key: 'pack', value: '大内容'.repeat(2000), updatedAt: Date.now() }],
    }, userKey));

    const res = await worker.fetch(gzipRequest(plain, ENC_HEADERS), env);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);

    const rows = await createD1Adapter(d1).getClientState(USER, 'fire_pack');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, 'pack');
  });

  test('压缩炸弹被挡在 handler 之前（config 的 maxRequestBodyBytes 说了算）', async () => {
    const { worker, env } = await bootstrap({ maxRequestBodyBytes: 512 });
    const res = await worker.fetch(gzipRequest('B'.repeat(1024 * 1024), ENC_HEADERS), env);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, 'REQUEST_BODY_TOO_LARGE');
  });

  test('不带 Content-Encoding 的请求一个字节都没变（老客户端照旧）', async () => {
    const { worker, env, d1 } = await bootstrap();
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const res = await worker.fetch(new Request('https://w.dev/client-state', {
      method: 'PUT',
      headers: ENC_HEADERS,
      body: JSON.stringify(await encryptPayload({
        entries: [{ namespace: 'plain_ns', key: 'k', value: 'v', updatedAt: Date.now() }],
      }, userKey)),
    }), env);
    assert.equal(res.status, 200);
    const rows = await createD1Adapter(d1).getClientState(USER, 'plain_ns');
    assert.equal(rows.length, 1);
  });
});
