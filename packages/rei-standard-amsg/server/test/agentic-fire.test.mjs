import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { processSingleMessage } from '../src/server/lib/message-processor.js';
import { callLlm } from '../src/server/lib/llm.js';
import { decryptFromStorage, deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { encryptTestSubscription, seedPushSubscription, withPushSubscriptionStore } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
// 用户级订阅：投递时从这里现读（任务行不携带订阅）。
const ENCRYPTED_PUSH_SUB = await encryptTestSubscription(USER, MASTER_KEY);

async function makeTask(payloadOverrides = {}) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const payload = {
    contactName: 'Rei',
    messageType: 'auto',
    completePrompt: 'frozen prompt',
    apiUrl: 'https://api.example.com/v1/chat/completions',
    apiKey: 'sk-secret',
    primaryModel: 'model-x',
    recurrenceType: 'daily',
    pushSubscription: { endpoint: 'https://push.example.com/sub', keys: { p256dh: 'k', auth: 'a' } },
    metadata: { charId: 'char-1' },
    ...payloadOverrides,
  };
  return {
    task: {
      id: 7, user_id: USER, uuid: 'u7',
      encrypted_payload: await encryptForStorage(JSON.stringify(payload), userKey),
      next_send_at: '2020-01-01T00:00:00.000Z', retry_count: 0,
    },
    payload,
  };
}

function makeCtx({ hooks, maxToolIterations, totalTimeoutMs, db, pushSpy, now, maxScheduledTasksPerFire } = {}) {
  return {
    masterKey: MASTER_KEY,
    webpush: { async sendNotification(sub, payload) { if (pushSpy) pushSpy(sub, payload); } },
    vapid: { email: 'v@example.com', publicKey: 'pub', privateKey: 'priv' },
    db: withPushSubscriptionStore(db || {}, ENCRYPTED_PUSH_SUB),
    hooks: hooks || null,
    maxToolIterations,
    totalTimeoutMs,
    maxScheduledTasksPerFire,
    _agenticSleep: async () => {},   // don't actually sleep 1.5s in tests
    _agenticNow: now,
  };
}

// fetch stub: returns scripted LLM responses in call order (last one repeats)
function stubLlm(responses, onCall) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (onCall) onCall(calls.length);
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: true, async json() { return r; } };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const TOOL_CALL = { id: 'call_1', type: 'function', function: { name: 'lookup_notes', arguments: '{"q":"recent"}' } };
const toolRound = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [TOOL_CALL] } }] };
const finishRound = { choices: [{ message: { role: 'assistant', content: '最终回复' } }] };

