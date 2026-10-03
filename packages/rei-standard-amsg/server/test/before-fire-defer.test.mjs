/**
 * onBeforeFire 的 `{ defer: { afterMs } }`：现在不合适，过一会儿再来问。
 *
 * 钉住的是任务行在推迟前后的样子（只动 retry_after 和租约）、这一跳不生成不
 * 推送、到点之后从 onBeforeFire 重新走一遍，以及过期线照常管着被推迟的任务。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledTick, runTask } from '../src/server/lib/run-tick.js';
import { processMessagesByUuid } from '../src/server/lib/message-processor.js';
import { MAX_DEFER_AFTER_MS } from '../src/server/lib/agentic-fire.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const VAPID = { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' };

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

function isoFromNow(ms) {
  return new Date(Date.now() + ms).toISOString();
}

/**
 * 一套现成的场景：一条刚到点的 LLM 任务 + 记账用的 hook。
 *
 * onBeforeFire 的返回值由 `beforeFire(fireCtx, callIndex)` 决定；LLM（fetch）、
 * onLLMOutput、onAfterSend、推送被调到了几次都记下来，推迟的那一跳它们应当全
 * 是 0。
 */
async function fixture(t, { uuid = 'defer-task', recurrenceType = 'none', nextSendAt, beforeFire, messageType = 'auto', ctx = {} } = {}) {
  const d1 = createTestD1();
  const adapter = createD1Adapter(d1);
  await adapter.initSchema();
  await seedPushSubscription(adapter, USER, MASTER_KEY);
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const dueAt = nextSendAt || isoFromNow(-30 * SECOND);
  await adapter.createTask({
    user_id: USER,
    uuid,
    encrypted_payload: await encryptForStorage(JSON.stringify({
      contactName: 'Rei',
      messageType,
      recurrenceType,
      apiUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'key',
      primaryModel: 'test',
      completePrompt: 'frozen prompt',
      metadata: { charId: 'c1' },
    }), userKey),
    next_send_at: dueAt,
    message_type: messageType,
  });

  const calls = { beforeFire: [], llm: 0, llmOutput: 0, afterSend: 0, settled: [], stale: [] };
  t.mock.method(globalThis, 'fetch', async () => {
    calls.llm++;
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'hello' } }] });
  });
  const webpush = { sent: [], async sendNotification(_sub, payload) { webpush.sent.push(payload); } };

  const tickCtx = {
    db: adapter,
    masterKey: MASTER_KEY,
    vapid: VAPID,
    webpush,
    // 心跳用的是真定时器，这些用例里用不上。
    leaseHeartbeatMs: 0,
    hooks: {
      onBeforeFire: async (fireCtx) => {
        calls.beforeFire.push({ nextSendAt: fireCtx.task.nextSendAt, retryCount: fireCtx.task.retryCount });
        return beforeFire(fireCtx, calls.beforeFire.length - 1);
      },
      onLLMOutput: async () => { calls.llmOutput++; return { decision: 'skip-push' }; },
    },
    onAfterSend: async () => { calls.afterSend++; },
    onFireSettled: async (info) => { calls.settled.push(info); },
    onStaleSkip: async (task, info) => { calls.stale.push({ uuid: task.uuid, info }); },
    ...ctx,
  };

  /** 行的全部列（含 lease_until / last_error，投递用的列集里没有这两个）。 */
  const row = () => d1.prepare('SELECT * FROM scheduled_messages WHERE uuid = ?').bind(uuid).first();

  return { adapter, tickCtx, calls, webpush, row, dueAt };
}

/** 把 Date 换成可拨的钟（定时器不动），返回「往后拨 ms」的函数。 */
function controllableClock(t) {
  let nowMs = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: nowMs });
  return (ms) => {
    nowMs += ms;
    t.mock.timers.setTime(nowMs);
  };
}

