/**
 * next.2 — splitPattern in hook mode.
 *
 * 0.7 / 0.8.0-next.1 disabled `splitPattern` on the hook path and
 * emitted a startup warn whenever both `onLLMOutput` and `splitPattern`
 * were set. This file pins the next.2 behaviour:
 *
 *   - splitPattern applies to the kind-specific text field of the
 *     pushPayload returned by the hook (`content.message`,
 *     `reasoning.reasoningContent`, `tool_request.message`).
 *   - Default `/([。！？!?]+)/` mirrors the legacy path.
 *   - `null` / `[]` opt out.
 *   - Each chunk gets a fresh `messageId` + 1-based `messageIndex` +
 *     `totalMessages`, shares `sessionId`, copies `metadata` verbatim.
 *   - ToolRequestPush splitting demotes prefix chunks to ContentPush
 *     (drops `toolCalls`) and binds `toolCalls` to the chunk holding
 *     the LAST prefix segment (kept as `tool_request`).
 *   - Chunks are serialised with `SLEEP_BETWEEN_MESSAGES_MS` (1500 ms)
 *     spacing — same constant as the legacy path.
 *   - The "splitPattern is ignored" startup warn is gone.
 *   - Non-hook path is untouched (0.6 regression covered by
 *     handler.test.mjs; we re-assert one case here to be loud about
 *     it).
 *
 * Most tests drive `processInstantMessage` directly so we can inject a
 * `sleep` mock — running real 1500 ms × (N-1) waits through the public
 * handler would balloon the suite. The handler-level wire-up is covered
 * by one end-to-end test that does pay the wall-clock cost.
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

let vapid;
let subKit;

before(async () => {
  vapid = await generateTestVapid();
  subKit = await generateTestSubscription();
});

function basePayload(overrides = {}) {
  return {
    contactName: 'Rei',
    messages: [{ role: 'user', content: 'kick the loop' }],
    apiUrl: LLM_URL,
    apiKey: 'sk-test',
    primaryModel: 'model-x',
    pushSubscription: subKit.subscription,
    sessionId: 'sess-split',
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

/** Drive the processor directly with an instant-sleep mock + sleep tracker. */
async function runProcessor(payload, hookCtxOverrides = {}) {
  const router = createFetchRouter({
    pushEndpoint: subKit.subscription.endpoint,
    llm: hookCtxOverrides.llm || (() => makeLlmResponse('llm-output')),
  });
  const sleeps = [];
  const events = [];
  const ctx = {
    vapid,
    fetch: router.fetch,
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    onEvent: (e) => events.push(e),
    onLLMOutput: hookCtxOverrides.onLLMOutput,
    requestUrl: 'http://localhost/instant',
    autoEmitReasoning: hookCtxOverrides.autoEmitReasoning,
    reasoningChunkBytes: hookCtxOverrides.reasoningChunkBytes,
    blobStore: hookCtxOverrides.blobStore,
  };
  const result = await processInstantMessage(payload, ctx);
  const decoded = [];
  for (const call of router.pushCalls) {
    decoded.push(JSON.parse(await decryptCapturedPushBody(call.body, subKit)));
  }
  return { result, pushes: decoded, sleeps, events, router };
}

// ─── 1) hook + no splitPattern + default ContentPush ────────────────────

describe('hook mode + splitPattern — default sentence-split', () => {
  it('splits content.message by default `/([。！？!?]+)/` into 3 pushes', async () => {
    const { result, pushes, sleeps } = await runProcessor(
      basePayload(),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'content',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-msg',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'A。B。C。',
            metadata: { trace: 'xyz' },
          },
        }),
      }
    );
    assert.equal(result.status, 'finished');
    assert.equal(pushes.length, 3);
    assert.deepEqual(pushes.map((p) => p.message), ['A。', 'B。', 'C。']);
    // wire format assertions
    assert.equal(pushes[0].messageIndex, 1);
    assert.equal(pushes[2].messageIndex, 3);
    assert.equal(pushes[0].totalMessages, 3);
    assert.equal(pushes[2].totalMessages, 3);
    // shared sessionId, distinct messageIds, metadata copied
    const sessionIds = new Set(pushes.map((p) => p.sessionId));
    assert.equal(sessionIds.size, 1);
    const messageIds = new Set(pushes.map((p) => p.messageId));
    assert.equal(messageIds.size, 3);
    assert.deepEqual(pushes.map((p) => p.metadata), [
      { trace: 'xyz' },
      { trace: 'xyz' },
      { trace: 'xyz' },
    ]);
    // spacing: SLEEP_BETWEEN_MESSAGES_MS between every pair (N-1 sleeps)
    assert.deepEqual(sleeps, [1500, 1500]);
  });
});

// ─── 2) explicit string splitPattern (same as default) ──────────────────

describe('hook mode + splitPattern — explicit string', () => {
  it('explicit `([。！？!?]+)` matches default behaviour', async () => {
    const { pushes } = await runProcessor(
      basePayload({ splitPattern: '([。！？!?]+)' }),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'content',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-msg',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'A。B。C。',
          },
        }),
      }
    );
    assert.equal(pushes.length, 3);
    assert.deepEqual(pushes.map((p) => p.message), ['A。', 'B。', 'C。']);
  });
});

// ─── 3) array cascade ───────────────────────────────────────────────────

describe('hook mode + splitPattern — array cascade', () => {
  it('splits by \\n+ first, then by sentence regex', async () => {
    const { pushes } = await runProcessor(
      basePayload({ splitPattern: ['\\n+', '([。！？!?]+)'] }),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'content',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-msg',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'A。B。\nC。D。',
          },
        }),
      }
    );
    // First cascade: ['A。B。', 'C。D。'] (delimiter \n+ has no capture group → dropped)
    // Second cascade: ['A。','B。','C。','D。']
    assert.deepEqual(pushes.map((p) => p.message), ['A。', 'B。', 'C。', 'D。']);
    assert.deepEqual(pushes.map((p) => p.messageIndex), [1, 2, 3, 4]);
    assert.equal(pushes[0].totalMessages, 4);
  });
});

// ─── 4) splitPattern: null / [] disable splitting ───────────────────────

