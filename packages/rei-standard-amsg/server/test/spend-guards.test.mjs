/**
 * 后台主动消息的三道花费护栏。
 *
 * 1. LLM 上游明确拒了这次请求（401 / 403 / 400 …）一跳终审：重试几次都是同一个
 *    结果，而每重试一次都要把整条生成从头再跑一遍。
 * 2. 生成成功、整批落进 outbox 之后推送才失败的，重试只补推送、不重新生成：同一
 *    次触发只花一次生成的钱，客户端那边也只会有一份内容。
 * 3. 用量按整次 fire 累计（usageTotal / llmCalls），失败结局也带。
 *
 * 这些用例是回归守卫：把任何一道改回老行为（401 照样重试、重试时重新生成、
 * 用量只剩最后一轮），下面都会红。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledTick } from '../src/server/lib/run-tick.js';
import { processSingleMessage, processMessagesByUuid } from '../src/server/lib/message-processor.js';
import { callLlm } from '../src/server/lib/llm.js';
import { accumulateUsage } from '../src/server/lib/agentic-fire.js';
import { isPermanentDeliveryFailure, isPermanentLlmFailure } from '../src/server/lib/errors.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSpyD1, createTestD1 } from './helpers/sqlite-d1.mjs';
import { withoutOutbox } from './helpers/no-outbox.mjs';
import { encryptTestSubscription, seedPushSubscription, withPushSubscriptionStore } from './helpers/push-subscription.mjs';
import { deriveUserEncryptionKey, decryptFromStorage, encryptForStorage } from '../src/server/lib/encryption.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const VAPID = { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' };
const DAY = 24 * 60 * 60 * 1000;

const LLM_PAYLOAD = {
  contactName: 'Rei',
  messageType: 'prompted',
  completePrompt: 'p',
  apiUrl: 'https://api.example.com/v1/chat/completions',
  apiKey: 'sk-test',
  primaryModel: 'm',
};

// ─── 测试脚手架 ─────────────────────────────────────────────────────────

/** 刚到点的触发时刻（远没到 60 分钟的补发新鲜度上限）。 */
function recentDue() {
  return new Date(Date.now() - 30_000).toISOString();
}

/** 第 n 次生成的正文：两句，每句都带着「第几次生成」，重新生成过一眼就看得出来。 */
function generation(n) {
  return `甲${n}。乙${n}。`;
}