test('defer：只写 retry_after 并放掉租约，不调 LLM、不推送', async (t) => {
  const f = await fixture(t, { beforeFire: () => ({ defer: { afterMs: 45 * SECOND } }) });

  const before = Date.now();
  const res = await runScheduledTick(f.tickCtx);
  const after = Date.now();

  const row = await f.row();
  assert.equal(row.status, 'pending');
  assert.equal(row.next_send_at, f.dueAt, '名义触发时刻不能动');
  assert.equal(row.retry_count, 0, '推迟不占重试次数');
  assert.equal(row.last_error, null, '推迟不留报错');
  assert.equal(row.lease_until, null, '租约要放掉');
  const retryAfterMs = Date.parse(row.retry_after);
  assert.ok(retryAfterMs >= before + 45 * SECOND && retryAfterMs <= after + 45 * SECOND,
    `retry_after 应当是 now + afterMs，实际 ${row.retry_after}`);

  assert.equal(f.calls.llm, 0);
  assert.equal(f.calls.llmOutput, 0);
  assert.equal(f.calls.afterSend, 0);
  assert.equal(f.webpush.sent.length, 0);

  assert.equal(res.successCount, 0);
  assert.equal(res.failedCount, 0);
  assert.deepEqual(res.details.deferredTasks, [{ taskId: row.id, retryAfter: row.retry_after }]);
  assert.equal(res.details.deletedOnceOffTasks, 0);
  assert.deepEqual(res.details.failedTasks, []);
});

test('defer：收尾回执是 deferred，带 retryAfter', async (t) => {
  const f = await fixture(t, { beforeFire: () => ({ defer: { afterMs: 45 * SECOND } }) });
  await runScheduledTick(f.tickCtx);

  assert.equal(f.calls.settled.length, 1, 'onBeforeFire 调过一次，收尾也只调一次');
  const info = f.calls.settled[0];
  assert.equal(info.status, 'deferred');
  assert.equal(info.retryAfter, (await f.row()).retry_after);
  assert.equal(info.skipReason, null);
  assert.equal(info.error, null);
  assert.equal(info.willRetry, null);
  assert.equal(info.failureStage, null);
  assert.equal(info.llmCalls, 0);
  assert.equal(info.iterations, 0);
  assert.equal(info.sentCount, 0);
  assert.equal(info.outboxed, false);
  assert.deepEqual(info.metadata, { charId: 'c1' });
});

test('别的结局的收尾回执上 retryAfter 是 null', async (t) => {
  const f = await fixture(t, { beforeFire: () => ({ skip: true }) });
  await runScheduledTick(f.tickCtx);
  assert.equal(f.calls.settled[0].status, 'skipped');
  assert.equal(f.calls.settled[0].retryAfter, null);
});

test('defer：已有的 retry_count 和 last_error 原样留着', async (t) => {
  const f = await fixture(t, { beforeFire: () => ({ defer: { afterMs: 45 * SECOND } }) });
  const lastError = JSON.stringify({ at: isoFromNow(-3 * MINUTE), reason: '上一次的失败' });
  await f.adapter.updateTaskById((await f.row()).id, {
    retry_count: 2,
    retry_after: isoFromNow(-SECOND),
    last_error: lastError,
  });

  await runScheduledTick(f.tickCtx);

  const row = await f.row();
  assert.equal(row.retry_count, 2);
  assert.equal(row.last_error, lastError);
  assert.equal(row.status, 'pending');
  assert.ok(Date.parse(row.retry_after) > Date.now());
  assert.equal(f.calls.beforeFire[0].retryCount, 2);
});