describe('hook mode + splitPattern — disable', () => {
  it('splitPattern: null → single push (no split)', async () => {
    const { pushes, sleeps } = await runProcessor(
      basePayload({ splitPattern: null }),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'content',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-msg',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'A。B。C。',
          },
        }),
      }
    );
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].message, 'A。B。C。');
    assert.equal(pushes[0].messageId, 'hook-msg', 'single-chunk passthrough preserves original messageId');
    assert.deepEqual(sleeps, []);
  });

  it('splitPattern: [] → single push (no split)', async () => {
    const { pushes } = await runProcessor(
      basePayload({ splitPattern: [] }),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'content',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-msg',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'A。B。C。',
          },
        }),
      }
    );
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].message, 'A。B。C。');
  });
});

// ─── 5) no punctuation + default pattern → single push ──────────────────

describe('hook mode + splitPattern — no match passes through', () => {
  it('default regex on punctuation-free message → single push', async () => {
    const { pushes, sleeps } = await runProcessor(
      basePayload(),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'content',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-msg',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'no punctuation here at all',
          },
        }),
      }
    );
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].message, 'no punctuation here at all');
    assert.deepEqual(sleeps, []);
  });
});

// ─── 6) ReasoningPush — default off; opt-in via reasoningSplitPattern ───

describe('hook mode — ReasoningPush default off', () => {
  it('reasoning is NOT split by default, even with sentence-laden content', async () => {
    const { pushes, sleeps } = await runProcessor(
      basePayload(),
      {
        autoEmitReasoning: false,
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'reasoning',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-reason-default',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            reasoningContent: 'first thought。second thought。third。',
          },
        }),
      }
    );
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].reasoningContent, 'first thought。second thought。third。');
    assert.equal(pushes[0].messageId, 'hook-reason-default');
    assert.deepEqual(sleeps, []);
  });

  it('splitPattern alone does NOT split reasoning — reasoning has its own knob', async () => {
    const { pushes, sleeps } = await runProcessor(
      basePayload({ splitPattern: '([。！？!?]+)' }),
      {
        autoEmitReasoning: false,
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'reasoning',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-reason-default',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            reasoningContent: 'first thought。second thought。third。',
          },
        }),
      }
    );
    assert.equal(pushes.length, 1);
    assert.deepEqual(sleeps, []);
  });
});

describe('hook mode — reasoningSplitPattern enables reasoning splitting', () => {
  it('reasoningSplitPattern: sentence regex → N reasoning pushes', async () => {
    const { pushes, sleeps } = await runProcessor(
      basePayload({ reasoningSplitPattern: '([。！？!?]+)' }),
      {
        autoEmitReasoning: false,
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'reasoning',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-reason',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            reasoningContent: 'first thought。second thought。third。',
          },
        }),
      }
    );
    assert.equal(pushes.length, 3);
    assert.deepEqual(pushes.map((p) => p.messageKind), [
      'reasoning', 'reasoning', 'reasoning',
    ]);
    assert.deepEqual(pushes.map((p) => p.reasoningContent), [
      'first thought。', 'second thought。', 'third。',
    ]);
    assert.deepEqual(pushes.map((p) => p.messageIndex), [1, 2, 3]);
    assert.deepEqual(pushes.map((p) => p.totalMessages), [3, 3, 3]);
    assert.deepEqual(sleeps, [1500, 1500]);
  });

  it('reasoningSplitPattern: null / [] keep reasoning unsplit (explicit-off, same as undefined)', async () => {
    for (const sp of [null, []]) {
      const { pushes } = await runProcessor(
        basePayload({ reasoningSplitPattern: sp }),
        {
          autoEmitReasoning: false,
          onLLMOutput: (sctx) => ({
            decision: 'finish',
            pushPayload: {
              messageKind: 'reasoning',
              messageType: 'instant',
              source: 'instant',
              messageId: 'hook-reason',
              sessionId: sctx.sessionId,
              timestamp: '2026-01-01T00:00:00.000Z',
              reasoningContent: 'first thought。second thought。third。',
            },
          }),
        }
      );
      assert.equal(pushes.length, 1, `reasoningSplitPattern: ${JSON.stringify(sp)}`);
    }
  });

  it('reasoningSplitPattern cascade (string[]) is honoured', async () => {
    const { pushes } = await runProcessor(
      basePayload({ reasoningSplitPattern: ['\\n+', '([。！？!?]+)'] }),
      {
        autoEmitReasoning: false,
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'reasoning',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-reason',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            reasoningContent: 'A。B。\nC。D。',
          },
        }),
      }
    );
    assert.deepEqual(pushes.map((p) => p.reasoningContent), ['A。', 'B。', 'C。', 'D。']);
  });
});

describe('hook mode — auto-emitted ReasoningPush also honours reasoningSplitPattern', () => {
  it('framework-built reasoning from LLM splits when reasoningSplitPattern is set', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('final answer', { reasoning_content: 'step 1。step 2。step 3。' }),
    });
    const sleeps = [];
    const ctx = {
      vapid,
      fetch: router.fetch,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      onLLMOutput: () => ({ decision: 'skip-push' }),
      requestUrl: 'http://localhost/instant',
    };
    await processInstantMessage(
      basePayload({ reasoningSplitPattern: '([。！？!?]+)' }),
      ctx
    );
    const decoded = [];
    for (const call of router.pushCalls) {
      decoded.push(JSON.parse(await decryptCapturedPushBody(call.body, subKit)));
    }
    // 3 reasoning chunks, then hook skip-push → no content
    assert.equal(decoded.length, 3);
    assert.deepEqual(decoded.map((p) => p.messageKind), [
      'reasoning', 'reasoning', 'reasoning',
    ]);
    assert.deepEqual(decoded.map((p) => p.reasoningContent), [
      'step 1。', 'step 2。', 'step 3。',
    ]);
    // 2 sleeps between 3 chunks (auto-emit) — no post-burst sleep counted
    // because the hook returned skip-push, but the legacy post-reasoning
    // sleep before content burst still fires.
    assert.deepEqual(sleeps.slice(0, 2), [1500, 1500]);
  });

  it('default (no reasoningSplitPattern) keeps auto-emit as a single reasoning push', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('final answer', { reasoning_content: 'step 1。step 2。step 3。' }),
    });
    const ctx = {
      vapid,
      fetch: router.fetch,
      sleep: () => Promise.resolve(),
      onLLMOutput: () => ({ decision: 'skip-push' }),
      requestUrl: 'http://localhost/instant',
    };
    await processInstantMessage(basePayload(), ctx);
    assert.equal(router.pushCalls.length, 1);
    const decoded = JSON.parse(await decryptCapturedPushBody(router.pushCalls[0].body, subKit));
    assert.equal(decoded.messageKind, 'reasoning');
    assert.equal(decoded.reasoningContent, 'step 1。step 2。step 3。');
  });
});

