import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1, createSpyD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { deriveUserEncryptionKey, encryptPayload, decryptPayload, encryptForStorage, decryptFromStorage } from '../src/server/lib/encryption.js';
import { chunkNamespaceFor, chunkKeyFor, chunkKeyPrefixFor } from '../src/server/lib/state-chunks.js';
import { MAX_KEY_CHARS, writeClientStateEntries } from '../src/server/lib/client-state-store.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

// 测试里的「服务端当前时间」。条件写要拿它认出「来自未来」的脏行，所以时间戳
// 必须围着它排，不能再用 100 / 200 这种小数字。
const SERVER_NOW = 1_700_000_000_000;
const ONE_DAY = 24 * 60 * 60 * 1000;

// D1 把 SQLite 的 SQLITE_LIMIT_LIKE_PATTERN_LENGTH 压到了 50 字节（SQLite 默认
// 50000）。超过这个长度的 LIKE / GLOB pattern 在真实 D1 上直接报
// `LIKE or GLOB pattern too complex: SQLITE_ERROR`，而 batch() 是原子的——一条
// cleanup 炸掉，同批的 upsert 全部回滚。
const D1_LIKE_PATTERN_MAX_BYTES = 50;

const utf8ByteLength = (value) => new TextEncoder().encode(value).length;

/**
 * 一条语句里每个 LIKE / GLOB 右操作数（`?`）绑到的值。
 * SQL 里只有位置参数，数一下这个 `?` 前面有几个 `?` 就知道它是第几个绑定值。
 */
function likePatternArgs({ sql, args }) {
  const patterns = [];
  const re = /\b(?:LIKE|GLOB)\s*\?/gi;
  let match;
  while ((match = re.exec(sql)) !== null) {
    const questionIndex = sql.indexOf('?', match.index);
    const paramIndex = (sql.slice(0, questionIndex).match(/\?/g) || []).length;
    patterns.push(args[paramIndex]);
  }
  return patterns;
}