test('defer：到 retry_after 之前不被捞，之后从 onBeforeFire 重新走一遍', async (t) => {
  const advance = controllableClock(t);
  const f = await fixture(t, {
    beforeFire: (_ctx, callIndex) => (callIndex < 2 ? { defer: { afterMs: 2 * MINUTE } } : { skip: true }),
  });

  await runScheduledTick(f.tickCtx);
  assert.equal(f.calls.beforeFire.length, 1);

  // 还没到点：这一跳捞不到它，hook 不会被调。
  advance(MINUTE);
  const idle = await runScheduledTick(f.tickCtx);
  assert.equal(idle.totalTasks, 0);
  assert.equal(f.calls.beforeFire.length, 1);

  // 到点：重新问一次，这次又推迟。
  advance(MINUTE + SECOND);
  const second = await runScheduledTick(f.tickCtx);
  assert.equal(f.calls.beforeFire.length, 2);
  assert.equal(second.details.deferredTasks.length, 1);
  assert.equal((await f.row()).retry_count, 0);

  // 再到点：这次放行（skip 收场），一次性任务删掉。
  advance(2 * MINUTE + SECOND);
  const third = await runScheduledTick(f.tickCtx);
  assert.equal(f.calls.beforeFire.length, 3);
  assert.equal(third.successCount, 1);
  assert.equal(await f.row(), null);

  // 三次问到的是同一次触发：名义时刻、重试次数都没变。
  assert.deepEqual(f.calls.beforeFire, Array(3).fill({ nextSendAt: f.dueAt, retryCount: 0 }));
  assert.deepEqual(f.calls.settled.map((s) => s.status), ['deferred', 'deferred', 'skipped']);
  assert.equal(f.calls.llm, 0);
});

test('defer：循环任务不推进到下一次', async (t) => {
  const advance = controllableClock(t);
  const f = await fixture(t, {
    recurrenceType: 'daily',
    beforeFire: (_ctx, callIndex) => (callIndex === 0 ? { defer: { afterMs: MINUTE } } : { skip: true }),
  });

  const res = await runScheduledTick(f.tickCtx);
  assert.equal(res.details.updatedRecurringTasks, 0);
  assert.equal((await f.row()).next_send_at, f.dueAt);

  // 到点后放行，这才推进到下一次，推迟留下的 retry_after 也清掉。
  advance(MINUTE + SECOND);
  const next = await runScheduledTick(f.tickCtx);
  assert.equal(next.details.updatedRecurringTasks, 1);
  const row = await f.row();
  assert.equal(row.next_send_at, new Date(Date.parse(f.dueAt) + DAY).toISOString());
  assert.equal(row.retry_after, null);
});

test('defer 之后名义时刻过了 staleAfterMs：下次捞起来直接判过期，不再问 onBeforeFire', async (t) => {
  const advance = controllableClock(t);
  const f = await fixture(t, { beforeFire: () => ({ defer: { afterMs: 10 * MINUTE } }) });

  await runScheduledTick(f.tickCtx);
  assert.equal(f.calls.beforeFire.length, 1);

  advance(61 * MINUTE);
  const res = await runScheduledTick(f.tickCtx);

  assert.equal(f.calls.beforeFire.length, 1, '过期守卫排在 onBeforeFire 前面');
  assert.deepEqual(res.details.staleTasks.map((s) => s.action), ['expired']);
  const row = await f.row();
  assert.equal(row.status, 'failed');
  assert.equal(JSON.parse(row.last_error).reason, 'stale');
  assert.equal(f.calls.stale.length, 1);
});

test('反复 defer：唤醒时刻越过过期线的那一次当场判过期', async (t) => {
  const advance = controllableClock(t);
  const f = await fixture(t, { beforeFire: () => ({ defer: { afterMs: 10 * MINUTE } }) });

  // 名义时刻是 30 秒前、过期线 60 分钟。每 10 分钟被问一次：前五次的唤醒时刻
  // 都在线内，第六次（第 50 分钟问，要推到第 60 分钟）越线。
  for (let i = 0; i < 5; i++) {
    const res = await runScheduledTick(f.tickCtx);
    assert.equal(res.details.deferredTasks.length, 1, `第 ${i + 1} 次应当照常推迟`);
    advance(10 * MINUTE + SECOND);
  }
  assert.equal((await f.row()).status, 'pending');

  const last = await runScheduledTick(f.tickCtx);
  assert.equal(f.calls.beforeFire.length, 6);
  assert.deepEqual(last.details.deferredTasks, []);
  assert.deepEqual(last.details.staleTasks.map((s) => s.action), ['expired']);

  const row = await f.row();
  assert.equal(row.status, 'failed');
  assert.equal(row.retry_count, 0);
  assert.equal(JSON.parse(row.last_error).reason, 'stale');
  assert.equal(f.calls.stale.length, 1);
  assert.equal(f.calls.stale[0].info.action, 'expired');
  assert.equal(f.calls.llm, 0);

  // 之后不会再被捞起来。
  advance(10 * MINUTE);
  assert.equal((await runScheduledTick(f.tickCtx)).totalTasks, 0);
  assert.equal(f.calls.beforeFire.length, 6);
});