describe('agentic fire loop', () => {
  test('happy path: onBeforeFire → tool round → executeToolCalls → finish with 2 pushes', async () => {
    const { task } = await makeTask();
    const beforeMessages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }];
    const executed = [];
    const decisions = [
      { decision: 'tool-request', toolCalls: [TOOL_CALL] },
      { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'A' }, { messageKind: 'content', message: 'B' }] },
    ];
    let llmOutputCalls = 0;
    const hooks = {
      onBeforeFire: async () => beforeMessages,
      onLLMOutput: async () => decisions[llmOutputCalls++],
      executeToolCalls: async (toolCalls) => {
        executed.push(toolCalls);
        return [{ tool_call_id: 'call_1', role: 'tool', content: '{"notes":[]}' }];
      },
    };
    const pushes = [];
    const llm = stubLlm([toolRound, finishRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks, pushSpy: (_s, p) => pushes.push(JSON.parse(p)) }));
      assert.equal(result.success, true);
      assert.equal(result.status, 'finished');
      assert.equal(result.iterations, 2);
      assert.equal(result.messagesSent, 2);

      // round 1 request used onBeforeFire's messages, not the frozen prompt
      assert.deepEqual(llm.calls[0].body.messages, beforeMessages);
      // round 2 appended assistant(tool_calls) + tool result
      const round2 = llm.calls[1].body.messages;
      assert.equal(round2.length, 4);
      assert.deepEqual(round2[2].tool_calls, [TOOL_CALL]);
      assert.equal(round2[3].role, 'tool');
      assert.equal(round2[3].tool_call_id, 'call_1');

      assert.deepEqual(executed, [[TOOL_CALL]]);

      // pushes: index/total overwritten, session pinned to (task id + 名义触发
      // 时刻), ids stamped —— 掺 occurrence 是为了循环任务跨天不同 occurrence
      // 的推送不在 SW/收件箱端互相去重覆盖
      const occurrenceMs = Date.parse('2020-01-01T00:00:00.000Z');
      assert.equal(pushes.length, 2);
      assert.deepEqual(pushes.map((p) => [p.messageIndex, p.totalMessages]), [[1, 2], [2, 2]]);
      for (const [i, p] of pushes.entries()) {
        assert.equal(p.sessionId, `sess_task_7@${occurrenceMs}`);
        assert.equal(p.messageId, `msg_task_7@${occurrenceMs}_hook_${i}`);
      }
      assert.deepEqual(pushes.map((p) => p.message), ['A', 'B']);
    } finally {
      llm.restore();
    }
  });

  test('instant-classifier shape: tool-request via pushPayloads is executed, NOT pushed', async () => {
    const { task } = await makeTask();
    const executed = [];
    let llmOutputCalls = 0;
    const decisions = [
      { decision: 'tool-request', pushPayloads: [{ messageKind: 'tool_request', toolCalls: [TOOL_CALL] }] },
      { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'done' }] },
    ];
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => decisions[llmOutputCalls++],
      executeToolCalls: async (toolCalls) => {
        executed.push(toolCalls);
        return [{ tool_call_id: 'call_1', role: 'tool', content: 'ok' }];
      },
    };
    const pushes = [];
    const llm = stubLlm([toolRound, finishRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks, pushSpy: (_s, p) => pushes.push(JSON.parse(p)) }));
      assert.equal(result.success, true);
      assert.deepEqual(executed, [[TOOL_CALL]]);
      // only the finish push went out; the tool_request payload was consumed server-side
      assert.equal(pushes.length, 1);
      assert.equal(pushes[0].message, 'done');
    } finally {
      llm.restore();
    }
  });

  test('maxToolIterations (factory level): forced wrap-up, last tool round short-circuits', async () => {
    const { task } = await makeTask();
    let llmOutputCalls = 0;
    let executeCalls = 0;
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => { llmOutputCalls++; return { decision: 'tool-request', toolCalls: [TOOL_CALL] }; },
      executeToolCalls: async () => { executeCalls++; return [{ tool_call_id: 'call_1', role: 'tool', content: 'x' }]; },
    };
    const llm = stubLlm([toolRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks, maxToolIterations: 3 }));
      assert.equal(result.success, false);
      assert.match(result.error, /AGENTIC_LOOP_EXCEEDED/);
      assert.equal(llm.calls.length, 3);
      assert.equal(llmOutputCalls, 3);
      assert.equal(executeCalls, 2); // last round short-circuits before executing
    } finally {
      llm.restore();
    }
  });

  test('onBeforeFire override: maxToolIterations 1 beats the factory value', async () => {
    const { task } = await makeTask();
    let executeCalls = 0;
    const hooks = {
      onBeforeFire: async () => ({ messages: [{ role: 'user', content: 'U' }], maxToolIterations: 1 }),
      onLLMOutput: async () => ({ decision: 'tool-request', toolCalls: [TOOL_CALL] }),
      executeToolCalls: async () => { executeCalls++; return []; },
    };
    const llm = stubLlm([toolRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks, maxToolIterations: 5 }));
      assert.equal(result.success, false);
      assert.match(result.error, /AGENTIC_LOOP_EXCEEDED/);
      assert.equal(llm.calls.length, 1);
      assert.equal(executeCalls, 0);
    } finally {
      llm.restore();
    }
  });

  test('totalTimeoutMs: wall-time ceiling breaks the loop; onBeforeFire can tighten it', async () => {
    // fake clock advances 100s per LLM call
    let fakeNow = 0;
    const { task } = await makeTask();
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => ({ decision: 'tool-request', toolCalls: [TOOL_CALL] }),
      executeToolCalls: async () => [{ tool_call_id: 'call_1', role: 'tool', content: 'x' }],
    };
    let llm = stubLlm([toolRound], () => { fakeNow += 100_000; });
    try {
      const result = await processSingleMessage(task, makeCtx({
        hooks, maxToolIterations: 10, totalTimeoutMs: 250_000, now: () => fakeNow,
      }));
      assert.equal(result.success, false);
      assert.match(result.error, /AGENTIC_TOTAL_TIMEOUT/);
      assert.equal(llm.calls.length, 3); // deadline 250s: rounds at t=0,100k,200k pass; t=300k breaks
    } finally {
      llm.restore();
    }

    fakeNow = 0;
    llm = stubLlm([toolRound], () => { fakeNow += 100_000; });
    try {
      const hooks2 = {
        ...hooks,
        onBeforeFire: async () => ({ messages: [{ role: 'user', content: 'U' }], totalTimeoutMs: 150_000 }),
      };
      const result = await processSingleMessage(task, makeCtx({
        hooks: hooks2, maxToolIterations: 10, totalTimeoutMs: 250_000, now: () => fakeNow,
      }));
      assert.equal(result.success, false);
      assert.match(result.error, /AGENTIC_TOTAL_TIMEOUT/);
      assert.equal(llm.calls.length, 2); // tightened deadline 150s: t=0,100k pass; t=200k breaks
    } finally {
      llm.restore();
    }
  });

  // A hung LLM request must not outlive totalTimeoutMs waiting for its own
  // legacy 300s abort: each round's fetch timeout shrinks to the remaining
  // wall-time budget.
  test('LLM per-round fetch timeout shrinks to the remaining totalTimeoutMs budget', async () => {
    let fakeNow = 0;
    const { task } = await makeTask();
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => ({ decision: 'tool-request', toolCalls: [TOOL_CALL] }),
      executeToolCalls: async () => [{ tool_call_id: 'call_1', role: 'tool', content: 'x' }],
    };
    const captured = [];
    const origTimeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => { captured.push(ms); return origTimeout.call(AbortSignal, 300000); };
    const llm = stubLlm([toolRound], () => { fakeNow += 100_000; });
    try {
      const result = await processSingleMessage(task, makeCtx({
        hooks, maxToolIterations: 10, totalTimeoutMs: 250_000, now: () => fakeNow,
      }));
      assert.equal(result.success, false);
      assert.match(result.error, /AGENTIC_TOTAL_TIMEOUT/);
      assert.deepEqual(captured, [250_000, 150_000, 50_000]);
    } finally {
      AbortSignal.timeout = origTimeout;
      llm.restore();
    }
  });

  test('callLlm: default per-call timeout stays 300s; custom timeoutMs is honored', async () => {
    const captured = [];
    const origTimeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => { captured.push(ms); return origTimeout.call(AbortSignal, 300000); };
    const llm = stubLlm([finishRound]);
    try {
      const payload = { apiUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'k', primaryModel: 'm', completePrompt: 'p' };
      await callLlm(payload);
      await callLlm(payload, { timeoutMs: 1234 });
      assert.deepEqual(captured, [300_000, 1234]);
    } finally {
      AbortSignal.timeout = origTimeout;
      llm.restore();
    }
  });

  test('skip-push: records and ends without pushing; task counts as success', async () => {
    const { task } = await makeTask();
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => ({ decision: 'skip-push' }),
    };
    const pushes = [];
    const llm = stubLlm([finishRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks, pushSpy: (_s, p) => pushes.push(p) }));
      assert.deepEqual(result, { success: true, messagesSent: 0, status: 'skipped', iterations: 1 });
      assert.equal(pushes.length, 0);
    } finally {
      llm.restore();
    }
  });

  test('onBeforeFire { skip: true }: fire ends before the first LLM call; zero-push success', async () => {
    const { task } = await makeTask();
    const hooks = {
      onBeforeFire: async () => ({ skip: true }),
      // If the skip ever leaked into the LLM loop, onLLMOutput would run and
      // this throw would flip result.success to false — the deepEqual guards it.
      onLLMOutput: async () => { throw new Error('onLLMOutput must not run when onBeforeFire skips'); },
    };
    const pushes = [];
    const llm = stubLlm([finishRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks, pushSpy: (_s, p) => pushes.push(p) }));
      // Same shape as the post-LLM skip-push path, but iterations: 0 — no round ran.
      assert.deepEqual(result, { success: true, messagesSent: 0, status: 'skipped', iterations: 0 });
      assert.equal(llm.calls.length, 0);   // never reached the LLM
      assert.equal(pushes.length, 0);
    } finally {
      llm.restore();
    }
  });

  test('continue: nextHistory replaces the running messages', async () => {
    const { task } = await makeTask();
    const nextHistory = [{ role: 'user', content: '重来' }];
    let llmOutputCalls = 0;
    const decisions = [
      { decision: 'continue', nextHistory },
      { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'ok' }] },
    ];
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'first' }],
      onLLMOutput: async () => decisions[llmOutputCalls++],
    };
    const llm = stubLlm([finishRound, finishRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks }));
      assert.equal(result.success, true);
      assert.equal(result.iterations, 2);
      assert.deepEqual(llm.calls[1].body.messages, nextHistory);
    } finally {
      llm.restore();
    }
  });

  test('executeToolCalls throws → error text fed back as tool result, fire still succeeds', async () => {
    const { task } = await makeTask();
    let llmOutputCalls = 0;
    const decisions = [
      { decision: 'tool-request', toolCalls: [TOOL_CALL] },
      { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'recovered' }] },
    ];
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => decisions[llmOutputCalls++],
      executeToolCalls: async () => { throw new Error('boom'); },
    };
    const llm = stubLlm([toolRound, finishRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks }));
      assert.equal(result.success, true);
      const round2 = llm.calls[1].body.messages;
      const toolMsg = round2[round2.length - 1];
      assert.equal(toolMsg.role, 'tool');
      assert.equal(toolMsg.tool_call_id, 'call_1');
      assert.match(toolMsg.content, /Tool execution failed: boom/);
    } finally {
      llm.restore();
    }
  });

  test('credential hiding: no apiKey/pushSubscription/vapid/masterKey on any hook ctx', async () => {
    const { task } = await makeTask();
    let capturedFireCtx = null;
    let capturedSessionCtx = null;
    const hooks = {
      onBeforeFire: async (fireCtx) => { capturedFireCtx = fireCtx; return [{ role: 'user', content: 'U' }]; },
      onLLMOutput: async (sessionCtx) => { capturedSessionCtx = sessionCtx; return { decision: 'skip-push' }; },
    };
    const llm = stubLlm([finishRound]);
    try {
      await processSingleMessage(task, makeCtx({ hooks }));

      assert.ok(Object.isFrozen(capturedFireCtx));
      assert.ok(Object.isFrozen(capturedFireCtx.task));
      assert.ok(Object.isFrozen(capturedSessionCtx));

      for (const k of ['apiKey', 'pushSubscription']) {
        assert.equal(k in capturedFireCtx.task, false, `fireCtx.task must not carry ${k}`);
      }
      for (const k of ['vapid', 'masterKey', 'apiKey', 'pushSubscription', 'webpush']) {
        assert.equal(k in capturedFireCtx, false, `fireCtx must not carry ${k}`);
      }
      // task view still carries the useful non-secret fields
      assert.equal(capturedFireCtx.task.contactName, 'Rei');
      assert.equal(capturedFireCtx.task.id, 7);
      assert.equal(capturedFireCtx.userId, USER);
      assert.ok(capturedFireCtx.now instanceof Date);

      const allowedSessionKeys = new Set([
        'sessionId', 'charId', 'messages', 'llmResponse', 'llmOutputText',
        'iteration', 'metadata', 'contactName', 'avatarUrl', 'scratch',
        // server 侧在共享 SessionContext 之上加的任务身份、状态访问器与建任务口
        'taskId', 'taskUuid', 'occurrenceMs',
        'readState', 'writeState', 'scheduleTask',
        // 往客户端补一条自定义结果（落收件箱 + 推送）
        'emitResult',
        // usage 是共享 SessionContext 新增的便捷字段（llmResponse.usage 的引用）；
        // cancelTask / renewTask 是 fire 内的任务管理口
        'usage', 'cancelTask', 'renewTask',
        // 按 cred_id 现读一份凭据（返回新对象，不挂在 ctx 上——这里只是方法本身）
        'resolveLlmCredential',
      ]);
      for (const k of Object.keys(capturedSessionCtx)) {
        assert.ok(allowedSessionKeys.has(k), `unexpected sessionCtx key: ${k}`);
      }
    } finally {
      llm.restore();
    }
  });

  test('readState reads decrypted client_state entries', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'k', value: await encryptForStorage('hello', userKey), updatedAt: 42 },
    ]);

    const { task } = await makeTask();
    let stateSeen = null;
    const hooks = {
      onBeforeFire: async (fireCtx) => {
        stateSeen = await fireCtx.readState('notes');
        return [{ role: 'user', content: 'U' }];
      },
      onLLMOutput: async () => ({ decision: 'skip-push' }),
    };
    const llm = stubLlm([finishRound]);
    try {
      await processSingleMessage(task, makeCtx({ hooks, db: adapter }));
      assert.deepEqual(stateSeen, [{ namespace: 'notes', key: 'k', value: 'hello', updatedAt: 42 }]);
    } finally {
      llm.restore();
    }
  });

  test('onBeforeFire returns null → legacy frozen-prompt path, hook loop untouched', async () => {
    const { task } = await makeTask();
    let llmOutputCalls = 0;
    const hooks = {
      onBeforeFire: async () => null,
      onLLMOutput: async () => { llmOutputCalls++; return { decision: 'skip-push' }; },
    };
    const pushes = [];
    const llm = stubLlm([{ choices: [{ message: { content: 'hello world' } }] }]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks, pushSpy: (_s, p) => pushes.push(p) }));
      assert.equal(result.success, true);
      assert.equal(llm.calls.length, 1);
      assert.deepEqual(llm.calls[0].body.messages, [{ role: 'user', content: 'frozen prompt' }]);
      assert.equal(llm.calls[0].body.temperature, 0.8);
      assert.equal(llmOutputCalls, 0);
      assert.equal(pushes.length, 1);
    } finally {
      llm.restore();
    }
  });

  test('fixed task with hooks → onBeforeFire never called, legacy path pushes userMessage', async () => {
    const { task } = await makeTask({
      messageType: 'fixed', userMessage: 'hi', apiUrl: null, apiKey: null, primaryModel: null, completePrompt: null,
    });
    let beforeFireCalls = 0;
    const hooks = {
      onBeforeFire: async () => { beforeFireCalls++; return [{ role: 'user', content: 'U' }]; },
      onLLMOutput: async () => ({ decision: 'skip-push' }),
    };
    const pushes = [];
    const llm = stubLlm([finishRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks, pushSpy: (_s, p) => pushes.push(JSON.parse(p)) }));
      assert.equal(result.success, true);
      assert.equal(beforeFireCalls, 0);
      assert.equal(llm.calls.length, 0);
      assert.equal(pushes.length, 1);
      assert.equal(pushes[0].message, 'hi');
    } finally {
      llm.restore();
    }
  });

  test('onBeforeFire configured without onLLMOutput → clear config error', async () => {
    const { task } = await makeTask();
    const hooks = { onBeforeFire: async () => [{ role: 'user', content: 'U' }] };
    const llm = stubLlm([finishRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks }));
      assert.equal(result.success, false);
      assert.match(result.error, /AGENTIC_CONFIG_ERROR/);
      assert.equal(llm.calls.length, 0);
    } finally {
      llm.restore();
    }
  });

  test('tool-request without executeToolCalls configured → clear config error', async () => {
    const { task } = await makeTask();
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => ({ decision: 'tool-request', toolCalls: [TOOL_CALL] }),
    };
    const llm = stubLlm([toolRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks }));
      assert.equal(result.success, false);
      assert.match(result.error, /AGENTIC_CONFIG_ERROR/);
    } finally {
      llm.restore();
    }
  });

  test('onBeforeFire may return { messages, tools }: every round carries them', async () => {
    const { task } = await makeTask();
    const tools = [
      { type: 'function', function: { name: 'lookup_notes', parameters: { type: 'object', properties: {} } } },
    ];
    let llmOutputCalls = 0;
    const decisions = [
      { decision: 'tool-request', toolCalls: [TOOL_CALL] },
      { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'done' }] },
    ];
    const hooks = {
      onBeforeFire: async () => ({ messages: [{ role: 'user', content: 'U' }], tools, toolChoice: 'auto' }),
      onLLMOutput: async () => decisions[llmOutputCalls++],
      executeToolCalls: async () => [{ tool_call_id: 'call_1', role: 'tool', content: 'ok' }],
    };
    const llm = stubLlm([toolRound, finishRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks }));
      assert.equal(result.success, true);
      assert.equal(llm.calls.length, 2);
      // 工具声明每轮都要带上：补完那轮 LLM 还可能再发起调用
      assert.deepEqual(llm.calls[0].body.tools, tools);
      assert.deepEqual(llm.calls[1].body.tools, tools);
      assert.equal(llm.calls[0].body.tool_choice, 'auto');
      assert.equal(llm.calls[1].body.tool_choice, 'auto');
    } finally {
      llm.restore();
    }
  });

  // native 调用和文本协议合成的调用同轮出现时，assistant 上两边的 id 都要在，
  // 否则那半边的 role:'tool' 结果没有归属，严格的 OpenAI 兼容中转会拒掉下一轮。
  test('assistant stamping merges native tool_calls with synthesized ones (no orphan role:tool)', async () => {
    const { task } = await makeTask();
    const nativeCall = { id: 'call_native', type: 'function', function: { name: 'lookup_notes', arguments: '{}' } };
    const tagCall = { id: 'call_tag', type: 'function', function: { name: 'mcp__weather', arguments: '{"city":"Shanghai"}' } };
    const mixedRound = {
      choices: [{ message: { role: 'assistant', content: '<tool>weather</tool>', tool_calls: [nativeCall] } }],
    };
    let llmOutputCalls = 0;
    const decisions = [
      // 分类器把正文里的调用也认出来，和 native 的一起交回来
      { decision: 'tool-request', toolCalls: [nativeCall, tagCall] },
      { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'done' }] },
    ];
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => decisions[llmOutputCalls++],
      executeToolCalls: async (toolCalls) =>
        toolCalls.map((tc) => ({ tool_call_id: tc.id, role: 'tool', content: 'ok' })),
    };
    const llm = stubLlm([mixedRound, finishRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks }));
      assert.equal(result.success, true);
      const round2 = llm.calls[1].body.messages;
      const assistant = round2.find((m) => m.role === 'assistant');
      assert.deepEqual(assistant.tool_calls.map((tc) => tc.id), ['call_native', 'call_tag']);
      // 每条 role:'tool' 都能在 assistant.tool_calls 里找到归属，一条不落
      const stampedIds = new Set(assistant.tool_calls.map((tc) => tc.id));
      const toolResults = round2.filter((m) => m.role === 'tool');
      assert.equal(toolResults.length, 2);
      for (const m of toolResults) {
        assert.ok(stampedIds.has(m.tool_call_id), `orphan tool result: ${m.tool_call_id}`);
      }
    } finally {
      llm.restore();
    }
  });

  // 纯文本协议：模型一个 native tool_call 都没声明，调用全靠 classifier 从正文
  // 里认出来。这时 assistant 上本来空空如也，补章要把合成的那份整个盖上去，
  // 后面的 role:'tool' 才有归属。
  test('assistant stamping: synthesized-only round gets the full tool_calls stamped on', async () => {
    const { task } = await makeTask();
    const tagCalls = [
      { id: 'call_tag_1', type: 'function', function: { name: 'mcp__weather', arguments: '{"city":"Shanghai"}' } },
      { id: 'call_tag_2', type: 'function', function: { name: 'mcp__notes', arguments: '{}' } },
    ];
    // 正文里写着调用，choices[0].message 上没有 tool_calls 这个字段
    const textOnlyRound = {
      choices: [{ message: { role: 'assistant', content: '<tool>weather</tool><tool>notes</tool>' } }],
    };
    let llmOutputCalls = 0;
    const decisions = [
      { decision: 'tool-request', toolCalls: tagCalls },
      { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'done' }] },
    ];
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => decisions[llmOutputCalls++],
      executeToolCalls: async (toolCalls) =>
        toolCalls.map((tc) => ({ tool_call_id: tc.id, role: 'tool', content: 'ok' })),
    };
    const llm = stubLlm([textOnlyRound, finishRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks }));
      assert.equal(result.success, true);
      const round2 = llm.calls[1].body.messages;
      const assistant = round2.find((m) => m.role === 'assistant');
      assert.deepEqual(assistant.tool_calls, tagCalls);
      // 正文照留，补章只是多加了 tool_calls 这一个字段
      assert.equal(assistant.content, '<tool>weather</tool><tool>notes</tool>');
      const stampedIds = new Set(assistant.tool_calls.map((tc) => tc.id));
      const toolResults = round2.filter((m) => m.role === 'tool');
      assert.equal(toolResults.length, 2);
      for (const m of toolResults) {
        assert.ok(stampedIds.has(m.tool_call_id), `orphan tool result: ${m.tool_call_id}`);
      }
    } finally {
      llm.restore();
    }
  });
});

