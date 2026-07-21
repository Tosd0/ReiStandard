import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { processSingleMessage } from '../src/server/lib/message-processor.js';
import { callLlm } from '../src/server/lib/llm.js';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

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

function makeCtx({ hooks, maxToolIterations, totalTimeoutMs, db, pushSpy, now } = {}) {
  return {
    masterKey: MASTER_KEY,
    webpush: { async sendNotification(sub, payload) { if (pushSpy) pushSpy(sub, payload); } },
    vapid: { email: 'v@example.com', publicKey: 'pub', privateKey: 'priv' },
    db: db || {},
    hooks: hooks || null,
    maxToolIterations,
    totalTimeoutMs,
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

      // pushes: index/total overwritten, session pinned to the task, ids stamped
      assert.equal(pushes.length, 2);
      assert.deepEqual(pushes.map((p) => [p.messageIndex, p.totalMessages]), [[1, 2], [2, 2]]);
      for (const p of pushes) {
        assert.equal(p.sessionId, 'sess_task_7');
        assert.ok(typeof p.messageId === 'string' && p.messageId.length > 0);
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
});

describe('agentic fire via the single-user worker (scheduled e2e)', () => {
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
      next_send_at: '2020-01-01T00:00:00.000Z', message_type: payload.messageType,
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
    await seedDueTask(adapter);

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
    assert.equal(row.next_send_at, '2020-01-02T00:00:00.000Z');
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