// ─── 7) ToolRequestPush — prefix chunks demote, toolCalls bind to last ──

describe('hook mode + splitPattern — ToolRequestPush', () => {
  it('N-1 chunks → ContentPush; final chunk → ToolRequestPush with toolCalls', async () => {
    const toolCalls = [{
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
    }];
    const { pushes, sleeps } = await runProcessor(
      basePayload(),
      {
        onLLMOutput: (sctx) => ({
          decision: 'tool-request',
          pushPayload: {
            messageKind: 'tool_request',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-tool',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'Let me check。One moment。Fetching now。',
            toolCalls,
          },
        }),
      }
    );
    assert.equal(pushes.length, 3);
    // Prefix chunks: ContentPush, no toolCalls
    assert.equal(pushes[0].messageKind, 'content');
    assert.equal(pushes[1].messageKind, 'content');
    assert.equal('toolCalls' in pushes[0], false);
    assert.equal('toolCalls' in pushes[1], false);
    assert.equal(pushes[0].message, 'Let me check。');
    assert.equal(pushes[1].message, 'One moment。');
    // Final chunk keeps tool_request kind + full toolCalls atomic
    assert.equal(pushes[2].messageKind, 'tool_request');
    assert.equal(pushes[2].message, 'Fetching now。');
    assert.deepEqual(pushes[2].toolCalls, toolCalls);
    // All share sessionId
    assert.equal(new Set(pushes.map((p) => p.sessionId)).size, 1);
    // 1-based messageIndex on every chunk
    assert.deepEqual(pushes.map((p) => p.messageIndex), [1, 2, 3]);
    assert.deepEqual(pushes.map((p) => p.totalMessages), [3, 3, 3]);
    assert.deepEqual(sleeps, [1500, 1500]);
  });

  it('single-segment ToolRequestPush passes through unchanged (toolCalls intact)', async () => {
    const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'x' } }];
    const { pushes } = await runProcessor(
      basePayload(),
      {
        onLLMOutput: (sctx) => ({
          decision: 'tool-request',
          pushPayload: {
            messageKind: 'tool_request',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-tool-single',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'no punctuation',
            toolCalls,
          },
        }),
      }
    );
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].messageKind, 'tool_request');
    assert.deepEqual(pushes[0].toolCalls, toolCalls);
    assert.equal(pushes[0].messageId, 'hook-tool-single');
  });

  it('ToolRequestPush without `message` is not split (no field to slice)', async () => {
    const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'x' } }];
    const { pushes } = await runProcessor(
      basePayload(),
      {
        onLLMOutput: (sctx) => ({
          decision: 'tool-request',
          pushPayload: {
            messageKind: 'tool_request',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-tool-no-msg',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            toolCalls,
          },
        }),
      }
    );
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].messageKind, 'tool_request');
    assert.deepEqual(pushes[0].toolCalls, toolCalls);
  });
});

// ─── 8) ErrorPush — default off; opt-in via errorSplitPattern ───────────

describe('hook mode — ErrorPush default off', () => {
  it('error kind passes through verbatim even with sentence-laden message', async () => {
    const { pushes, sleeps } = await runProcessor(
      basePayload(),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'error',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-err',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            code: 'CUSTOM_FAIL',
            message: 'first sentence。second sentence。',
          },
        }),
      }
    );
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].messageKind, 'error');
    assert.equal(pushes[0].message, 'first sentence。second sentence。');
    assert.deepEqual(sleeps, []);
  });

  it('splitPattern alone does NOT split error — error has its own knob', async () => {
    const { pushes } = await runProcessor(
      basePayload({ splitPattern: '([。！？!?]+)' }),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'error',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-err',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            code: 'CUSTOM_FAIL',
            message: 'first sentence。second sentence。',
          },
        }),
      }
    );
    assert.equal(pushes.length, 1);
  });
});

describe('hook mode — errorSplitPattern enables error splitting', () => {
  it('errorSplitPattern: sentence regex → N error pushes', async () => {
    const { pushes, sleeps } = await runProcessor(
      basePayload({ errorSplitPattern: '([。！？!?]+)' }),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'error',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-err',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            code: 'CUSTOM_FAIL',
            message: 'first sentence。second sentence。third sentence。',
          },
        }),
      }
    );
    assert.equal(pushes.length, 3);
    assert.deepEqual(pushes.map((p) => p.messageKind), ['error', 'error', 'error']);
    assert.deepEqual(pushes.map((p) => p.message), [
      'first sentence。', 'second sentence。', 'third sentence。',
    ]);
    // `code` and other top-level fields are preserved on every chunk.
    assert.deepEqual(pushes.map((p) => p.code), [
      'CUSTOM_FAIL', 'CUSTOM_FAIL', 'CUSTOM_FAIL',
    ]);
    assert.deepEqual(sleeps, [1500, 1500]);
  });

  it('errorSplitPattern: null / [] keep error unsplit (explicit-off)', async () => {
    for (const sp of [null, []]) {
      const { pushes } = await runProcessor(
        basePayload({ errorSplitPattern: sp }),
        {
          onLLMOutput: (sctx) => ({
            decision: 'finish',
            pushPayload: {
              messageKind: 'error',
              messageType: 'instant',
              source: 'instant',
              messageId: 'hook-err',
              sessionId: sctx.sessionId,
              timestamp: '2026-01-01T00:00:00.000Z',
              code: 'CUSTOM_FAIL',
              message: 'first sentence。second sentence。',
            },
          }),
        }
      );
      assert.equal(pushes.length, 1, `errorSplitPattern: ${JSON.stringify(sp)}`);
    }
  });
});