describe('D1 adapter client_state', () => {
  test('initSchema creates client_state; upsert is last-write-wins on updatedAt', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();

    let r = await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'k1', value: 'enc-v1', updatedAt: 100 },
      { namespace: 'notes', key: 'k2', value: 'enc-v2', updatedAt: 100 },
    ]);
    assert.deepEqual(r, { upserted: 2, skipped: 0, outcomes: [true, true] });

    // older than stored → skip; equal-or-newer → overwrite
    r = await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'k1', value: 'enc-old', updatedAt: 50 },
      { namespace: 'notes', key: 'k2', value: 'enc-new', updatedAt: 200 },
    ]);
    assert.deepEqual(r, { upserted: 1, skipped: 1, outcomes: [false, true] });

    const rows = await adapter.getClientState(USER, 'notes');
    assert.deepEqual(
      rows.map((x) => [x.key, x.value, x.updated_at]),
      [['k1', 'enc-v1', 100], ['k2', 'enc-new', 200]]
    );
    // namespace isolation
    assert.deepEqual(await adapter.getClientState(USER, 'other'), []);
  });

  test('clearClientState wipes only that user', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const OTHER = '660e8400-e29b-41d4-a716-446655440000';
    await adapter.upsertClientState(USER, [{ namespace: 'n', key: 'k', value: 'v', updatedAt: 1 }]);
    await adapter.upsertClientState(OTHER, [{ namespace: 'n', key: 'k', value: 'v', updatedAt: 1 }]);
    assert.equal(await adapter.clearClientState(USER), 1);
    assert.deepEqual(await adapter.getClientState(USER, 'n'), []);
    assert.equal((await adapter.getClientState(OTHER, 'n')).length, 1);
  });

  // The client uploads inside its few-seconds background window, so the
  // whole batch must go out in ONE D1 round trip when the binding supports
  // batch(). Bindings without batch() (custom adapters) must still work.
  test('upsertClientState uses db.batch when available, sequential fallback otherwise', async () => {
    // batch path: spy on the shim's batch — one call for the whole set
    const d1 = createTestD1();
    let batchCalls = 0;
    const origBatch = d1.batch;
    d1.batch = async (statements) => { batchCalls++; return origBatch(statements); };
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    const r = await adapter.upsertClientState(USER, [
      { namespace: 'n', key: 'a', value: 'v1', updatedAt: 2 },
      { namespace: 'n', key: 'b', value: 'v2', updatedAt: 2 },
      { namespace: 'n', key: 'a', value: 'old', updatedAt: 1 }, // stale → skipped
    ]);
    assert.deepEqual(r, { upserted: 2, skipped: 1, outcomes: [true, true, false] });
    assert.equal(batchCalls, 1);

    // fallback path: binding without batch() gives identical results
    const d1b = createTestD1();
    const adapter2 = createD1Adapter({ prepare: d1b.prepare });
    await adapter2.initSchema();
    const r2 = await adapter2.upsertClientState(USER, [
      { namespace: 'n', key: 'a', value: 'v1', updatedAt: 2 },
      { namespace: 'n', key: 'a', value: 'old', updatedAt: 1 },
    ]);
    assert.deepEqual(r2, { upserted: 1, skipped: 1, outcomes: [true, false] });
    assert.deepEqual(
      (await adapter2.getClientState(USER, 'n')).map((x) => [x.key, x.value]),
      [['a', 'v1']]
    );
  });

  test('cleanups：前缀删除只删自己 key 的切片、尊重 LWW、% 不当通配符使', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const chunkNs = chunkNamespaceFor('n');
    await adapter.upsertClientState(USER, [
      { namespace: chunkNs, key: chunkKeyFor('a', 0), value: 'c0', updatedAt: 100 },
      { namespace: chunkNs, key: chunkKeyFor('a', 1), value: 'c1', updatedAt: 100 },
      { namespace: chunkNs, key: chunkKeyFor('ab', 0), value: 'other-key', updatedAt: 100 },
      { namespace: chunkNs, key: chunkKeyFor('a%b', 0), value: 'pct-key', updatedAt: 100 },
    ]);

    // 清 key 'a' 的切片：'ab' / 'a%b' 的不受影响（\u001f 分隔符挡住前缀误伤）
    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: chunkKeyPrefixFor('a'), updatedAt: 150 },
    ]);
    let keys = (await adapter.getClientState(USER, chunkNs)).map((r) => r.key).sort();
    assert.deepEqual(keys, [chunkKeyFor('a%b', 0), chunkKeyFor('ab', 0)].sort());

    // 清 'a%b' 的切片：% 不能当通配符把 'ab' 的也带走
    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: chunkKeyPrefixFor('a%b'), updatedAt: 150 },
    ]);
    keys = (await adapter.getClientState(USER, chunkNs)).map((r) => r.key);
    assert.deepEqual(keys, [chunkKeyFor('ab', 0)]);

    // 陈旧批次（updatedAt 更老）的 cleanup 删不动更新的行
    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: chunkKeyPrefixFor('ab'), updatedAt: 50 },
    ]);
    assert.equal((await adapter.getClientState(USER, chunkNs)).length, 1);

    // cleanup + upsert 同批：先删后写，同一 key 的新切片完整落库
    const r = await adapter.upsertClientState(USER, [
      { namespace: chunkNs, key: chunkKeyFor('ab', 0), value: 'new0', updatedAt: 200 },
      { namespace: chunkNs, key: chunkKeyFor('ab', 1), value: 'new1', updatedAt: 200 },
    ], [
      { namespace: chunkNs, keyPrefix: chunkKeyPrefixFor('ab'), updatedAt: 200 },
    ]);
    assert.deepEqual(r, { upserted: 2, skipped: 0, outcomes: [true, true] });
    assert.deepEqual(
      (await adapter.getClientState(USER, chunkNs)).map((x) => [x.key, x.value]),
      [[chunkKeyFor('ab', 0), 'new0'], [chunkKeyFor('ab', 1), 'new1']]
    );
  });

  // 回归守卫，盯的是「发出去的 SQL 长什么样」而不是执行结果：本地跑的是
  // better-sqlite3，它的 LIKE pattern 上限是 SQLite 默认的 50000，长 pattern
  // 在这里根本不报错，只有真实 D1 才炸。所以断言必须落在绑定值的字节长度上。
  test('前缀清理不给 SQL 喂超长 LIKE / GLOB pattern（D1 上限 50 字节）', async () => {
    const { db, calls } = createSpyD1();
    const adapter = createD1Adapter(db);
    await adapter.initSchema();

    // 真实事故形态：`emotion_update:<UUID>` = 51 字符。key 里还带一个下划线，
    // LIKE 写法要转义它，pattern 因此更长。
    const key = `emotion_update:${USER}`;
    assert.equal(key.length, 51);
    calls.length = 0;
    await adapter.upsertClientState(
      USER,
      [{ namespace: 'n', key, value: 'enc', updatedAt: 100 }],
      [{ namespace: chunkNamespaceFor('n'), keyPrefix: chunkKeyPrefixFor(key), updatedAt: 100 }]
    );

    const cleanupCalls = calls.filter((c) => /DELETE\s+FROM\s+client_state/i.test(c.sql));
    assert.equal(cleanupCalls.length, 1, '这一批应该发出一条前缀清理语句');

    for (const call of calls) {
      for (const pattern of likePatternArgs(call)) {
        assert.ok(
          typeof pattern === 'string' && utf8ByteLength(pattern) <= D1_LIKE_PATTERN_MAX_BYTES,
          `LIKE / GLOB pattern 超过 D1 的 ${D1_LIKE_PATTERN_MAX_BYTES} 字节上限：` +
          `${utf8ByteLength(String(pattern))} 字节，语句 ${call.sql}`
        );
      }
    }
  });

  test('长 key 的切片清理：51 / 256 字符照样清得掉，根行留着，特殊字符不误伤', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const chunkNs = chunkNamespaceFor('n');

    const longKey = `emotion_update:${USER}`;               // 51 字符，真实事故形态
    const maxKey = 'k'.repeat(MAX_KEY_CHARS);               // 契约上限 256 字符
    const wildKey = `${'w'.repeat(60)}%_\\`;                // 长且带 % _ \ 三种特殊字符
    const wildSibling = `${'w'.repeat(60)}%_\\x`;           // 只多一个字符的兄弟 key
    assert.equal(maxKey.length, MAX_KEY_CHARS);

    const rows = [
      { namespace: 'n', key: longKey, value: 'root-long', updatedAt: 100 },
      { namespace: chunkNs, key: chunkKeyFor(longKey, 0), value: 'c0', updatedAt: 100 },
      { namespace: chunkNs, key: chunkKeyFor(longKey, 1), value: 'c1', updatedAt: 100 },
      { namespace: chunkNs, key: chunkKeyFor(`${longKey}-sibling`, 0), value: 'sib', updatedAt: 100 },
      { namespace: chunkNs, key: chunkKeyFor(maxKey, 0), value: 'max0', updatedAt: 100 },
      { namespace: chunkNs, key: chunkKeyFor(wildKey, 0), value: 'wild0', updatedAt: 100 },
      { namespace: chunkNs, key: chunkKeyFor(wildSibling, 0), value: 'wild-sib', updatedAt: 100 },
    ];
    const initial = await adapter.upsertClientState(USER, rows);
    assert.equal(initial.upserted, rows.length);

    // 51 字符的 key：自己的切片清干净，兄弟 key 的切片和用户 namespace 的根行都在
    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: chunkKeyPrefixFor(longKey), updatedAt: 150 },
    ]);
    let keys = (await adapter.getClientState(USER, chunkNs)).map((r) => r.key);
    assert.ok(!keys.includes(chunkKeyFor(longKey, 0)) && !keys.includes(chunkKeyFor(longKey, 1)));
    assert.ok(keys.includes(chunkKeyFor(`${longKey}-sibling`, 0)));
    assert.deepEqual(
      (await adapter.getClientState(USER, 'n')).map((r) => [r.key, r.value]),
      [[longKey, 'root-long']]
    );

    // 带 % _ \ 的长 key：前缀只匹配自己，多一个字符的兄弟 key 不受影响
    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: chunkKeyPrefixFor(wildKey), updatedAt: 150 },
    ]);
    keys = (await adapter.getClientState(USER, chunkNs)).map((r) => r.key);
    assert.ok(!keys.includes(chunkKeyFor(wildKey, 0)));
    assert.ok(keys.includes(chunkKeyFor(wildSibling, 0)));

    // 256 字符的 key：陈旧批次删不动（LWW），更新的批次才删得掉
    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: chunkKeyPrefixFor(maxKey), updatedAt: 50 },
    ]);
    keys = (await adapter.getClientState(USER, chunkNs)).map((r) => r.key);
    assert.ok(keys.includes(chunkKeyFor(maxKey, 0)), '陈旧 cleanup 不该删掉更新的行');

    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: chunkKeyPrefixFor(maxKey), updatedAt: 200 },
    ]);
    keys = (await adapter.getClientState(USER, chunkNs)).map((r) => r.key).sort();
    assert.deepEqual(keys, [
      chunkKeyFor(`${longKey}-sibling`, 0),
      chunkKeyFor(wildSibling, 0),
    ].sort());
  });

  // 设备时钟跑偏的死锁，回归守卫。客户端报上来的 updated_at 只要领先过真实时间
  // （用户改过系统时间、时区/日期误操作），那一刻同步上去的行就带着一个还没到的
  // 时刻；之后这台设备每次上传都比它「旧」，条件写无声跳过，云端那行要等真实时间
  // 追上来才解得开——删本地数据、重装 PWA 都碰不到它。合法写入不可能来自未来，
  // 所以这种行按脏数据处理，条件写放行覆盖。
  test('库里那行来自未来：正常时间戳的写入覆盖得掉（设备时钟跑偏不再锁死）', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();

    // 时钟领先一天的设备同步上来的行
    await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'k', value: 'from-skewed-clock', updatedAt: SERVER_NOW + ONE_DAY },
    ], [], SERVER_NOW);

    // 时间调回来之后的正常写入：拿服务端的钟一比就知道库里那行是脏的，放行覆盖
    const r = await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'k', value: 'fresh', updatedAt: SERVER_NOW },
    ], [], SERVER_NOW);
    assert.deepEqual(r, { upserted: 1, skipped: 0, outcomes: [true] });
    assert.deepEqual(
      (await adapter.getClientState(USER, 'notes')).map((x) => [x.value, x.updated_at]),
      [['fresh', SERVER_NOW]]
    );
  });

  test('放行未来行不动摇旧不盖新：过去的行照旧拦，相同时间戳照旧覆盖', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'k', value: 'stored', updatedAt: SERVER_NOW - 1000 },
    ], [], SERVER_NOW);

    // 库里那行是过去的、没跑偏，更旧的写入照旧被跳过
    const stale = await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'k', value: 'stale', updatedAt: SERVER_NOW - 2000 },
    ], [], SERVER_NOW);
    assert.deepEqual(stale, { upserted: 0, skipped: 1, outcomes: [false] });
    assert.equal((await adapter.getClientState(USER, 'notes'))[0].value, 'stored');

    // 相同时间戳仍然覆盖（条件是 >=，不是 >）
    const same = await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'k', value: 'same-ts', updatedAt: SERVER_NOW - 1000 },
    ], [], SERVER_NOW);
    assert.deepEqual(same, { upserted: 1, skipped: 0, outcomes: [true] });
    assert.equal((await adapter.getClientState(USER, 'notes'))[0].value, 'same-ts');
  });

  test('清理 DELETE：未来时间戳的行也删得掉，不留孤儿切片', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const chunkNs = chunkNamespaceFor('n');
    const future = SERVER_NOW + ONE_DAY;

    await adapter.upsertClientState(USER, [
      { namespace: 'n', key: 'k', value: 'root', updatedAt: future },
      { namespace: chunkNs, key: chunkKeyFor('k', 0), value: 'c0', updatedAt: future },
      { namespace: chunkNs, key: chunkKeyFor('k', 1), value: 'c1', updatedAt: future },
      { namespace: chunkNs, key: chunkKeyFor('sibling', 0), value: 'sib', updatedAt: SERVER_NOW - 1000 },
    ], [], SERVER_NOW);

    // 前缀清理（切片行）和精确 key 清理（根行）两条 DELETE 都得认未来行，
    // 否则删一条状态时切片留在库里成孤儿，读回来还是缺块。
    await adapter.upsertClientState(USER, [], [
      { namespace: chunkNs, keyPrefix: chunkKeyPrefixFor('k'), updatedAt: SERVER_NOW },
      { namespace: 'n', key: 'k', updatedAt: SERVER_NOW },
    ], SERVER_NOW);

    assert.deepEqual(await adapter.getClientState(USER, 'n'), []);
    assert.deepEqual(
      (await adapter.getClientState(USER, chunkNs)).map((r) => r.key),
      [chunkKeyFor('sibling', 0)],
      '别人的切片行不该被连累'
    );
  });
});

