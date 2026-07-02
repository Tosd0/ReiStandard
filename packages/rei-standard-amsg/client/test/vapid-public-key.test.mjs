import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReiClient } from '../src/index.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';

test('getVapidPublicKey() GETs /vapid-public-key with X-Client-Token and returns the key string', async () => {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), method: init && init.method, headers: (init && init.headers) || {} });
    return new Response(JSON.stringify({ success: true, publicKey: 'BPUB123' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  let key;
  try {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER, serverToken: 's3cret' });
    key = await client.getVapidPublicKey();
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, 'https://w.dev/vapid-public-key');
  assert.equal(captured[0].method, 'GET');
  assert.equal(captured[0].headers['X-Client-Token'], 's3cret');
  assert.equal(key, 'BPUB123');
});

test('getVapidPublicKey() without serverToken sends no X-Client-Token', async () => {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ headers: (init && init.headers) || {} });
    return new Response(JSON.stringify({ success: true, publicKey: 'BPUB123' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
    await client.getVapidPublicKey();
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(captured[0].headers['X-Client-Token'], undefined);
});

test('getVapidPublicKey() throws on a non-success response', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ success: false, error: { code: 'VAPID_NOT_CONFIGURED', message: 'VAPID 未配置' } }),
    { status: 503, headers: { 'Content-Type': 'application/json' } }
  );
  try {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
    await assert.rejects(() => client.getVapidPublicKey(), /VAPID 未配置/);
  } finally {
    globalThis.fetch = original;
  }
});