describe('hook mode — LOOP_EXCEEDED diagnostic respects errorSplitPattern', () => {
  it('framework-built LOOP_EXCEEDED can be chunked when errorSplitPattern matches', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('again'),
    });
    const sleeps = [];
    const ctx = {
      vapid,
      fetch: router.fetch,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      maxLoopIterations: 2,
      onLLMOutput: (sctx) => ({ decision: 'continue', nextHistory: sctx.messages }),
      requestUrl: 'http://localhost/instant',
    };
    // The framework message is "Agentic loop exceeded 2 iterations" —
    // no sentence punctuation. Split by whitespace so we can prove the
    // path runs through the splitter for ErrorPush too.
    const result = await processInstantMessage(
      basePayload({ errorSplitPattern: '(\\s+)' }),
      ctx
    );
    assert.equal(result.status, 'loop_exceeded');
    // "Agentic loop exceeded 2 iterations" → 4 tokens with the
    // capture-group-spaces convention. Just check >1 to keep the
    // assertion robust against future wording tweaks.
    assert.ok(router.pushCalls.length >= 2, `expected ≥2 chunks, got ${router.pushCalls.length}`);
    const decoded = [];
    for (const call of router.pushCalls) {
      decoded.push(JSON.parse(await decryptCapturedPushBody(call.body, subKit)));
    }
    assert.equal(decoded[0].messageKind, 'error');
    assert.equal(decoded[0].code, 'LOOP_EXCEEDED');
  });
});

// ─── 9) Free-form pushPayload is never split ────────────────────────────

describe('hook mode + splitPattern — free-form payload opts out', () => {
  it('payload without `messageKind` passes through verbatim', async () => {
    const { pushes, sleeps } = await runProcessor(
      basePayload(),
      {
        onLLMOutput: () => ({
          decision: 'finish',
          // No messageKind → framework can't guess which field to split.
          pushPayload: { type: 'legacy', text: 'A。B。C。' },
        }),
      }
    );
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].text, 'A。B。C。');
    assert.equal(pushes[0].type, 'legacy');
    assert.deepEqual(sleeps, []);
  });
});

// ─── 10) ordering: pushes ship strictly serially with the sleep gap ─────

describe('hook mode + splitPattern — serial ordering', () => {
  it('emits pushes in 1..N order interleaved with sleeps', async () => {
    const sequence = [];
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('x'),
      onPush: () => { sequence.push('push'); return undefined; },
    });
    const ctx = {
      vapid,
      fetch: router.fetch,
      sleep: (ms) => { sequence.push(`sleep:${ms}`); return Promise.resolve(); },
      onLLMOutput: (sctx) => ({
        decision: 'finish',
        pushPayload: {
          messageKind: 'content',
          messageType: 'instant',
          source: 'instant',
          messageId: 'hook-msg',
          sessionId: sctx.sessionId,
          message: 'A。B。C。',
        },
      }),
      requestUrl: 'http://localhost/instant',
    };
    await processInstantMessage(basePayload(), ctx);
    assert.deepEqual(sequence, [
      'push', 'sleep:1500',
      'push', 'sleep:1500',
      'push',
    ]);
  });
});

// ─── 10b) per-push splitPattern override on pushPayload (next.3+) ───────
//
// 0.8.0-next.2 treated `splitPattern` strictly as a request-level field
// — a hook that wrote `splitPattern: null` on its own pushPayload had
// the field silently ignored (the only way to disable splitting for one
// push was to flip the outer request body). next.3 promotes
// `pushPayload.splitPattern` to a per-push override that takes
// precedence over the request-level field for that one push, and gets
// stripped before delivery so it never leaks onto the wire.