// 重试链上的任务（retry_count > 0）不看名义时刻，只看 retry_after 新不新；而
// 每次推迟都会把 retry_after 刷新。推迟自己不把过期线带上的话，这种任务可以
// 被无限期推下去。
test('反复 defer：已经在重试链上的任务一样会过期', async (t) => {
  const advance = controllableClock(t);
  const f = await fixture(t, { beforeFire: () => ({ defer: { afterMs: 10 * MINUTE } }) });
  await f.adapter.updateTaskById((await f.row()).id, { retry_count: 1, retry_after: isoFromNow(-SECOND) });

  let ticks = 0;
  let res;
  do {
    res = await runScheduledTick(f.tickCtx);
    ticks++;
    advance(10 * MINUTE + SECOND);
  } while (res.details.deferredTasks.length === 1 && ticks < 20);

  assert.equal(ticks, 6, '第六次的唤醒时刻越线');
  assert.deepEqual(res.details.staleTasks.map((s) => s.action), ['expired']);
  assert.equal((await f.row()).status, 'failed');
  assert.equal(f.calls.stale.length, 1);
});

test('反复 defer：循环任务越线时快进到下一次', async (t) => {
  const advance = controllableClock(t);
  const f = await fixture(t, { recurrenceType: 'daily', beforeFire: () => ({ defer: { afterMs: 20 * MINUTE } }) });

  let res;
  for (let i = 0; i < 3; i++) {
    res = await runScheduledTick(f.tickCtx);
    advance(20 * MINUTE + SECOND);
  }

  assert.deepEqual(res.details.staleTasks.map((s) => s.action), ['fast_forwarded']);
  const row = await f.row();
  assert.equal(row.status, 'pending');
  assert.equal(row.next_send_at, new Date(Date.parse(f.dueAt) + DAY).toISOString());
  assert.equal(row.retry_after, null);
  assert.equal(f.calls.stale[0].info.action, 'fast_forwarded');
});

for (const [label, defer] of [
  ['0', { afterMs: 0 }],
  ['负数', { afterMs: -1000 }],
  ['NaN', { afterMs: NaN }],
  ['Infinity', { afterMs: Infinity }],
  ['字符串', { afterMs: '1000' }],
  ['缺 afterMs', {}],
  ['defer 不是对象', true],
  ['超过上限', { afterMs: MAX_DEFER_AFTER_MS + 1 }],
]) {
  test(`非法的 defer（${label}）：按 AGENTIC_BAD_BEFORE_FIRE 一跳终审`, async (t) => {
    const f = await fixture(t, { beforeFire: () => ({ defer }) });
    const res = await runScheduledTick(f.tickCtx);

    assert.equal(res.failedCount, 1);
    assert.deepEqual(res.details.deferredTasks, []);
    assert.equal(res.details.failedTasks[0].status, 'permanently_failed');
    assert.match(res.details.failedTasks[0].reason, /AGENTIC_BAD_BEFORE_FIRE/);
    assert.match(res.details.failedTasks[0].reason, /\{ defer: \{ afterMs \} \}/, '合法返回值列表里要有 defer');

    const row = await f.row();
    assert.equal(row.status, 'failed');
    assert.equal(JSON.parse(row.last_error).errorCode, 'AGENTIC_BAD_BEFORE_FIRE');

    assert.equal(f.calls.settled.length, 1);
    assert.equal(f.calls.settled[0].status, 'failed');
    assert.equal(f.calls.settled[0].error.permanent, true);
    assert.equal(f.calls.settled[0].retryAfter, null);
    assert.equal(f.calls.llm, 0);
  });
}