function completion(content, usage) {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], ...(usage ? { usage } : {}) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function llmError(status) {
  return new Response(
    JSON.stringify({ error: { message: `upstream said ${status}`, code: 'some_code' } }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * 替换 globalThis.fetch：第 n 次调用交给 respond(n) 决定回什么（抛错 = 网络炸
 * 了）。默认每次都成功，正文是 generation(n)。
 */
function stubLlm(respond = (n) => completion(generation(n))) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return respond(calls.length);
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

/** 推送服务替身：failOn 里列出的第几次调用回 503，其余照收。 */
function scriptedWebpush(failOn = []) {
  const failures = new Set(failOn);
  const received = [];
  let attempts = 0;
  return {
    received,
    get attempts() { return attempts; },
    async sendNotification(_subscription, payload) {
      attempts++;
      if (failures.has(attempts)) {
        const error = new Error('Web Push delivery failed: 503 Service Unavailable');
        error.statusCode = 503;
        throw error;
      }
      received.push(JSON.parse(payload));
    },
  };
}

async function makeAdapter() {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seedPushSubscription(adapter, USER, MASTER_KEY);
  return adapter;
}

async function seedTask(adapter, { uuid, payload, nextSendAt = recentDue(), recurrenceType = 'none' }) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const full = { recurrenceType, ...payload };
  await adapter.createTask({
    user_id: USER,
    uuid,
    encrypted_payload: await encryptForStorage(JSON.stringify(full), userKey),
    next_send_at: nextSendAt,
    message_type: full.messageType,
  });
}

/** 把一条正在退避的任务拨到「重试到点了」。 */
async function makeRetryDue(adapter, uuid) {
  const row = await adapter.getTaskByUuidOnly(uuid);
  assert.ok(row, `任务 ${uuid} 应该还是 pending`);
  await adapter.updateTaskById(row.id, { retry_after: new Date(Date.now() - 1000).toISOString() });
}

async function findTaskAnyStatus(adapter, uuid) {
  const { tasks } = await adapter.listTasks(USER, { status: 'all', limit: 50 });
  return tasks.find((t) => t.uuid === uuid);
}

/** 这条任务名下 outbox 里的全部行（解密后的 push + 投递 / ack 状态）。 */
async function outboxOf(adapter, uuid) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const rows = await adapter.listOutboxForTask(USER, uuid, { sinceMs: 0 });
  return Promise.all(rows.map(async (row) => ({
    push: JSON.parse(await decryptFromStorage(row.payload, userKey)),
    delivered: row.delivered_at != null,
    acked: row.acked_at != null,
  })));
}

function tickCtx(adapter, webpush, extra = {}) {
  return {
    db: adapter,
    masterKey: MASTER_KEY,
    vapid: VAPID,
    webpush,
    // 不真的等 1.5 秒的发送节奏。
    _pushSleep: async () => {},
    _agenticSleep: async () => {},
    ...extra,
  };
}

/** 把一次生成的正文按句号拆成 finish 的 pushPayloads（agentic 用例的分类器）。 */
function finishWithSentences(sessionCtx) {
  const content = sessionCtx.llmResponse.choices[0].message.content;
  const sentences = content.split('。').filter(Boolean);
  return {
    decision: 'finish',
    pushPayloads: sentences.map((message) => ({ messageKind: 'content', message })),
  };
}

// ─── 1. LLM 拒了这次请求：一跳终审 ───────────────────────────────────────

describe('LLM 上游明确拒了请求：错误上直接标 permanent', () => {
  async function llmErrorFor(respond) {
    const llm = stubLlm(respond);
    try {
      await callLlm({ ...LLM_PAYLOAD });
      assert.fail('callLlm 应该抛错');
    } catch (error) {
      return error;
    } finally {
      llm.restore();
    }
  }

  for (const status of [400, 401, 402, 403, 404, 405, 413, 422]) {
    test(`${status} → permanent`, async () => {
      const error = await llmErrorFor(() => llmError(status));
      assert.equal(error.code, 'LLM_CALL_FAILED');
      assert.equal(error.llmStatus, status);
      assert.equal(error.permanent, true, `${status} 是请求本身有问题，重试不会好`);
      assert.equal(isPermanentLlmFailure(error), true);
    });
  }

  for (const status of [408, 409, 425, 429, 500, 502, 503]) {
    test(`${status} → 仍然可重试`, async () => {
      const error = await llmErrorFor(() => llmError(status));
      assert.equal(error.llmStatus, status);
      assert.notEqual(error.permanent, true);
      assert.equal(isPermanentDeliveryFailure({ permanent: error.permanent, errorCode: error.code }), false);
    });
  }

  test('没有 llmStatus（网络直接炸了）→ 仍然可重试', async () => {
    const error = await llmErrorFor(() => { throw new TypeError('fetch failed'); });
    assert.equal(error.llmStatus, undefined);
    assert.notEqual(error.permanent, true);
  });

  test('200 却装着报错的响应体 → 仍然可重试（真实原因说不准）', async () => {
    const error = await llmErrorFor(() => new Response(
      JSON.stringify({ error: { message: 'invalid api key', code: 401 } }),
      { status: 200 }
    ));
    assert.equal(error.code, 'LLM_CALL_FAILED');
    assert.equal(error.llmStatus, 200);
    assert.notEqual(error.permanent, true);
  });

  test('isPermanentLlmFailure 只认 LLM_CALL_FAILED 这一族', () => {
    // 别的来路挂了个 llmStatus 也不算：判据是「LLM 上游答复了且拒了」。
    assert.equal(isPermanentLlmFailure({ code: 'SOMETHING_ELSE', llmStatus: 401 }), false);
    assert.equal(isPermanentLlmFailure({ code: 'LLM_CALL_FAILED', llmStatus: '401' }), false);
    assert.equal(isPermanentLlmFailure(null), false);
  });
});

describe('LLM 401：定时任务一跳终审，不再把整条生成重跑几遍', () => {
  test('一次性任务：第一跳就标 failed，不排重试，LLM 只调一次', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'once-401', payload: LLM_PAYLOAD });
    const llm = stubLlm(() => llmError(401));
    try {
      const res = await runScheduledTick(tickCtx(adapter, scriptedWebpush()));
      assert.equal(res.failedCount, 1);
      assert.equal(res.details.failedTasks[0].status, 'permanently_failed');
      assert.equal(res.details.failedTasks[0].permanent, true);
    } finally {
      llm.restore();
    }
    const row = await findTaskAnyStatus(adapter, 'once-401');
    assert.equal(row.status, 'failed');
    assert.equal(row.retry_count, 0, '终审不走退避阶梯');
    assert.equal(llm.calls.length, 1);
    assert.equal(JSON.parse(row.last_error).errorCode, 'LLM_CALL_FAILED');
  });

  test('循环任务：本次 occurrence 作废，排期快进到下一次', async () => {
    const adapter = await makeAdapter();
    const dueAt = recentDue();
    await seedTask(adapter, { uuid: 'daily-403', payload: LLM_PAYLOAD, nextSendAt: dueAt, recurrenceType: 'daily' });
    const llm = stubLlm(() => llmError(403));
    try {
      const res = await runScheduledTick(tickCtx(adapter, scriptedWebpush()));
      assert.equal(res.details.failedTasks[0].status, 'occurrence_skipped');
    } finally {
      llm.restore();
    }
    const row = await adapter.getTaskByUuidOnly('daily-403');
    assert.equal(row.status, 'pending');
    assert.equal(row.retry_count, 0);
    assert.equal(row.next_send_at, new Date(Date.parse(dueAt) + DAY).toISOString());
  });

  for (const [label, respond] of [
    ['429 限流', () => llmError(429)],
    ['500 上游故障', () => llmError(500)],
    ['网络炸了（没有 llmStatus）', () => { throw new TypeError('fetch failed'); }],
  ]) {
    test(`${label}：照旧进退避阶梯`, async () => {
      const adapter = await makeAdapter();
      await seedTask(adapter, { uuid: 'retryable', payload: LLM_PAYLOAD });
      const llm = stubLlm(respond);
      try {
        await runScheduledTick(tickCtx(adapter, scriptedWebpush()));
      } finally {
        llm.restore();
      }
      const row = await adapter.getTaskByUuidOnly('retryable');
      assert.ok(row, '行还是 pending，等重试');
      assert.equal(row.retry_count, 1);
      assert.ok(row.retry_after);
    });
  }

  test('fire hook 收到的 error.permanent 为 true（下游据此发失败通知）', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'hooked-401', payload: LLM_PAYLOAD });
    const settled = [];
    const llm = stubLlm(() => llmError(401));
    try {
      await runScheduledTick(tickCtx(adapter, scriptedWebpush(), {
        hooks: {
          onBeforeFire: async () => [{ role: 'user', content: 'U' }],
          onLLMOutput: async () => ({ decision: 'skip-push' }),
        },
        onFireSettled: async (info) => { settled.push(info); },
      }));
    } finally {
      llm.restore();
    }
    assert.equal(settled.length, 1);
    assert.equal(settled[0].status, 'failed');
    assert.equal(settled[0].error.permanent, true);
    assert.equal(settled[0].error.code, 'LLM_CALL_FAILED');
    assert.equal(settled[0].error.llmStatus, 401);
    const row = await findTaskAnyStatus(adapter, 'hooked-401');
    assert.equal(row.status, 'failed');
  });

  test('fire hook 收到的 429 错误不带 permanent', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'hooked-429', payload: LLM_PAYLOAD });
    const settled = [];
    const llm = stubLlm(() => llmError(429));
    try {
      await runScheduledTick(tickCtx(adapter, scriptedWebpush(), {
        hooks: {
          onBeforeFire: async () => [{ role: 'user', content: 'U' }],
          onLLMOutput: async () => ({ decision: 'skip-push' }),
        },
        onFireSettled: async (info) => { settled.push(info); },
      }));
    } finally {
      llm.restore();
    }
    assert.notEqual(settled[0].error.permanent, true);
  });

  test('instant 任务的请求内重试：401 只跑一轮', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'instant-401', payload: { ...LLM_PAYLOAD, messageType: 'instant' } });
    const llm = stubLlm(() => llmError(401));
    let result;
    try {
      result = await processMessagesByUuid('instant-401', tickCtx(adapter, scriptedWebpush()), 2, USER, MASTER_KEY);
    } finally {
      llm.restore();
    }
    assert.equal(result.success, false);
    assert.equal(result.error.permanent, true);
    assert.equal(result.error.retriesAttempted, 0);
    assert.equal(llm.calls.length, 1);
  });
});

