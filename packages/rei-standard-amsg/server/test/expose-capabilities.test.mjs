/**
 * 三件「库里做得到、但没露出来」的能力：
 *   - 500 响应体带真实原因（error.cause），fetch / cron 两条路都有出口
 *   - schema 自查与补齐（getSchemaVersion / ensureSchema）
 *   - 按 uuid 只跑一条任务（worker.runTask，以及不跑时的各种回报）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { getSchemaVersion, ensureSchema, SCHEMA_VERSION } from '../src/server/lib/schema-version.js';
import { SQLITE_REQUIRED_SCHEMA } from '../src/server/adapters/schema.sqlite.js';
import { runTask } from '../src/server/lib/run-tick.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const VAPID = { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' };

/** console.error / console.warn 静音跑一段（库照常记日志，测试输出别被刷屏）。 */
async function quiet(fn) {
  const origError = console.error;
  const origWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }
}

async function freshAdapter() {
  const raw = createTestD1();
  const adapter = createD1Adapter(raw);
  await adapter.initSchema();
  return { raw, adapter };
}

async function seedTask(adapter, { uuid, nextSendAt, recurrenceType = 'none' }) {
  await seedPushSubscription(adapter, USER, MASTER_KEY);
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const enc = await encryptForStorage(JSON.stringify({
    contactName: 'Rei', messageType: 'fixed', userMessage: 'hi', recurrenceType
  }), userKey);
  await adapter.createTask({
    user_id: USER, uuid, encrypted_payload: enc, next_send_at: nextSendAt, message_type: 'fixed'
  });
}

// ─── A. 错误响应体带真实原因 ────────────────────────────────────────────────
//
// 以前 500 只有一句写死的「服务器内部错误」，真因只进 console.error。调用方
// 为了拿到它只能全局 patch console.error 去偷听库的日志。