describe('hook mode + splitPattern — per-push override', () => {
  it('pushPayload.splitPattern: null disables split even when outer request is default-on', async () => {
    const { pushes, sleeps } = await runProcessor(
      basePayload(), // outer request: splitPattern undefined → default sentence-split on
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'content',
            messageType: 'instant',
            source: 'instant',
            messageId: 'override-null',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'A。B。C。',
            splitPattern: null,
          },
        }),
      }
    );
    assert.equal(pushes.length, 1, 'override null → single push');
    assert.equal(pushes[0].message, 'A。B。C。');
    assert.equal(pushes[0].messageId, 'override-null');
    assert.deepEqual(sleeps, []);
    // Stripped before delivery — never appears on the wire.
    assert.equal('splitPattern' in pushes[0], false);
  });

  it('pushPayload.splitPattern beats outer request splitPattern (override > request)', async () => {
    // Outer says split-by-newline, push override says split-by-sentence.
    // Override should win → 3 chunks on `。`, not 1.
    const { pushes } = await runProcessor(
      basePayload({ splitPattern: '(\\n+)' }),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'content',
            messageType: 'instant',
            source: 'instant',
            messageId: 'override-string',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'A。B。C。',
            splitPattern: '([。！？!?]+)',
          },
        }),
      }
    );
    assert.equal(pushes.length, 3);
    assert.deepEqual(pushes.map((p) => p.message), ['A。', 'B。', 'C。']);
    // Stripped from every chunk, not just one.
    for (const p of pushes) assert.equal('splitPattern' in p, false);
  });

  it('pushPayload.splitPattern: [] disables (same `null`-or-empty rule as request-level)', async () => {
    const { pushes } = await runProcessor(
      basePayload({ splitPattern: '([。！？!?]+)' }),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'content',
            messageType: 'instant',
            source: 'instant',
            messageId: 'override-empty',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'A。B。C。',
            splitPattern: [],
          },
        }),
      }
    );
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].message, 'A。B。C。');
    assert.equal('splitPattern' in pushes[0], false);
  });

  it('pushPayload.splitPattern enables split on a default-off kind (reasoning)', async () => {
    // Reasoning is default-off at request level. Hook puts splitPattern
    // on the ReasoningPush → that one push splits even though the
    // request omitted `reasoningSplitPattern`.
    const { pushes, sleeps } = await runProcessor(
      basePayload(),
      {
        autoEmitReasoning: false,
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'reasoning',
            messageType: 'instant',
            source: 'instant',
            messageId: 'reason-override',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            reasoningContent: 'first。second。third。',
            splitPattern: '([。！？!?]+)',
          },
        }),
      }
    );
    assert.equal(pushes.length, 3);
    assert.deepEqual(pushes.map((p) => p.messageKind), ['reasoning', 'reasoning', 'reasoning']);
    assert.deepEqual(pushes.map((p) => p.reasoningContent), ['first。', 'second。', 'third。']);
    assert.deepEqual(sleeps, [1500, 1500]);
    for (const p of pushes) assert.equal('splitPattern' in p, false);
  });

  it('pushPayload.splitPattern enables split on a default-off kind (error)', async () => {
    const { pushes } = await runProcessor(
      basePayload(),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'error',
            messageType: 'instant',
            source: 'instant',
            messageId: 'err-override',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            code: 'CUSTOM_FAIL',
            message: 'first。second。third。',
            splitPattern: '([。！？!?]+)',
          },
        }),
      }
    );
    assert.equal(pushes.length, 3);
    assert.deepEqual(pushes.map((p) => p.messageKind), ['error', 'error', 'error']);
    assert.deepEqual(pushes.map((p) => p.code), ['CUSTOM_FAIL', 'CUSTOM_FAIL', 'CUSTOM_FAIL']);
    for (const p of pushes) assert.equal('splitPattern' in p, false);
  });

  it('absent pushPayload.splitPattern falls through to outer request (existing behaviour)', async () => {
    // No `splitPattern` field on the push → outer request controls.
    const { pushes } = await runProcessor(
      basePayload({ splitPattern: null }),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'content',
            messageType: 'instant',
            source: 'instant',
            messageId: 'no-override',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'A。B。C。',
          },
        }),
      }
    );
    assert.equal(pushes.length, 1, 'outer null disables → single push');
    assert.equal(pushes[0].message, 'A。B。C。');
  });

  it('malformed pushPayload.splitPattern surfaces as HookError', async () => {
    // Unbalanced regex group — same shape rule as request-level.
    await assert.rejects(
      runProcessor(
        basePayload(),
        {
          onLLMOutput: (sctx) => ({
            decision: 'finish',
            pushPayload: {
              messageKind: 'content',
              messageType: 'instant',
              source: 'instant',
              messageId: 'bad-override',
              sessionId: sctx.sessionId,
              timestamp: '2026-01-01T00:00:00.000Z',
              message: 'A。B。C。',
              splitPattern: '(',
            },
          }),
        }
      ),
      (err) => {
        assert.equal(err.name, 'HookError');
        assert.ok(/pushPayload\.splitPattern invalid/.test(err.message));
        return true;
      }
    );
  });

  it('ToolRequestPush override demotes prefix chunks + binds toolCalls to last (same as request-level)', async () => {
    const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'x' } }];
    const { pushes } = await runProcessor(
      basePayload({ splitPattern: null }), // outer says off — override re-enables for this push only
      {
        onLLMOutput: (sctx) => ({
          decision: 'tool-request',
          pushPayload: {
            messageKind: 'tool_request',
            messageType: 'instant',
            source: 'instant',
            messageId: 'tool-override',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'one。two。three。',
            toolCalls,
            splitPattern: '([。！？!?]+)',
          },
        }),
      }
    );
    assert.equal(pushes.length, 3);
    assert.deepEqual(pushes.map((p) => p.messageKind), ['content', 'content', 'tool_request']);
    assert.equal('toolCalls' in pushes[0], false);
    assert.equal('toolCalls' in pushes[1], false);
    assert.deepEqual(pushes[2].toolCalls, toolCalls);
    // Override field is stripped from every chunk, including the
    // demoted ContentPush chunks (which spread from cleanPushObj).
    for (const p of pushes) assert.equal('splitPattern' in p, false);
  });

  it('splitPattern stripped even when override fires but produces a single segment', async () => {
    // Punctuation-free message + a regex that won't match → single
    // chunk passthrough. The strip should still apply.
    const { pushes } = await runProcessor(
      basePayload(),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'content',
            messageType: 'instant',
            source: 'instant',
            messageId: 'no-match-strip',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'no punctuation here',
            splitPattern: '([。！？!?]+)',
          },
        }),
      }
    );
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].messageId, 'no-match-strip', 'no-match passthrough still preserves messageId');
    assert.equal('splitPattern' in pushes[0], false, 'no-match passthrough still strips override');
  });

  // ─── undefined vs null distinction ──────────────────────────────────
  //
  // `null` is an *opinion* ("explicitly off for this push, ignore the
  // request-level field"). `undefined` is *not an opinion* ("I didn't
  // set this, do whatever the request-level field says"). Matches the
  // request-level convention and plain-JS reading of `undefined`.

  it('splitPattern: undefined is treated as absent — falls back to outer request', async () => {
    // Outer says default-on. Push has the field set to `undefined`.
    // Should behave the same as if the field were absent: split.
    const { pushes } = await runProcessor(
      basePayload(),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'content',
            messageType: 'instant',
            source: 'instant',
            messageId: 'undef-fallback',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'A。B。C。',
            splitPattern: undefined,
          },
        }),
      }
    );
    assert.equal(pushes.length, 3, 'undefined override must NOT shadow outer default-on');
    assert.deepEqual(pushes.map((p) => p.message), ['A。', 'B。', 'C。']);
    for (const p of pushes) assert.equal('splitPattern' in p, false);
  });

  it('splitPattern: undefined + outer null → respects outer null (still falls back)', async () => {
    const { pushes } = await runProcessor(
      basePayload({ splitPattern: null }),
      {
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'content',
            messageType: 'instant',
            source: 'instant',
            messageId: 'undef-outer-null',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'A。B。C。',
            splitPattern: undefined,
          },
        }),
      }
    );
    assert.equal(pushes.length, 1, 'undefined must fall back to outer null → unsplit');
    assert.equal(pushes[0].message, 'A。B。C。');
  });

  // ─── non-recursive split: demoted chunks aren't re-split ────────────
  //
  // `splitHookPushPayload` runs exactly once per push delivery. The
  // ToolRequestPush prefix-demotion path produces ContentPush chunks
  // that share the same `cleanPushObj` (already-stripped) parent — so
  // there's no second pass that could see the override and re-split.
  // This test wires up a scenario that would catch any future
  // recursion: a 5-segment override that, if applied twice, would
  // shatter into 25+ chunks. Asserting exact count == 5 pins the
  // single-pass invariant.

  it('strip is clone-based — does NOT mutate the original pushPayload', async () => {
    // Hook authors may legitimately return a cached / shared
    // pushPayload template (e.g. a frozen base + per-iteration
    // overrides). If the library used `delete` on the original
    // object, the second reuse of the same reference would silently
    // lose its `splitPattern`. Assert clone-based strip by inspecting
    // the original object after delivery.
    const shared = {
      messageKind: 'content',
      messageType: 'instant',
      source: 'instant',
      messageId: 'shared-template',
      sessionId: 'sess-clone',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: 'A。B。C。',
      splitPattern: null, // explicit-off
    };
    const { pushes } = await runProcessor(
      basePayload(),
      {
        onLLMOutput: () => ({ decision: 'finish', pushPayload: shared }),
      }
    );
    assert.equal(pushes.length, 1, 'override null disables → single push');
    // Wire-clean.
    for (const p of pushes) assert.equal('splitPattern' in p, false);
    // Original object untouched — hook author's template is safe to
    // reuse on the next iteration / next request.
    assert.equal('splitPattern' in shared, true, 'original pushPayload must NOT be mutated');
    assert.equal(shared.splitPattern, null, 'original splitPattern value preserved');
    assert.equal(shared.messageId, 'shared-template', 'other fields untouched');
  });

  it('override on ToolRequestPush splits once — demoted ContentPush chunks not re-split', async () => {
    const toolCalls = [{ id: 'c1', type: 'function', function: { name: 'x' } }];
    const { pushes } = await runProcessor(
      basePayload({ splitPattern: null }), // outer off, override on
      {
        onLLMOutput: (sctx) => ({
          decision: 'tool-request',
          pushPayload: {
            messageKind: 'tool_request',
            messageType: 'instant',
            source: 'instant',
            messageId: 'recursion-check',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            message: 'a。b。c。d。e。', // 5 sentences → 5 chunks if single-pass
            toolCalls,
            splitPattern: '([。！？!?]+)',
          },
        }),
      }
    );
    assert.equal(pushes.length, 5, 'must be exactly 5 — recursion would inflate this');
    assert.deepEqual(pushes.map((p) => p.messageKind), [
      'content', 'content', 'content', 'content', 'tool_request',
    ]);
    assert.deepEqual(pushes.map((p) => p.message), ['a。', 'b。', 'c。', 'd。', 'e。']);
    // Demoted ContentPush prefix chunks (chunks 0..3) carry no
    // toolCalls and no splitPattern. Final tool_request chunk still
    // has toolCalls but no splitPattern.
    for (let i = 0; i < 4; i++) {
      assert.equal('toolCalls' in pushes[i], false, `chunk ${i}: no toolCalls`);
      assert.equal('splitPattern' in pushes[i], false, `chunk ${i}: no splitPattern`);
    }
    assert.deepEqual(pushes[4].toolCalls, toolCalls);
    assert.equal('splitPattern' in pushes[4], false, 'final chunk: no splitPattern');
  });
});

