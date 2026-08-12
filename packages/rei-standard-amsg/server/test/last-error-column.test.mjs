/**
 * `last_error` 列写不写得进去的判定（见 lib/run-tick.js 的 updateTaskWithLastError）。
 *
 * 这一列是 `GET /message` / `GET /messages` 里 lastError 的权威来源。判定要满足
 * 三件事：健康的库只花一个来回（Cloudflare 部署每个请求都新建适配器，探测型的
 * 额外写等于永远在探）；没有这一列的库行为正确、告警不刷屏；一次瞬时错误不能把
 * 「这个库写不了这一列」永久坐实——长驻的 Node 部署里适配器活到进程结束，坐实一
 * 次之后每个失败任务的 lastError 就永远读成 null。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledTick } from '../src/server/lib/run-tick.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const VAPID = { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' };

/** 推送必挂，走的就是「失败要记 last_error」那条路。 */
const FAILING_WEBPUSH = { async sendNotification() { throw new Error('push failed'); } };

function hasLastError(fields) {
  return Object.prototype.hasOwnProperty.call(fields, 'last_error');
}

async function seedDueTask(adapter, uuid) {
  await seedPushSubscription(adapter, USER, MASTER_KEY);
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  await adapter.createTask({
    user_id: USER,
    uuid,
    encrypted_payload: await encryptForStorage(JSON.stringify({
      contactName: 'Rei', messageType: 'fixed', userMessage: 'hi', recurrenceType: 'none',
    }), userKey),
    next_send_at: new Date(Date.now() - 30_000).toISOString(),
    message_type: 'fixed',
  });
}

/** 投递失败一次的任务会被排进退避窗口，所以每一跳都用一条新任务。 */
async function tickWithFreshTask(db, adapter, uuid) {
  await seedDueTask(adapter, uuid);
  return runScheduledTick({ db, masterKey: MASTER_KEY, vapid: VAPID, webpush: FAILING_WEBPUSH });
}

/** 记下每一次 updateTaskById 的字段，并可以按需拦下其中一些写。 */
function spyOnUpdates(adapter, intercept) {
  /** @type {Array<Object>} */
  const writes = [];
  const db = new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'updateTaskById') {
        return async (taskId, fields) => {
          writes.push(fields);
          if (intercept) intercept(fields);
          return target.updateTaskById(taskId, fields);
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db, writes };
}

function captureWarnings(run) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  return run().finally(() => { console.warn = originalWarn; }).then(() => warnings);
}

describe('last_error 列写不写得进去', () => {
  // ⚠️ 这条用例必须排在最前面：那条运维提示挂在模块上、一个进程内只说一次，
  // 被同文件里别的用例先说掉了，这里就一条也看不到。
  it('每跳都新建适配器（Cloudflare 的样子）：这条运维提示只说一次', async () => {
    const d1 = createTestD1();
    await createD1Adapter(d1).initSchema();

    const warnings = await captureWarnings(async () => {
      for (const uuid of ['cf-1', 'cf-2', 'cf-3', 'cf-4']) {
        // Worker 每个请求都 new 一个适配器，按适配器记的东西每跳就丢。
        const adapter = createD1Adapter(d1);
        const { db } = spyOnUpdates(adapter, (fields) => {
          if (hasLastError(fields)) throw new Error('no such column: last_error');
        });
        await tickWithFreshTask(db, adapter, uuid);
      }
    });

    const columnWarnings = warnings.filter((line) => line.includes('带 last_error 的写没成功'));
    assert.equal(
      columnWarnings.length, 1,
      `这条运维提示说一次就够，实际说了 ${columnWarnings.length} 次（cron 每分钟一跳，日志会被刷满）：${JSON.stringify(columnWarnings)}`
    );
  });

  // 一次连接重置 / 语句超时 / D1 的 `Network connection lost` 恰好落在带
  // last_error 的那笔写上，跟「库里没这一列」长得一模一样。按一次观察就坐实的
  // 话，长驻部署里这个适配器从此不再写 last_error——之后每个失败任务的
  // GET /message 都只剩 lastError: null。
  it('写 last_error 时撞上一次瞬时错误：之后的失败照样记得进这一列', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();

    let glitched = false;
    const { db } = spyOnUpdates(adapter, (fields) => {
      if (!glitched && hasLastError(fields)) {
        glitched = true;
        throw new Error('Network connection lost');
      }
    });

    await tickWithFreshTask(db, adapter, 'glitch-1');
    assert.equal(glitched, true, '得先真的撞上那次瞬时错误，这个测试才说明得了问题');

    await tickWithFreshTask(db, adapter, 'glitch-2');
    // 投递用的列集不含 last_error，读这一列走 getTaskStatusInfo。
    const info = await adapter.getTaskStatusInfo('glitch-2', USER);
    assert.ok(
      info.last_error,
      '一次瞬时错误不该让这个适配器从此不写 last_error（客户端会再也看不到失败原因）'
    );
    assert.equal(JSON.parse(info.last_error).reason, 'push failed');
  });

  it('库里真没有这一列：状态照常推进，认定之后的写不再带它', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();

    // 升级后没重跑 /init-tenant 的库、或者拒绝未知字段的自建适配器：任何带
    // last_error 的写都不认。
    const { db, writes } = spyOnUpdates(adapter, (fields) => {
      if (hasLastError(fields)) throw new Error('no such column: last_error');
    });

    await tickWithFreshTask(db, adapter, 'missing-1');
    await tickWithFreshTask(db, adapter, 'missing-2');
    writes.length = 0;
    await tickWithFreshTask(db, adapter, 'missing-3');

    // 状态推进不能被这条锦上添花的记录挡住：挡住的话 retry_count 不涨、退避不排
    // 出去，这条任务会被每一跳 cron 重新捞起来。
    for (const uuid of ['missing-1', 'missing-2', 'missing-3']) {
      const row = await adapter.getTaskByUuidOnly(uuid);
      assert.equal(row.retry_count, 1, `${uuid} 的重试计数必须往前走`);
      assert.ok(Date.parse(row.retry_after) > Date.now(), `${uuid} 的退避要真的排出去`);
    }

    assert.equal(
      writes.length, 1,
      `认定之后每次失败只该写一笔，实际写了 ${writes.length} 笔：${JSON.stringify(writes)}`
    );
    assert.equal(hasLastError(writes[0]), false, '认定之后的写不该再带这个字段');
  });

  it('健康的库：一次失败只写一笔（不为探测多花一个来回）', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const { db, writes } = spyOnUpdates(adapter, null);

    await tickWithFreshTask(db, adapter, 'healthy-1');

    assert.equal(
      writes.length, 1,
      `健康的库不该为了探这一列多写一笔（Cloudflare 上适配器每个请求都新建，探了也记不住）：${JSON.stringify(writes)}`
    );
    assert.equal(hasLastError(writes[0]), true, '状态字段和 last_error 合成一笔写');
    const info = await adapter.getTaskStatusInfo('healthy-1', USER);
    assert.equal(JSON.parse(info.last_error).reason, 'push failed');
  });
});