describe('error cause', () => {
  test('处理器抛错：500 的 error.cause 带类型和真实消息', async () => {
    const worker = createSingleUserCloudflareWorker(() => ({
      db: { async listTasks() { throw new Error('D1_ERROR: no such table: message_outbox'); } },
      masterKey: MASTER_KEY,
      vapid: VAPID,
      webpush: { async sendNotification() {} }
    }));

    const res = await quiet(() => worker.fetch(new Request('https://w.dev/messages?status=all', {
      method: 'GET', headers: { 'X-User-Id': USER }
    }), {}));

    assert.equal(res.status, 500);
    const body = await res.json();
    // 老字段一个不动。
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, '服务器内部错误');
    // 新字段：真因。
    assert.equal(body.error.cause.stage, 'request');
    assert.equal(body.error.cause.name, 'Error');
    assert.match(body.error.cause.message, /no such table: message_outbox/);
  });

  test('buildConfig 抛错：cause 的 stage 是 config', async () => {
    const worker = createSingleUserCloudflareWorker(() => {
      const error = new Error('env.DB binding 缺失');
      error.name = 'ConfigError';
      throw error;
    });

    const res = await quiet(() => worker.fetch(new Request('https://w.dev/messages', { method: 'GET' }), {}));

    assert.equal(res.status, 500);
    const { error } = await res.json();
    assert.equal(error.cause.stage, 'config');
    assert.equal(error.cause.name, 'ConfigError');
    assert.match(error.cause.message, /binding 缺失/);
  });

  test('cause 里长得像凭据的串被遮掉', async () => {
    const worker = createSingleUserCloudflareWorker(() => ({
      db: { async listTasks() { throw new Error('upstream rejected: Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345'); } },
      masterKey: MASTER_KEY,
      vapid: VAPID,
      webpush: { async sendNotification() {} }
    }));

    const res = await quiet(() => worker.fetch(new Request('https://w.dev/messages?status=all', {
      method: 'GET', headers: { 'X-User-Id': USER }
    }), {}));

    const { error } = await res.json();
    assert.match(error.cause.message, /upstream rejected/);
    assert.doesNotMatch(error.cause.message, /abcdefghijklmnopqrstuvwxyz/);
  });

  test('onError：fetch 出错时宿主收得到（不用去劫 console）', async () => {
    const seen = [];
    const worker = createSingleUserCloudflareWorker(
      () => ({
        db: { async listTasks() { throw new Error('db boom'); } },
        masterKey: MASTER_KEY,
        vapid: VAPID,
        webpush: { async sendNotification() {} }
      }),
      { onError: (info) => { seen.push(info); } }
    );

    await quiet(() => worker.fetch(new Request('https://w.dev/messages?status=all', {
      method: 'GET', headers: { 'X-User-Id': USER }
    }), {}));

    assert.equal(seen.length, 1);
    assert.equal(seen[0].stage, 'request');
    assert.equal(seen[0].path, '/messages');
    assert.match(seen[0].cause.message, /db boom/);
    assert.equal(seen[0].error instanceof Error, true);
  });

  test('cron 那一跳挂掉：onError 收得到，scheduled() 也把原因返回出来', async () => {
    const seen = [];
    const worker = createSingleUserCloudflareWorker(
      () => ({
        db: { async getPendingTasks() { throw new Error('D1 storage operation exceeded timeout'); } },
        masterKey: MASTER_KEY,
        vapid: VAPID,
        webpush: { async sendNotification() {} }
      }),
      { onError: (info) => { seen.push(info); } }
    );

    const result = await quiet(() => worker.scheduled({}, { DB: null }));

    assert.equal(result.ok, false);
    assert.equal(result.cause.stage, 'tick');
    assert.match(result.cause.message, /exceeded timeout/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].stage, 'tick');
  });

  test('cron 的配置没配齐也报出来，不是无声跳过', async () => {
    const seen = [];
    const worker = createSingleUserCloudflareWorker(
      () => ({ db: {}, masterKey: MASTER_KEY, vapid: {}, webpush: null }),
      { onError: (info) => { seen.push(info); } }
    );

    const result = await quiet(() => worker.scheduled({}, { DB: null }));

    assert.equal(result.ok, false);
    assert.equal(result.cause.name, 'VapidNotConfigured');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].error, null);
  });

  test('onError 自己抛错不影响响应', async () => {
    const worker = createSingleUserCloudflareWorker(
      () => ({
        db: { async listTasks() { throw new Error('db boom'); } },
        masterKey: MASTER_KEY,
        vapid: VAPID,
        webpush: { async sendNotification() {} }
      }),
      { onError: () => { throw new Error('hook 自己炸了'); } }
    );

    const res = await quiet(() => worker.fetch(new Request('https://w.dev/messages?status=all', {
      method: 'GET', headers: { 'X-User-Id': USER }
    }), {}));

    assert.equal(res.status, 500);
    assert.equal((await res.json()).error.code, 'INTERNAL_ERROR');
  });

  test('一切正常时 scheduled() 回 ok，summary 就是那一跳的结果', async () => {
    const { raw, adapter } = await freshAdapter();
    await seedTask(adapter, { uuid: 'ok-tick', nextSendAt: new Date(Date.now() - 30_000).toISOString() });
    const worker = createSingleUserCloudflareWorker(() => ({
      db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: { async sendNotification() {} }
    }));

    const result = await worker.scheduled({}, { DB: raw });
    assert.equal(result.ok, true);
    assert.equal(result.summary.totalTasks, 1);
    assert.equal(result.summary.successCount, 1);
  });
});

// ─── B. schema 自查 / 补齐 ─────────────────────────────────────────────────
//
// 建表是 CREATE TABLE IF NOT EXISTS，升级后老部署的表不会自己跟上；那之后
// cron 每分钟静默挂在缺的那一列上，前端界面一切正常。