describe('agentic fire via the single-user worker (scheduled e2e)', () => {
  // 「刚到点」的触发时刻：run-tick 的补发新鲜度守卫只放行 60 分钟内的任务。
  const dueAt = () => new Date(Date.now() - 30_000).toISOString();

  async function seedDueTask(adapter, payloadOverrides = {}) {
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const payload = {
      contactName: 'Rei', messageType: 'auto', completePrompt: 'frozen prompt',
      apiUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'sk-secret',
      primaryModel: 'model-x', recurrenceType: 'daily',
      pushSubscription: { endpoint: 'https://push.example.com/sub', keys: { p256dh: 'k', auth: 'a' } },
      ...payloadOverrides,
    };
    return adapter.createTask({
      user_id: USER, uuid: 'due-agentic',
      encrypted_payload: await encryptForStorage(JSON.stringify(payload), userKey),
      next_send_at: dueAt(), message_type: payload.messageType,
    });
  }

  test('scheduled(): hooks drive the fire, recurring task is rescheduled cleanly', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'latest', value: await encryptForStorage('state-derived context', userKey), updatedAt: 1 },
    ]);
    const seeded = await seedDueTask(adapter);
    // 用户级订阅：投递时现读这一份。
    await seedPushSubscription(adapter, USER, MASTER_KEY);

    const pushes = [];
    const worker = createSingleUserCloudflareWorker(() => ({
      db: adapter,
      masterKey: MASTER_KEY,
      vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
      webpush: { async sendNotification(_sub, payload) { pushes.push(JSON.parse(payload)); } },
      hooks: {
        onBeforeFire: async (fireCtx) => {
          const state = await fireCtx.readState('notes');
          return [{ role: 'user', content: `write with: ${state[0].value}` }];
        },
        onLLMOutput: async (sessionCtx) => ({
          decision: 'finish',
          pushPayloads: [{ messageKind: 'content', message: sessionCtx.llmOutputText }],
        }),
        executeToolCalls: async () => [],
      },
      maxToolIterations: 4,
      totalTimeoutMs: 60_000,
    }));

    const llm = stubLlm([finishRound]);
    try {
      await worker.scheduled({}, { DB: d1 });
    } finally {
      llm.restore();
    }

    // the fresh, state-derived prompt hit the LLM — not the frozen one
    assert.deepEqual(llm.calls[0].body.messages, [{ role: 'user', content: 'write with: state-derived context' }]);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].message, '最终回复');

    // recurring task rescheduled +24h, retry counter reset
    const row = await adapter.getTaskByUuidOnly('due-agentic');
    assert.equal(row.next_send_at, new Date(Date.parse(seeded.next_send_at) + 24 * 60 * 60 * 1000).toISOString());
    assert.equal(row.retry_count, 0);
  });

  test('scheduled(): hooks returning null keep the frozen-prompt chain', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedDueTask(adapter);

    const worker = createSingleUserCloudflareWorker(() => ({
      db: adapter,
      masterKey: MASTER_KEY,
      vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
      webpush: { async sendNotification() {} },
      hooks: {
        onBeforeFire: async () => null,
        onLLMOutput: async () => ({ decision: 'skip-push' }),
      },
    }));

    const llm = stubLlm([{ choices: [{ message: { content: 'hello world' } }] }]);
    try {
      await worker.scheduled({}, { DB: d1 });
    } finally {
      llm.restore();
    }
    assert.equal(llm.calls.length, 1);
    assert.deepEqual(llm.calls[0].body.messages, [{ role: 'user', content: 'frozen prompt' }]);
  });
});

describe('readState 分块拼回', () => {
  test('分块的 client_state 值拼回原文；写到一半断掉的 key 不出现', async () => {
    const { buildChunkedRootValue, chunkNamespaceFor, chunkKeyFor } =
      await import('../src/server/lib/state-chunks.js');
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    await adapter.upsertClientState(USER, [
      { namespace: 'ns', key: 'big', value: buildChunkedRootValue(2), updatedAt: 100 },
      { namespace: chunkNamespaceFor('ns'), key: chunkKeyFor('big', 0), value: await encryptForStorage('前半', userKey), updatedAt: 100 },
      { namespace: chunkNamespaceFor('ns'), key: chunkKeyFor('big', 1), value: await encryptForStorage('后半', userKey), updatedAt: 100 },
      { namespace: 'ns', key: 'torn', value: buildChunkedRootValue(2), updatedAt: 200 },
      { namespace: chunkNamespaceFor('ns'), key: chunkKeyFor('torn', 0), value: await encryptForStorage('半截', userKey), updatedAt: 200 },
    ]);

    const { task } = await makeTask();
    let seen;
    const hooks = {
      onBeforeFire: async (fireCtx) => {
        seen = await fireCtx.readState('ns');
        return [{ role: 'user', content: 'U' }];
      },
      onLLMOutput: async () => ({ decision: 'skip-push' }),
    };
    const llm = stubLlm([finishRound]);
    try {
      const result = await processSingleMessage(task, makeCtx({ hooks, db: adapter }));
      assert.equal(result.success, true);
      assert.deepEqual(seen, [{ namespace: 'ns', key: 'big', value: '前半后半', updatedAt: 100 }]);
    } finally {
      llm.restore();
    }
  });
});