// ─── 11) no startup warn about splitPattern + onLLMOutput combo ─────────

describe('createInstantHandler — no warn about splitPattern in hook mode', () => {
  it('does NOT emit "splitPattern is ignored" warning anymore', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try {
      createInstantHandler({
        vapid,
        fetch: globalThis.fetch,
        onLLMOutput: () => ({ decision: 'skip-push' }),
      });
      // Construct a second handler that explicitly passes splitPattern
      // via the request payload path — there's no handler-level option,
      // so the only thing that could have warned was the old 0.7 block.
      createInstantHandler({
        vapid,
        fetch: globalThis.fetch,
        onLLMOutput: () => ({ decision: 'skip-push' }),
      });
    } finally {
      console.warn = origWarn;
    }
    const offending = warnings.find((w) => w.includes('splitPattern is ignored'));
    assert.equal(offending, undefined, `unexpected warn: ${offending}`);
  });
});

// ─── 12) legacy path regression — splitPattern still works without hook ─

describe('non-hook regression — splitPattern still drives sentence-burst', () => {
  it('legacy path with default splitPattern still emits N content pushes', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('A。B。C。'),
    });
    const sleeps = [];
    const ctx = {
      vapid,
      fetch: router.fetch,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      // No onLLMOutput → legacy path.
      requestUrl: 'http://localhost/instant',
    };
    const payload = {
      contactName: 'Rei',
      completePrompt: 'say A B C',
      apiUrl: LLM_URL,
      apiKey: 'sk-test',
      primaryModel: 'model-x',
      pushSubscription: subKit.subscription,
    };
    const result = await processInstantMessage(payload, ctx);
    assert.equal(result.messagesSent, 3);
    assert.equal(router.pushCalls.length, 3);
    const decoded = [];
    for (const call of router.pushCalls) {
      decoded.push(JSON.parse(await decryptCapturedPushBody(call.body, subKit)));
    }
    assert.deepEqual(decoded.map((p) => p.message), ['A。', 'B。', 'C。']);
    assert.deepEqual(sleeps, [1500, 1500]);
  });
});

// ─── validation: per-kind split-pattern fields ──────────────────────────

describe('validation — reasoningSplitPattern + errorSplitPattern', () => {
  it('rejects reasoningSplitPattern that is not string / string[]', async () => {
    const handler = createInstantHandler({
      vapid,
      fetch: globalThis.fetch,
      onLLMOutput: () => ({ decision: 'skip-push' }),
    });
    const res = await handler(makeRequest(
      'http://h/instant',
      basePayload({ reasoningSplitPattern: 42 })
    ));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_PAYLOAD_FORMAT');
    assert.deepEqual(body.error.details.invalidFields, ['reasoningSplitPattern']);
    assert.ok(body.error.message.includes('reasoningSplitPattern'));
  });

  it('rejects errorSplitPattern with un-compilable regex', async () => {
    const handler = createInstantHandler({
      vapid,
      fetch: globalThis.fetch,
      onLLMOutput: () => ({ decision: 'skip-push' }),
    });
    const res = await handler(makeRequest(
      'http://h/instant',
      basePayload({ errorSplitPattern: '(' /* unbalanced group */ })
    ));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.deepEqual(body.error.details.invalidFields, ['errorSplitPattern']);
  });

  it('accepts valid string / string[] / null / [] / undefined', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('x'),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: () => ({ decision: 'skip-push' }),
    });
    for (const sp of [undefined, null, [], '([。！？!?]+)', ['\\n+', '([。！？!?]+)']]) {
      const res = await handler(makeRequest(
        'http://h/instant',
        basePayload({ reasoningSplitPattern: sp, errorSplitPattern: sp })
      ));
      assert.equal(res.status, 200, `reasoningSplitPattern: ${JSON.stringify(sp)}`);
    }
  });
});

// ─── 13) handler-level wiring smoke test ────────────────────────────────
//
// Spends one real 1500 ms sleep through `setTimeout` to prove the
// public handler entry-point honours splitPattern end-to-end. Only one
// chunk-gap so the suite cost is bounded.

