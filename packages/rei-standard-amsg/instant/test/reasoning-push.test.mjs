/**
 * v0.8 ReasoningPush tests.
 *
 * Covers the new "auto-emit ReasoningPush before the content burst /
 * before the hook" behaviour on both the legacy and the agentic-loop
 * paths, plus the hook-path `autoEmitReasoning: false` opt-out.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { createInstantHandler } from '../src/index.js';
import {
  generateTestVapid,
  generateTestSubscription,
  createFetchRouter,
  decryptCapturedPushBody,
  makeLlmResponse,
} from './helpers.mjs';

const LLM_URL = 'https://api.example.com/v1/chat/completions';

let vapid;
let subKit;

before(async () => {
  vapid = await generateTestVapid();
  subKit = await generateTestSubscription();
});

function makeRequest(body, headers = {}) {
  return new Request('http://localhost/instant', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function basePayload(overrides = {}) {
  return {
    contactName: 'Rei',
    completePrompt: 'say hi',
    apiUrl: LLM_URL,
    apiKey: 'sk-test',
    primaryModel: 'model-x',
    pushSubscription: subKit.subscription,
    ...overrides,
  };
}

async function decryptAll(pushCalls) {
  const out = [];
  for (const call of pushCalls) {
    out.push(JSON.parse(await decryptCapturedPushBody(call.body, subKit)));
  }
  return out;
}

// ─── Legacy path ────────────────────────────────────────────────────────

describe('legacy path — ReasoningPush auto-emission', () => {
  it('emits ReasoningPush before ContentPush when reasoning_content present', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('hello.', { reasoning_content: 'user said hi; reply briefly' }),
    });
    // Disable sentence-spacing sleeps so the test stays fast — the
    // production 1500ms gap is exercised by handler.test.mjs.
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
    });
    // Skip the wait — drive the handler through a sleep override by
    // bypassing the handler-facing wrapper. We can't pass sleep
    // through `createInstantHandler`, so the test is sized to send
    // one sentence + reasoning = 2 pushes.
    const res = await handler(makeRequest(basePayload()));
    assert.equal(res.status, 200);
    assert.equal(router.pushCalls.length, 2);

    const decoded = await decryptAll(router.pushCalls);
    // Reasoning first, content second.
    assert.equal(decoded[0].messageKind, 'reasoning');
    assert.equal(decoded[0].reasoningContent, 'user said hi; reply briefly');
    assert.equal('messageIndex' in decoded[0], false, 'reasoning must not carry messageIndex');
    assert.equal('totalMessages' in decoded[0], false, 'reasoning must not carry totalMessages');

    assert.equal(decoded[1].messageKind, 'content');
    assert.equal(decoded[1].message, 'hello.');
    assert.equal(decoded[1].messageIndex, 1);
    assert.equal(decoded[1].totalMessages, 1);

    // Same sessionId across reasoning + content (one LLM round).
    assert.equal(decoded[0].sessionId, decoded[1].sessionId);
  });

  it('does NOT emit ReasoningPush when reasoning_content is empty/absent', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('plain.'),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(makeRequest(basePayload()));
    assert.equal(res.status, 200);
    assert.equal(router.pushCalls.length, 1, 'no reasoning_content → no ReasoningPush');
    const [content] = await decryptAll(router.pushCalls);
    assert.equal(content.messageKind, 'content');
  });

  it('treats whitespace-only reasoning_content as absent', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('plain.', { reasoning_content: '   \n  ' }),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(makeRequest(basePayload()));
    assert.equal(res.status, 200);
    assert.equal(router.pushCalls.length, 1);
  });
});

// ─── Hook path ──────────────────────────────────────────────────────────

function hookPayload(overrides = {}) {
  const p = basePayload({
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  });
  // The handler rejects payloads carrying BOTH completePrompt and messages.
  delete p.completePrompt;
  return p;
}

describe('hook path — ReasoningPush auto-emission', () => {
  it('default config emits ReasoningPush BEFORE invoking the hook (hook honors ctx.sessionId)', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('answer text', { reasoning_content: 'thinking out loud' }),
    });
    const events = [];
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onEvent: (e) => events.push(e),
      // The hook is responsible for propagating ctx.sessionId into its
      // own pushPayload — the framework does NOT auto-inject (the hook
      // contract is `pushPayload: unknown`, fully caller-controlled).
      // ctx.sessionId is exposed for exactly this purpose.
      onLLMOutput: (ctx) => ({
        decision: 'finish',
        pushPayloads: [{ messageKind: 'content', message: ctx.llmOutputText, sessionId: ctx.sessionId }],
      }),
    });
    const res = await handler(makeRequest(hookPayload({ sessionId: 'sess-pair-1' })));
    assert.equal(res.status, 200);
    assert.equal(router.pushCalls.length, 2);
    const decoded = await decryptAll(router.pushCalls);
    assert.equal(decoded[0].messageKind, 'reasoning');
    assert.equal(decoded[0].reasoningContent, 'thinking out loud');
    assert.equal(decoded[1].messageKind, 'content');
    // Same sessionId across reasoning + hook's content push — the
    // hook propagates it via ctx.sessionId.
    assert.equal(decoded[0].sessionId, 'sess-pair-1');
    assert.equal(decoded[1].sessionId, 'sess-pair-1');
    // onEvent received the auto-push notification.
    assert.ok(events.some((e) => e.type === 'reasoning_pushed'),
      `expected a 'reasoning_pushed' event, got: ${JSON.stringify(events.map(e => e.type))}`);
  });

  it('autoEmitReasoning:false suppresses auto-emit even when reasoning_content present', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('answer text', { reasoning_content: 'thinking out loud' }),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      autoEmitReasoning: false,
      onLLMOutput: (ctx) => ({
        decision: 'finish',
        pushPayloads: [{ messageKind: 'content', message: ctx.llmOutputText }],
      }),
    });
    const res = await handler(makeRequest(hookPayload()));
    assert.equal(res.status, 200);
    assert.equal(router.pushCalls.length, 1, 'autoEmitReasoning:false → only the hook push');
    const [only] = await decryptAll(router.pushCalls);
    assert.equal(only.messageKind, 'content');
  });

  it('hook returning skip-push still ships the auto-emitted ReasoningPush', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('whatever', { reasoning_content: 'I will stay silent' }),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: () => ({ decision: 'skip-push' }),
    });
    const res = await handler(makeRequest(hookPayload()));
    const body = await res.json();
    assert.equal(body.data.status, 'skipped');
    // ReasoningPush already shipped before the hook decided to skip.
    assert.equal(router.pushCalls.length, 1);
    const [only] = await decryptAll(router.pushCalls);
    assert.equal(only.messageKind, 'reasoning');
  });

  it('reasoning push uses the same sessionId as subsequent agentic-loop iterations', async () => {
    let llmCalls = 0;
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => {
        llmCalls++;
        // round 1 has reasoning; round 2 emits a finish push.
        return llmCalls === 1
          ? makeLlmResponse(`round-${llmCalls}`, { reasoning_content: 'planning' })
          : makeLlmResponse(`round-${llmCalls}`);
      },
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: (ctx) => {
        if (ctx.iteration === 0) {
          return { decision: 'continue', nextHistory: ctx.messages };
        }
        return {
          decision: 'finish',
          pushPayloads: [{ messageKind: 'content', message: ctx.llmOutputText, sessionId: ctx.sessionId }],
        };
      },
    });
    const res = await handler(makeRequest(hookPayload({ sessionId: 'sess-stable-1' })));
    assert.equal(res.status, 200);
    assert.equal(llmCalls, 2);
    // 1 reasoning (iter 0) + 1 content (iter 1 finish) = 2 pushes total.
    assert.equal(router.pushCalls.length, 2);
    const decoded = await decryptAll(router.pushCalls);
    assert.equal(decoded[0].messageKind, 'reasoning');
    assert.equal(decoded[0].sessionId, 'sess-stable-1');
    assert.equal(decoded[1].sessionId, 'sess-stable-1');
  });
});

// ─── next.4 — reasoning byte-chunking simplified ───────────────────────

describe('next.4 — reasoning byte-chunking simplified', () => {
  it('short reasoning ships as a single push (no chunkIndex on wire)', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('hi.', { reasoning_content: 'short thought' }),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    await handler(makeRequest(basePayload()));
    const decoded = await decryptAll(router.pushCalls);
    const r = decoded.find(p => p.messageKind === 'reasoning');
    assert.ok(r, 'expected a reasoning push');
    assert.equal('chunkIndex' in r, false);
    assert.equal('totalChunks' in r, false);
    assert.equal('messageIndex' in r, false, 'no Layer-1 split → no messageIndex');
    assert.equal(r.reasoningContent, 'short thought');
  });

  it('oversized reasoning gets byte-chunked into N pushes with chunkIndex/totalChunks', async () => {
    const big = 'x'.repeat(5500); // > default 2000 B threshold
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('hi.', { reasoning_content: big }),
    });
    const events = [];
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onEvent: (e) => events.push(e),
    });
    await handler(makeRequest(basePayload()));
    const decoded = await decryptAll(router.pushCalls);
    const reasoning = decoded.filter(p => p.messageKind === 'reasoning');
    assert.ok(reasoning.length >= 3, `expected >= 3 chunks for 5500B reasoning at 2000B threshold, got ${reasoning.length}`);
    for (let i = 0; i < reasoning.length; i++) {
      assert.equal(reasoning[i].chunkIndex, i + 1);
      assert.equal(reasoning[i].totalChunks, reasoning.length);
    }
    // Reassembling yields the original
    const reassembled = reasoning.map(p => p.reasoningContent).join('');
    assert.equal(reassembled, big);
    // reasoning_chunked event fires exactly once
    const chunkedEvts = events.filter(e => e.type === 'reasoning_chunked');
    assert.equal(chunkedEvts.length, 1);
    assert.equal(chunkedEvts[0].totalChunks, reasoning.length);
  });
});
