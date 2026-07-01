import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReiClient } from '../src/index.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';

function stubFetch(captured) {
  return async (url, init) => {
    captured.push({ url: String(url), headers: (init && init.headers) || {} });
    return new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
}

test('serverToken adds X-Client-Token to amsg-server requests', async () => {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch(captured);
  try {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER, serverToken: 's3cret' });
    await client.cancelMessage('some-uuid');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].headers['X-Client-Token'], 's3cret');
});

test('no serverToken → no X-Client-Token on server requests', async () => {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch(captured);
  try {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
    await client.cancelMessage('some-uuid');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(captured[0].headers['X-Client-Token'], undefined);
});