describe('writeClientStateEntries 的服务端时钟护栏', () => {
  const setup = async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const write = (entries, now = () => SERVER_NOW) => writeClientStateEntries({
      db: adapter, userId: USER, userKey, entries, now,
    });
    return { adapter, userKey, write };
  };

  // 护栏值钳到服务端当前时刻。不钳的话，时钟领先的那台设备写下的行会一直压着别人
  // ——内容更旧也盖不过去，而这个偏差是持续的，不像网络抖动会自己过去。
  test('设备时钟领先时，落库的是服务端时刻而不是那个未来值', async () => {
    const { adapter, write } = await setup();

    await write([{ namespace: 'n', key: 'k', value: 'from-skewed-clock', updatedAt: SERVER_NOW + ONE_DAY }]);

    const rows = await adapter.getClientState(USER, 'n');
    assert.equal(rows[0].updated_at, SERVER_NOW, '未来值应被钳到服务端当前时刻');
  });

  test('钳制不碰正常路径：过去的时间戳原样落库，慢包后到照旧被拦', async () => {
    const { adapter, write } = await setup();

    // 客户端时钟正常，构建时刻就是护栏值，一个字不改
    await write([{ namespace: 'n', key: 'k', value: 'built-at-T2', updatedAt: SERVER_NOW - 2000 }]);
    assert.equal((await adapter.getClientState(USER, 'n'))[0].updated_at, SERVER_NOW - 2000);

    // 更早构建、更晚到达的那一份仍然被拦下——乱序保护不受钳制影响
    const late = await write([{ namespace: 'n', key: 'k', value: 'built-at-T1-arrived-late', updatedAt: SERVER_NOW - 5000 }]);
    assert.deepEqual(late, {
      upserted: 0, skipped: 1, deleted: 0, skippedEntries: [{ namespace: 'n', key: 'k' }],
    });
  });

  test('同一批共用一个钳制基准，不会一条一个时刻', async () => {
    const { adapter, write } = await setup();
    // 每次调用都往前走一秒：整批取两次以上的话，同批条目会落到不同的 updated_at
    let tick = 0;
    const marchingClock = () => SERVER_NOW + (tick++) * 1000;

    await write([
      { namespace: 'n', key: 'a', value: 'A', updatedAt: SERVER_NOW + ONE_DAY },
      { namespace: 'n', key: 'b', value: 'B', updatedAt: SERVER_NOW + ONE_DAY },
    ], marchingClock);

    const stamps = (await adapter.getClientState(USER, 'n')).map((r) => r.updated_at);
    assert.equal(new Set(stamps).size, 1, '同一批的条目必须落在同一个时刻上');
  });

  // 钳制之后这条路自己写不出未来行了，但钳制上线**之前**留下的还在库里，
  // 放行那条得继续管用——否则那些行反而被焊死（客户端再也盖不过去）。
  test('遗留的未来行仍然覆盖得掉，之后旧不盖新立刻恢复', async () => {
    const { adapter, userKey, write } = await setup();

    // 绕过钳制直接落一行未来的，模拟上个版本留下的脏数据
    await adapter.upsertClientState(USER, [{
      namespace: 'n', key: 'k',
      value: await encryptForStorage('legacy-future-row', userKey),
      updatedAt: SERVER_NOW + ONE_DAY,
    }], [], SERVER_NOW + ONE_DAY + 1);

    const recovered = await write([{ namespace: 'n', key: 'k', value: 'fresh', updatedAt: SERVER_NOW }]);
    assert.deepEqual(recovered, { upserted: 1, skipped: 0, deleted: 0, skippedEntries: [] });

    const stale = await write([{ namespace: 'n', key: 'k', value: 'stale', updatedAt: SERVER_NOW - 1000 }]);
    assert.deepEqual(stale, {
      upserted: 0, skipped: 1, deleted: 0, skippedEntries: [{ namespace: 'n', key: 'k' }],
    });

    const rows = await adapter.getClientState(USER, 'n');
    assert.equal(rows.length, 1);
    assert.equal(await decryptFromStorage(rows[0].value, userKey), 'fresh');
  });
});

