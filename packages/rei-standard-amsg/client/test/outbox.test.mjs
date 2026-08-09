/**
 * SDK 侧的消息收件箱两方法（getOutbox / ackOutbox）。请求形状、响应解密、
 * 翻页参数缺省、入参护栏。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReiClient } from '../src/index.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const USER_KEY_HEX = 'ab'.repeat(32);

async function makeInitializedClient(config = {}) {
  const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER, ...config });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ success: true, data: { userKey: USER_KEY_HEX } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
  try {
    await client.init();
  } finally {
    globalThis.fetch = original;
  }
  return client;
}

/** 换掉 fetch，记下这次请求，返回给定的 JSON。 */
async function capture(fn, responseBody) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    return new Response(JSON.stringify(responseBody), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  let result;
  try {
    result = await fn();
  } finally {
    globalThis.fetch = original;
  }
  return { captured, result };
}

/** 服务端返回的一页 outbox（`push` 就是推送信封本身）。 */
const PAGE = {
  entries: [
    {
      id: 7,
      messageId: 'msg-7',
      taskUuid: 'task-1',
      sessionId: 'sess-1',
      messageIndex: 0,
      totalMessages: 2,
      createdAt: 1700000000000,
      deliveredAt: null,
      push: { messageKind: 'content', messageId: 'msg-7', sessionId: 'sess-1', message: '晚安' },
    },
  ],
  cursor: 7,
  hasMore: false,
};

test('getOutbox() 解开加密响应信封，push 原样拿到', async () => {
  const client = await makeInitializedClient({ serverToken: 's3cret' });
  const encrypted = await client._encrypt(JSON.stringify(PAGE));

  const { captured, result } = await capture(
    () => client.getOutbox(),
    { success: true, encrypted: true, version: 1, data: encrypted }
  );

  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://w.dev/outbox');
  assert.equal(captured[0].method, 'GET');
  assert.equal(captured[0].headers['X-User-Id'], USER);
  assert.equal(captured[0].headers['X-Response-Encrypted'], 'true');
  assert.equal(captured[0].headers['X-Encryption-Version'], '1');
  assert.equal(captured[0].headers['X-Client-Token'], 's3cret');

  assert.equal(result.success, true);
  assert.deepEqual(result.data, PAGE);
  assert.deepEqual(result.data.entries[0].push, PAGE.entries[0].push);
});

test('getOutbox() 不传参数时 URL 上没有 query', async () => {
  const client = await makeInitializedClient();
  const encrypted = await client._encrypt(JSON.stringify(PAGE));

  const { captured } = await capture(
    () => client.getOutbox({}),
    { success: true, encrypted: true, version: 1, data: encrypted }
  );
  assert.equal(captured[0].url, 'https://w.dev/outbox');
  assert.ok(!captured[0].url.includes('?'));
});

test('getOutbox() 带上 since / limit 翻页', async () => {
  const client = await makeInitializedClient();
  const encrypted = await client._encrypt(JSON.stringify(PAGE));

  const { captured } = await capture(
    () => client.getOutbox({ since: 7, limit: 25 }),
    { success: true, encrypted: true, version: 1, data: encrypted }
  );
  assert.equal(captured[0].url, 'https://w.dev/outbox?since=7&limit=25');
});

test('getOutbox() since=0 也要带上（第一页的合法游标）', async () => {
  const client = await makeInitializedClient();
  const encrypted = await client._encrypt(JSON.stringify(PAGE));

  const { captured } = await capture(
    () => client.getOutbox({ since: 0 }),
    { success: true, encrypted: true, version: 1, data: encrypted }
  );
  assert.equal(captured[0].url, 'https://w.dev/outbox?since=0');
});

test('getOutbox() 非成功响应原样透出', async () => {
  const client = await makeInitializedClient();
  const failure = {
    success: false,
    error: { code: 'OUTBOX_NOT_SUPPORTED', message: '当前数据库适配器不支持 message_outbox' },
  };
  const { result } = await capture(() => client.getOutbox(), failure);
  assert.deepEqual(result, failure);
});

test('getOutbox() 入参不合法直接抛 TypeError，不发请求', async () => {
  const client = await makeInitializedClient();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not reach the network'); };
  try {
    const badSince = /since must be a non-negative integer/;
    const badLimit = /limit must be an integer between 1 and 100/;
    await assert.rejects(() => client.getOutbox({ since: -1 }), badSince);
    await assert.rejects(() => client.getOutbox({ since: 1.5 }), badSince);
    await assert.rejects(() => client.getOutbox({ since: '7' }), badSince);
    await assert.rejects(() => client.getOutbox({ limit: 0 }), badLimit);
    await assert.rejects(() => client.getOutbox({ limit: 101 }), badLimit);
    await assert.rejects(() => client.getOutbox({ limit: 10.5 }), badLimit);
  } finally {
    globalThis.fetch = original;
  }
});

test('ackOutbox() POST 加密后的 messageIds 到 /outbox/ack', async () => {
  const client = await makeInitializedClient({ serverToken: 's3cret' });
  const messageIds = ['msg-7', 'msg-8'];

  const { captured, result } = await capture(
    () => client.ackOutbox(messageIds),
    { success: true, data: { acked: 2 } }
  );

  assert.equal(captured[0].url, 'https://w.dev/outbox/ack');
  assert.equal(captured[0].method, 'POST');
  assert.equal(captured[0].headers['X-User-Id'], USER);
  assert.equal(captured[0].headers['X-Payload-Encrypted'], 'true');
  assert.equal(captured[0].headers['X-Encryption-Version'], '1');
  assert.equal(captured[0].headers['X-Client-Token'], 's3cret');

  assert.ok(!captured[0].body.includes('msg-7'), '请求体应该是密文');
  assert.deepEqual(await client._decrypt(JSON.parse(captured[0].body)), { messageIds });
  assert.deepEqual(result, { success: true, data: { acked: 2 } });
});

test('ackOutbox() 入参不合法直接抛 TypeError，不发请求', async () => {
  const client = await makeInitializedClient();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not reach the network'); };
  try {
    const notArray = /messageIds must be a non-empty array/;
    const notString = /every messageId must be a non-empty string/;
    await assert.rejects(() => client.ackOutbox(), notArray);
    await assert.rejects(() => client.ackOutbox([]), notArray);
    await assert.rejects(() => client.ackOutbox('msg-7'), notArray);
    await assert.rejects(() => client.ackOutbox(['msg-7', '']), notString);
    await assert.rejects(() => client.ackOutbox(['msg-7', 42]), notString);
  } finally {
    globalThis.fetch = original;
  }
});

test('ackOutbox() 超过 200 条被本地拦下，不发请求', async () => {
  const client = await makeInitializedClient();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('must not reach the network'); };
  try {
    const tooMany = Array.from({ length: 201 }, (_, i) => `msg-${i}`);
    await assert.rejects(() => client.ackOutbox(tooMany), /at most 200 ids per call/);
    // 正好 200 条是允许的（不能连边界一起拦掉）。
    const atLimit = Array.from({ length: 200 }, (_, i) => `msg-${i}`);
    globalThis.fetch = async () => new Response(
      JSON.stringify({ success: true, data: { acked: 200 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
    const result = await client.ackOutbox(atLimit);
    assert.equal(result.data.acked, 200);
  } finally {
    globalThis.fetch = original;
  }
});

test('ackOutbox() 未 init() 时抛 Not initialised', async () => {
  const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
  await assert.rejects(() => client.ackOutbox(['msg-7']), /Not initialised/);
});