describe('schema self-check', () => {
  test('空库：ok 为 false，缺哪几张表逐条列出来', async () => {
    const adapter = createD1Adapter(createTestD1());
    const result = await getSchemaVersion(adapter);

    assert.equal(result.ok, false);
    assert.equal(result.current, null);
    assert.equal(result.required, SCHEMA_VERSION);
    assert.deepEqual(
      result.missing.filter((item) => item.startsWith('table:')).sort(),
      Object.keys(SQLITE_REQUIRED_SCHEMA.tables).map((name) => `table:${name}`).sort()
    );
  });

  test('ensureSchema 把空库补齐；再调一次就不动手了', async () => {
    const adapter = createD1Adapter(createTestD1());

    const first = await ensureSchema(adapter);
    assert.equal(first.ok, true);
    assert.equal(first.migrated, true);
    assert.equal(first.current, SCHEMA_VERSION);
    assert.deepEqual(first.missing, []);
    assert.ok(first.schema, '真的跑了一次 initSchema，返回它的结果');

    const second = await ensureSchema(adapter);
    assert.equal(second.ok, true);
    assert.equal(second.migrated, false);
    assert.equal(second.schema, null);
  });

  // 这一条是本能力的正题：老部署的表停在旧形状上（少一列），自查要认出来，
  // ensureSchema 要补回去。
  test('老部署少一列：自查点名，ensureSchema 补回来', async () => {
    const { raw, adapter } = await freshAdapter();
    raw._raw.prepare('ALTER TABLE scheduled_messages DROP COLUMN last_error').run();

    const before = await getSchemaVersion(adapter);
    assert.equal(before.ok, false);
    assert.equal(before.current, null);
    assert.ok(before.missing.includes('column:scheduled_messages.last_error'), before.missing.join(', '));

    const fixed = await ensureSchema(adapter);
    assert.equal(fixed.ok, true);
    assert.equal(fixed.migrated, true);
    assert.deepEqual(fixed.missing, []);
  });

  test('缺关键索引也算不够用', async () => {
    const { raw, adapter } = await freshAdapter();
    raw._raw.prepare('DROP INDEX uidx_uuid').run();

    const result = await getSchemaVersion(adapter);
    assert.equal(result.ok, false);
    assert.ok(result.missing.includes('index:uidx_uuid'));

    assert.equal((await ensureSchema(adapter)).ok, true);
  });

  // 需要什么是从建表语句里解析出来的，不是手抄的第二份清单——手抄那份漏了
  // 新列的话，自查会对着一个缺列的库回「一切正常」。这里拿真 SQLite 建出来的
  // 表反过来对一遍。
  test('「需要什么」与建表语句真正建出来的列一致', async () => {
    const { adapter } = await freshAdapter();
    const live = await adapter.describeSchema();

    for (const [table, columns] of Object.entries(SQLITE_REQUIRED_SCHEMA.tables)) {
      assert.deepEqual(
        [...columns].sort(),
        [...live.tables[table]].sort(),
        `${table} 的列清单和实际建出来的对不上`
      );
    }
    for (const index of SQLITE_REQUIRED_SCHEMA.indexes) {
      assert.ok(live.indexes.includes(index), `索引 ${index} 没建出来`);
    }
  });

  test('不支持自查的适配器：抛错说清楚，不假装一切正常', async () => {
    await assert.rejects(
      () => getSchemaVersion({ async initSchema() { return {}; } }),
      /describeSchema/
    );
  });

  test('worker.getSchemaVersion / ensureSchema 走 env 也是同一套', async () => {
    const raw = createTestD1();
    const worker = createSingleUserCloudflareWorker((env) => ({
      db: createD1Adapter(env.DB), masterKey: MASTER_KEY, vapid: VAPID,
      webpush: { async sendNotification() {} }
    }));
    const env = { DB: raw };

    assert.equal((await worker.getSchemaVersion(env)).ok, false);
    assert.equal((await worker.ensureSchema(env)).migrated, true);
    assert.equal((await worker.getSchemaVersion(env)).ok, true);
  });
});

// ─── C. 只跑指定那一条任务 ─────────────────────────────────────────────────

