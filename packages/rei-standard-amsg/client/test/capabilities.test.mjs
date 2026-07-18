import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReiClient } from '../src/index.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';

async function withFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('getCapabilities() GET /capabilities，带 X-Client-Token，返回 { serverVersion, features }', async () => {
  const captured = [];
  await withFetch(async (url, init) => {
    captured.push({ url: String(url), method: init && init.method, headers: (init && init.headers) || {} });
    return new Response(JSON.stringify({
      success: true, serverVersion: '2.7.0', features: ['client-state', 'client-state-chunking'],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, async () => {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER, serverToken: 's3cret' });
    const caps = await client.getCapabilities();
    assert.deepEqual(caps, { serverVersion: '2.7.0', features: ['client-state', 'client-state-chunking'] });
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://w.dev/capabilities');
  assert.equal(captured[0].method, 'GET');
  assert.equal(captured[0].headers['X-Client-Token'], 's3cret');
});

test('老 worker 404（JSON 或非 JSON 页面）→ null 不抛错', async () => {
  await withFetch(async () => new Response(
    JSON.stringify({ success: false, error: { code: 'NOT_FOUND', message: 'Unknown route' } }),
    { status: 404, headers: { 'Content-Type': 'application/json' } }
  ), async () => {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
    assert.equal(await client.getCapabilities(), null);
  });
  await withFetch(async () => new Response('<html>Not Found</html>', { status: 404 }), async () => {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
    assert.equal(await client.getCapabilities(), null);
  });
});

test('非 404 但响应不是 JSON（代理错误页）→ null', async () => {
  await withFetch(async () => new Response('<html>Bad Gateway</html>', { status: 200 }), async () => {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
    assert.equal(await client.getCapabilities(), null);
  });
});

test('success:false（如 token 错 401）→ 抛错带服务端 message', async () => {
  await withFetch(async () => new Response(
    JSON.stringify({ success: false, error: { code: 'UNAUTHORIZED', message: '缺少或错误的 X-Client-Token' } }),
    { status: 401, headers: { 'Content-Type': 'application/json' } }
  ), async () => {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER, serverToken: 'wrong' });
    await assert.rejects(() => client.getCapabilities(), /X-Client-Token/);
  });
});
