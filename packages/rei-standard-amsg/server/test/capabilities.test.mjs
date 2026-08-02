import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { SERVER_FEATURES } from '../src/server/handlers/capabilities.js';

const MASTER_KEY = 'a'.repeat(64);

// feature 名是跟客户端的线上契约，这份名单是它的钉子：改名、删条目、或者往
// SERVER_FEATURES 加了新的却没同步过来，下面的断言都会当场红。
const EXPECTED_FEATURES = [
  'client-state',
  'client-state-chunking',
  'client-state-partial-failure',
  'agentic-hooks',
  'agentic-scratch',
  'agentic-write-state',
  'agentic-fire-tools',
  'agentic-schedule-task',
  'vapid-public-key',
  'tick-stale-guard',
  'recurring-skip-occurrence',
  'occurrence-scoped-push-ids',
  'after-send-hook',
  'update-message-credentials',
  'hook-state-accessors',
  'after-send-scratch',
  'fire-task-identity',
  'push-task-identity',
  'push-envelope-reserved-bytes',
  'schedule-task-duplicate-row',
  'recurring-stale-skip-hook',
  'task-timezone',
  'user-push-subscription',
];

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
    // 逐条点名：缺了哪个，失败信息里直接就是那个名字
    for (const f of EXPECTED_FEATURES) {
      assert.ok(body.features.includes(f), `features 应包含 ${f}`);
    }
    // 名单要和源头逐字对上：以后往 SERVER_FEATURES 加了 feature 却没同步这份
    // 名单，这行当场红
    assert.deepEqual([...SERVER_FEATURES], EXPECTED_FEATURES);
    // 端点把常量原样吐出去，不过滤也不重排
    assert.deepEqual([...body.features], [...SERVER_FEATURES]);
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