describe('writeState', () => {
  // 跑一次 fire，把 fireCtx / sessionCtx 交给回调折腾，返回 processSingleMessage 的结果。
  async function fireWith(adapter, { onFire, onSession } = {}) {
    const { task } = await makeTask();
    const hooks = {
      onBeforeFire: async (fireCtx) => {
        if (onFire) await onFire(fireCtx);
        return [{ role: 'user', content: 'U' }];
      },
      onLLMOutput: async (sessionCtx) => {
        if (onSession) await onSession(sessionCtx);
        return { decision: 'skip-push' };
      },
    };
    const llm = stubLlm([finishRound]);
    try {
      return await processSingleMessage(task, makeCtx({ hooks, db: adapter }));
    } finally {
      llm.restore();
    }
  }

  async function freshAdapter() {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    return adapter;
  }

  test('写入 → readState 读回原文；覆盖写换掉旧值；value:null 删掉这一条', async () => {
    const adapter = await freshAdapter();
    let seen = [];

    let result = await fireWith(adapter, {
      onFire: async (ctx) => {
        const r = await ctx.writeState('bypass', [
          { key: 'note-1', value: '第一版', updatedAt: 100 },
          { key: 'note-2', value: 'keep me', updatedAt: 100 },
        ]);
        assert.deepEqual(r, { upserted: 2, skipped: 0, deleted: 0, skippedEntries: [] });
        seen = await ctx.readState('bypass');
      },
    });
    assert.equal(result.success, true);
    assert.deepEqual(seen.map((e) => [e.key, e.value]), [['note-1', '第一版'], ['note-2', 'keep me']]);

    // 覆盖写：整条换掉，不是追加
    result = await fireWith(adapter, {
      onFire: async (ctx) => {
        await ctx.writeState('bypass', [{ key: 'note-1', value: '第二版', updatedAt: 200 }]);
        seen = await ctx.readState('bypass');
      },
    });
    assert.equal(result.success, true);
    assert.deepEqual(seen.map((e) => [e.key, e.value]), [['note-1', '第二版'], ['note-2', 'keep me']]);

    // 删除
    result = await fireWith(adapter, {
      onFire: async (ctx) => {
        const r = await ctx.writeState('bypass', [{ key: 'note-1', value: null, updatedAt: 300 }]);
        assert.deepEqual(r, { upserted: 0, skipped: 0, deleted: 1, skippedEntries: [] });
        seen = await ctx.readState('bypass');
      },
    });
    assert.equal(result.success, true);
    assert.deepEqual(seen.map((e) => e.key), ['note-2']);
  });

  // 前缀删会把 'note' 的删除请求变成「删掉所有以 note 开头的 key」，
  // 顺手带走 'notes' —— 删除必须走精确 key 匹配。
  test('删除只命中这一个 key，同前缀的兄弟 key 不受影响', async () => {
    const adapter = await freshAdapter();
    let seen = [];
    const result = await fireWith(adapter, {
      onFire: async (ctx) => {
        await ctx.writeState('ns', [
          { key: 'note', value: 'A', updatedAt: 100 },
          { key: 'notes', value: 'B', updatedAt: 100 },
          { key: 'note-extra', value: 'C', updatedAt: 100 },
        ]);
        await ctx.writeState('ns', [{ key: 'note', value: null, updatedAt: 200 }]);
        seen = await ctx.readState('ns');
      },
    });
    assert.equal(result.success, true);
    assert.deepEqual(seen.map((e) => [e.key, e.value]), [['note-extra', 'C'], ['notes', 'B']]);
  });

  // 旁路数据无限堆积的守卫：大值走分块存储，删除必须把切片行也带走，
  // 不然 D1 里会留下一堆没人引用得到的切片。
  test('大值分块写入 → readState 拼回原文；删除后切片行不残留', async () => {
    const adapter = await freshAdapter();
    const { chunkNamespaceFor } = await import('../src/server/lib/state-chunks.js');
    const big = '笔'.repeat(120_000); // UTF-8 360KB，超过 200KB 单行上限
    let seen = [];

    let result = await fireWith(adapter, {
      onFire: async (ctx) => {
        await ctx.writeState('bypass', [{ key: 'xhs-note', value: big, updatedAt: 100 }]);
        seen = await ctx.readState('bypass');
      },
    });
    assert.equal(result.success, true);
    assert.deepEqual(seen.map((e) => [e.key, e.value.length]), [['xhs-note', big.length]]);
    assert.equal(seen[0].value, big);
    assert.ok((await adapter.getClientState(USER, chunkNamespaceFor('bypass'))).length >= 2, '大值应当被切片存储');

    result = await fireWith(adapter, {
      onFire: async (ctx) => {
        await ctx.writeState('bypass', [{ key: 'xhs-note', value: null, updatedAt: 200 }]);
        seen = await ctx.readState('bypass');
      },
    });
    assert.equal(result.success, true);
    assert.deepEqual(seen, []);
    assert.deepEqual(await adapter.getClientState(USER, 'bypass'), []);
    assert.deepEqual(await adapter.getClientState(USER, chunkNamespaceFor('bypass')), []);
  });

  test('last-write-wins：updatedAt 比库里旧的写入被跳过', async () => {
    const adapter = await freshAdapter();
    let outcome = null;
    let seen = [];
    const result = await fireWith(adapter, {
      onFire: async (ctx) => {
        await ctx.writeState('ns', [{ key: 'k', value: 'new', updatedAt: 500 }]);
        outcome = await ctx.writeState('ns', [{ key: 'k', value: 'stale', updatedAt: 100 }]);
        seen = await ctx.readState('ns');
      },
    });
    assert.equal(result.success, true);
    assert.deepEqual(outcome, { upserted: 0, skipped: 1, deleted: 0, skippedEntries: [{ namespace: 'ns', key: 'k' }] });
    assert.deepEqual(seen.map((e) => e.value), ['new']);
  });

  // 大内容要不要旁路，往往到组 pushPayloads 时才知道——那时 onBeforeFire 早已返回，
  // 所以 sessionCtx 上也得有写口。
  test('sessionCtx 上也能写：onLLMOutput 里存下大内容，push 只带引用键', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    const long = '正文'.repeat(5000);

    const pushes = [];
    const worker = createSingleUserCloudflareWorker(() => ({
      db: adapter,
      masterKey: MASTER_KEY,
      vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
      webpush: { async sendNotification(_sub, payload) { pushes.push(JSON.parse(payload)); } },
      hooks: {
        onBeforeFire: async () => [{ role: 'user', content: 'U' }],
        onLLMOutput: async (sessionCtx) => {
          await sessionCtx.writeState('bypass', [{ key: 'ref-1', value: long, updatedAt: 100 }]);
          return {
            decision: 'finish',
            pushPayloads: [{ messageKind: 'content', message: '发你了', bypassRef: 'bypass/ref-1' }],
          };
        },
      },
    }));

    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    await adapter.createTask({
      user_id: USER,
      uuid: 'due-writestate',
      encrypted_payload: await encryptForStorage(JSON.stringify({
        contactName: 'Rei', messageType: 'auto', completePrompt: 'frozen prompt',
        apiUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'sk-secret',
        primaryModel: 'model-x',
        pushSubscription: { endpoint: 'https://push.example.com/sub', keys: { p256dh: 'k', auth: 'a' } },
      }), userKey),
      next_send_at: new Date(Date.now() - 30_000).toISOString(),
      message_type: 'auto',
    });
    await seedPushSubscription(adapter, USER, MASTER_KEY);

    const llm = stubLlm([finishRound]);
    try {
      await worker.scheduled({}, { DB: d1 });
    } finally {
      llm.restore();
    }

    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].bypassRef, 'bypass/ref-1');
    assert.equal(JSON.stringify(pushes[0]).length < long.length, true, 'push 里只带引用键，不带正文');

    // 客户端上线后走现成的 GET /client-state 取回
    const getRes = await worker.fetch(new Request('https://w.dev/client-state?namespace=bypass', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), { DB: d1 });
    const { decryptPayload } = await import('../src/server/lib/encryption.js');
    const data = await decryptPayload((await getRes.json()).data, userKey);
    assert.deepEqual(data.entries.map((e) => [e.key, e.value]), [['ref-1', long]]);
  });

  test('参数校验：namespace / entries / value / updatedAt 非法都当场抛错', async () => {
    const adapter = await freshAdapter();
    const errors = [];
    const result = await fireWith(adapter, {
      onFire: async (ctx) => {
        const US = String.fromCharCode(0x1f); // 库内部保留的分隔符
        const cases = [
          () => ctx.writeState('', [{ key: 'k', value: 'v' }]),
          () => ctx.writeState(`ns${US}x`, [{ key: 'k', value: 'v' }]),
          () => ctx.writeState('ns', 'not-an-array'),
          () => ctx.writeState('ns', [{ key: '', value: 'v' }]),
          () => ctx.writeState('ns', [{ key: `k${US}0`, value: 'v' }]),
          () => ctx.writeState('ns', [{ key: 'k', value: 42 }]),
          () => ctx.writeState('ns', [{ key: 'k', value: 'v', updatedAt: -1 }]),
        ];
        for (const run of cases) {
          await assert.rejects(run, TypeError);
          errors.push('ok');
        }
        // 超出单条上限 → RangeError，且没有半条数据落库
        await assert.rejects(
          () => ctx.writeState('ns', [{ key: 'k', value: 'x'.repeat(6 * 1024 * 1024) }]),
          (err) => err instanceof RangeError && /6291456 字节/.test(err.message)
        );
        assert.deepEqual(await ctx.readState('ns'), []);
      },
    });
    assert.equal(result.success, true);
    assert.equal(errors.length, 7);
  });

  test('适配器不支持 client_state 写入 → 明确报错，不静默成功', async () => {
    const { task } = await makeTask();
    let caught = null;
    const hooks = {
      onBeforeFire: async (ctx) => {
        try {
          await ctx.writeState('ns', [{ key: 'k', value: 'v' }]);
        } catch (error) {
          caught = error;
        }
        return [{ role: 'user', content: 'U' }];
      },
      onLLMOutput: async () => ({ decision: 'skip-push' }),
    };
    const llm = stubLlm([finishRound]);
    try {
      await processSingleMessage(task, makeCtx({ hooks, db: {} }));
    } finally {
      llm.restore();
    }
    assert.match(caught.message, /AGENTIC_STATE_WRITE_UNSUPPORTED/);
  });
});

