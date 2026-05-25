/**
 * 0.8.0 — pushPayloads-only hook decision API contract matrix.
 *
 * Pins the 13 fixtures from spec §测试要求.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInstantHandler,
  processInstantMessage,
} from '../src/index.js';
import {
  generateTestVapid,
  generateTestSubscription,
  createFetchRouter,
  decryptCapturedPushBody,
  makeLlmResponse,
} from './helpers.mjs';

const LLM_URL = 'https://api.example.com/v1/chat/completions';
let vapid, subKit;
before(async () => { vapid = await generateTestVapid(); subKit = await generateTestSubscription(); });

function basePayload(overrides = {}) {
  return {
    contactName: 'Rei',
    messages: [{ role: 'user', content: 'kick the loop' }],
    apiUrl: LLM_URL,
    apiKey: 'sk-test',
    primaryModel: 'model-x',
    pushSubscription: subKit.subscription,
    sessionId: 'sess-fixture',
    ...overrides,
  };
}

function makeRequest(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function runDirect(hookReturn, ctxOverrides = {}) {
  const router = createFetchRouter({
    pushEndpoint: subKit.subscription.endpoint,
    llm: () => makeLlmResponse('llm-output', ctxOverrides.reasoning ? { reasoning_content: ctxOverrides.reasoning } : undefined),
  });
  const sleeps = [];
  const events = [];
  const result = await processInstantMessage(basePayload(ctxOverrides.payload), {
    vapid,
    fetch: router.fetch,
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    onEvent: (e) => events.push(e),
    onLLMOutput: () => hookReturn,
    autoEmitReasoning: ctxOverrides.autoEmitReasoning,
    reasoningChunkBytes: ctxOverrides.reasoningChunkBytes,
    blobStore: ctxOverrides.blobStore,
    requestUrl: 'http://localhost/instant',
  });
  const decoded = [];
  for (const c of router.pushCalls) {
    decoded.push(JSON.parse(await decryptCapturedPushBody(c.body, subKit)));
  }
  return { result, pushes: decoded, sleeps, events, router };
}

async function runHandler(hookReturn, ctxOverrides = {}) {
  const router = createFetchRouter({
    pushEndpoint: subKit.subscription.endpoint,
    llm: () => makeLlmResponse('llm-output'),
  });
  const handler = createInstantHandler({
    vapid,
    fetch: router.fetch,
    autoEmitReasoning: false,
    onLLMOutput: () => hookReturn,
  });
  const res = await handler(makeRequest('http://localhost/instant', basePayload(ctxOverrides.payload)));
  return { res, body: await res.json(), router };
}

// 1) Single-push happy path
describe('1) pushPayloads.length === 1', () => {
  it('single push goes through, messageIndex=1, totalMessages=1, metadata preserved', async () => {
    const { result, pushes, sleeps } = await runDirect({
      decision: 'finish',
      pushPayloads: [{
        messageKind: 'content',
        message: 'hi',
        metadata: { trace: 'x' },
        notification: { title: 'Rei', body: 'hi' },
      }],
    }, { autoEmitReasoning: false });
    assert.equal(result.status, 'finished');
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].message, 'hi');
    assert.equal(pushes[0].messageIndex, 1);
    assert.equal(pushes[0].totalMessages, 1);
    assert.deepEqual(pushes[0].metadata, { trace: 'x' });
    assert.deepEqual(pushes[0].notification, { title: 'Rei', body: 'hi' });
    assert.deepEqual(sleeps, []);
  });
});

// 2) Three-push multi-burst with 1500ms spacing
describe('2) pushPayloads.length === 3', () => {
  it('ships 3 pushes with correct indices + 1500ms spacing', async () => {
    const { pushes, sleeps } = await runDirect({
      decision: 'finish',
      pushPayloads: [
        { messageKind: 'content', message: 'a' },
        { messageKind: 'content', message: 'b' },
        { messageKind: 'content', message: 'c' },
      ],
    }, { autoEmitReasoning: false });
    assert.equal(pushes.length, 3);
    assert.deepEqual(pushes.map(p => p.message), ['a', 'b', 'c']);
    assert.deepEqual(pushes.map(p => p.messageIndex), [1, 2, 3]);
    assert.deepEqual(pushes.map(p => p.totalMessages), [3, 3, 3]);
    assert.deepEqual(sleeps, [1500, 1500]);
  });
});

// 3) Mid-array throw
describe('3) mid-array throw aborts remaining + no final_pushed', () => {
  it('push 2 fails → push 3 never sent, push_failed propagates', async () => {
    let pushIdx = 0;
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('whatever'),
      pushHandler: () => {
        pushIdx++;
        if (pushIdx === 2) return { ok: false, status: 502, statusText: 'BG', async text() { return ''; } };
        return { ok: true, status: 201, async text() { return ''; } };
      },
    });
    const events = [];
    let caught;
    try {
      await processInstantMessage(basePayload(), {
        vapid,
        fetch: router.fetch,
        sleep: () => Promise.resolve(),
        onEvent: (e) => events.push(e),
        onLLMOutput: () => ({
          decision: 'finish',
          pushPayloads: [
            { messageKind: 'content', message: 'one' },
            { messageKind: 'content', message: 'two' },
            { messageKind: 'content', message: 'three' },
          ],
        }),
        autoEmitReasoning: false,
        requestUrl: 'http://localhost/instant',
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(caught.code, 'PUSH_SEND_FAILED');
    assert.equal(caught.messageIndex, 2);
    assert.equal(pushIdx, 2);
    assert.equal(events.some(e => e.type === 'final_pushed'), false);
  });
});

// 4) Empty array → HookError
describe('4) pushPayloads: [] → HookError', () => {
  it('empty array routed to skip-push hint via HOOK_THREW', async () => {
    const { res, body } = await runHandler({ decision: 'finish', pushPayloads: [] });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /use decision: skip-push to skip notification entirely/);
  });
});

// 5) BOTH pushPayload + pushPayloads → HookError
describe('5) pushPayload + pushPayloads → HookError', () => {
  it('mixing singular and plural keys is rejected', async () => {
    const { res, body } = await runHandler({
      decision: 'finish',
      pushPayload: { messageKind: 'content', message: 'a' },
      pushPayloads: [{ messageKind: 'content', message: 'b' }],
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /use pushPayloads/);
  });
});

// 6) ONLY pushPayload (singular) → HookError with migration hint
describe('6) only pushPayload (singular) → HookError', () => {
  it('migration message tells the caller to wrap in an array', async () => {
    const { res, body } = await runHandler({
      decision: 'finish',
      pushPayload: { messageKind: 'content', message: 'a' },
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /pushPayloads: \[yourPayload\]/);
  });
});

// 7) push.splitPattern → HookError
describe('7) per-push splitPattern → HookError', () => {
  it('rejects splitPattern on individual push', async () => {
    const { res, body } = await runHandler({
      decision: 'finish',
      pushPayloads: [{ messageKind: 'content', message: 'a', splitPattern: '([。！？!?]+)' }],
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /splitPattern is removed in 0\.8\.0/);
  });
});

// 8) request body splitPattern → 400 INVALID_PAYLOAD_FORMAT
describe('8) request body splitPattern → 400', () => {
  it('rejected pre-hook with INVALID_PAYLOAD_FORMAT', async () => {
    const router = createFetchRouter({ pushEndpoint: subKit.subscription.endpoint, llm: () => makeLlmResponse('x') });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: () => ({ decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'a' }] }),
    });
    const res = await handler(makeRequest('http://localhost/instant', basePayload({ splitPattern: '([。！？!?]+)' })));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_PAYLOAD_FORMAT');
    assert.match(body.error.message, /splitPattern is removed in 0\.8\.0/);
  });
});

// 9) tool-request decision with all content kinds — lib does not police kind/decision pairing
describe('9) decision: tool-request + all content kinds', () => {
  it('ships every push and returns tool_requested', async () => {
    const { result, pushes } = await runDirect({
      decision: 'tool-request',
      pushPayloads: [
        { messageKind: 'content', message: 'a' },
        { messageKind: 'content', message: 'b' },
      ],
    }, { autoEmitReasoning: false });
    assert.equal(result.status, 'tool_requested');
    assert.equal(pushes.length, 2);
  });
});

// 10) finish decision containing a tool_request kind push — also accepted
describe('10) decision: finish + tool_request kind push', () => {
  it('ships the tool_request push, returns finished', async () => {
    const { result, pushes } = await runDirect({
      decision: 'finish',
      pushPayloads: [
        { messageKind: 'content', message: 'narration' },
        { messageKind: 'tool_request', message: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'x' } }] },
      ],
    }, { autoEmitReasoning: false });
    assert.equal(result.status, 'finished');
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1].messageKind, 'tool_request');
    assert.deepEqual(pushes[1].toolCalls, [{ id: 'c1', type: 'function', function: { name: 'x' } }]);
  });
});

// 11) messageId precedence
describe('11) messageId hook vs auto', () => {
  it('hook-set messageId is preserved; unset → lib auto-fills with unique id', async () => {
    const { pushes } = await runDirect({
      decision: 'finish',
      pushPayloads: [
        { messageKind: 'content', message: 'a', messageId: 'hook-set-1' },
        { messageKind: 'content', message: 'b' },
        { messageKind: 'content', message: 'c', messageId: 'hook-set-3' },
      ],
    }, { autoEmitReasoning: false });
    assert.equal(pushes[0].messageId, 'hook-set-1');
    assert.equal(pushes[2].messageId, 'hook-set-3');
    assert.notEqual(pushes[1].messageId, undefined);
    assert.notEqual(pushes[1].messageId, pushes[0].messageId);
    assert.notEqual(pushes[1].messageId, pushes[2].messageId);
  });
});

// 12) messageIndex/totalMessages always overwritten
describe('12) messageIndex/totalMessages overwritten', () => {
  it('caller-supplied indices are clobbered with array-derived values', async () => {
    const { pushes } = await runDirect({
      decision: 'finish',
      pushPayloads: [
        { messageKind: 'content', message: 'a', messageIndex: 999, totalMessages: 0 },
        { messageKind: 'content', message: 'b', messageIndex: 999, totalMessages: 0 },
      ],
    }, { autoEmitReasoning: false });
    assert.deepEqual(pushes.map(p => p.messageIndex), [1, 2]);
    assert.deepEqual(pushes.map(p => p.totalMessages), [2, 2]);
  });
});

// 13) reasoning auto-emit + pushPayloads coexist
describe('13) reasoning auto-emit precedes hook pushPayloads', () => {
  it('reasoning push ships first, then hook pushes', async () => {
    const { pushes } = await runDirect({
      decision: 'finish',
      pushPayloads: [
        { messageKind: 'content', message: 'final answer' },
      ],
    }, { reasoning: 'thinking...' });
    assert.equal(pushes.length, 2);
    assert.equal(pushes[0].messageKind, 'reasoning');
    assert.equal(pushes[0].reasoningContent, 'thinking...');
    assert.equal(pushes[1].messageKind, 'content');
    assert.equal(pushes[1].message, 'final answer');
  });
});

// 14) messageId edge cases: empty string / null / non-string
describe('14) messageId must be a non-empty string when set', () => {
  it('rejects messageId: "" (empty string)', async () => {
    const { res, body } = await runHandler({
      decision: 'finish',
      pushPayloads: [{ messageKind: 'content', message: 'a', messageId: '' }],
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /messageId must be a non-empty string/);
  });
  it('rejects messageId: null', async () => {
    const { res, body } = await runHandler({
      decision: 'finish',
      pushPayloads: [{ messageKind: 'content', message: 'a', messageId: null }],
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /messageId must be a non-empty string/);
  });
  it('rejects messageId: 42 (non-string)', async () => {
    const { res, body } = await runHandler({
      decision: 'finish',
      pushPayloads: [{ messageKind: 'content', message: 'a', messageId: 42 }],
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /messageId must be a non-empty string/);
  });
});