// ─── /client-state endpoints ─────────────────────────────────────────────────

function makeWorker(d1, extra = {}) {
  return createSingleUserCloudflareWorker((env) => ({
    db: createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} },
    ...extra,
  }));
}

const ENC_HEADERS = { 'X-User-Id': USER, 'X-Payload-Encrypted': 'true', 'X-Encryption-Version': '1' };

async function putState(worker, env, entries, headers = ENC_HEADERS) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const body = JSON.stringify(await encryptPayload({ entries }, userKey));
  return worker.fetch(new Request('https://w.dev/client-state', { method: 'PUT', headers, body }), env);
}

describe('/client-state endpoints', () => {
  test('PUT upsert → GET decrypted roundtrip → DELETE wipes', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const putRes = await putState(worker, env, [
      { namespace: 'notes', key: 'k1', value: JSON.stringify({ a: 1 }), updatedAt: 100 },
      { namespace: 'notes', key: 'k2', value: 'plain text', updatedAt: 100 },
    ]);
    assert.equal(putRes.status, 200);
    assert.deepEqual((await putRes.json()).data, { upserted: 2, skipped: 0 });

    // stale entry is skipped
    const putRes2 = await putState(worker, env, [
      { namespace: 'notes', key: 'k1', value: 'stale', updatedAt: 50 },
    ]);
    assert.deepEqual((await putRes2.json()).data, { upserted: 0, skipped: 1, skippedEntries: [{ namespace: 'notes', key: 'k1' }] });

    const getRes = await worker.fetch(new Request('https://w.dev/client-state?namespace=notes', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.encrypted, true);
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const data = await decryptPayload(getBody.data, userKey);
    assert.deepEqual(
      data.entries.map((e) => [e.namespace, e.key, e.value, e.updatedAt]),
      [['notes', 'k1', JSON.stringify({ a: 1 }), 100], ['notes', 'k2', 'plain text', 100]]
    );

    const delRes = await worker.fetch(new Request('https://w.dev/client-state', {
      method: 'DELETE', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(delRes.status, 200);
    assert.equal((await delRes.json()).data.deleted, 2);

    const getRes2 = await worker.fetch(new Request('https://w.dev/client-state?namespace=notes', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    const data2 = await decryptPayload((await getRes2.json()).data, userKey);
    assert.deepEqual(data2.entries, []);
  });

  // 读一个 namespace 并解密（拼回后的逻辑条目视图）
  async function getEntries(worker, env, namespace) {
    const getRes = await worker.fetch(new Request(
      `https://w.dev/client-state?namespace=${encodeURIComponent(namespace)}`,
      { method: 'GET', headers: { 'X-User-Id': USER } }
    ), env);
    assert.equal(getRes.status, 200);
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const data = await decryptPayload((await getRes.json()).data, userKey);
    return data.entries;
  }

  test('刚超 200KB：不再整批 413，分块入库后 GET 读回原值', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const value = 'x'.repeat(200 * 1024 + 1);
    const res = await putState(worker, env, [
      { namespace: 'n', key: 'big', value, updatedAt: 1 },
    ]);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data, { upserted: 1, skipped: 0 });

    const entries = await getEntries(worker, env, 'n');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].value, value);
  });

  test('中文大值分块：GET 拼回原值；物理存储 = 根 marker + 保留 ns 里的加密切片', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const bigValue = JSON.stringify({ v: 1, doc: '记'.repeat(120_000) }); // ~360KB → 2 片
    await putState(worker, env, [
      { namespace: 'notes', key: 'big', value: bigValue, updatedAt: 100 },
      { namespace: 'notes', key: 'small', value: 'tiny', updatedAt: 100 },
    ]);

    const entries = await getEntries(worker, env, 'notes');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].key, 'big');
    assert.equal(entries[0].value, bigValue);
    assert.deepEqual(entries[1], { namespace: 'notes', key: 'small', value: 'tiny', updatedAt: 100 });

    const adapter = createD1Adapter(d1);
    const userRows = await adapter.getClientState(USER, 'notes');
    assert.equal(userRows.length, 2); // 用户 namespace 里只有逻辑条目的行
    const rootRow = userRows.find((r) => r.key === 'big');
    assert.equal(rootRow.value.charCodeAt(0), 0x1f, '分块根行是 marker');
    const chunkRows = await adapter.getClientState(USER, chunkNamespaceFor('notes'));
    assert.equal(chunkRows.length, 2);
    for (const row of chunkRows) assert.match(row.value, /^[0-9a-f]+:[0-9a-f]+:/); // 切片是密文
  });

  test('覆盖写变小 / 缩块：旧切片行清干净，读到的始终是最新值', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const adapter = createD1Adapter(d1);
    const chunkNs = chunkNamespaceFor('n');

    // 大(2片) → 小(单行)：切片全清
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: '记'.repeat(120_000), updatedAt: 100 }]);
    assert.equal((await adapter.getClientState(USER, chunkNs)).length, 2);
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: 'small-now', updatedAt: 200 }]);
    assert.deepEqual(await adapter.getClientState(USER, chunkNs), []);
    let entries = await getEntries(worker, env, 'n');
    assert.deepEqual(entries.map((e) => [e.key, e.value]), [['k', 'small-now']]);

    // 大(3片) → 大(2片)：尾片不残留
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: '记'.repeat(200_000), updatedAt: 300 }]);
    assert.equal((await adapter.getClientState(USER, chunkNs)).length, 3);
    const two = '记'.repeat(120_000);
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: two, updatedAt: 400 }]);
    assert.equal((await adapter.getClientState(USER, chunkNs)).length, 2);
    entries = await getEntries(worker, env, 'n');
    assert.equal(entries[0].value, two);
  });

  test('陈旧的分块写入动不了更新的值（LWW 对分块路径成立）', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: 'fresh', updatedAt: 500 }]);
    const stale = await putState(worker, env, [
      { namespace: 'n', key: 'k', value: '记'.repeat(120_000), updatedAt: 100 },
    ]);
    assert.deepEqual((await stale.json()).data, { upserted: 0, skipped: 1, skippedEntries: [{ namespace: 'n', key: 'k' }] });
    const entries = await getEntries(worker, env, 'n');
    assert.deepEqual(entries.map((e) => [e.key, e.value]), [['k', 'fresh']]);
  });

  test('整批局部失败：坏条目逐条拒绝，好条目照常入库；全成功响应不带 rejected', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const res = await putState(worker, env, [
      { namespace: 'n', key: 'good', value: 'v', updatedAt: 100 },
      { namespace: 'n', key: 'bad-ts', value: 'v', updatedAt: -1 },
      { namespace: 'n', key: 'huge', value: 'x'.repeat(6 * 1024 * 1024), updatedAt: 100 },
      { namespace: 'n\u0000ctl', key: 'k', value: 'v', updatedAt: 100 },
    ]);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.upserted, 1);
    assert.deepEqual(
      body.data.rejected.map((r) => [r.index, r.code]),
      [[1, 'INVALID_STATE_UPDATED_AT'], [2, 'STATE_VALUE_TOO_LARGE'], [3, 'INVALID_STATE_NAMESPACE']]
    );
    const oversized = body.data.rejected.find((r) => r.code === 'STATE_VALUE_TOO_LARGE');
    assert.equal(oversized.maxBytes, 5 * 1024 * 1024);
    assert.equal(oversized.key, 'huge');

    const entries = await getEntries(worker, env, 'n');
    assert.deepEqual(entries.map((e) => e.key), ['good']);

    // 全成功响应形状不变（老客户端无感）
    const okRes = await putState(worker, env, [{ namespace: 'n', key: 'k2', value: 'v', updatedAt: 1 }]);
    assert.deepEqual(Object.keys((await okRes.json()).data).sort(), ['skipped', 'upserted']);
  });

  test('工厂配置 maxStateValueBytes 调总上限；GET 保留 namespace → 400', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1, { maxStateValueBytes: 1024 });
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const res = await putState(worker, env, [
      { namespace: 'n', key: 'over', value: 'x'.repeat(2000), updatedAt: 1 },
      { namespace: 'n', key: 'under', value: 'x'.repeat(500), updatedAt: 1 },
    ]);
    const body = await res.json();
    assert.equal(body.data.upserted, 1);
    assert.deepEqual(
      body.data.rejected.map((r) => [r.key, r.code, r.maxBytes]),
      [['over', 'STATE_VALUE_TOO_LARGE', 1024]]
    );

    const badNs = await worker.fetch(new Request(
      `https://w.dev/client-state?namespace=${encodeURIComponent(chunkNamespaceFor('n'))}`,
      { method: 'GET', headers: { 'X-User-Id': USER } }
    ), env);
    assert.equal(badNs.status, 400);
    assert.equal((await badNs.json()).error.code, 'INVALID_STATE_NAMESPACE');
  });

  test('validation: non-array/empty entries → 400; missing namespace → 400; stored value is ciphertext', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const bad = await putState(worker, env, 'not-an-array');
    assert.equal(bad.status, 400);
    const empty = await putState(worker, env, []);
    assert.equal(empty.status, 400);

    const noNs = await worker.fetch(new Request('https://w.dev/client-state', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(noNs.status, 400);
    assert.equal((await noNs.json()).error.code, 'NAMESPACE_REQUIRED');

    // what lands in the DB is encryptForStorage ciphertext, not plaintext
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: 'SECRET-PLAINTEXT', updatedAt: 1 }]);
    const adapter = createD1Adapter(d1);
    const raw = await adapter.getClientState(USER, 'n');
    assert.equal(raw.length, 1);
    assert.notEqual(raw[0].value, 'SECRET-PLAINTEXT');
    assert.match(raw[0].value, /^[0-9a-f]+:[0-9a-f]+:/); // iv:authTag:cipher
  });

  test('PUT unencrypted body → 400 ENCRYPTION_REQUIRED; serverToken set → all three endpoints 401 without token', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1, { serverToken: 's3cret' });
    const env = { DB: d1 };
    for (const [method, url] of [
      ['PUT', 'https://w.dev/client-state'],
      ['GET', 'https://w.dev/client-state?namespace=n'],
      ['DELETE', 'https://w.dev/client-state'],
    ]) {
      const res = await worker.fetch(new Request(url, { method, headers: { 'X-User-Id': USER } }), env);
      assert.equal(res.status, 401, `${method} without token must be 401`);
    }

    const d1b = createTestD1();
    const worker2 = makeWorker(d1b);
    await worker2.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), { DB: d1b });
    const plain = await worker2.fetch(new Request('https://w.dev/client-state', {
      method: 'PUT', headers: { 'X-User-Id': USER }, body: JSON.stringify({ entries: [] }),
    }), { DB: d1b });
    assert.equal(plain.status, 400);
    assert.equal((await plain.json()).error.code, 'ENCRYPTION_REQUIRED');
  });
});