describe('scheduleTask（fire 里给自己排后续任务）', () => {
  // 固定时钟：护栏是「至少比现在晚 60 秒」，现在得是个说得准的数
  const NOW = Date.parse('2020-06-01T12:00:00.000Z');
  const IN_30S = new Date(NOW + 30_000).toISOString();
  const IN_2MIN = new Date(NOW + 120_000).toISOString();
  const IN_90MIN = new Date(NOW + 90 * 60_000).toISOString();
  const PAST = new Date(NOW - 60 * 60_000).toISOString();

  async function freshAdapter() {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    return { d1, adapter };
  }

  async function countTasks(d1) {
    const row = await d1.prepare('SELECT COUNT(*) AS n FROM scheduled_messages').first();
    return row.n;
  }

  // 跑一次 fire，把 fireCtx / sessionCtx 交给回调折腾。
  async function fireWith(adapter, { onFire, onSession, maxScheduledTasksPerFire, taskOverrides } = {}) {
    const { task } = await makeTask(taskOverrides);
    const hooks = {
      onBeforeFire: async (fireCtx) => {
        if (onFire) await onFire(fireCtx);
        return [{ role: 'user', content: 'U' }];
      },
      onLLMOutput: async (sessionCtx) => {
        if (onSession) await onSession(sessionCtx);
        return { decision: 'skip-push' };
      },
    };
    const llm = stubLlm([finishRound]);
    try {
      return await processSingleMessage(task, makeCtx({
        hooks, db: adapter, now: () => NOW, maxScheduledTasksPerFire,
      }));
    } finally {
      llm.restore();
    }
  }

  async function readStoredPayload(adapter, uuid) {
    const row = await adapter.getTaskByUuidOnly(uuid);
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    return { row, payload: JSON.parse(await decryptFromStorage(row.encrypted_payload, userKey)) };
  }

  test('新任务继承凭据与投递配置；hook 拿到的 ctx 里一个凭据都没有', async () => {
    const { adapter } = await freshAdapter();
    let outcome = null;
    let seenFireCtx = null;
    let seenSessionCtx = null;

    const result = await fireWith(adapter, {
      onFire: async (ctx) => {
        seenFireCtx = ctx;
        outcome = await ctx.scheduleTask({ firstSendTime: IN_90MIN });
      },
      onSession: async (ctx) => { seenSessionCtx = ctx; },
    });
    assert.equal(result.success, true);
    assert.equal(outcome.created, true);
    assert.equal(typeof outcome.id, 'number');
    assert.equal(outcome.nextSendAt, IN_90MIN);

    // 落库的 payload 里凭据齐全，新任务到点能自己发出去
    const { row, payload } = await readStoredPayload(adapter, outcome.uuid);
    // 推送订阅是用户级的一份，任务不携带它——新任务到点读的就是当时最新的
    // 那份，用户中途换了设备也不用回头把这条任务翻出来刷。
    assert.equal('pushSubscription' in payload, false);
    assert.equal(payload.apiKey, 'sk-secret');
    assert.equal(payload.apiUrl, 'https://api.example.com/v1/chat/completions');
    assert.equal(payload.primaryModel, 'model-x');
    assert.equal(row.user_id, USER);
    assert.equal(row.next_send_at, IN_90MIN);

    // 而 hook 自己从头到尾看不到这些
    for (const k of ['apiKey', 'pushSubscription']) {
      assert.equal(k in seenFireCtx.task, false, `fireCtx.task 不该带 ${k}`);
      assert.equal(k in seenFireCtx, false, `fireCtx 不该带 ${k}`);
      assert.equal(k in seenSessionCtx, false, `sessionCtx 不该带 ${k}`);
    }
  });

  test('宿主传的 firstSendTime / metadata / messageType 生效；不传就继承当前任务', async () => {
    const { adapter } = await freshAdapter();
    let explicit = null;
    let inherited = null;

    const result = await fireWith(adapter, {
      onFire: async (ctx) => {
        explicit = await ctx.scheduleTask({
          firstSendTime: IN_90MIN,
          messageType: 'prompted',
          recurrenceType: 'daily',
          metadata: { charId: 'char-2', beat: 'followup' },
          contactName: 'Rei（续）',
          messageSubtype: 'forum',
        });
        inherited = await ctx.scheduleTask({ firstSendTime: IN_2MIN });
      },
    });
    assert.equal(result.success, true);

    const a = await readStoredPayload(adapter, explicit.uuid);
    assert.equal(a.row.message_type, 'prompted');
    assert.equal(a.row.next_send_at, IN_90MIN);
    assert.equal(a.payload.messageType, 'prompted');
    assert.equal(a.payload.recurrenceType, 'daily');
    assert.equal(a.payload.firstSendTime, IN_90MIN);
    assert.equal(a.payload.contactName, 'Rei（续）');
    assert.equal(a.payload.messageSubtype, 'forum');
    // metadata 是整体替换，不是深合并：原来的 charId: 'char-1' 不该渗过来
    assert.deepEqual(a.payload.metadata, { charId: 'char-2', beat: 'followup' });

    const b = await readStoredPayload(adapter, inherited.uuid);
    assert.equal(b.row.message_type, 'auto');            // 继承当前任务
    assert.equal(b.payload.contactName, 'Rei');
    assert.equal(b.payload.recurrenceType, 'none');      // 默认一次性
    assert.deepEqual(b.payload.metadata, { charId: 'char-1' });
  });

  // fire-time hook 每次现场重组 prompt。把排程时冻结的旧 prompt 带过去，
  // 新任务万一走回老链路就会静默发出一条谁也没打算发的文案。
  test('completePrompt / messages 不继承，两者都是 null', async () => {
    const { adapter } = await freshAdapter();
    let outcome = null;
    const result = await fireWith(adapter, {
      taskOverrides: { completePrompt: '排程时冻结的老 prompt' },
      onFire: async (ctx) => { outcome = await ctx.scheduleTask({ firstSendTime: IN_90MIN }); },
    });
    assert.equal(result.success, true);
    const { payload } = await readStoredPayload(adapter, outcome.uuid);
    assert.equal(payload.completePrompt, null);
    assert.equal(payload.messages, null);
  });

  test('firstSendTime：缺席 / 解析不了 / 过去 / 60 秒内，全被拒且一行都没建', async () => {
    const { d1, adapter } = await freshAdapter();
    const caught = [];
    const result = await fireWith(adapter, {
      onFire: async (ctx) => {
        for (const bad of [undefined, '', 'not-a-time', PAST, IN_30S]) {
          await assert.rejects(
            () => ctx.scheduleTask(bad === undefined ? {} : { firstSendTime: bad }),
            RangeError
          );
          caught.push(bad);
        }
        // 60 秒整这条边界是收的
        const ok = await ctx.scheduleTask({ firstSendTime: new Date(NOW + 60_000).toISOString() });
        assert.equal(ok.created, true);
      },
    });
    assert.equal(result.success, true);
    assert.equal(caught.length, 5);
    assert.equal(await countTasks(d1), 1); // 只有边界那条落了库
  });

  test("messageType: 'instant' 被拒（合法的三种照常）", async () => {
    const { d1, adapter } = await freshAdapter();
    let ok = null;
    const result = await fireWith(adapter, {
      onFire: async (ctx) => {
        await assert.rejects(
          () => ctx.scheduleTask({ firstSendTime: IN_90MIN, messageType: 'instant' }),
          (err) => err instanceof TypeError && /instant/.test(err.message)
        );
        await assert.rejects(
          () => ctx.scheduleTask({ firstSendTime: IN_90MIN, messageType: 'whatever' }),
          (err) => err instanceof TypeError && /auto \/ prompted \/ fixed/.test(err.message)
        );
        ok = await ctx.scheduleTask({ firstSendTime: IN_90MIN, messageType: 'prompted' });
      },
    });
    assert.equal(result.success, true);
    assert.equal(ok.created, true);
    assert.equal(await countTasks(d1), 1);
  });

  test("messageType 'fixed' 没有 userMessage → 拒（继承到正文就放行）", async () => {
    const { d1, adapter } = await freshAdapter();
    let created = null;
    const result = await fireWith(adapter, {
      onFire: async (ctx) => {
        await assert.rejects(
          () => ctx.scheduleTask({ firstSendTime: IN_90MIN, messageType: 'fixed' }),
          (err) => err instanceof TypeError && /userMessage/.test(err.message)
        );
        created = await ctx.scheduleTask({
          firstSendTime: IN_90MIN, messageType: 'fixed', userMessage: '晚安。',
        });
      },
    });
    assert.equal(result.success, true);
    assert.equal(created.created, true);
    assert.equal(await countTasks(d1), 1);
    const { payload } = await readStoredPayload(adapter, created.uuid);
    assert.equal(payload.userMessage, '晚安。');
  });

  // 模型自排后续本质上是条能无限延伸的链，没有上限就没人按停止键。
  test('单次 fire 的建任务上限：默认 2 条，第 3 条被拒；factory 配置能调', async () => {
    const { d1, adapter } = await freshAdapter();
    let result = await fireWith(adapter, {
      onFire: async (ctx) => {
        assert.equal((await ctx.scheduleTask({ firstSendTime: IN_2MIN })).created, true);
        assert.equal((await ctx.scheduleTask({ firstSendTime: IN_90MIN })).created, true);
        await assert.rejects(
          () => ctx.scheduleTask({ firstSendTime: IN_90MIN }),
          (err) => err instanceof RangeError && /最多建 2 条/.test(err.message)
        );
      },
    });
    assert.equal(result.success, true);
    assert.equal(await countTasks(d1), 2);

    const second = await freshAdapter();
    result = await fireWith(second.adapter, {
      maxScheduledTasksPerFire: 1,
      onFire: async (ctx) => {
        assert.equal((await ctx.scheduleTask({ firstSendTime: IN_2MIN })).created, true);
        await assert.rejects(
          () => ctx.scheduleTask({ firstSendTime: IN_90MIN }),
          (err) => err instanceof RangeError && /最多建 1 条/.test(err.message)
        );
      },
    });
    assert.equal(result.success, true);
    assert.equal(await countTasks(second.d1), 1);
  });

  // fire 失败会整条重跑；宿主传确定性 uuid 就天然幂等，不该每重试一次多排一条。
  test('uuid 撞车返回 { created: false, reason: "duplicate" }，不抛错也不重复建行', async () => {
    const { d1, adapter } = await freshAdapter();
    const uuid = 'fire-7-2020-01-01T00:00:00.000Z';

    let first = null;
    await fireWith(adapter, {
      onFire: async (ctx) => { first = await ctx.scheduleTask({ firstSendTime: IN_90MIN, uuid }); },
    });
    assert.equal(first.created, true);
    assert.equal(first.uuid, uuid);

    // 同一次任务重跑：同样的 uuid 再来一次
    let retry = null;
    const result = await fireWith(adapter, {
      onFire: async (ctx) => { retry = await ctx.scheduleTask({ firstSendTime: IN_90MIN, uuid }); },
    });
    assert.equal(result.success, true);
    assert.equal(retry.created, false);
    assert.equal(retry.reason, 'duplicate');
    assert.equal(retry.uuid, uuid);
    assert.equal(await countTasks(d1), 1);

    // 撞车时把已经存在的那一行投影回来：重跑那轮宿主才记得下这条任务，
    // 否则它只活在数据库里——面板列不出、用户取消不了、还会照常到点触发。
    assert.equal(retry.task.uuid, uuid);
    assert.equal(retry.task.id, first.id);
    assert.equal(retry.task.nextSendAt, first.nextSendAt);
    assert.equal(retry.task.status, 'pending');
    assert.equal(retry.task.contactName, 'Rei');
    assert.equal(retry.task.recurrenceType, 'none');
    // 脱敏形状：凭据一个都不能出现在这份投影里。
    const serialized = JSON.stringify(retry.task);
    assert.ok(!serialized.includes('sk-secret'));
    assert.ok(!serialized.includes('push.example.com'));
    for (const k of ['apiKey', 'apiUrl', 'pushSubscription', 'completePrompt', 'messages']) {
      assert.equal(k in retry.task, false, `duplicate 投影不该带 ${k}`);
    }
  });

  // 要不要接着说，往往是看完这轮 LLM 输出才定的——那时 onBeforeFire 早已返回。
  test('sessionCtx 上也拿得到 scheduleTask', async () => {
    const { d1, adapter } = await freshAdapter();
    let outcome = null;
    const result = await fireWith(adapter, {
      onSession: async (ctx) => {
        assert.equal(typeof ctx.scheduleTask, 'function');
        outcome = await ctx.scheduleTask({ firstSendTime: IN_90MIN, metadata: { beat: 'followup' } });
      },
    });
    assert.equal(result.success, true);
    assert.equal(outcome.created, true);
    assert.equal(await countTasks(d1), 1);
    const { payload } = await readStoredPayload(adapter, outcome.uuid);
    assert.deepEqual(payload.metadata, { beat: 'followup' });
  });

  test('适配器不支持建任务 → 明确报错，不静默成功', async () => {
    const { task } = await makeTask();
    let caught = null;
    const hooks = {
      onBeforeFire: async (ctx) => {
        try {
          await ctx.scheduleTask({ firstSendTime: IN_90MIN });
        } catch (error) {
          caught = error;
        }
        return [{ role: 'user', content: 'U' }];
      },
      onLLMOutput: async () => ({ decision: 'skip-push' }),
    };
    const llm = stubLlm([finishRound]);
    try {
      await processSingleMessage(task, makeCtx({ hooks, db: {}, now: () => NOW }));
    } finally {
      llm.restore();
    }
    assert.match(caught.message, /AGENTIC_SCHEDULE_UNSUPPORTED/);
  });

  // HTTP 那两个入口都过这道闸门，hook 建任务也得过：不然大 payload 会一路走到
  // 落库那步，撞上存储的单行上限抛一句看不出所以然的错。
  test('任务内容超出上限 → 当场打回，一行都不落库', async () => {
    const { d1, adapter } = await freshAdapter();
    let caught = null;
    await fireWith(adapter, {
      onFire: async (ctx) => {
        try {
          await ctx.scheduleTask({
            firstSendTime: IN_90MIN,
            metadata: { blob: 'x'.repeat(2 * 1024 * 1024) },
          });
        } catch (error) {
          caught = error;
        }
      },
    });
    assert.ok(caught, '超限的任务不该悄悄建成功');
    assert.match(caught.message, /TASK_PAYLOAD_TOO_LARGE/);
    assert.equal(caught.code, 'TASK_PAYLOAD_TOO_LARGE');
    assert.equal(caught.permanent, true, '内容太大重试也好不了');
    assert.equal(await countTasks(d1), 0);
  });

  // 大小闸门跟其余参数护栏（contactName / uuid / tzId / …）待遇一致：正文超限
  // 也是「这次调用的参数不合法」，不该烧掉一次建任务额度。烧掉的话，hook 捕获
  // 之后换份小 metadata 重排时，会莫名其妙撞上「单次 fire 最多建 N 条」。
  test('正文超限不占建任务额度：换份小的还能照排', async () => {
    const { d1, adapter } = await freshAdapter();
    const seen = [];

    const result = await fireWith(adapter, {
      maxScheduledTasksPerFire: 2,
      onFire: async (ctx) => {
        try {
          await ctx.scheduleTask({
            firstSendTime: IN_90MIN,
            metadata: { blob: 'x'.repeat(2 * 1024 * 1024) },
          });
        } catch (error) {
          seen.push(error.code);
        }
        // 额度还剩满满两条。
        seen.push((await ctx.scheduleTask({ firstSendTime: IN_2MIN })).created);
        seen.push((await ctx.scheduleTask({ firstSendTime: IN_90MIN })).created);
      },
    });

    assert.equal(result.success, true, `重排两条合法任务不该失败：${result.error}`);
    assert.deepEqual(seen, ['TASK_PAYLOAD_TOO_LARGE', true, true]);
    assert.equal(await countTasks(d1), 2);
  });
});