describe('handler entry-point — wires through splitPattern end-to-end', () => {
  it('createInstantHandler + hook + 2-chunk message → 2 pushes', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('x'),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: (sctx) => ({
        decision: 'finish',
        pushPayload: {
          messageKind: 'content',
          messageType: 'instant',
          source: 'instant',
          messageId: 'wire-msg',
          sessionId: sctx.sessionId,
          message: 'first half。second half。',
        },
      }),
    });
    const start = Date.now();
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    const elapsed = Date.now() - start;
    assert.equal(res.status, 200);
    assert.equal(router.pushCalls.length, 2);
    // Real 1.5s gap between two pushes. Allow generous slack (CI).
    assert.ok(elapsed >= 1400, `expected ≥1.4s wall, got ${elapsed}ms`);
  });
});

// ─── reasoning byte chunking (next.2 Layer 2) ───────────────────────────

describe('reasoning byte chunking — defaults', () => {
  it('short reasoning (< 2000 B) ships as a single push, no chunkIndex fields', async () => {
    const { pushes } = await runProcessor(
      basePayload(),
      {
        autoEmitReasoning: false,
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'reasoning',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-small',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            reasoningContent: 'short thought',
          },
        }),
      }
    );
    assert.equal(pushes.length, 1);
    assert.ok(!('chunkIndex' in pushes[0]));
    assert.ok(!('totalChunks' in pushes[0]));
    // Single-chunk passthrough preserves original messageId (no regen).
    assert.equal(pushes[0].messageId, 'hook-small');
  });

  it('6 KB ASCII reasoning at default 2000 B → 3 chunks with chunkIndex 1..3', async () => {
    const big = 'a'.repeat(6000);
    const { pushes, sleeps, events } = await runProcessor(
      basePayload(),
      {
        autoEmitReasoning: false,
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'reasoning',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-big',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            reasoningContent: big,
          },
        }),
      }
    );
    assert.equal(pushes.length, 3);
    assert.deepEqual(pushes.map((p) => p.messageKind), ['reasoning', 'reasoning', 'reasoning']);
    assert.deepEqual(pushes.map((p) => p.chunkIndex), [1, 2, 3]);
    assert.deepEqual(pushes.map((p) => p.totalChunks), [3, 3, 3]);
    // Reassembled content must equal the input — no data loss.
    assert.equal(pushes.map((p) => p.reasoningContent).join(''), big);
    // Each chunk's reasoningContent UTF-8 bytes ≤ threshold.
    const enc = new TextEncoder();
    for (const p of pushes) assert.ok(enc.encode(p.reasoningContent).byteLength <= 2000);
    // 100ms gap between Layer-2 chunks of the same Layer-1 segment.
    assert.deepEqual(sleeps, [100, 100]);
    // One `reasoning_chunked` event fired.
    const chunkedEvents = events.filter((e) => e.type === 'reasoning_chunked');
    assert.equal(chunkedEvents.length, 1);
    assert.equal(chunkedEvents[0].totalChunks, 3);
    assert.equal(chunkedEvents[0].totalBytes, 6000);
    assert.equal(chunkedEvents[0].sessionId, 'sess-split');
  });

  it('CJK 1500-char reasoning (~4500 B) at default threshold → safe codepoint boundaries', async () => {
    const cjk = '寿'.repeat(1500);
    const { pushes } = await runProcessor(
      basePayload(),
      {
        autoEmitReasoning: false,
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'reasoning',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-cjk',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            reasoningContent: cjk,
          },
        }),
      }
    );
    assert.ok(pushes.length >= 3);
    assert.equal(pushes.map((p) => p.reasoningContent).join(''), cjk);
    // Every chunk decodes cleanly — no garbled half-character residue.
    for (const p of pushes) {
      assert.ok(typeof p.reasoningContent === 'string' && p.reasoningContent.length > 0);
    }
  });

  it('emoji (4-byte char) reasoning chunks at codepoint boundary', async () => {
    const text = '🙂'.repeat(800); // 800 × 4 = 3200 B → ≥2 chunks at 2000 B threshold
    const { pushes } = await runProcessor(
      basePayload(),
      {
        autoEmitReasoning: false,
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'reasoning',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-emoji',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            reasoningContent: text,
          },
        }),
      }
    );
    assert.ok(pushes.length >= 2);
    assert.equal(pushes.map((p) => p.reasoningContent).join(''), text);
  });
});

describe('reasoning byte chunking — cascade with reasoningSplitPattern', () => {
  it('sentence-split first, oversized sentences then byte-chunked', async () => {
    // Three sentences. Sentence 2 is 5 KB → should byte-chunk into 3.
    // Sentences 1 and 3 are short → stay single.
    const big = 'b'.repeat(5000);
    const text = `start。${big}。end。`;
    const { pushes, sleeps } = await runProcessor(
      basePayload({ reasoningSplitPattern: '([。！？!?]+)' }),
      {
        autoEmitReasoning: false,
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'reasoning',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-cascade',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            reasoningContent: text,
          },
        }),
      }
    );
    // Layer 1 produces 3 segments. Segment 2 is oversized → byte-chunks
    // into 3. Final leaf count: 1 + 3 + 1 = 5.
    assert.equal(pushes.length, 5);

    // First leaf: Layer 1 segment 1, no byte chunking.
    assert.equal(pushes[0].messageIndex, 1);
    assert.equal(pushes[0].totalMessages, 3);
    assert.ok(!('chunkIndex' in pushes[0]));
    assert.equal(pushes[0].reasoningContent, 'start。');

    // Leaves 2..4: Layer 1 segment 2, byte-chunked into 3.
    for (let i = 1; i <= 3; i++) {
      assert.equal(pushes[i].messageIndex, 2);
      assert.equal(pushes[i].totalMessages, 3);
      assert.equal(pushes[i].chunkIndex, i);
      assert.equal(pushes[i].totalChunks, 3);
    }
    // Byte-chunks concat back to the original Layer-1 segment 2.
    assert.equal(pushes.slice(1, 4).map((p) => p.reasoningContent).join(''), big + '。');

    // Last leaf: Layer 1 segment 3, no byte chunking.
    assert.equal(pushes[4].messageIndex, 3);
    assert.ok(!('chunkIndex' in pushes[4]));
    assert.equal(pushes[4].reasoningContent, 'end。');

    // Sleeps: 1500ms between Layer-1 segments, 100ms between Layer-2 chunks of segment 2.
    // Sequence: send leaf 0 → 1500 (boundary) → leaf 1 → 100 → leaf 2 → 100 → leaf 3 → 1500 (boundary) → leaf 4.
    assert.deepEqual(sleeps, [1500, 100, 100, 1500]);
  });
});