test('afterMs 正好等于上限：照常推迟', async (t) => {
  // 过期线放宽到两天，免得唤醒时刻先撞上它。
  const f = await fixture(t, {
    beforeFire: () => ({ defer: { afterMs: MAX_DEFER_AFTER_MS } }),
    ctx: { staleAfterMs: 2 * DAY },
  });
  const res = await runScheduledTick(f.tickCtx);
  assert.equal(res.details.deferredTasks.length, 1);
  assert.equal(MAX_DEFER_AFTER_MS, DAY);
});

test('runTask：defer 后回 ran: true，到点之前再调回 retry_pending', async (t) => {
  const f = await fixture(t, { beforeFire: () => ({ defer: { afterMs: 45 * SECOND } }) });

  const first = await runTask(f.tickCtx, 'defer-task');
  assert.equal(first.ran, true);
  assert.equal(first.summary.details.deferredTasks.length, 1);

  const row = await f.row();
  const second = await runTask(f.tickCtx, 'defer-task');
  assert.deepEqual(second, { ran: false, reason: 'retry_pending', retryAfter: row.retry_after });
  assert.equal(f.calls.beforeFire.length, 1);
});

test('defer 期间任务被取消：不把行写回来，记成取消', async (t) => {
  const f = await fixture(t, {
    beforeFire: async () => {
      assert.equal(await f.adapter.deleteTaskByUuid('defer-task', USER), true);
      return { defer: { afterMs: 45 * SECOND } };
    },
  });

  const res = await runScheduledTick(f.tickCtx);

  assert.equal(await f.row(), null);
  assert.deepEqual(res.details.deferredTasks, []);
  assert.deepEqual(res.details.cancelledTasks.map((c) => c.status), ['cancelled_mid_delivery']);
  assert.equal(res.failedCount, 0);
});

// 没有 retry_after 列可写的适配器只能改 next_send_at，而那是这次触发的名义时
// 刻。所以这里不推迟，明确报配置错误（可重试，不判终态）。
test('没实现 claimTask 的适配器：defer 报 AGENTIC_DEFER_UNSUPPORTED', async (t) => {
  const f = await fixture(t, { beforeFire: () => ({ defer: { afterMs: 45 * SECOND } }) });
  const db = new Proxy(f.adapter, {
    get(target, prop) {
      if (prop === 'claimTask') return undefined;
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const res = await runScheduledTick({ ...f.tickCtx, db });

  assert.equal(res.failedCount, 1);
  assert.deepEqual(res.details.deferredTasks, []);
  assert.match(res.details.failedTasks[0].reason, /AGENTIC_DEFER_UNSUPPORTED/);
  assert.ok(res.details.failedTasks[0].nextRetryAt, '配置错误留在退避阶梯上');
  const row = await f.row();
  assert.equal(row.status, 'pending');
  assert.equal(row.retry_count, 1);
  assert.equal(f.calls.settled[0].status, 'failed');
  assert.equal(f.calls.settled[0].error.code, 'AGENTIC_DEFER_UNSUPPORTED');
  assert.notEqual(f.calls.settled[0].error.permanent, true);
  assert.equal(f.calls.llm, 0);
});

test('请求内当场投递的 instant 任务：defer 报 AGENTIC_DEFER_UNSUPPORTED', async (t) => {
  const f = await fixture(t, {
    messageType: 'instant',
    beforeFire: () => ({ defer: { afterMs: 45 * SECOND } }),
  });

  const result = await processMessagesByUuid('defer-task', f.tickCtx, 0, USER, MASTER_KEY);

  assert.equal(result.success, false);
  assert.match(result.error.message, /AGENTIC_DEFER_UNSUPPORTED/);
  assert.equal((await f.row()).status, 'failed', '不能当成发完了把任务删掉，也不能悄悄留着');
  assert.equal(f.calls.settled[0].status, 'failed');
  assert.equal(f.calls.llm, 0);
  assert.equal(f.webpush.sent.length, 0);
});