describe('fire 级 scratch', () => {
  test('同一次 fire 的 onBeforeFire / onLLMOutput / executeToolCalls 拿到同一引用；跨 fire 隔离', async () => {
    const { task } = await makeTask();
    const seen = [];
    let llmOutputCalls = 0;
    const decisions = [
      { decision: 'tool-request', toolCalls: [TOOL_CALL] },
      { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'ok' }] },
    ];
    const hooks = {
      onBeforeFire: async (fireCtx) => {
        fireCtx.scratch.token = (fireCtx.scratch.token || 0) + 1;
        seen.push(fireCtx.scratch);
        return [{ role: 'user', content: 'U' }];
      },
      onLLMOutput: async (sessionCtx) => { seen.push(sessionCtx.scratch); return decisions[llmOutputCalls++]; },
      executeToolCalls: async (_toolCalls, sessionCtx) => {
        seen.push(sessionCtx.scratch);
        return [{ tool_call_id: 'call_1', role: 'tool', content: 'ok' }];
      },
    };
    const llm = stubLlm([toolRound, finishRound]);
    try {
      await processSingleMessage(task, makeCtx({ hooks }));
      // before / llm轮1 / tools / llm轮2 —— 4 次全部同一引用，token 只加了一次
      assert.equal(seen.length, 4);
      for (const s of seen) assert.equal(s, seen[0]);
      assert.equal(seen[0].token, 1);

      // 第二次 fire（重试语义）：新对象，token 重新从 1 开始
      llmOutputCalls = 0;
      seen.length = 0;
      await processSingleMessage(task, makeCtx({ hooks }));
      assert.equal(seen[0].token, 1);
    } finally {
      llm.restore();
    }
  });

  test('fire 抛错后 scratch 不带到下一次 fire', async () => {
    const { task } = await makeTask();
    const scratches = [];
    const hooks = {
      onBeforeFire: async (fireCtx) => {
        scratches.push(fireCtx.scratch);
        fireCtx.scratch.poisoned = true;
        return [{ role: 'user', content: 'U' }];
      },
      onLLMOutput: async () => { throw new Error('boom'); },
    };
    const llm = stubLlm([finishRound]);
    try {
      const r1 = await processSingleMessage(task, makeCtx({ hooks }));
      const r2 = await processSingleMessage(task, makeCtx({ hooks }));
      assert.equal(r1.success, false);
      assert.equal(r2.success, false);
      assert.equal(scratches.length, 2);
      assert.notEqual(scratches[0], scratches[1]);
      assert.equal(scratches[1].poisoned, true); // 本次 hook 自己写的，不是上次残留
    } finally {
      llm.restore();
    }
  });
});

