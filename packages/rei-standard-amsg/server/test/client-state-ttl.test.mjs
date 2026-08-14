/**
 * client_state 的按命名空间过期清理（config 的 `clientStateTtl`）。
 *
 * 默认一个都不清——写进去的是宿主的数据，库不替它决定什么时候该没。但「大内容
 * 旁路」那类用法写的是一次性内容（push 塞不下的正文先写进状态、push 里只带引用
 * 键），客户端取走之后没人再去删，攒着白占库。给那个命名空间配上天数，cron 每
 * 跳顺手清一次。
 *
 * 三件事必须钉住：没配就一行都不动、只清配了的那个命名空间、大值的切片行跟着
 * 根行一起走（切片留下来就是永远读不出来的垃圾行）。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { planClientStateCleanup } from '../src/server/lib/client-state-store.js';
import { chunkNamespaceFor, chunkKeyFor } from '../src/server/lib/state-chunks.js';
import { runScheduledTick } from '../src/server/lib/run-tick.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const DAY_MS = 24 * 60 * 60 * 1000;

/** 直接落几行状态（值不解密，所以随便放什么字符串都行）。 */
async function seedState(adapter, rows) {
  await adapter.upsertClientState(
    USER,
    rows.map((row) => ({ namespace: row.namespace, key: row.key, value: 'x', updatedAt: row.updatedAt })),
    []
  );
}

async function keysIn(adapter, namespace) {
  const rows = await adapter.getClientState(USER, namespace);
  return rows.map((row) => row.key).sort();
}

describe('planClientStateCleanup', () => {
  test('一个命名空间出两条：它自己 + 它的切片命名空间', () => {
    const now = 1_000 * DAY_MS;
    const targets = planClientStateCleanup({ fire_pack: 7 }, now);
    assert.deepEqual(targets, [
      { namespace: 'fire_pack', updatedBefore: now - 7 * DAY_MS },
      { namespace: chunkNamespaceFor('fire_pack'), updatedBefore: now - 7 * DAY_MS },
    ]);
  });

  test('没配 / 配了非正数 → 不产生指令（配错了不该变成「清空一切」）', () => {
    const now = Date.now();
    assert.deepEqual(planClientStateCleanup(undefined, now), []);
    assert.deepEqual(planClientStateCleanup({}, now), []);
    assert.deepEqual(planClientStateCleanup({ ns: 0 }, now), []);
    assert.deepEqual(planClientStateCleanup({ ns: -1 }, now), []);
    assert.deepEqual(planClientStateCleanup({ ns: '7' }, now), []);
  });
});

describe('D1 adapter: cleanupClientState', () => {
  test('只删够老的那几行，别的命名空间与新数据不动', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const now = Date.now();
    await seedState(adapter, [
      { namespace: 'fire_pack', key: 'old', updatedAt: now - 10 * DAY_MS },
      { namespace: 'fire_pack', key: 'fresh', updatedAt: now - 1 * DAY_MS },
      { namespace: 'chat_draft', key: 'old-but-not-configured', updatedAt: now - 10 * DAY_MS },
    ]);

    const deleted = await adapter.cleanupClientState(planClientStateCleanup({ fire_pack: 7 }, now));

    assert.equal(deleted, 1);
    assert.deepEqual(await keysIn(adapter, 'fire_pack'), ['fresh']);
    assert.deepEqual(await keysIn(adapter, 'chat_draft'), ['old-but-not-configured']);
  });

  test('大值的切片行跟着根行一起走，不留读不出来的垃圾', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const now = Date.now();
    const stale = now - 30 * DAY_MS;
    await seedState(adapter, [
      { namespace: 'fire_pack', key: 'big', updatedAt: stale },
      { namespace: chunkNamespaceFor('fire_pack'), key: chunkKeyFor('big', 0), updatedAt: stale },
      { namespace: chunkNamespaceFor('fire_pack'), key: chunkKeyFor('big', 1), updatedAt: stale },
    ]);

    await adapter.cleanupClientState(planClientStateCleanup({ fire_pack: 7 }, now));

    assert.deepEqual(await keysIn(adapter, 'fire_pack'), []);
    assert.deepEqual(await keysIn(adapter, chunkNamespaceFor('fire_pack')), []);
  });

  test('空指令是空操作（没配 TTL 的部署一条 DELETE 都不发）', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    assert.equal(await adapter.cleanupClientState([]), 0);
    assert.equal(await adapter.cleanupClientState(), 0);
  });
});

describe('runScheduledTick 里的顺手清理', () => {
  function tickCtx(adapter, extra = {}) {
    return {
      db: adapter,
      masterKey: MASTER_KEY,
      vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
      webpush: { async sendNotification() {} },
      ...extra,
    };
  }

  test('配了 clientStateTtl：超期的条目在 tick 里被清掉', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const now = Date.now();
    await seedState(adapter, [
      { namespace: 'fire_pack', key: 'old', updatedAt: now - 10 * DAY_MS },
      { namespace: 'fire_pack', key: 'fresh', updatedAt: now },
    ]);

    await runScheduledTick(tickCtx(adapter, { clientStateTtl: { fire_pack: 7 } }));

    assert.deepEqual(await keysIn(adapter, 'fire_pack'), ['fresh']);
  });

  test('没配 clientStateTtl：多老的条目都留着（默认不过期）', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    await seedState(adapter, [
      { namespace: 'fire_pack', key: 'ancient', updatedAt: Date.now() - 3650 * DAY_MS },
    ]);

    await runScheduledTick(tickCtx(adapter));

    assert.deepEqual(await keysIn(adapter, 'fire_pack'), ['ancient']);
  });

  test('清理挂了不拖垮整跳投递', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const broken = new Proxy(adapter, {
      get(target, prop) {
        if (prop === 'cleanupClientState') return async () => { throw new Error('库炸了'); };
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const summary = await runScheduledTick(tickCtx(broken, { clientStateTtl: { fire_pack: 7 } }));
    assert.equal(summary.totalTasks, 0);
  });
});
