/**
 * SDK 侧的用户级 LLM 凭据三方法（putLlmCredentials / listLlmCredentials /
 * deleteLlmCredentials）。请求形状、加密往返、入参护栏。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReiClient } from '../src/index.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const USER_KEY_HEX = 'ab'.repeat(32);
const CRED = {
  credId: 'char:c1/chat',
  value: { apiUrl: 'https://cred.example.com/v1/chat/completions', apiKey: 'sk-secret', primaryModel: 'model-x' },
};

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

test('putLlmCredentials() PUTs 加密后的凭据到 /llm-credentials', async () => {
  const client = await makeInitializedClient({ serverToken: 's3cret' });
  const { captured, result } = await capture(
    () => client.putLlmCredentials([CRED]),
    { success: true, data: { upserted: 1 } }
  );

  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://w.dev/llm-credentials');
  assert.equal(captured[0].method, 'PUT');
  assert.equal(captured[0].headers['X-User-Id'], USER);
  assert.equal(captured[0].headers['X-Payload-Encrypted'], 'true');
  assert.equal(captured[0].headers['X-Encryption-Version'], '1');
  assert.equal(captured[0].headers['X-Client-Token'], 's3cret');

  // 凭据在网络上是密文：apiKey 不能出现在请求体里。
  assert.ok(!captured[0].body.includes('sk-secret'));
  const roundtripped = await client._decrypt(JSON.parse(captured[0].body));
  assert.deepEqual(roundtripped, { credentials: [CRED] });
  assert.equal(result.data.upserted, 1);
});

test('putLlmCredentials() 空数组 / 非数组直接抛，不发请求', async () => {
  const client = await makeInitializedClient();
  await assert.rejects(() => client.putLlmCredentials([]), TypeError);
  await assert.rejects(() => client.putLlmCredentials('nope'), TypeError);
});

test('listLlmCredentials() GET，不带加密头', async () => {
  const client = await makeInitializedClient();
  const { captured, result } = await capture(
    () => client.listLlmCredentials(),
    { success: true, data: { credentials: [{ credId: CRED.credId, updatedAt: '2026-01-01T00:00:00.000Z' }] } }
  );
  assert.equal(captured[0].url, 'https://w.dev/llm-credentials');
  assert.equal(captured[0].method, 'GET');
  assert.equal(captured[0].headers['X-User-Id'], USER);
  assert.deepEqual(result.data.credentials.map((c) => c.credId), [CRED.credId]);
});

test('deleteLlmCredentials() 加密 body：credIds 与 all 两种形态', async () => {
  const client = await makeInitializedClient();

  const byIds = await capture(
    () => client.deleteLlmCredentials({ credIds: [CRED.credId] }),
    { success: true, data: { deleted: 1 } }
  );
  assert.equal(byIds.captured[0].method, 'DELETE');
  assert.equal(byIds.captured[0].headers['X-Payload-Encrypted'], 'true');
  assert.deepEqual(
    await client._decrypt(JSON.parse(byIds.captured[0].body)),
    { credIds: [CRED.credId] }
  );

  const all = await capture(
    () => client.deleteLlmCredentials({ all: true }),
    { success: true, data: { deleted: 3 } }
  );
  assert.deepEqual(await client._decrypt(JSON.parse(all.captured[0].body)), { all: true });

  await assert.rejects(() => client.deleteLlmCredentials({}), TypeError);
  await assert.rejects(() => client.deleteLlmCredentials({ credIds: [] }), TypeError);
});

test('deleteLlmCredentials() all 与 credIds 同时传：点名歧义直接抛，不发请求', async () => {
  const client = await makeInitializedClient();

  // 回归守卫：以前这种歧义输入会被静默按 { all: true } 全删发出去。
  const { captured } = await capture(async () => {
    await assert.rejects(
      () => client.deleteLlmCredentials({ all: true, credIds: [CRED.credId] }),
      { name: 'TypeError', message: /all 与 credIds 不能同时出现/ }
    );
    // credIds 只要出现就算同时传（空数组也是），跟服务端 400 守卫同一条件。
    await assert.rejects(
      () => client.deleteLlmCredentials({ all: true, credIds: [] }),
      { name: 'TypeError', message: /all 与 credIds 不能同时出现/ }
    );
  }, { success: true, data: { deleted: 999 } });

  assert.equal(captured.length, 0);
});

test('scheduleMessage() 透传 credRefs（不加工不过滤）', async () => {
  const client = await makeInitializedClient();
  const payload = {
    contactName: 'Rei',
    messageType: 'prompted',
    completePrompt: 'p',
    firstSendTime: '2099-01-01T00:00:00.000Z',
    credRefs: { chat: CRED.credId },
  };
  const { captured } = await capture(
    () => client.scheduleMessage(payload),
    { success: true, data: { uuid: 'u' } }
  );
  const roundtripped = await client._decrypt(JSON.parse(captured[0].body));
  assert.deepEqual(roundtripped.credRefs, { chat: CRED.credId });
});