describe('推送 id 掺名义触发时刻（occurrence）', () => {
  const finishTwo = {
    decision: 'finish',
    pushPayloads: [{ messageKind: 'content', message: 'A' }, { messageKind: 'content', message: 'B' }],
  };
  const hooksFinishTwo = {
    onBeforeFire: async () => [{ role: 'user', content: 'U' }],
    onLLMOutput: async () => finishTwo,
  };

  test('同一条循环任务的两个 occurrence，默认 messageId/sessionId 各不相同', async () => {
    async function fireAt(nextSendAt) {
      const { task } = await makeTask();
      task.next_send_at = nextSendAt;
      const pushes = [];
      const llm = stubLlm([finishRound]);
      try {
        await processSingleMessage(task, makeCtx({ hooks: hooksFinishTwo, pushSpy: (_s, p) => pushes.push(JSON.parse(p)) }));
      } finally {
        llm.restore();
      }
      return pushes;
    }

    const day1 = await fireAt('2020-01-01T00:00:00.000Z');
    const day2 = await fireAt('2020-01-02T00:00:00.000Z');

    // 每个 occurrence 一套 id：离线设备一次性收到两天的积压推送时不会互相去重。
    assert.notEqual(day1[0].messageId, day2[0].messageId);
    assert.notEqual(day1[0].sessionId, day2[0].sessionId);
    // 同一 occurrence 重发（重试）拿到同一套 id：已送达的段照旧被去重。
    const day1Again = await fireAt('2020-01-01T00:00:00.000Z');
    assert.deepEqual(day1.map((p) => p.messageId), day1Again.map((p) => p.messageId));
    assert.equal(day1[0].sessionId, day1Again[0].sessionId);
  });

  test('调用方显式传的 messageId / sessionId 不被默认值覆盖', async () => {
    const { task } = await makeTask();
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => ({
        decision: 'finish',
        pushPayloads: [{ messageKind: 'content', message: 'A', messageId: 'my-id', sessionId: 'my-sess' }],
      }),
    };
    const pushes = [];
    const llm = stubLlm([finishRound]);
    try {
      await processSingleMessage(task, makeCtx({ hooks, pushSpy: (_s, p) => pushes.push(JSON.parse(p)) }));
    } finally {
      llm.restore();
    }
    assert.equal(pushes[0].messageId, 'my-id');
    assert.equal(pushes[0].sessionId, 'my-sess');
  });
});

describe('onAfterSend（推送发出之后的 hook）', () => {
  const hooksFinishTwo = {
    onBeforeFire: async () => [{ role: 'user', content: 'U' }],
    onLLMOutput: async () => ({
      decision: 'finish',
      pushPayloads: [{ messageKind: 'content', message: 'A' }, { messageKind: 'content', message: 'B' }],
    }),
  };

  test('全部发成功：调用一次，{ task, sentCount, total, error: null }', async () => {
    const { task } = await makeTask();
    const calls = [];
    const llm = stubLlm([finishRound]);
    try {
      const result = await processSingleMessage(task, {
        ...makeCtx({ hooks: hooksFinishTwo }),
        onAfterSend: async (info) => { calls.push(info); },
      });
      assert.equal(result.success, true);
      assert.equal(result.messagesSent, 2);
    } finally {
      llm.restore();
    }
    // 载荷带任务身份：宿主按任务写回自述日志时靠 task 对号入座。
    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, task);
    assert.equal(calls[0].sentCount, 2);
    assert.equal(calls[0].total, 2);
    assert.equal(calls[0].error, null);
    // client_state 的读写口跟着回执一起来：宿主不用再去别处翻一个能用的写口。
    assert.equal(typeof calls[0].readState, 'function');
    assert.equal(typeof calls[0].writeState, 'function');
  });

  test('tick 内多任务并发：每次回执的 task 各是各的，能区分开', async () => {
    const calls = [];
    const onAfterSend = async (info) => { calls.push(info); };
    const { task: taskA } = await makeTask();
    const { task: taskB } = await makeTask();
    taskB.id = 8;
    taskB.uuid = 'u8';
    const llm = stubLlm([finishRound]);
    try {
      await Promise.all([
        processSingleMessage(taskA, { ...makeCtx({ hooks: hooksFinishTwo }), onAfterSend }),
        processSingleMessage(taskB, { ...makeCtx({ hooks: hooksFinishTwo }), onAfterSend }),
      ]);
    } finally {
      llm.restore();
    }
    assert.equal(calls.length, 2);
    // 两条回执的 task 一一对应到各自的任务行（顺序不保证，按 id 集合断言）。
    assert.deepEqual(calls.map((c) => c.task.id).sort(), [7, 8]);
    for (const c of calls) {
      assert.ok(c.task === taskA || c.task === taskB, '载荷里的 task 必须是传入的任务行本身');
    }
  });

  test('第 2 段发挂：hook 在错误往上抛之前收到 { task, sentCount: 1, total: 2, error }', async () => {
    const { task } = await makeTask();
    const calls = [];
    let sends = 0;
    const ctx = {
      ...makeCtx({ hooks: hooksFinishTwo }),
      webpush: {
        async sendNotification() {
          sends++;
          if (sends === 2) throw new Error('push endpoint gone');
        },
      },
      onAfterSend: async (info) => { calls.push(info); },
    };
    const llm = stubLlm([finishRound]);
    let result;
    try {
      result = await processSingleMessage(task, ctx);
    } finally {
      llm.restore();
    }
    // fire 整体按失败处理（走 run-tick 的重试语义）……
    assert.equal(result.success, false);
    assert.match(result.error, /push endpoint gone/);
    // ……但宿主已经先拿到了「发出去 1 段」的事实。
    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, task);
    assert.equal(calls[0].sentCount, 1);
    assert.equal(calls[0].total, 2);
    assert.ok(calls[0].error instanceof Error);
    assert.match(calls[0].error.message, /push endpoint gone/);
  });

  test('hook 自己抛错只 console.warn，不影响投递结果', async () => {
    const { task } = await makeTask();
    const origWarn = console.warn;
    let warned = 0;
    console.warn = () => { warned++; };
    const llm = stubLlm([finishRound]);
    let result;
    try {
      result = await processSingleMessage(task, {
        ...makeCtx({ hooks: hooksFinishTwo }),
        onAfterSend: async () => { throw new Error('hook boom'); },
      });
    } finally {
      llm.restore();
      console.warn = origWarn;
    }
    assert.equal(result.success, true);
    assert.equal(result.messagesSent, 2);
    assert.ok(warned >= 1);
  });
});

// onAfterSend 只在「有 push 要发」这条路上走。hook 判断这次不用说话、或者
// 链路中途抛错时，宿主此前收不到任何收尾信号——「开始时占点什么、结束时放
// 掉」的写法必然漏（fire 里已经真建出来的任务没人记账、拿到的锁没处释放）。
// 下面每条都是那种漏法的钉子：onBeforeFire 被调用过，就必须有一次回执。
describe('onFireSettled（一次 fire 收尾，什么结局都调）', () => {
  const finishTwo = {
    onBeforeFire: async () => [{ role: 'user', content: 'U' }],
    onLLMOutput: async () => ({
      decision: 'finish',
      pushPayloads: [{ messageKind: 'content', message: 'A' }, { messageKind: 'content', message: 'B' }],
    }),
  };

  async function runWithSettled(hooks, extraCtx = {}) {
    const { task } = await makeTask();
    const calls = [];
    const llm = stubLlm([finishRound]);
    let result;
    try {
      result = await processSingleMessage(task, {
        ...makeCtx({ hooks }),
        ...extraCtx,
        onFireSettled: async (info) => { calls.push(info); },
      });
    } finally {
      llm.restore();
    }
    return { task, calls, result };
  }

  test('正常发完：status sent，带 sentCount / total / iterations', async () => {
    const { task, calls, result } = await runWithSettled(finishTwo);
    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, task);
    assert.equal(calls[0].status, 'sent');
    assert.equal(calls[0].skipReason, null);
    assert.equal(calls[0].sentCount, 2);
    assert.equal(calls[0].total, 2);
    assert.equal(calls[0].iterations, 1);
    assert.equal(calls[0].error, null);
    // 状态读写口跟着回执一起来（与 onAfterSend 同一套）。
    assert.equal(typeof calls[0].readState, 'function');
    assert.equal(typeof calls[0].writeState, 'function');
  });

  test('onBeforeFire 直接 skip：status skipped / skipReason before-fire', async () => {
    const { calls, result } = await runWithSettled({
      onBeforeFire: async () => ({ skip: true }),
      onLLMOutput: async () => { throw new Error('不该走到这里'); },
    });
    assert.equal(result.success, true);
    assert.equal(result.messagesSent, 0);
    assert.equal(calls.length, 1, 'skip 也要有收尾回执');
    assert.equal(calls[0].status, 'skipped');
    assert.equal(calls[0].skipReason, 'before-fire');
    assert.equal(calls[0].sentCount, 0);
    assert.equal(calls[0].total, 0);
    assert.equal(calls[0].iterations, 0);
    assert.equal(calls[0].error, null);
  });

  test('模型跑完判定不发（skip-push）：status skipped / skipReason skip-push', async () => {
    const { calls, result } = await runWithSettled({
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => ({ decision: 'skip-push' }),
    });
    assert.equal(result.success, true);
    assert.equal(calls.length, 1, '没有可发的 push 也要有收尾回执');
    assert.equal(calls[0].status, 'skipped');
    assert.equal(calls[0].skipReason, 'skip-push');
    assert.equal(calls[0].iterations, 1);
  });

  test('链路抛错：status failed，带原始错误', async () => {
    const { calls, result } = await runWithSettled({
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => { throw new Error('classifier exploded'); },
    });
    assert.equal(result.success, false);
    assert.equal(calls.length, 1, '抛错也要有收尾回执');
    assert.equal(calls[0].status, 'failed');
    assert.ok(calls[0].error instanceof Error);
    assert.match(calls[0].error.message, /classifier exploded/);
  });

  test('发到一半挂掉：status failed，sentCount / total 说清发出去了几段', async () => {
    let sends = 0;
    const { calls, result } = await runWithSettled(finishTwo, {
      webpush: {
        async sendNotification() {
          sends++;
          if (sends === 2) throw new Error('push endpoint gone');
        },
      },
    });
    assert.equal(result.success, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].status, 'failed');
    assert.equal(calls[0].sentCount, 1);
    assert.equal(calls[0].total, 2);
    assert.match(calls[0].error.message, /push endpoint gone/);
  });

  test('onBeforeFire 交还老链路（返回 null）：status not-handled', async () => {
    const { calls } = await runWithSettled({
      onBeforeFire: async () => null,
      onLLMOutput: async () => { throw new Error('不该走到这里'); },
    });
    assert.equal(calls.length, 1, 'onBeforeFire 被调用过就得有回执');
    assert.equal(calls[0].status, 'not-handled');
    assert.equal(calls[0].sentCount, 0);
  });

  test('正常发完时 onAfterSend 与 onFireSettled 都调，且共享同一个 scratch', async () => {
    const { task } = await makeTask();
    const order = [];
    let afterSend = null;
    let settled = null;
    const llm = stubLlm([finishRound]);
    try {
      await processSingleMessage(task, {
        ...makeCtx({
          hooks: {
            onBeforeFire: async (fireCtx) => { fireCtx.scratch.note = 'hi'; return [{ role: 'user', content: 'U' }]; },
            onLLMOutput: finishTwo.onLLMOutput,
          },
        }),
        onAfterSend: async (info) => { order.push('after-send'); afterSend = info; },
        onFireSettled: async (info) => { order.push('settled'); settled = info; },
      });
    } finally {
      llm.restore();
    }
    assert.deepEqual(order, ['after-send', 'settled'], 'onAfterSend 先、收尾回执后');
    assert.equal(settled.scratch, afterSend.scratch);
    assert.equal(settled.scratch.note, 'hi');
  });

  test('hook 自己抛错只 console.warn，不影响投递结果', async () => {
    const { task } = await makeTask();
    const origWarn = console.warn;
    let warned = 0;
    console.warn = () => { warned++; };
    const llm = stubLlm([finishRound]);
    let result;
    try {
      result = await processSingleMessage(task, {
        ...makeCtx({ hooks: finishTwo }),
        onFireSettled: async () => { throw new Error('hook boom'); },
      });
    } finally {
      llm.restore();
      console.warn = origWarn;
    }
    assert.equal(result.success, true);
    assert.equal(result.messagesSent, 2);
    assert.ok(warned >= 1);
  });
});

