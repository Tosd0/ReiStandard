/**
 * pg / neon 适配器的占位 SQL 测试。
 *
 * 这两个适配器要连真 Postgres 才跑得起来，CI 里没有，所以这里换个打法：
 * 塞一个假的查询执行器进去，把适配器真正发出去的 SQL 和参数录下来，对着
 * 断言。能钉住的是「语句长什么样」——CAS 条件、租约条件、参数顺序、返回值
 * 怎么从行数推出来；钉不住的是「Postgres 执行这条语句的结果对不对」，那部
 * 分由 D1 适配器的行为测试（跑真 SQLite）覆盖，两边 SQL 的语义是对齐的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PgAdapter } from '../src/server/adapters/pg.js';
import { NeonAdapter } from '../src/server/adapters/neon.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSpyD1 } from './helpers/sqlite-d1.mjs';

/** 把 SQL 压成单行，断言时不用管缩进。 */
const flat = (text) => text.replace(/\s+/g, ' ').trim();

/** SET 子句里写了哪些列（用来确认占位没动 next_send_at）。 */
function setClauseOf(text) {
  const match = flat(text).match(/\bSET\b(.*?)\bWHERE\b/i);
  assert.ok(match, `语句里没找到 SET ... WHERE：${text}`);
  return match[1];
}

/** SELECT 出来的列，按出现顺序。 */
function selectedColumns(text) {
  const match = flat(text).match(/^SELECT\s+(.+?)\s+FROM scheduled_messages\b/i);
  assert.ok(match, `不是一条 scheduled_messages 的 SELECT：${text}`);
  return match[1].split(',').map((column) => column.trim());
}

/**
 * 两个适配器的驱动接口形状不同：pg 的 pool.query 返回 { rows }，neon 的
 * sql.query 直接返回行数组。各自塞对应的假执行器，其余代码走真的。
 */
function recordingPg(rowsFor = () => []) {
  const calls = [];
  const adapter = new PgAdapter('postgres://test');
  adapter._pool = {
    async query(text, params) {
      calls.push({ text, params });
      return { rows: rowsFor(text) };
    }
  };
  return { adapter, calls };
}

function recordingNeon(rowsFor = () => []) {
  const calls = [];
  const adapter = new NeonAdapter('postgres://test');
  adapter._sql = {
    async query(text, params) {
      calls.push({ text, params });
      return rowsFor(text);
    }
  };
  return { adapter, calls };
}

const BACKENDS = [
  { name: 'pg', make: recordingPg },
  { name: 'neon', make: recordingNeon }
];

