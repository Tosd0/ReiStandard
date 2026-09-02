/**
 * 防回归守卫：四条每分钟跑的清理必须走索引，否则 D1 免费额度会被扫穿。
 *
 * cron 每跳都会顺手跑 client_state 的 TTL 清理和 message_outbox 的两条例行清
 * 理；取消 / 顶替任务时还有一条按 task_uuid 删未投递行的 DELETE。这几条语句
 * 一旦走不了索引就是全表扫描，扫过的行数全算进 D1 的 rows read——每分钟一跳
 * 乘上一张只涨不跌的表，两张表合计一千多行就能把免费额度（每天 500 万行）用
 * 光，之后整个 worker 报 `exceeded D1's free tier daily row read limit`。
 *
 * 这里用真实 SQLite 建好 schema，拦下适配器实际发出的 DELETE 语句，对它跑
 * `EXPLAIN QUERY PLAN`，断言计划里没有 `SCAN`、并且 SEARCH 的条件里带着那个
 * 真正把行数收窄的列。SQL 不手抄，直接录适配器发出去的那条：语句改了守卫
 * 跟着改，不会盯着一条早就不存在的 SQL 说「没问题」。
 *
 * 只盯 `SCAN` 不够：message_outbox 上 `user_id = ?` 能吃到 (user_id, message_id)
 * 的唯一约束索引，计划显示 SEARCH，但单用户部署下 user_id 对每一行都成立，
 * 等于整表扫一遍。所以每条还要求 SEARCH 条件里出现真正收窄范围的那一列。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSpyD1 } from './helpers/sqlite-d1.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const TASK_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1';

async function setup() {
  const spy = createSpyD1();
  const adapter = createD1Adapter(spy.db);
  await adapter.initSchema();
  // initSchema 的语句不带 bind，本来就录不进 calls；清一下是保险。
  spy.calls.length = 0;
  return { spy, adapter };
}

/** 录下来的语句里，删这张表的那几条。 */
function deleteCallsOn(spy, table) {
  const re = new RegExp(`^\\s*DELETE\\s+FROM\\s+${table}\\b`, 'i');
  return spy.calls.filter((call) => re.test(call.sql));
}

/** 对录下来的那条语句跑 EXPLAIN QUERY PLAN，把各行 detail 拼成一段文字。 */
function explainPlan(spy, call) {
  const rows = spy._raw.prepare(`EXPLAIN QUERY PLAN ${call.sql}`).all(...call.args);
  return rows.map((row) => row.detail).join('\n');
}

/**
 * 计划必须是「用索引搜」而不是「整表扫」，并且搜的条件里带着 narrowingTerm
 * （形如 `updated_at<?`），说明索引真的在收窄行数，而不是只碰了个 user_id。
 */
function assertIndexed(label, plan, narrowingTerm) {
  assert.doesNotMatch(plan, /\bSCAN\b/, `${label}：计划里出现了全表扫描\n${plan}`);
  assert.match(plan, /SEARCH \w+ USING (?:COVERING )?INDEX/, `${label}：计划不是走索引的 SEARCH\n${plan}`);
  assert.ok(plan.includes(narrowingTerm), `${label}：SEARCH 条件里没有 ${narrowingTerm}\n${plan}`);
}

describe('每分钟跑的清理 DELETE 都走索引（EXPLAIN QUERY PLAN 无 SCAN）', () => {
  test('cleanupClientState：DELETE FROM client_state WHERE namespace = ? AND updated_at < ?', async (t) => {
    const { spy, adapter } = await setup();
    await adapter.cleanupClientState([{ namespace: 'fire_pack', updatedBefore: Date.now() }]);

    const calls = deleteCallsOn(spy, 'client_state');
    assert.equal(calls.length, 1, '应恰好发出一条 DELETE');
    const plan = explainPlan(spy, calls[0]);
    t.diagnostic(`client_state TTL 清理\n${plan}`);
    assertIndexed('client_state TTL 清理', plan, 'updated_at<?');
  });

  test('cleanupOutbox：已 ack 的按 acked_at 删、全部按 created_at 删', async (t) => {
    const { spy, adapter } = await setup();
    const now = Date.now();
    await adapter.cleanupOutbox({ ackedBeforeMs: now - 1000, allBeforeMs: now - 5000 });

    const calls = deleteCallsOn(spy, 'message_outbox');
    assert.equal(calls.length, 2, '应恰好发出两条 DELETE');
    const acked = calls.find((call) => /acked_at/.test(call.sql));
    const all = calls.find((call) => /created_at/.test(call.sql));
    assert.ok(acked && all, '两条语句应分别按 acked_at / created_at 删');
    // 两条计划都先打印再断言，任一条挂掉时另一条的计划也留在输出里。
    const ackedPlan = explainPlan(spy, acked);
    const allPlan = explainPlan(spy, all);
    t.diagnostic(`outbox 已 ack 行清理\n${ackedPlan}`);
    t.diagnostic(`outbox 过期行清理\n${allPlan}`);
    assertIndexed('outbox 已 ack 行清理', ackedPlan, 'acked_at<?');
    assertIndexed('outbox 过期行清理', allPlan, 'created_at<?');
  });

  test('discardUndeliveredOutboxForTask：按 task_uuid 删未投递行，不能靶着 user_id 扫整个积压', async (t) => {
    const { spy, adapter } = await setup();
    await adapter.discardUndeliveredOutboxForTask(USER, TASK_UUID);

    const calls = deleteCallsOn(spy, 'message_outbox');
    assert.equal(calls.length, 1, '应恰好发出一条 DELETE');
    const plan = explainPlan(spy, calls[0]);
    t.diagnostic(`outbox 按任务撤未投递行\n${plan}`);
    assertIndexed('outbox 按任务撤未投递行', plan, 'task_uuid=?');
  });
});
