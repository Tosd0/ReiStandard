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

/** 把 SQL 压成单行，断言时不用管缩进。 */
const flat = (text) => text.replace(/\s+/g, ' ').trim();

/** SET 子句里写了哪些列（用来确认占位没动 next_send_at）。 */
function setClauseOf(text) {
  const match = flat(text).match(/\bSET\b(.*?)\bWHERE\b/i);
  assert.ok(match, `语句里没找到 SET ... WHERE：${text}`);
  return match[1];
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

  test(`${backend.name}: 改到 0 行就是没领到`, async () => {
    const { adapter } = backend.make(() => []);
    assert.equal(
      await adapter.claimTask(7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:10:00.000Z'),
      false
    );
  });

  test(`${backend.name}: getPendingTasks 跳过租约还没到期的行`, async () => {
    const { adapter, calls } = backend.make(() => []);
    await adapter.getPendingTasks(50);

    const text = flat(calls.at(-1).text);
    assert.match(text, /lease_until IS NULL OR lease_until <= NOW\(\)/i);
    assert.match(text, /next_send_at <= NOW\(\)/i);
  });

  test(`${backend.name}: initSchema 给老表补上 lease_until 列`, async () => {
    // initSchema 末尾要验证建表结果，这两个查询得有行返回，否则它会抛错。
    const { adapter, calls } = backend.make((text) =>
      /information_schema/i.test(text) ? [{ table_name: 'scheduled_messages', column_name: 'id' }] : []
    );
    await adapter.initSchema();

    const altered = calls.some((c) => /ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS lease_until/i.test(flat(c.text)));
    assert.ok(altered, 'initSchema 应该给已有的表补 lease_until 列');
  });
}
