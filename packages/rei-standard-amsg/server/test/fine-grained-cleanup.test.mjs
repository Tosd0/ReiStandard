/**
 * 按角色 / 按命名空间的细粒度清理：宿主要能「列出云端有什么 → 跟本地对账 →
 * 一个一个清掉」，而不是只有「整表全清」这一个粒度。
 *
 * 四条能力各自的回归守卫：
 *   1. `GET /client-state/namespaces`：有哪些命名空间、各自几条 / 占多少字节 /
 *      最后更新是什么时候。大值切片的保留命名空间折算进原命名空间，不单独列。
 *   2. `DELETE /client-state?namespace=<ns>`：只清这一个命名空间，连它的切片行
 *      一起；不带参数仍是整表全清。
 *   3. `DELETE /llm-credentials { credIdPrefix }`：按 cred_id 前缀删。
 *   4. `DELETE /outbox`：主动删收件箱的行（点名几条 / 全清）。
 *
 * 另外两条守卫盯的是 D1 那两条没写进文档的限制——本地跑的是 better-sqlite3，
 * 两条都不触发，所以断言只能落在「发出去的语句长什么样」上，落不到执行结果：
 *   - LIKE / GLOB 的 pattern 最长 50 字节 → 按前缀删凭据一条 LIKE 都不许发；
 *   - 单条语句最多 100 个绑定参数 → 按 id 删 outbox 必须切批。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1, createSpyD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptPayload, decryptPayload, encryptForStorage } from '../src/server/lib/encryption.js';
import { chunkNamespaceFor, chunkKeyFor, CHUNK_NAMESPACE_PREFIX } from '../src/server/lib/state-chunks.js';
import { MAX_CLIENT_STATE_NAMESPACES } from '../src/server/handlers/client-state-namespaces.js';
import { MAX_OUTBOX_DELETE_IDS } from '../src/server/handlers/outbox.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const OTHER_USER = '660e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

const ENC_HEADERS = {
  'X-User-Id': USER,
  'X-Payload-Encrypted': 'true',
  'X-Encryption-Version': '1',
};

// D1 的两条平台限制（都没写进官方文档，本地 SQLite 上一条都不触发）。
const D1_LIKE_PATTERN_MAX_BYTES = 50;
const D1_MAX_BOUND_PARAMS = 100;

function makeWorker(d1, extra = {}) {
  return createSingleUserCloudflareWorker((env) => ({
    db: extra.db || createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} },
    ...extra,
  }));
}

async function encBody(obj) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return JSON.stringify(await encryptPayload(obj, userKey));
}

async function decodeEncrypted(res) {
  const body = await res.json();
  assert.equal(body.encrypted, true, '响应应该是加密信封');
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return decryptPayload(body.data, userKey);
}

async function freshWorker(extra = {}) {
  const d1 = createTestD1();
  const adapter = createD1Adapter(d1);
  await adapter.initSchema();
  return { d1, adapter, worker: makeWorker(d1, extra), env: { DB: d1 } };
}

/**
 * 把适配器包成「缺了某几个方法」的样子，验 501 降级。用 Proxy 是因为内置适配器
 * 是 class 实例，方法挂在原型上，浅拷贝一个都拷不到（同 helpers/no-outbox.mjs）。
 */
function withoutMethods(adapter, names) {
  const hidden = new Set(names);
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (hidden.has(prop)) return undefined;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    has(target, prop) {
      return hidden.has(prop) ? false : Reflect.has(target, prop);
    },
  });
}

// ─── 1. GET /client-state/namespaces ────────────────────────────────────────