describe('任务身份：hook ctx 与 push 都直接带着', () => {
  const OCCURRENCE = '2020-01-01T00:00:00.000Z';
  const OCCURRENCE_MS = Date.parse(OCCURRENCE);

  // 以前只能从 sessionId（`sess_task_<id>@<occurrenceMs>`）里切字符串，切不出
  // 来是静默的：送达归属失效之后客户端会误判「这次没送达过」。
  test('onLLMOutput / executeToolCalls 的 ctx 上直接有 taskId / taskUuid / occurrenceMs', async () => {
    const { task } = await makeTask();
    const seen = [];
    let round = 0;
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async (ctx) => {
        seen.push({ from: 'onLLMOutput', taskId: ctx.taskId, taskUuid: ctx.taskUuid, occurrenceMs: ctx.occurrenceMs });
        return round++ === 0
          ? { decision: 'tool-request', toolCalls: [TOOL_CALL] }
          : { decision: 'skip-push' };
      },
      executeToolCalls: async (_calls, ctx) => {
        seen.push({ from: 'executeToolCalls', taskId: ctx.taskId, taskUuid: ctx.taskUuid, occurrenceMs: ctx.occurrenceMs });
        return [{ tool_call_id: 'call_1', role: 'tool', content: '{}' }];
      },
    };
    const llm = stubLlm([toolRound, finishRound]);
    try {
      await processSingleMessage(task, makeCtx({ hooks }));
    } finally {
      llm.restore();
    }
    assert.equal(seen.length, 3);
    for (const entry of seen) {
      assert.equal(entry.taskId, 7, `${entry.from} 应拿到 taskId`);
      assert.equal(entry.taskUuid, 'u7', `${entry.from} 应拿到 taskUuid`);
      assert.equal(entry.occurrenceMs, OCCURRENCE_MS, `${entry.from} 应拿到 occurrenceMs`);
    }
  });

  // 客户端要知道「这条推送属于哪条任务、它还会不会再来」。角色在 fire 里给
  // 自己排的任务客户端从没见过，靠宿主往 metadata 里抄字段总有抄漏的一天。
  test('hook 路径的每条 push 都带 taskId / taskUuid / recurrenceType / occurrenceMs', async () => {
    const { task } = await makeTask({ recurrenceType: 'daily' });
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => ({
        decision: 'finish',
        pushPayloads: [
          { messageKind: 'content', message: 'A' },
          { messageKind: 'content', message: 'B' },
        ],
      }),
    };
    const pushes = [];
    const llm = stubLlm([finishRound]);
    try {
      await processSingleMessage(task, makeCtx({ hooks, pushSpy: (_s, p) => pushes.push(JSON.parse(p)) }));
    } finally {
      llm.restore();
    }
    assert.equal(pushes.length, 2);
    for (const push of pushes) {
      assert.equal(push.taskId, 7);
      assert.equal(push.taskUuid, 'u7');
      assert.equal(push.recurrenceType, 'daily');
      assert.equal(push.occurrenceMs, OCCURRENCE_MS);
    }
  });

  test('调度身份以库为准：hook 自己写的值会被覆盖', async () => {
    const { task } = await makeTask({ recurrenceType: 'weekly' });
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => ({
        decision: 'finish',
        pushPayloads: [{ messageKind: 'content', message: 'A', taskUuid: '瞎写的', recurrenceType: 'none' }],
      }),
    };
    const pushes = [];
    const llm = stubLlm([finishRound]);
    try {
      await processSingleMessage(task, makeCtx({ hooks, pushSpy: (_s, p) => pushes.push(JSON.parse(p)) }));
    } finally {
      llm.restore();
    }
    assert.equal(pushes[0].taskUuid, 'u7');
    assert.equal(pushes[0].recurrenceType, 'weekly');
  });

  test('一次性任务的 recurrenceType 是 none（payload 里没写也一样）', async () => {
    const { task } = await makeTask({ recurrenceType: undefined });
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => ({ decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'A' }] }),
    };
    const pushes = [];
    const llm = stubLlm([finishRound]);
    try {
      await processSingleMessage(task, makeCtx({ hooks, pushSpy: (_s, p) => pushes.push(JSON.parse(p)) }));
    } finally {
      llm.restore();
    }
    assert.equal(pushes[0].recurrenceType, 'none');
  });
});

describe('scratch 贯穿到 onAfterSend', () => {
  // 宿主要把「这次 fire 生成了哪几段正文」从 onLLMOutput 传到 onAfterSend，
  // 以前只能自建模块级 Map 按任务行 id 分格，还得配 TTL 清扫和并发隔离——
  // 那张登记表上长了一堆「早退就把状态丢了」的洞。
  test('onBeforeFire / onLLMOutput / onAfterSend 拿到同一个 scratch 引用', async () => {
    const { task } = await makeTask();
    const seen = [];
    const hooks = {
      onBeforeFire: async (ctx) => {
        ctx.scratch.segments = [];
        seen.push(ctx.scratch);
        return [{ role: 'user', content: 'U' }];
      },
      onLLMOutput: async (ctx) => {
        ctx.scratch.segments.push('A', 'B');
        seen.push(ctx.scratch);
        return {
          decision: 'finish',
          pushPayloads: [
            { messageKind: 'content', message: 'A' },
            { messageKind: 'content', message: 'B' },
          ],
        };
      },
    };
    let afterSend = null;
    const llm = stubLlm([finishRound]);
    try {
      await processSingleMessage(task, {
        ...makeCtx({ hooks }),
        onAfterSend: async (info) => { afterSend = info; },
      });
    } finally {
      llm.restore();
    }
    assert.ok(afterSend, 'onAfterSend 必须被调到');
    assert.deepEqual(afterSend.scratch.segments, ['A', 'B']);
    assert.equal(afterSend.scratch, seen[0], 'onAfterSend 的 scratch 必须是 onBeforeFire 那一个');
    assert.equal(afterSend.scratch, seen[1]);
  });

  test('推送中途挂掉时，onAfterSend 照样拿得到 scratch', async () => {
    const { task } = await makeTask();
    const hooks = {
      onBeforeFire: async (ctx) => { ctx.scratch.segments = ['A', 'B']; return [{ role: 'user', content: 'U' }]; },
      onLLMOutput: async () => ({
        decision: 'finish',
        pushPayloads: [
          { messageKind: 'content', message: 'A' },
          { messageKind: 'content', message: 'B' },
        ],
      }),
    };
    let sends = 0;
    let afterSend = null;
    const llm = stubLlm([finishRound]);
    try {
      const result = await processSingleMessage(task, {
        ...makeCtx({ hooks }),
        webpush: { async sendNotification() { if (++sends === 2) throw new Error('push endpoint gone'); } },
        onAfterSend: async (info) => { afterSend = info; },
      });
      assert.equal(result.success, false);
    } finally {
      llm.restore();
    }
    assert.equal(afterSend.sentCount, 1);
    assert.deepEqual(afterSend.scratch.segments, ['A', 'B']);
  });

  // 每次 fire 一份新的：重试产生的新 fire 不该看见上一轮留下的东西。
  test('两次 fire 各自一份 scratch', async () => {
    const { task } = await makeTask();
    const scratches = [];
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => ({ decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'A' }] }),
    };
    const llm = stubLlm([finishRound]);
    try {
      const ctx = { ...makeCtx({ hooks }), onAfterSend: async (info) => { scratches.push(info.scratch); } };
      await processSingleMessage(task, ctx);
      await processSingleMessage(task, ctx);
    } finally {
      llm.restore();
    }
    assert.equal(scratches.length, 2);
    assert.notEqual(scratches[0], scratches[1]);
  });
});