// ─── 2. 生成成功之后推送失败：重试只补推送 ───────────────────────────────

describe('推送 5xx 一次后恢复：重试只补推送，不重新生成', () => {
  test('agentic 链路：LLM 只调一次，客户端只拿到一份内容', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'agentic', payload: LLM_PAYLOAD });
    const webpush = scriptedWebpush([1]);   // 第一条推送 503，之后恢复
    let beforeFireCalls = 0;
    const settled = [];
    const afterSend = [];
    const ctx = tickCtx(adapter, webpush, {
      hooks: {
        onBeforeFire: async () => { beforeFireCalls++; return [{ role: 'user', content: 'U' }]; },
        onLLMOutput: async (sessionCtx) => finishWithSentences(sessionCtx),
      },
      onFireSettled: async (info) => { settled.push(info); },
      onAfterSend: async (info) => { afterSend.push(info); },
    });
    const llm = stubLlm();
    try {
      const first = await runScheduledTick(ctx);
      assert.equal(first.failedCount, 1, '第一跳推送失败');
      await makeRetryDue(adapter, 'agentic');
      const second = await runScheduledTick(ctx);
      assert.equal(second.successCount, 1);
      assert.equal(second.details.redeliveredTasks.length, 1);
      assert.equal(second.details.redeliveredTasks[0].pushedCount, 2);
    } finally {
      llm.restore();
    }

    assert.equal(llm.calls.length, 1, '同一次触发只该生成一次');
    assert.equal(beforeFireCalls, 1, '补推那一跳不再调 onBeforeFire');

    // 客户端能拿到的东西：推送收到的 + outbox 里补收得到的。全部来自第一次生成，
    // 同一个 messageId 只有一份内容。
    const rows = await outboxOf(adapter, 'agentic');
    assert.equal(rows.length, 2, 'outbox 里只有这一批');
    assert.ok(rows.every((row) => row.delivered), '补推之后整批都标了 delivered');
    const seen = new Map();
    for (const push of [...webpush.received, ...rows.map((row) => row.push)]) {
      assert.match(push.message, /1$/, `出现了第二次生成的内容：${push.message}`);
      if (seen.has(push.messageId)) assert.equal(seen.get(push.messageId), push.message);
      seen.set(push.messageId, push.message);
    }
    assert.deepEqual(webpush.received.map((p) => p.message), ['甲1', '乙1']);

    // 第一跳的回执照实说「内容已经落定、只是推送没发完」；补推那一跳不调 hook。
    assert.equal(settled.length, 1);
    assert.equal(settled[0].status, 'failed');
    assert.equal(settled[0].outboxed, true);
    assert.notEqual(settled[0].error.permanent, true);
    assert.equal(afterSend.length, 1);
    assert.equal(afterSend[0].outboxed, true);
    assert.equal(afterSend[0].sentCount, 0);

    // 补推成功就是这次触发成功了：一次性任务的行删掉。
    assert.equal(await adapter.getTaskByUuidOnly('agentic'), null);
  });

  test('冻结 prompt 老链路：同样只补推送', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'legacy', payload: LLM_PAYLOAD });
    const webpush = scriptedWebpush([1]);
    const ctx = tickCtx(adapter, webpush);
    const llm = stubLlm();
    try {
      await runScheduledTick(ctx);
      await makeRetryDue(adapter, 'legacy');
      const second = await runScheduledTick(ctx);
      assert.equal(second.successCount, 1);
      assert.equal(second.details.redeliveredTasks.length, 1);
    } finally {
      llm.restore();
    }
    assert.equal(llm.calls.length, 1);
    assert.deepEqual(webpush.received.map((p) => p.message), ['甲1。', '乙1。']);
    const rows = await outboxOf(adapter, 'legacy');
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.delivered && /1。$/.test(row.push.message)));
  });

  test('推到一半挂了：补推只推剩下的那几条，已经送到的不重推', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'half', payload: LLM_PAYLOAD });
    const webpush = scriptedWebpush([2]);   // 第一句送到，第二句 503
    const ctx = tickCtx(adapter, webpush);
    const llm = stubLlm();
    try {
      await runScheduledTick(ctx);
      await makeRetryDue(adapter, 'half');
      const second = await runScheduledTick(ctx);
      assert.equal(second.details.redeliveredTasks[0].pushedCount, 1);
    } finally {
      llm.restore();
    }
    assert.equal(llm.calls.length, 1);
    assert.deepEqual(webpush.received.map((p) => p.message), ['甲1。', '乙1。'], '第一句不会被推两遍');
  });

  test('两次重试之间客户端已经把整批补收并 ack：什么都不用推，也不重新生成', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'acked', payload: LLM_PAYLOAD });
    const webpush = scriptedWebpush([1]);
    const ctx = tickCtx(adapter, webpush);
    const llm = stubLlm();
    try {
      await runScheduledTick(ctx);
      const rows = await outboxOf(adapter, 'acked');
      await adapter.ackOutboxMessages(USER, rows.map((row) => row.push.messageId), Date.now());
      await makeRetryDue(adapter, 'acked');
      const second = await runScheduledTick(ctx);
      assert.equal(second.successCount, 1);
      assert.equal(second.details.redeliveredTasks[0].pushedCount, 0);
    } finally {
      llm.restore();
    }
    assert.equal(llm.calls.length, 1);
    assert.equal(webpush.received.length, 0);
    assert.equal(webpush.attempts, 1, '补推那一跳一条都没推');
  });

  test('补推又失败：继续留在退避阶梯上，下一跳还是只补推', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'twice', payload: LLM_PAYLOAD });
    const webpush = scriptedWebpush([1, 2]);   // 首次和第一次补推都 503
    const ctx = tickCtx(adapter, webpush);
    const llm = stubLlm();
    try {
      await runScheduledTick(ctx);
      await makeRetryDue(adapter, 'twice');
      const second = await runScheduledTick(ctx);
      assert.equal(second.failedCount, 1);
      assert.equal((await adapter.getTaskByUuidOnly('twice')).retry_count, 2);
      await makeRetryDue(adapter, 'twice');
      const third = await runScheduledTick(ctx);
      assert.equal(third.successCount, 1);
    } finally {
      llm.restore();
    }
    assert.equal(llm.calls.length, 1);
    assert.deepEqual(webpush.received.map((p) => p.message), ['甲1。', '乙1。']);
  });

  test('生成之后读订阅那一下失败（读库超时）：同样只补推送', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'sub-lookup', payload: LLM_PAYLOAD });
    let lookups = 0;
    const flakyDb = new Proxy(adapter, {
      get(target, prop) {
        if (prop === 'getPushSubscription') {
          return async (...args) => {
            lookups++;
            if (lookups === 1) throw new Error('D1_ERROR: storage operation timed out');
            return target.getPushSubscription(...args);
          };
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const webpush = scriptedWebpush();
    const ctx = tickCtx(flakyDb, webpush);
    const llm = stubLlm();
    try {
      const first = await runScheduledTick(ctx);
      assert.equal(first.failedCount, 1);
      assert.equal((await outboxOf(adapter, 'sub-lookup')).length, 2, '订阅没读到之前，这一批已经落定');
      await makeRetryDue(adapter, 'sub-lookup');
      const second = await runScheduledTick(ctx);
      assert.equal(second.details.redeliveredTasks.length, 1);
    } finally {
      llm.restore();
    }
    assert.equal(llm.calls.length, 1);
    assert.deepEqual(webpush.received.map((p) => p.message), ['甲1。', '乙1。']);
  });

  test('循环任务：补推成功后照常推进到下一次，下一次照常生成', async () => {
    const adapter = await makeAdapter();
    const dueAt = recentDue();
    await seedTask(adapter, { uuid: 'daily', payload: LLM_PAYLOAD, nextSendAt: dueAt, recurrenceType: 'daily' });
    const webpush = scriptedWebpush([1]);
    const ctx = tickCtx(adapter, webpush);
    const llm = stubLlm();
    try {
      await runScheduledTick(ctx);
      await makeRetryDue(adapter, 'daily');
      const second = await runScheduledTick(ctx);
      assert.equal(second.details.updatedRecurringTasks, 1);
    } finally {
      llm.restore();
    }
    const row = await adapter.getTaskByUuidOnly('daily');
    assert.equal(row.next_send_at, new Date(Date.parse(dueAt) + DAY).toISOString());
    assert.equal(row.retry_count, 0, '下一次触发 retry_count 归零，不会去找上一次的批次');
    assert.equal(llm.calls.length, 1);
  });

  test('instant 任务的请求内重试：推送 503 一次后恢复，LLM 只调一次', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'instant', payload: { ...LLM_PAYLOAD, messageType: 'instant' } });
    const webpush = scriptedWebpush([1]);
    const llm = stubLlm();
    let result;
    try {
      result = await processMessagesByUuid('instant', tickCtx(adapter, webpush), 2, USER, MASTER_KEY);
    } finally {
      llm.restore();
    }
    assert.equal(result.success, true);
    assert.equal(result.retriesUsed, 1);
    assert.equal(llm.calls.length, 1);
    assert.deepEqual(webpush.received.map((p) => p.message), ['甲1。', '乙1。']);
  });
});