describe('GET /client-state/namespaces：云端有哪些命名空间', () => {
  /** 造几个命名空间，其中 amsg:char:a 有一条被切成两片的大值。 */
  async function seedNamespaces(adapter) {
    await adapter.upsertClientState(USER, [
      { namespace: 'amsg:char:a', key: 'k1', value: 'abcd', updatedAt: 100 },
      { namespace: 'amsg:char:a', key: 'big', value: 'root-marker', updatedAt: 300 },
      { namespace: 'amsg:char:b', key: 'k1', value: 'x', updatedAt: 50 },
      { namespace: 'notes', key: 'k', value: 'yy', updatedAt: 10 },
      // 大值切片行：落在保留命名空间里，对宿主不可见
      { namespace: chunkNamespaceFor('amsg:char:a'), key: chunkKeyFor('big', 0), value: 'sliceslice', updatedAt: 300 },
      { namespace: chunkNamespaceFor('amsg:char:a'), key: chunkKeyFor('big', 1), value: 'slice2', updatedAt: 300 },
    ]);
  }

  test('切片保留命名空间折算进原命名空间：字节数算进去，条目数不算', async () => {
    const { adapter } = await freshWorker();
    await seedNamespaces(adapter);

    const rows = await adapter.listClientStateNamespaces(USER, { foldPrefix: CHUNK_NAMESPACE_PREFIX });
    assert.deepEqual(rows.map((r) => r.namespace), ['amsg:char:a', 'amsg:char:b', 'notes'],
      '保留命名空间不该单独出现在清单里');

    const a = rows.find((r) => r.namespace === 'amsg:char:a');
    // 两个逻辑条目（k1 + big），切片不算条目
    assert.equal(a.entry_count, 2);
    // 字节数是四行加起来：'abcd'(4) + 'root-marker'(11) + 'sliceslice'(10) + 'slice2'(6)
    assert.equal(a.byte_size, 4 + 11 + 10 + 6);
    assert.equal(a.updated_at, 300);

    assert.deepEqual(
      rows.filter((r) => r.namespace !== 'amsg:char:a').map((r) => [r.entry_count, r.byte_size, r.updated_at]),
      [[1, 1, 50], [1, 2, 10]]
    );
  });

  test('byteSize 数的是字节不是字符（多字节内容不会少算）', async () => {
    const { adapter } = await freshWorker();
    // '记' 是 3 字节 1 字符；LENGTH() 按字符算会少算三分之二
    await adapter.upsertClientState(USER, [
      { namespace: 'n', key: 'k', value: '记记', updatedAt: 1 },
    ]);
    const [row] = await adapter.listClientStateNamespaces(USER, { foldPrefix: CHUNK_NAMESPACE_PREFIX });
    assert.equal(row.byte_size, 6);
  });

  test('不传 foldPrefix 时保留命名空间原样列出来（折算是调用方的选择）', async () => {
    const { adapter } = await freshWorker();
    await seedNamespaces(adapter);
    const rows = await adapter.listClientStateNamespaces(USER);
    assert.ok(rows.some((r) => r.namespace === chunkNamespaceFor('amsg:char:a')));
  });

  test('端点：加密信封回清单，命名空间名不明文出门', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedNamespaces(adapter);

    const res = await worker.fetch(new Request('https://w.dev/client-state/namespaces', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(res.status, 200);
    const raw = await res.clone().text();
    assert.ok(!raw.includes('amsg:char:a'), '命名空间名不该出现在明文响应里');

    const data = await decodeEncrypted(res);
    assert.equal(data.truncated, false);
    assert.deepEqual(
      data.namespaces.map((n) => [n.namespace, n.entryCount, n.updatedAt]),
      [['amsg:char:a', 2, 300], ['amsg:char:b', 1, 50], ['notes', 1, 10]]
    );
    assert.equal(typeof data.namespaces[0].byteSize, 'number');
  });

  test('端点：一条都没有时回空清单，不是报错', async () => {
    const { worker, env } = await freshWorker();
    const res = await worker.fetch(new Request('https://w.dev/client-state/namespaces', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(res.status, 200);
    const data = await decodeEncrypted(res);
    assert.deepEqual(data.namespaces, []);
    assert.equal(data.truncated, false);
  });

  test('超过条数上限：截断并标 truncated，正好等于上限时不标', async () => {
    const { adapter, worker, env } = await freshWorker();
    await adapter.upsertClientState(USER, Array.from({ length: 5 }, (_, i) => ({
      namespace: `ns-${i}`, key: 'k', value: 'v', updatedAt: 1,
    })));

    const over = await decodeEncrypted(await worker.fetch(new Request(
      'https://w.dev/client-state/namespaces?limit=3', { method: 'GET', headers: { 'X-User-Id': USER } }
    ), env));
    assert.equal(over.namespaces.length, 3);
    assert.equal(over.truncated, true);
    assert.deepEqual(over.namespaces.map((n) => n.namespace), ['ns-0', 'ns-1', 'ns-2']);

    // 正好 5 个、limit 也是 5：不该因为「捞满一页」就误报还有下一页
    const exact = await decodeEncrypted(await worker.fetch(new Request(
      'https://w.dev/client-state/namespaces?limit=5', { method: 'GET', headers: { 'X-User-Id': USER } }
    ), env));
    assert.equal(exact.namespaces.length, 5);
    assert.equal(exact.truncated, false);
  });

  test('limit 参数：非法值 400，超过硬上限按硬上限收', async () => {
    const { worker, env } = await freshWorker();
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      const res = await worker.fetch(new Request(
        `https://w.dev/client-state/namespaces?limit=${bad}`, { method: 'GET', headers: { 'X-User-Id': USER } }
      ), env);
      assert.equal(res.status, 400, `limit=${bad} 应被拒`);
      assert.equal((await res.json()).error.code, 'INVALID_NAMESPACE_LIMIT');
    }
    const huge = await worker.fetch(new Request(
      'https://w.dev/client-state/namespaces?limit=99999', { method: 'GET', headers: { 'X-User-Id': USER } }
    ), env);
    assert.equal(huge.status, 200);
    assert.equal((await decodeEncrypted(huge)).limit, MAX_CLIENT_STATE_NAMESPACES);
  });

  test('缺 X-User-Id → 400；适配器没这个方法 → 501', async () => {
    const { worker, env } = await freshWorker();
    const noUser = await worker.fetch(new Request('https://w.dev/client-state/namespaces', { method: 'GET' }), env);
    assert.equal(noUser.status, 400);

    const d1 = createTestD1();
    const bare = createD1Adapter(d1);
    await bare.initSchema();
    const degraded = makeWorker(d1, { db: withoutMethods(bare, ['listClientStateNamespaces']) });
    const res = await degraded.fetch(new Request('https://w.dev/client-state/namespaces', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), { DB: d1 });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).error.code, 'CLIENT_STATE_NAMESPACES_NOT_SUPPORTED');
  });

  test('路由不被 /client-state 吃掉（endsWith 匹配的尾缀陷阱）', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedNamespaces(adapter);
    // 同一个 GET 打到 /client-state 上要求带 namespace 参数，不带就是 400；
    // 打到 /client-state/namespaces 上是 200。两条路由确实分开了。
    const list = await worker.fetch(new Request('https://w.dev/client-state/namespaces', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(list.status, 200);
    const read = await worker.fetch(new Request('https://w.dev/client-state', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(read.status, 400);
    assert.equal((await read.json()).error.code, 'NAMESPACE_REQUIRED');
  });
});

// ─── 2. DELETE /client-state?namespace=<ns> ─────────────────────────────────

describe('DELETE /client-state?namespace=<ns>：只清一个命名空间', () => {
  async function seed(adapter) {
    await adapter.upsertClientState(USER, [
      { namespace: 'amsg:char:a', key: 'k1', value: 'v1', updatedAt: 100 },
      { namespace: 'amsg:char:a', key: 'big', value: 'root', updatedAt: 100 },
      { namespace: chunkNamespaceFor('amsg:char:a'), key: chunkKeyFor('big', 0), value: 's0', updatedAt: 100 },
      { namespace: chunkNamespaceFor('amsg:char:a'), key: chunkKeyFor('big', 1), value: 's1', updatedAt: 100 },
      { namespace: 'amsg:char:b', key: 'k1', value: 'keep', updatedAt: 100 },
      { namespace: chunkNamespaceFor('amsg:char:b'), key: chunkKeyFor('x', 0), value: 'keep-slice', updatedAt: 100 },
    ]);
  }

  test('连它的切片行一起删，别的命名空间一行不动', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seed(adapter);

    const res = await worker.fetch(new Request(
      'https://w.dev/client-state?namespace=amsg%3Achar%3Aa',
      { method: 'DELETE', headers: { 'X-User-Id': USER } }
    ), env);
    assert.equal(res.status, 200);
    const data = (await res.json()).data;
    assert.equal(data.deleted, 4, '2 条根行 + 2 条切片行');
    assert.equal(data.namespace, 'amsg:char:a');

    assert.deepEqual(await adapter.getClientState(USER, 'amsg:char:a'), []);
    assert.deepEqual(await adapter.getClientState(USER, chunkNamespaceFor('amsg:char:a')), [],
      '切片行不该留成孤儿');
    assert.equal((await adapter.getClientState(USER, 'amsg:char:b')).length, 1);
    assert.equal((await adapter.getClientState(USER, chunkNamespaceFor('amsg:char:b'))).length, 1);
  });

  test('不带 namespace 参数仍是整表全清（老调用方不受影响）', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seed(adapter);
    const res = await worker.fetch(new Request('https://w.dev/client-state', {
      method: 'DELETE', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(res.status, 200);
    const data = (await res.json()).data;
    assert.equal(data.deleted, 6);
    assert.equal(data.namespace, undefined, '整表全清不该带 namespace 字段');
    assert.deepEqual(await adapter.getClientState(USER, 'amsg:char:b'), []);
  });

  test('删的是一个事务：两条 DELETE 走同一次 batch', async () => {
    const d1 = createTestD1();
    let batchCalls = 0;
    const origBatch = d1.batch;
    d1.batch = async (statements) => { batchCalls++; return origBatch(statements); };
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seed(adapter);
    batchCalls = 0;

    const deleted = await adapter.deleteClientStateNamespaces(USER, [
      'amsg:char:a', chunkNamespaceFor('amsg:char:a'),
    ]);
    assert.equal(deleted, 4);
    assert.equal(batchCalls, 1, '原命名空间和它的切片命名空间必须在同一个事务里删');
  });

  test('别人的行不受影响', async () => {
    const { adapter, worker, env } = await freshWorker();
    await adapter.upsertClientState(USER, [{ namespace: 'n', key: 'k', value: 'mine', updatedAt: 1 }]);
    await adapter.upsertClientState(OTHER_USER, [{ namespace: 'n', key: 'k', value: 'theirs', updatedAt: 1 }]);
    await worker.fetch(new Request('https://w.dev/client-state?namespace=n', {
      method: 'DELETE', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal((await adapter.getClientState(OTHER_USER, 'n')).length, 1);
  });

  test('空 namespace / 带控制字符 → 400（不许点名去删保留命名空间）', async () => {
    const { worker, env } = await freshWorker();
    const empty = await worker.fetch(new Request('https://w.dev/client-state?namespace=%20', {
      method: 'DELETE', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, 'INVALID_STATE_NAMESPACE');

    const reserved = await worker.fetch(new Request(
      `https://w.dev/client-state?namespace=${encodeURIComponent(chunkNamespaceFor('n'))}`,
      { method: 'DELETE', headers: { 'X-User-Id': USER } }
    ), env);
    assert.equal(reserved.status, 400);
    assert.equal((await reserved.json()).error.code, 'INVALID_STATE_NAMESPACE');
  });

  test('适配器没这个方法 → 501，但整表全清照常', async () => {
    const d1 = createTestD1();
    const bare = createD1Adapter(d1);
    await bare.initSchema();
    await bare.upsertClientState(USER, [{ namespace: 'n', key: 'k', value: 'v', updatedAt: 1 }]);
    const worker = makeWorker(d1, { db: withoutMethods(bare, ['deleteClientStateNamespaces']) });
    const env = { DB: d1 };

    const scoped = await worker.fetch(new Request('https://w.dev/client-state?namespace=n', {
      method: 'DELETE', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(scoped.status, 501);
    assert.equal((await scoped.json()).error.code, 'CLIENT_STATE_NAMESPACE_DELETE_NOT_SUPPORTED');

    const all = await worker.fetch(new Request('https://w.dev/client-state', {
      method: 'DELETE', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(all.status, 200);
    assert.equal((await all.json()).data.deleted, 1);
  });
});

// ─── 3. DELETE /llm-credentials { credIdPrefix } ────────────────────────────

describe('DELETE /llm-credentials：按 cred_id 前缀删', () => {
  const CHAR_A = '11111111-2222-4333-8444-555555555555';
  const CHAR_B = '99999999-2222-4333-8444-555555555555';

  async function seedCreds(adapter) {
    await adapter.upsertLlmCredentials(USER, [
      { credId: `char:${CHAR_A}/chat`, encryptedValue: 'enc' },
      { credId: `char:${CHAR_A}/instant`, encryptedValue: 'enc' },
      { credId: `char:${CHAR_A}/emotion`, encryptedValue: 'enc' },
      { credId: `char:${CHAR_B}/chat`, encryptedValue: 'enc' },
      { credId: 'global/chat', encryptedValue: 'enc' },
    ]);
  }

  async function deleteCreds(worker, env, body) {
    return worker.fetch(new Request('https://w.dev/llm-credentials', {
      method: 'DELETE', headers: ENC_HEADERS, body: await encBody(body),
    }), env);
  }

  test('一把清掉一个角色名下的几行，别的角色和 global 不动', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedCreds(adapter);

    const res = await deleteCreds(worker, env, { credIdPrefix: `char:${CHAR_A}/` });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.deleted, 3);

    assert.deepEqual(
      (await adapter.listLlmCredentials(USER)).map((r) => r.cred_id),
      [`char:${CHAR_B}/chat`, 'global/chat']
    );
  });

  test('前缀是「开头一截」不是通配：% 和 _ 只是普通字符', async () => {
    const { adapter, worker, env } = await freshWorker();
    await adapter.upsertLlmCredentials(USER, [
      { credId: 'a%b/chat', encryptedValue: 'enc' },
      { credId: 'axb/chat', encryptedValue: 'enc' },
      { credId: 'a_b/chat', encryptedValue: 'enc' },
      { credId: 'ayb/chat', encryptedValue: 'enc' },
    ]);

    assert.equal((await (await deleteCreds(worker, env, { credIdPrefix: 'a%b' })).json()).data.deleted, 1);
    assert.equal((await (await deleteCreds(worker, env, { credIdPrefix: 'a_b' })).json()).data.deleted, 1);
    assert.deepEqual(
      (await adapter.listLlmCredentials(USER)).map((r) => r.cred_id),
      ['axb/chat', 'ayb/chat']
    );
  });

  test('一个都不匹配 → deleted 0，不报错', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedCreds(adapter);
    const res = await deleteCreds(worker, env, { credIdPrefix: 'char:nobody/' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.deleted, 0);
    assert.equal((await adapter.listLlmCredentials(USER)).length, 5);
  });

  // ── D1 限制守卫之一：LIKE / GLOB 的 pattern 最长 50 字节 ──────────────────
  //
  // `char:<uuid>/` 已经 42 字节，cred_id 契约允许到 128 字符，随便一个真实前缀
  // 就能把 LIKE pattern 顶过 50 字节，真实 D1 上整条语句报
  // `LIKE or GLOB pattern too complex`。本地 better-sqlite3 的上限是 SQLite 默认
  // 的 50000，功能测试在改回 LIKE 之后照样全绿——所以守卫必须盯语句形态。
  test('按前缀删一条 LIKE / GLOB 都不许发（D1 pattern 上限 50 字节）', async () => {
    const { db, calls } = createSpyD1();
    const adapter = createD1Adapter(db);
    await adapter.initSchema();
    await seedCreds(adapter);

    calls.length = 0;
    await adapter.deleteLlmCredentialsByPrefix(USER, `char:${CHAR_A}/`);

    assert.ok(calls.length > 0, '应该真的发出了语句');
    for (const call of calls) {
      assert.doesNotMatch(
        call.sql, /\b(?:LIKE|GLOB)\b/i,
        `按前缀删凭据不能用 LIKE / GLOB（D1 的 pattern 上限只有 ${D1_LIKE_PATTERN_MAX_BYTES} 字节）：${call.sql}`
      );
    }
    // 正面确认走的是字典序范围比较
    assert.match(calls[0].sql, /cred_id\s*>=\s*\?[\s\S]*cred_id\s*<\s*\?/i);
  });

  test('前缀长到 128 字符照样删得掉（LIKE 写法在真实 D1 上这里就炸了）', async () => {
    const { adapter, worker, env } = await freshWorker();
    const longPrefix = `char:${'x'.repeat(122)}/`; // 128 字符，cred_id 的契约上限
    assert.equal(longPrefix.length, 128);
    assert.ok(new TextEncoder().encode(longPrefix).length > D1_LIKE_PATTERN_MAX_BYTES);

    await adapter.upsertLlmCredentials(USER, [
      { credId: longPrefix, encryptedValue: 'enc' },
      { credId: 'other/chat', encryptedValue: 'enc' },
    ]);
    const res = await deleteCreds(worker, env, { credIdPrefix: longPrefix });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.deleted, 1);
    assert.deepEqual((await adapter.listLlmCredentials(USER)).map((r) => r.cred_id), ['other/chat']);
  });

  test('三种入参互斥：混传 / 都不传 / 空前缀 / 超长前缀都被拒', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedCreds(adapter);

    const cases = [
      [{ all: true, credIdPrefix: 'char:' }, 'all + credIdPrefix'],
      [{ credIds: ['a'], credIdPrefix: 'char:' }, 'credIds + credIdPrefix'],
      [{ all: true, credIds: ['a'] }, 'all + credIds'],
      [{}, '什么都不传'],
      [{ credIdPrefix: '' }, '空前缀'],
      [{ credIdPrefix: 'x'.repeat(129) }, '超过 128 字符'],
      [{ credIdPrefix: 'a\u0000b' }, '带控制字符'],
      [{ credIdPrefix: 42 }, '不是字符串'],
    ];
    for (const [body, label] of cases) {
      const res = await deleteCreds(worker, env, body);
      assert.equal(res.status, 400, `${label} 应被拒`);
      assert.equal((await res.json()).error.code, 'INVALID_PARAMETERS', label);
    }
    assert.equal((await adapter.listLlmCredentials(USER)).length, 5, '被拒的请求一行都不该删掉');
  });

  test('点名删和全清这两条老路一个字节没变', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedCreds(adapter);
    assert.equal((await (await deleteCreds(worker, env, { credIds: ['global/chat'] })).json()).data.deleted, 1);
    assert.equal((await (await deleteCreds(worker, env, { all: true })).json()).data.deleted, 4);
    assert.deepEqual(await adapter.listLlmCredentials(USER), []);
  });

  test('适配器没这个方法 → 501，另外两种入参照常', async () => {
    const d1 = createTestD1();
    const bare = createD1Adapter(d1);
    await bare.initSchema();
    await seedCreds(bare);
    const worker = makeWorker(d1, { db: withoutMethods(bare, ['deleteLlmCredentialsByPrefix']) });
    const env = { DB: d1 };

    const prefix = await deleteCreds(worker, env, { credIdPrefix: `char:${CHAR_A}/` });
    assert.equal(prefix.status, 501);
    assert.equal((await prefix.json()).error.code, 'LLM_CREDENTIALS_PREFIX_DELETE_NOT_SUPPORTED');

    const byId = await deleteCreds(worker, env, { credIds: ['global/chat'] });
    assert.equal(byId.status, 200);
    assert.equal((await byId.json()).data.deleted, 1);
  });
});

// ─── 4. DELETE /outbox ──────────────────────────────────────────────────────

describe('DELETE /outbox：主动删收件箱的行', () => {
  /** 造 n 条 outbox 行，返回它们的 messageId。 */
  async function seedOutbox(adapter, n, userId = USER) {
    const ids = Array.from({ length: n }, (_, i) => `msg-${String(i).padStart(4, '0')}`);
    await adapter.appendOutboxMessages(userId, ids.map((id) => ({
      message_id: id, payload: 'enc', created_at: 1000,
    })));
    return ids;
  }

  async function deleteOutbox(worker, env, body) {
    return worker.fetch(new Request('https://w.dev/outbox', {
      method: 'DELETE', headers: ENC_HEADERS, body: await encBody(body),
    }), env);
  }

  test('点名删：已投递 / 已 ack 的行也删得掉（跟取消时的「撤未投递」是两件事）', async () => {
    const { adapter, worker, env } = await freshWorker();
    const ids = await seedOutbox(adapter, 4);
    await adapter.markOutboxDelivered(USER, [ids[0]], 2000);
    await adapter.ackOutboxMessages(USER, [ids[1]], 3000);

    const res = await deleteOutbox(worker, env, { messageIds: [ids[0], ids[1], ids[2]] });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.deleted, 3);

    const left = await adapter.listUnackedOutbox(USER, 0, 100);
    assert.deepEqual(left.map((r) => r.message_id), [ids[3]]);

    // 对照：discardOutboxMessages 只撤没发出去的，已投递 / 已 ack 的它动不了
    const ids2 = await seedOutbox(adapter, 2);
    await adapter.markOutboxDelivered(USER, [ids2[0]], 2000);
    assert.equal(await adapter.discardOutboxMessages(USER, ids2), 1);
  });

  test('{ all: true } 清这个用户的全部，别人的不动', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedOutbox(adapter, 3);
    await seedOutbox(adapter, 2, OTHER_USER);

    const res = await deleteOutbox(worker, env, { all: true });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.deleted, 3);
    assert.deepEqual(await adapter.listUnackedOutbox(USER, 0, 100), []);
    assert.equal((await adapter.listUnackedOutbox(OTHER_USER, 0, 100)).length, 2);
  });

  // ── D1 限制守卫之二：单条语句最多 100 个绑定参数 ──────────────────────────
  //
  // 第 101 个直接报 `too many SQL variables`（D1_ERROR 7500），这个数算的是整条
  // 语句的参数总数、不只是 IN (...) 那部分。本地 better-sqlite3 的
  // SQLITE_MAX_VARIABLE_NUMBER 是几百到几万，喂 201 个照样跑得通——功能测试在
  // 没切批的实现上也是绿的，所以守卫得盯「每条语句绑了几个参数」。
  test('按 id 删要切批：单条语句不许超过 100 个绑定参数', async () => {
    const { db, calls } = createSpyD1();
    const adapter = createD1Adapter(db);
    await adapter.initSchema();
    // MAX_OUTBOX_DELETE_IDS 是契约允许的最大值
    const ids = await seedOutbox(adapter, MAX_OUTBOX_DELETE_IDS);

    calls.length = 0;
    await adapter.deleteOutboxMessages(USER, ids);

    assert.ok(calls.length > 1, '200 个 id 一条语句装不下，必须切批');
    for (const call of calls) {
      assert.ok(
        call.args.length <= D1_MAX_BOUND_PARAMS,
        `单条语句绑了 ${call.args.length} 个参数，超过 D1 的 ${D1_MAX_BOUND_PARAMS} 上限：${call.sql}`
      );
    }
    // 额度按语句自己的固定参数算：user_id 占 1 个 → 一批最多 99 个 id
    const batchesFor = async (n) => {
      calls.length = 0;
      await adapter.deleteOutboxMessages(USER, ids.slice(0, n));
      return calls.length;
    };
    assert.equal(await batchesFor(99), 1, '99 个 id + 1 个固定参数 = 100，正好一条');
    assert.equal(await batchesFor(100), 2);
  });

  test('切批之后返回值是各批合计，不是最后一批', async () => {
    const { adapter } = await freshWorker();
    const ids = await seedOutbox(adapter, MAX_OUTBOX_DELETE_IDS);
    assert.equal(await adapter.deleteOutboxMessages(USER, ids), MAX_OUTBOX_DELETE_IDS);
    assert.deepEqual(await adapter.listUnackedOutbox(USER, 0, 500), []);
  });

  test('入参校验：混传 / 都不传 / 超量 / 非字符串都被拒，一行都不删', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedOutbox(adapter, 3);

    const cases = [
      [{ all: true, messageIds: ['a'] }, 'all + messageIds', 'INVALID_OUTBOX_DELETE'],
      [{}, '什么都不传', 'INVALID_OUTBOX_DELETE'],
      [{ messageIds: [] }, '空数组', 'INVALID_OUTBOX_DELETE'],
      [{ messageIds: ['a', 42] }, '非字符串', 'INVALID_OUTBOX_DELETE'],
      [{ messageIds: ['a', '  '] }, '空白字符串', 'INVALID_OUTBOX_DELETE'],
      [{ messageIds: Array.from({ length: MAX_OUTBOX_DELETE_IDS + 1 }, (_, i) => `m${i}`) }, '超量', 'TOO_MANY_OUTBOX_DELETE_IDS'],
    ];
    for (const [body, label, code] of cases) {
      const res = await deleteOutbox(worker, env, body);
      assert.equal(res.status, 400, `${label} 应被拒`);
      assert.equal((await res.json()).error.code, code, label);
    }
    assert.equal((await adapter.listUnackedOutbox(USER, 0, 100)).length, 3);
  });

  test('body 不加密 → 400；适配器没这个方法 → 501', async () => {
    const { worker, env } = await freshWorker();
    const plain = await worker.fetch(new Request('https://w.dev/outbox', {
      method: 'DELETE', headers: { 'X-User-Id': USER }, body: JSON.stringify({ all: true }),
    }), env);
    assert.equal(plain.status, 400);
    assert.equal((await plain.json()).error.code, 'ENCRYPTION_REQUIRED');

    const d1 = createTestD1();
    const bare = createD1Adapter(d1);
    await bare.initSchema();
    const degraded = makeWorker(d1, { db: withoutMethods(bare, ['deleteOutboxMessages']) });
    const res = await degraded.fetch(new Request('https://w.dev/outbox', {
      method: 'DELETE', headers: ENC_HEADERS, body: await encBody({ all: true }),
    }), { DB: d1 });
    assert.equal(res.status, 501);
    assert.equal((await res.json()).error.code, 'OUTBOX_DELETE_NOT_SUPPORTED');
  });

  test('DELETE /outbox 与 GET /outbox、POST /outbox/ack 互不干扰', async () => {
    const { adapter, worker, env } = await freshWorker();
    // 这条要真的走一遍 GET /outbox 的解密，payload 得是真密文（别的用例只看行数，
    // 用占位串就够）。
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const ids = ['m-1', 'm-2'];
    await adapter.appendOutboxMessages(USER, await Promise.all(ids.map(async (id) => ({
      message_id: id,
      payload: await encryptForStorage(JSON.stringify({ messageId: id }), userKey),
      created_at: 1000,
    }))));

    // GET 照常（DELETE 这条 else-if 不该把 GET 吃掉）
    const get = await worker.fetch(new Request('https://w.dev/outbox?since=0', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(get.status, 200);
    assert.equal((await decodeEncrypted(get)).entries.length, 2);

    // POST /outbox/ack 照常
    const ack = await worker.fetch(new Request('https://w.dev/outbox/ack', {
      method: 'POST', headers: ENC_HEADERS, body: await encBody({ messageIds: [ids[0]] }),
    }), env);
    assert.equal(ack.status, 200);
    assert.equal((await ack.json()).data.acked, 1);

    // DELETE /outbox/ack 不是一条路由 → 404（尾缀吃单的反向确认）
    const bogus = await worker.fetch(new Request('https://w.dev/outbox/ack', {
      method: 'DELETE', headers: ENC_HEADERS, body: await encBody({ all: true }),
    }), env);
    assert.equal(bogus.status, 404);
  });
});