describe('worker.runTask', () => {
  test('到点的那一条立刻跑完；没到点 / 没这条 / 已跑完分开回报', async () => {
    const { raw, adapter } = await freshAdapter();
    await seedTask(adapter, { uuid: 'due', nextSendAt: new Date(Date.now() - 30_000).toISOString() });
    await seedTask(adapter, { uuid: 'future', nextSendAt: new Date(Date.now() + 3600_000).toISOString() });

    let sent = 0;
    const worker = createSingleUserCloudflareWorker(() => ({
      db: adapter, masterKey: MASTER_KEY, vapid: VAPID,
      webpush: { async sendNotification() { sent++; } }
    }));
    const env = { DB: raw };

    assert.deepEqual(await worker.runTask('nope', env), { ran: false, reason: 'not_found' });

    const notDue = await worker.runTask('future', env);
    assert.equal(notDue.ran, false);
    assert.equal(notDue.reason, 'not_due');
    assert.ok(notDue.nextSendAt);

    const ran = await worker.runTask('due', env);
    assert.equal(ran.ran, true);
    assert.equal(ran.summary.totalTasks, 1);
    assert.equal(ran.summary.successCount, 1);
    assert.equal(sent, 1);
    // 全量扫描没被顺带触发：未到点那条一根汗毛都没动。
    assert.equal((await adapter.getPendingTasks(50)).length, 0);
    assert.ok(await adapter.getTaskByUuid('future', USER));
  });

  test('行还在但已经是终态 → already_settled，带上是哪个状态', async () => {
    const { raw, adapter } = await freshAdapter();
    await seedTask(adapter, { uuid: 'settled', nextSendAt: new Date(Date.now() - 30_000).toISOString() });
    const [task] = await adapter.getPendingTasks(1);
    await adapter.updateTaskById(task.id, { status: 'failed' });

    const worker = createSingleUserCloudflareWorker(() => ({
      db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: { async sendNotification() {} }
    }));

    assert.deepEqual(
      await worker.runTask('settled', { DB: raw }),
      { ran: false, reason: 'already_settled', status: 'failed' }
    );
  });

  test('在退避窗口里 → retry_pending，不抢在重试时刻之前跑', async () => {
    const { raw, adapter } = await freshAdapter();
    await seedTask(adapter, { uuid: 'backoff', nextSendAt: new Date(Date.now() - 30_000).toISOString() });
    const [task] = await adapter.getPendingTasks(1);
    const retryAfter = new Date(Date.now() + 120_000).toISOString();
    await adapter.updateTaskById(task.id, { retry_after: retryAfter, retry_count: 1 });

    const worker = createSingleUserCloudflareWorker(() => ({
      db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush: { async sendNotification() {} }
    }));

    const result = await worker.runTask('backoff', { DB: raw });
    assert.equal(result.ran, false);
    assert.equal(result.reason, 'retry_pending');
    assert.ok(result.retryAfter);
  });

  test('VAPID / webpush 没配齐 → not_configured，不白扣一次重试', async () => {
    const { raw, adapter } = await freshAdapter();
    await seedTask(adapter, { uuid: 'nocfg', nextSendAt: new Date(Date.now() - 30_000).toISOString() });

    const worker = createSingleUserCloudflareWorker(() => ({
      db: adapter, masterKey: MASTER_KEY, vapid: {}, webpush: null
    }));

    assert.deepEqual(await worker.runTask('nocfg', { DB: raw }), { ran: false, reason: 'not_configured' });
    const [row] = await adapter.getPendingTasks(1);
    assert.equal(row.retry_count, 0, '没跑就不该给它记一次失败');
  });

  test('适配器没实现 getTaskStatusByUuidOnly 时，终态行仍按 not_found 回报', async () => {
    const adapter = {
      async getTaskByUuidOnly() { return null; }
    };
    assert.deepEqual(await runTask({ db: adapter }, 'whatever'), { ran: false, reason: 'not_found' });
  });
});