for (const backend of BACKENDS) {
  test(`${backend.name}: claimTask 写租约，不动 next_send_at`, async () => {
    const { adapter, calls } = backend.make(() => [{ id: 1 }]);
    const lease = '2026-01-01T00:10:00.000Z';

    assert.equal(await adapter.claimTask(7, '2026-01-01T00:00:00.000Z', lease), true);

    const { text, params } = calls.at(-1);
    const setClause = setClauseOf(text);
    assert.match(setClause, /lease_until\s*=\s*\$1/);
    assert.doesNotMatch(setClause, /next_send_at/, '占位不该改用户设的触发时刻');
    assert.deepEqual(params, [lease, 7, '2026-01-01T00:00:00.000Z']);
  });

  test(`${backend.name}: claimTask 的 WHERE 同时挡住「别人拿着租约」和「排期被改过」`, async () => {
    const { adapter, calls } = backend.make(() => [{ id: 1 }]);
    await adapter.claimTask(7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z');

    const where = flat(calls.at(-1).text).split(/\bWHERE\b/i)[1];
    // 租约为空或已到期才领得走。
    assert.match(where, /lease_until IS NULL OR lease_until <= NOW\(\)/i);
    // 读出来之后排期被改过就不发了；毫秒截断是为了绕开 timestamptz 的亚毫秒差。
    assert.match(where, /date_trunc\('milliseconds', next_send_at\)/i);
    assert.match(where, /status = 'pending'/i);
  });

  // 分组串行：判定和占位必须在同一条语句里。拆成「先查这组忙不忙、再占位」的
  // 话，两个 tick 的查询都会在对方占位之前返回「不忙」，双双进同一个分组。
  // 占位提交之后另有一次复查（READ COMMITTED 写偏斜的收口，见 pg-shared.js）：
  // 两个 tick 各领同组「不同」行时 NOT EXISTS 互相看不见对方未提交的租约，
  // 复查发生在自己的租约提交之后，至少一方看得见冲突并让路。
  test(`${backend.name}: 带 serializeGroup 时，分组判定和占位是同一条 UPDATE`, async () => {
    const { adapter, calls } = backend.make((text) =>
      /^\s*SELECT 1 FROM scheduled_messages busy/i.test(text) ? [] : [{ id: 1 }]
    );
    const lease = '2026-01-01T00:10:00.000Z';

    assert.equal(await adapter.claimTask(7, '2026-01-01T00:00:00.000Z', lease, 'grp-abc'), true);

    assert.equal(calls.length, 2, '判定+占位合一的 UPDATE，加一次占位提交后的复查');
    const { text, params } = calls[0];
    // 子查询自带 WHERE，这里就不切段了，直接对整条语句断言。
    const sql = flat(text);
    // 同一分组里有别的行拿着未到期的租约就领不走。
    assert.match(sql, /NOT EXISTS/i);
    assert.match(sql, /busy\.serialize_group = \$4/i);
    assert.match(sql, /busy\.lease_until > NOW\(\)/i);
    // 退避中的任务闲着，不算「这个分组忙着」。
    assert.doesNotMatch(sql, /busy\.retry_after/i);
    // 领到的同时把分组写在行上，下一跳靠它判断这组忙不忙。
    assert.match(setClauseOf(text), /serialize_group\s*=\s*\$4/);
    assert.deepEqual(params, [lease, 7, '2026-01-01T00:00:00.000Z', 'grp-abc']);
    // 复查只看同组其他行的活租约。
    const verify = flat(calls[1].text);
    assert.match(verify, /^SELECT 1 FROM scheduled_messages busy/i);
    assert.match(verify, /busy\.lease_until > NOW\(\)/i);
    assert.deepEqual(calls[1].params, ['grp-abc', 7]);
  });

  test(`${backend.name}: 占位后复查撞上同组另一条活租约 → 放掉租约、返回 false`, async () => {
    const { adapter, calls } = backend.make((text) =>
      /^\s*SELECT 1 FROM scheduled_messages busy/i.test(text) ? [{ ok: 1 }] : [{ id: 1 }]
    );

    assert.equal(
      await adapter.claimTask(7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z', 'grp-abc'),
      false
    );

    // 最后一条语句把自己刚写的租约放掉（两边都让路也没事：行保持 pending，
    // 下一跳重试）。
    const release = flat(calls.at(-1).text);
    assert.match(release, /SET lease_until = NULL/i);
    assert.match(release, /WHERE id = \$1/i);
    assert.deepEqual(calls.at(-1).params, [7]);
  });

  test(`${backend.name}: 不传 serializeGroup 时语句里没有分组门`, async () => {
    const { adapter, calls } = backend.make(() => [{ id: 1 }]);
    await adapter.claimTask(7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z');

    const text = flat(calls.at(-1).text);
    assert.doesNotMatch(text, /NOT EXISTS/i);
    assert.doesNotMatch(text, /serialize_group/i);
  });

  test(`${backend.name}: 改到 0 行就是没领到`, async () => {
    const { adapter } = backend.make(() => []);
    assert.equal(
      await adapter.claimTask(7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z'),
      false
    );
  });

  test(`${backend.name}: getPendingTasks 跳过租约没到期、退避没到点的行`, async () => {
    const { adapter, calls } = backend.make(() => []);
    await adapter.getPendingTasks(50);

    const text = flat(calls.at(-1).text);
    assert.match(text, /lease_until IS NULL OR lease_until <= NOW\(\)/i);
    assert.match(text, /retry_after IS NULL OR retry_after <= NOW\(\)/i);
    assert.match(text, /next_send_at <= NOW\(\)/i);
  });

  test(`${backend.name}: initSchema 给老表补上 lease_until 列`, async () => {
    // initSchema 末尾要验证建表结果，这两个查询得有行返回，否则它会抛错。
    const { adapter, calls } = backend.make((text) =>
      /information_schema/i.test(text) ? [{ table_name: 'scheduled_messages', column_name: 'id' }] : []
    );
    await adapter.initSchema();

    for (const column of ['lease_until', 'retry_after', 'serialize_group']) {
      const altered = calls.some((c) =>
        new RegExp(`ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS ${column}`, 'i').test(flat(c.text))
      );
      assert.ok(altered, `initSchema 应该给已有的表补 ${column} 列`);
    }
  });
}

// ── 任务行的列集：三个适配器必须一致 ──────────────────────────────────────
//
// 取任务行的四个方法分两条链路，各要一套列：投递链路（getTaskByUuidOnly /
// getPendingTasks）和读接口（getTaskByUuid / listTasks）。以前三个适配器各写
// 各的 SELECT 列表，加列时漏掉其中一个不会有任何报错——pg / neon 的
// getTaskByUuidOnly 就这么漏了 retry_after，run-tick 的退避守卫在这两种部署上
// 整个失效（读到的永远是 undefined），还在等重试的任务被 runTask 当场再跑一
// 遍。现在列集收在 adapters/schema.js 里共用，这组测试盯住它别再散开。

/** COUNT 查询得有行返回，否则 listTasks 会在读 count 时抛错。 */
const countAwareRows = (text) => (/COUNT\(\*\)/i.test(text) ? [{ count: '0' }] : []);

/**
 * 四个取任务行的方法各 SELECT 了哪些列。
 *
 * @param {Object} adapter
 * @param {() => string} lastSql - 取刚发出去的那条 SQL
 */
async function taskSelectColumns(adapter, lastSql) {
  const columnsAfter = async (run) => {
    await run();
    return selectedColumns(lastSql());
  };
  return {
    getTaskByUuidOnly: await columnsAfter(() => adapter.getTaskByUuidOnly('uuid-1')),
    getPendingTasks: await columnsAfter(() => adapter.getPendingTasks(50)),
    getTaskByUuid: await columnsAfter(() => adapter.getTaskByUuid('uuid-1', 'user-1')),
    listTasks: await columnsAfter(() => adapter.listTasks('user-1', {}))
  };
}

async function d1TaskSelectColumns() {
  const { db, calls } = createSpyD1();
  const adapter = createD1Adapter(db);
  await adapter.initSchema();
  return taskSelectColumns(adapter, () => calls.at(-1).sql);
}

test('投递链路和读接口各自的列集，三个适配器逐字一致', async () => {
  const pg = recordingPg(countAwareRows);
  const neon = recordingNeon(countAwareRows);

  const byBackend = {
    pg: await taskSelectColumns(pg.adapter, () => pg.calls.at(-1).text),
    neon: await taskSelectColumns(neon.adapter, () => neon.calls.at(-1).text),
    d1: await d1TaskSelectColumns()
  };

  for (const [name, columns] of Object.entries(byBackend)) {
    assert.deepEqual(
      columns.getTaskByUuidOnly, columns.getPendingTasks,
      `${name}: 投递链路的两个方法要给出同一套列（runTask 和 cron 走同一条投递链）`
    );
    assert.deepEqual(
      columns.getTaskByUuid, columns.listTasks,
      `${name}: 读接口的两个方法要给出同一套列`
    );
  }

  assert.deepEqual(byBackend.pg, byBackend.d1, 'pg 的任务行列集要跟 D1 一致');
  assert.deepEqual(byBackend.neon, byBackend.d1, 'neon 的任务行列集要跟 D1 一致');

  // 光「三边一致」还不够：三个适配器一起丢掉 retry_after 的话一致性照样成立，
  // 退避守卫却全线失效。这一列单独钉死。
  for (const [name, columns] of Object.entries(byBackend)) {
    assert.ok(
      columns.getTaskByUuidOnly.includes('retry_after'),
      `${name}: 投递链路的行必须带 retry_after，run-tick 的退避守卫读它`
    );
  }
});

// ── 连接池的空闲连接出错 ────────────────────────────────────────────────
//
// pg-pool 在空闲连接出错时 emit('error')（见 node_modules/pg-pool 的
// makeIdleListener）。Pool 是 EventEmitter，没人监听时这一下会直接抛出来，在
// 真实进程里就是未捕获异常——整个 Node 进程退出，日志里只剩一句栈全在 pg 内部
// 的 `Connection terminated unexpectedly`，看不出跟本库有关系。
test('pg: 池子里的空闲连接出错时不炸进程，只留一条认得出出处的日志', async () => {
  const adapter = new PgAdapter('postgres://user:pass@127.0.0.1:5432/db');
  // pg-pool 建池是懒的（连接留到第一次查询），这里不会真的去连库。
  const pool = adapter._getPool();

  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.map((arg) => String(arg)).join(' '));
  try {
    assert.doesNotThrow(
      () => pool.emit('error', new Error('Connection terminated unexpectedly'), {}),
      '没挂 error 监听的话，这一下就是进程级未捕获异常'
    );
  } finally {
    console.error = originalError;
  }

  assert.equal(logged.length, 1);
  assert.match(logged[0], /\[amsg-server pg\]/, '日志要认得出是谁的池子');
  assert.match(logged[0], /Connection terminated unexpectedly/, '日志要带上原始错误');

  await pool.end();
});