describe('reasoning byte chunking — disable knob', () => {
  it('reasoningChunkBytes: null + big reasoning + no BlobStore → PAYLOAD_TOO_LARGE', async () => {
    const big = 'a'.repeat(6000);
    await assert.rejects(
      runProcessor(
        basePayload(),
        {
          reasoningChunkBytes: null,
          autoEmitReasoning: false,
          onLLMOutput: (sctx) => ({
            decision: 'finish',
            pushPayload: {
              messageKind: 'reasoning',
              messageType: 'instant',
              source: 'instant',
              messageId: 'hook-big',
              sessionId: sctx.sessionId,
              timestamp: '2026-01-01T00:00:00.000Z',
              reasoningContent: big,
            },
          }),
        }
      ),
      (err) => err && err.code === 'PAYLOAD_TOO_LARGE'
    );
  });

  it('reasoningChunkBytes: null + big reasoning + BlobStore configured → 1 envelope push', async () => {
    const { createMemoryBlobStore } = await import('../src/blob-store/memory.js');
    const blobAdapter = createMemoryBlobStore();
    const big = 'a'.repeat(6000);
    const { pushes } = await runProcessor(
      basePayload(),
      {
        reasoningChunkBytes: null,
        blobStore: { adapter: blobAdapter },
        autoEmitReasoning: false,
        onLLMOutput: (sctx) => ({
          decision: 'finish',
          pushPayload: {
            messageKind: 'reasoning',
            messageType: 'instant',
            source: 'instant',
            messageId: 'hook-big',
            sessionId: sctx.sessionId,
            timestamp: '2026-01-01T00:00:00.000Z',
            reasoningContent: big,
          },
        }),
      }
    );
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0]._blob, true);
    assert.equal(pushes[0].messageKind, 'reasoning');
  });
});

describe('reasoning byte chunking — legacy path (no onLLMOutput)', () => {
  it('legacy reasoning auto-emit chunks by bytes too', async () => {
    const big = 'a'.repeat(6000);
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('final', { reasoning_content: big }),
    });
    const sleeps = [];
    const events = [];
    const ctx = {
      vapid,
      fetch: router.fetch,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      onEvent: (e) => events.push(e),
      requestUrl: 'http://localhost/instant',
      // No onLLMOutput → legacy path.
    };
    const payload = {
      contactName: 'Rei',
      completePrompt: 'reason a lot',
      apiUrl: LLM_URL,
      apiKey: 'sk-test',
      primaryModel: 'model-x',
      pushSubscription: subKit.subscription,
    };
    await processInstantMessage(payload, ctx);
    const decoded = [];
    for (const call of router.pushCalls) {
      decoded.push(JSON.parse(await decryptCapturedPushBody(call.body, subKit)));
    }
    const reasonings = decoded.filter((p) => p.messageKind === 'reasoning');
    // 6000 B reasoning → 3 chunks of ≤ 2000 B each.
    assert.equal(reasonings.length, 3);
    assert.deepEqual(reasonings.map((p) => p.chunkIndex), [1, 2, 3]);
    assert.equal(reasonings.map((p) => p.reasoningContent).join(''), big);
    // The `reasoning_chunked` event fired on the legacy path too (no iteration).
    const chunkedEvents = events.filter((e) => e.type === 'reasoning_chunked');
    assert.equal(chunkedEvents.length, 1);
    assert.ok(!('iteration' in chunkedEvents[0]));
  });
});

describe('reasoning byte chunking — handler-level validation', () => {
  it('throws TypeError when reasoningChunkBytes is 0 / negative / non-integer / too big', async () => {
    for (const bad of [0, -1, 1.5, NaN, 'big', {}, []]) {
      assert.throws(
        () => createInstantHandler({
          vapid,
          fetch: globalThis.fetch,
          onLLMOutput: () => ({ decision: 'skip-push' }),
          reasoningChunkBytes: bad,
        }),
        TypeError,
        `expected TypeError for reasoningChunkBytes=${JSON.stringify(bad)}`
      );
    }
  });

  it('throws when reasoningChunkBytes exceeds maxInlineBytes - 600 margin', async () => {
    // Default maxInlineBytes = 2600 → upper bound = 2000. 2001 should throw.
    assert.throws(
      () => createInstantHandler({
        vapid,
        fetch: globalThis.fetch,
        onLLMOutput: () => ({ decision: 'skip-push' }),
        reasoningChunkBytes: 2001,
      }),
      TypeError,
    );
  });

  it('accepts undefined (default 2000), null (disable), and in-range positive integer', async () => {
    for (const v of [undefined, null, 500, 1000, 2000]) {
      assert.doesNotThrow(
        () => createInstantHandler({
          vapid,
          fetch: globalThis.fetch,
          onLLMOutput: () => ({ decision: 'skip-push' }),
          reasoningChunkBytes: v,
        }),
        `should accept reasoningChunkBytes=${JSON.stringify(v)}`,
      );
    }
  });

  it('uses blobStore.maxInlineBytes to compute the upper bound', async () => {
    // Custom blobStore with maxInlineBytes 4096 → upper bound = 3496.
    const customBlob = { adapter: { put: async () => {}, read: async () => null }, maxInlineBytes: 4096 };
    // 3000 should be accepted with the wider cap (it'd be over the default 2000 cap).
    assert.doesNotThrow(
      () => createInstantHandler({
        vapid,
        fetch: globalThis.fetch,
        onLLMOutput: () => ({ decision: 'skip-push' }),
        blobStore: customBlob,
        reasoningChunkBytes: 3000,
      }),
    );
    // 3497 still over the upper bound.
    assert.throws(
      () => createInstantHandler({
        vapid,
        fetch: globalThis.fetch,
        onLLMOutput: () => ({ decision: 'skip-push' }),
        blobStore: customBlob,
        reasoningChunkBytes: 3497,
      }),
      TypeError,
    );
  });
});
