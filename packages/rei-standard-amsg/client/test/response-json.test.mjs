/**
 * 所有走 amsg-server 的方法共用一个 JSON 读取：HTML 错误页（代理 / Cloudflare）
 * 抛出带 status 的 Error，而不是裸 SyntaxError；非 2xx 的 JSON 信封照旧返回。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReiClient } from '../src/index.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const USER_KEY_HEX = 'ab'.repeat(32);

async function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const htmlPage = (status) => async () => new Response('<html><body>Bad Gateway</body></html>', {
  status, headers: { 'Content-Type': 'text/html' }
});

async function makeInitializedClient() {
  const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
  await withFetch(async () => Response.json({ success: true, data: { userKey: USER_KEY_HEX } }), () => client.init());
  return client;
}

test('非 JSON 错误页 → 抛出的错误带 status 和 code，不是 SyntaxError', async () => {
  const client = await makeInitializedClient();
  const calls = [
    () => client.init(),
    () => client.getVapidPublicKey(),
    () => client.scheduleMessage({ messageType: 'instant' }),
    () => client.cancelMessage('u'),
    () => client.listMessages(),
    () => client.getMessage('u'),
    () => client.putClientState([{ namespace: 'n', key: 'k', value: 'v', updatedAt: 1 }]),
    () => client.getClientState('n'),
    () => client.clearClientState(),
    () => client.getPushSubscription(),
    () => client.deletePushSubscription(),
    () => client.listLlmCredentials(),
    () => client.getOutbox(),
    () => client.ackOutbox(['m']),
    () => client.sendInstant({ message: 'hi' }),
  ];
  for (const call of calls) {
    await withFetch(htmlPage(502), async () => {
      await assert.rejects(call, (err) => {
        assert.ok(!(err instanceof SyntaxError), `${call} leaked a SyntaxError`);
        assert.equal(err.status, 502);
        assert.equal(err.code, 'NON_JSON_RESPONSE');
        assert.match(err.message, /502/);
        return true;
      });
    });
  }
});

test('2xx 但 body 不是 JSON → 同样带 status', async () => {
  const client = await makeInitializedClient();
  await withFetch(htmlPage(200), async () => {
    await assert.rejects(() => client.listLlmCredentials(), (err) => err.status === 200 && err.code === 'NON_JSON_RESPONSE');
  });
});

test('非 2xx 的 JSON 信封照旧原样返回，宿主能读 error.code', async () => {
  const client = await makeInitializedClient();
  const envelope = { success: false, error: { code: 'TASK_ALREADY_COMPLETED', message: 'done' } };
  await withFetch(async () => Response.json(envelope, { status: 409 }), async () => {
    assert.deepEqual(await client.getMessage('u'), envelope);
    assert.deepEqual(await client.cancelMessage('u'), envelope);
  });
});

test('init() 的 success:false 错误带 status 和服务端 code', async () => {
  const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
  await withFetch(
    async () => Response.json({ success: false, error: { code: 'UNAUTHORIZED', message: 'bad token' } }, { status: 401 }),
    () => assert.rejects(() => client.init(), (err) => err.status === 401 && err.code === 'UNAUTHORIZED' && err.message === 'bad token')
  );
});

test('getCapabilities() 的 404 / 非 JSON → null 这条特殊分支不变', async () => {
  const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
  await withFetch(htmlPage(404), async () => assert.equal(await client.getCapabilities(), null));
  await withFetch(htmlPage(502), async () => assert.equal(await client.getCapabilities(), null));
});
