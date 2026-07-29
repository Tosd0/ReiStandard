import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';

const MASTER_KEY = 'a'.repeat(64);

function makeWorker(extra = {}) {
  return createSingleUserCloudflareWorker((env) => ({
    db: createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} },
    ...extra,
  }));
}

describe('GET /capabilities', () => {
  test('返回 serverVersion + 静态 features 名单', async () => {
    const d1 = createTestD1();
    const worker = makeWorker();
    const res = await worker.fetch(new Request('https://w.dev/capabilities', { method: 'GET' }), { DB: d1 });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(typeof body.serverVersion, 'string');
    assert.ok(body.serverVersion.length > 0);
    for (const f of [
      'client-state',
      'client-state-chunking',
      'client-state-partial-failure',
      'agentic-hooks',
      'agentic-scratch',
      'agentic-fire-tools',
      'vapid-public-key',
    ]) {
      assert.ok(body.features.includes(f), `features 应包含 ${f}`);
    }
  });

  test('serverToken 配置后：无 X-Client-Token → 401，带上 → 200', async () => {
    const d1 = createTestD1();
    const worker = makeWorker({ serverToken: 's3cret' });
    const env = { DB: d1 };
    const no = await worker.fetch(new Request('https://w.dev/capabilities', { method: 'GET' }), env);
    assert.equal(no.status, 401);
    const ok = await worker.fetch(new Request('https://w.dev/capabilities', {
      method: 'GET', headers: { 'X-Client-Token': 's3cret' },
    }), env);
    assert.equal(ok.status, 200);
  });
});