describe('没落进 outbox 的批次（没有收件箱 / 落行失败）', () => {
  test('一条都没推出去：照旧重试并重新生成（客户端只会见到第二份）', async () => {
    const adapter = await makeAdapter();
    const db = withoutOutbox(adapter);
    await seedTask(adapter, { uuid: 'no-outbox', payload: LLM_PAYLOAD });
    const webpush = scriptedWebpush([1]);
    const ctx = tickCtx(db, webpush);
    const llm = stubLlm();
    try {
      const first = await runScheduledTick(ctx);
      assert.equal(first.failedCount, 1);
      assert.notEqual(first.details.failedTasks[0].permanent, true);
      await makeRetryDue(adapter, 'no-outbox');
      const second = await runScheduledTick(ctx);
      assert.equal(second.successCount, 1);
      assert.equal(second.details.redeliveredTasks.length, 0);
    } finally {
      llm.restore();
    }
    // 没有收件箱兜着，重新生成是唯一能送到的办法；设备上只有第二次生成的内容。
    assert.equal(llm.calls.length, 2);
    assert.deepEqual(webpush.received.map((p) => p.message), ['甲2。', '乙2。']);
  });

  test('已经推出去几条：就地终审，不再重新生成拼出第二份', async () => {
    const adapter = await makeAdapter();
    const db = withoutOutbox(adapter);
    await seedTask(adapter, { uuid: 'no-outbox-half', payload: LLM_PAYLOAD });
    const webpush = scriptedWebpush([2]);
    const settled = [];
    const ctx = tickCtx(db, webpush, {
      hooks: {
        onBeforeFire: async () => [{ role: 'user', content: 'U' }],
        onLLMOutput: async (sessionCtx) => finishWithSentences(sessionCtx),
      },
      onFireSettled: async (info) => { settled.push(info); },
    });
    const llm = stubLlm();
    try {
      const first = await runScheduledTick(ctx);
      assert.equal(first.details.failedTasks[0].status, 'permanently_failed');
    } finally {
      llm.restore();
    }
    assert.equal(llm.calls.length, 1);
    assert.deepEqual(webpush.received.map((p) => p.message), ['甲1']);
    assert.equal(settled[0].outboxed, false);
    assert.equal(settled[0].error.permanent, true, '回执与投递侧的终审一致');
    const row = await findTaskAnyStatus(adapter, 'no-outbox-half');
    assert.equal(row.status, 'failed');
    assert.equal(row.retry_count, 0);
  });

  test('老链路同样：已经推出去几条就终审', async () => {
    const adapter = await makeAdapter();
    const db = withoutOutbox(adapter);
    await seedTask(adapter, { uuid: 'legacy-half', payload: LLM_PAYLOAD });
    const webpush = scriptedWebpush([2]);
    const llm = stubLlm();
    try {
      const first = await runScheduledTick(tickCtx(db, webpush));
      assert.equal(first.details.failedTasks[0].status, 'permanently_failed');
    } finally {
      llm.restore();
    }
    assert.equal(llm.calls.length, 1);
    assert.equal((await findTaskAnyStatus(adapter, 'legacy-half')).status, 'failed');
  });
});

test('listOutboxForTask 按 created_at 收窄，不把整个收件箱扫一遍', async () => {
  const spy = createSpyD1();
  const adapter = createD1Adapter(spy.db);
  await adapter.initSchema();
  spy.calls.length = 0;
  await adapter.listOutboxForTask(USER, 'some-task', { sinceMs: Date.now() - 60_000 });
  const call = spy.calls.find((c) => /FROM message_outbox/i.test(c.sql));
  assert.ok(call, '录到了查询语句');
  const plan = spy._raw.prepare(`EXPLAIN QUERY PLAN ${call.sql}`).all(...call.args).map((row) => row.detail).join('\n');
  assert.doesNotMatch(plan, /\bSCAN\b/, plan);
  assert.match(plan, /USING INDEX idx_outbox_created \(created_at>\?\)/, plan);
});

// ─── 3. 用量按整次 fire 累计 ─────────────────────────────────────────────

const ENCRYPTED_PUSH_SUB = await encryptTestSubscription(USER, MASTER_KEY);

describe('usageTotal / llmCalls：整次 fire 的花费', () => {
  async function makeTask() {
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    return {
      id: 7,
      uuid: 'u7',
      user_id: USER,
      next_send_at: '2020-01-01T00:00:00.000Z',
      retry_count: 0,
      encrypted_payload: await encryptForStorage(JSON.stringify({ ...LLM_PAYLOAD, recurrenceType: 'none' }), userKey),
    };
  }

  function fireCtx(hooks, extra = {}) {
    return {
      masterKey: MASTER_KEY,
      webpush: { async sendNotification() {} },
      vapid: VAPID,
      db: withPushSubscriptionStore({}, ENCRYPTED_PUSH_SUB),
      hooks,
      _agenticSleep: async () => {},
      ...extra,
    };
  }

  const TOOL_CALL = { id: 'call_1', type: 'function', function: { name: 't', arguments: '{}' } };
  const toolRound = (usage) => new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [TOOL_CALL] } }],
    ...(usage ? { usage } : {}),
  }), { status: 200 });

  /** 第一轮要工具，第二轮收尾。 */
  function twoRoundHooks() {
    let round = 0;
    return {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => (round++ === 0
        ? { decision: 'tool-request', toolCalls: [TOOL_CALL] }
        : { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'done' }] }),
      executeToolCalls: async () => [{ tool_call_id: 'call_1', role: 'tool', content: '{}' }],
    };
  }

  test('多轮：各轮 token 相加；usage 仍是最后一轮', async () => {
    const settled = [];
    const afterSend = [];
    const llm = stubLlm((n) => (n === 1
      ? toolRound({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
      // 第二轮没报 total_tokens：用 prompt + completion 补上。
      : completion('done', { prompt_tokens: 20, completion_tokens: 7 })));
    try {
      const result = await processSingleMessage(await makeTask(), fireCtx(twoRoundHooks(), {
        onFireSettled: async (info) => { settled.push(info); },
        onAfterSend: async (info) => { afterSend.push(info); },
      }));
      assert.equal(result.success, true);
    } finally {
      llm.restore();
    }
    const expected = { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 };
    assert.deepEqual(settled[0].usageTotal, expected);
    assert.equal(settled[0].llmCalls, 2);
    assert.deepEqual(settled[0].usage, { prompt_tokens: 20, completion_tokens: 7 }, 'usage 的语义不变：最后一轮');
    assert.deepEqual(afterSend[0].usageTotal, expected);
    assert.equal(afterSend[0].llmCalls, 2);
    assert.equal(afterSend[0].outboxed, false, '这个 db 没有 outbox');
  });

  test('第二轮失败：失败结局也带上已经花掉的用量，失败那次也计进 llmCalls', async () => {
    const settled = [];
    const llm = stubLlm((n) => (n === 1
      ? toolRound({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })
      : llmError(500)));
    try {
      const result = await processSingleMessage(await makeTask(), fireCtx(twoRoundHooks(), {
        onFireSettled: async (info) => { settled.push(info); },
      }));
      assert.equal(result.success, false);
    } finally {
      llm.restore();
    }
    assert.equal(settled[0].status, 'failed');
    assert.equal(settled[0].llmCalls, 2);
    assert.deepEqual(settled[0].usageTotal, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  test('onBeforeFire 直接 skip：llmCalls 为 0，usageTotal 为 null', async () => {
    const settled = [];
    const llm = stubLlm();
    try {
      await processSingleMessage(await makeTask(), fireCtx({
        onBeforeFire: async () => ({ skip: true }),
        onLLMOutput: async () => ({ decision: 'skip-push' }),
      }, { onFireSettled: async (info) => { settled.push(info); } }));
    } finally {
      llm.restore();
    }
    assert.equal(settled[0].status, 'skipped');
    assert.equal(settled[0].llmCalls, 0);
    assert.equal(settled[0].usageTotal, null);
    assert.equal(settled[0].outboxed, false);
  });

  test('模型跑完判定不发（skip-push）：照样报这一轮的用量', async () => {
    const settled = [];
    const llm = stubLlm(() => completion('x', { input_tokens: 8, output_tokens: 2 }));
    try {
      await processSingleMessage(await makeTask(), fireCtx({
        onBeforeFire: async () => [{ role: 'user', content: 'U' }],
        onLLMOutput: async () => ({ decision: 'skip-push' }),
      }, { onFireSettled: async (info) => { settled.push(info); } }));
    } finally {
      llm.restore();
    }
    assert.equal(settled[0].status, 'skipped');
    assert.equal(settled[0].llmCalls, 1);
    // Anthropic 风格的 input / output tokens 也认。
    assert.deepEqual(settled[0].usageTotal, { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 });
  });

  test('所有轮次都没报 usage：usageTotal 为 null，llmCalls 照数', async () => {
    const settled = [];
    const llm = stubLlm((n) => (n === 1 ? toolRound() : completion('done')));
    try {
      await processSingleMessage(await makeTask(), fireCtx(twoRoundHooks(), {
        onFireSettled: async (info) => { settled.push(info); },
      }));
    } finally {
      llm.restore();
    }
    assert.equal(settled[0].usageTotal, null);
    assert.equal(settled[0].llmCalls, 2);
  });

  test('accumulateUsage：形状不齐时尽量相加', () => {
    assert.equal(accumulateUsage(null, null), null);
    assert.equal(accumulateUsage(null, { cached: 3 }), null, '一项都认不出就当没报');
    const a = accumulateUsage(null, { prompt_tokens: 5 });
    assert.deepEqual(a, { prompt_tokens: 5, completion_tokens: null, total_tokens: null });
    const b = accumulateUsage(a, { completion_tokens: 3, total_tokens: 9 });
    assert.deepEqual(b, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 9 });
    assert.deepEqual(accumulateUsage(b, { prompt_tokens: -1, completion_tokens: 'x' }), b, '非法值不计');
  });
});

// ─── maxDeliveryRetries ──────────────────────────────────────────────────

describe('maxDeliveryRetries：投递失败的重试次数上限', () => {
  const FIXED = { contactName: 'Rei', messageType: 'fixed', userMessage: '你好。' };
  const alwaysFail = () => scriptedWebpush(Array.from({ length: 20 }, (_, i) => i + 1));

  test('配 0：第一次失败就终审', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'zero', payload: FIXED });
    const res = await runScheduledTick(tickCtx(adapter, alwaysFail(), { maxDeliveryRetries: 0 }));
    assert.equal(res.details.failedTasks[0].status, 'permanently_failed');
    assert.equal((await findTaskAnyStatus(adapter, 'zero')).status, 'failed');
  });

  test('配 1：重试一次，第二次失败终审', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'one', payload: FIXED });
    const webpush = alwaysFail();
    const ctx = tickCtx(adapter, webpush, { maxDeliveryRetries: 1 });
    await runScheduledTick(ctx);
    assert.equal((await adapter.getTaskByUuidOnly('one')).retry_count, 1);
    await makeRetryDue(adapter, 'one');
    const second = await runScheduledTick(ctx);
    assert.equal(second.details.failedTasks[0].status, 'permanently_failed');
    assert.equal((await findTaskAnyStatus(adapter, 'one')).status, 'failed');
  });

  test('不配 / 配了非法值：默认 3 次，与以前一致', async () => {
    const adapter = await makeAdapter();
    await seedTask(adapter, { uuid: 'default', payload: FIXED });
    const ctx = tickCtx(adapter, alwaysFail(), { maxDeliveryRetries: -1 });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await runScheduledTick(ctx);
      assert.equal((await adapter.getTaskByUuidOnly('default')).retry_count, attempt);
      await makeRetryDue(adapter, 'default');
    }
    const last = await runScheduledTick(ctx);
    assert.equal(last.details.failedTasks[0].status, 'permanently_failed');
  });
});
