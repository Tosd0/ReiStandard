/**
 * v0.7 agentic-loop tests.
 *
 * Covers the hook path end-to-end without going through the
 * sentence-splitting v0.6 path — that one is exercised by
 * handler.test.mjs / e2e.test.mjs.
 *
 * Test design notes:
 *   - We never bring up a real LLM. `createFetchRouter` from
 *     helpers.mjs already intercepts the push endpoint; we extend
 *     it with `llm: () => makeLlmResponse(...)` so every call
 *     resolves deterministically.
 *   - Pushes are captured but never decrypted in this file; we
 *     verify *behaviour* (called or not, with what envelope shape)
 *     rather than re-checking the encryption round-trip (covered by
 *     webpush.test.mjs).
 *   - Each test builds a fresh handler so the `console.warn`
 *     splitPattern banner doesn't bleed across cases.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInstantHandler,
  HookError,
  PayloadTooLargeError,
  MemoryStoreFullError,
  processInstantMessage,
  validateContinuePayload,
  validateInstantPayload,
} from '../src/index.js';
import { createMemoryBlobStore } from '../src/blob-store/memory.js';
import {
  generateTestVapid,
  generateTestSubscription,
  createFetchRouter,
  decryptCapturedPushBody,
} from './helpers.mjs';

const LLM_URL = 'https://api.example.com/v1/chat/completions';

let vapid;
let subKit;

before(async () => {
  vapid = await generateTestVapid();
  subKit = await generateTestSubscription();
});

function makeLlmResponse(content, extra = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      const message = { role: 'assistant', content, ...extra };
      return { choices: [{ message }] };
    },
  };
}

function basePayload(overrides = {}) {
  return {
    contactName: 'Rei',
    messages: [{ role: 'user', content: 'kick the loop' }],
    apiUrl: LLM_URL,
    apiKey: 'sk-test',
    primaryModel: 'model-x',
    pushSubscription: subKit.subscription,
    sessionId: 'sess-abc',
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

// ─── decision: finish ───────────────────────────────────────────────────

describe('agentic loop — decision: finish', () => {
  it('pushes the hook-returned payload and returns finished', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('hi there'),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: (ctx) => ({
        decision: 'finish',
        pushPayloads: [{ type: 'custom', text: ctx.llmOutputText }],
      }),
    });
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, 'finished');
    assert.equal(router.pushCalls.length, 1);
    const decrypted = await decryptCapturedPushBody(router.pushCalls[0].body, subKit);
    const decoded = JSON.parse(decrypted);
    assert.equal(decoded.type, 'custom');
    assert.equal(decoded.text, 'hi there');
    // sendPushesSequentially auto-fills these on every push.
    assert.equal(decoded.messageIndex, 1);
    assert.equal(decoded.totalMessages, 1);
    assert.match(decoded.messageId, /^msg_[0-9a-f-]+_chunk_0$/);
  });
});

// ─── decision: tool-request ─────────────────────────────────────────────

describe('agentic loop — decision: tool-request', () => {
  it('pushes the tool-request payload and returns tool_requested', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('NEED_TOOL get_weather'),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: () => ({
        decision: 'tool-request',
        pushPayloads: [{ type: 'tool-request', tool: 'get_weather' }],
      }),
    });
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    const body = await res.json();
    assert.equal(body.data.status, 'tool_requested');
    assert.equal(router.pushCalls.length, 1);
  });
});

// ─── decision: continue (single round → finish) ─────────────────────────

describe('agentic loop — decision: continue → finish', () => {
  it('loops once then pushes finish; nextHistory replaces messages', async () => {
    let llmCalls = 0;
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse(`round-${++llmCalls}`),
    });
    let observedHistory;
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: (ctx) => {
        if (ctx.iteration === 0) {
          return {
            decision: 'continue',
            nextHistory: [
              ...ctx.messages,
              { role: 'user', content: 'reflect again' },
            ],
          };
        }
        observedHistory = ctx.messages;
        return { decision: 'finish', pushPayloads: [{ type: 'done' }] };
      },
    });
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    assert.equal(res.status, 200);
    assert.equal(llmCalls, 2);
    assert.equal(router.pushCalls.length, 1);
    // History on round 2 must contain: original user + round-1 assistant + injected user + round-2 assistant
    assert.equal(observedHistory.length, 4);
    assert.equal(observedHistory[0].role, 'user');
    assert.equal(observedHistory[1].role, 'assistant');
    assert.equal(observedHistory[1].content, 'round-1');
    assert.equal(observedHistory[2].content, 'reflect again');
    assert.equal(observedHistory[3].content, 'round-2');
  });
});

// ─── decision: skip-push ────────────────────────────────────────────────

describe('agentic loop — decision: skip-push', () => {
  it('returns skipped without pushing', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('nothing to push'),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: () => ({ decision: 'skip-push' }),
    });
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    const body = await res.json();
    assert.equal(body.data.status, 'skipped');
    assert.equal(router.pushCalls.length, 0);
  });
});

// ─── loop budget guard ──────────────────────────────────────────────────

describe('agentic loop — loop-exceeded', () => {
  it('caps at maxLoopIterations, emits diagnostic push, returns HTTP 200', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('again'),
    });
    const events = [];
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onEvent: (e) => events.push(e),
      maxLoopIterations: 3,
      onLLMOutput: (ctx) => ({ decision: 'continue', nextHistory: ctx.messages }),
    });
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, 'loop_exceeded');
    assert.equal(body.data.iteration, 3);
    const loopExceededEvent = events.find((e) => e.type === 'loop_exceeded');
    assert.ok(loopExceededEvent);
    assert.equal(router.pushCalls.length, 1);
    const decrypted = await decryptCapturedPushBody(router.pushCalls[0].body, subKit);
    const decoded = JSON.parse(decrypted);
    assert.equal(decoded.messageKind, 'error');
    assert.equal(decoded.code, 'LOOP_EXCEEDED');
    // Legacy {type:'error'} envelope is gone in 0.8.0.
    assert.equal('type' in decoded, false);
  });
});

// ─── hook throws / returns invalid decision ─────────────────────────────

describe('agentic loop — hook contract violations', () => {
  it('hook throw → emits hook_threw, pushes diagnostic, HTTP 500 with error:hook_threw', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('boom'),
    });
    const events = [];
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onEvent: (e) => events.push(e),
      onLLMOutput: () => { throw new Error('hook intentional fail'); },
    });
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.ok(events.find((e) => e.type === 'hook_threw'));
    assert.equal(router.pushCalls.length, 1);
    const decrypted = await decryptCapturedPushBody(router.pushCalls[0].body, subKit);
    const decoded = JSON.parse(decrypted);
    assert.equal(decoded.code, 'HOOK_THREW');
    assert.equal(decoded.messageKind, 'error');
    assert.equal('type' in decoded, false);
  });

  it('hook returns null → HookError path', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('whatever'),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: () => null,
    });
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
  });

  it('hook returns unknown decision tag → HookError path', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('whatever'),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: () => ({ decision: 'bogus' }),
    });
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
  });

  it('hook returns pushPayload with BigInt → HookError (not crash)', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('whatever'),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: () => ({
        decision: 'finish',
        pushPayloads: [{ type: 'finish', big: 1n }],
      }),
    });
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
  });
});

// ─── credentials must not leak into SessionContext ──────────────────────

describe('agentic loop — SessionContext does not expose credentials', () => {
  it('apiKey / pushSubscription / vapid are absent from ctx', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('check'),
    });
    let captured;
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: (ctx) => {
        captured = ctx;
        return { decision: 'finish', pushPayloads: [{ ok: true }] };
      },
    });
    await handler(makeRequest('http://h/instant', basePayload()));
    assert.equal('apiKey' in captured, false);
    assert.equal('apiUrl' in captured, false);
    assert.equal('primaryModel' in captured, false);
    assert.equal('pushSubscription' in captured, false);
    assert.equal('vapid' in captured, false);
  });
});

// ─── byte boundary for blob detour ──────────────────────────────────────

describe('sendPushWithMaybeBlob — byte boundary', () => {
  it('ASCII length 2600 → direct push; length 2601 → blob', async () => {
    const cases = [
      { len: 2600, expectBlob: false },
      { len: 2601, expectBlob: true },
    ];
    for (const { len, expectBlob } of cases) {
      const router = createFetchRouter({
        pushEndpoint: subKit.subscription.endpoint,
        llm: () => makeLlmResponse('x'),
      });
      const blobAdapter = createMemoryBlobStore();
      // Build a JSON string of *exactly* `len` UTF-8 bytes after the
      // sendPushesSequentially auto-fill mutates the push object.
      // Final shape: {"type":"x","p":"...","messageId":"msg_<uuid>_chunk_0","messageIndex":1,"totalMessages":1}
      // messageId is the only variable-width field; its UUID is 36 chars,
      // so messageId value length is `msg_`.length + 36 + `_chunk_0`.length = 48.
      const overhead = JSON.stringify({
        type: 'x',
        p: '',
        messageId: 'm'.repeat(48),
        messageIndex: 1,
        totalMessages: 1,
      }).length;
      const filler = 'a'.repeat(len - overhead);
      const handler = createInstantHandler({
        vapid,
        fetch: router.fetch,
        blobStore: { adapter: blobAdapter },
        onLLMOutput: () => ({
          decision: 'finish',
          pushPayloads: [{ type: 'x', p: filler }],
        }),
      });
      const res = await handler(makeRequest('http://h/instant', basePayload()));
      assert.equal(res.status, 200);
      assert.equal(router.pushCalls.length, 1, `len=${len}`);
      const decrypted = await decryptCapturedPushBody(router.pushCalls[0].body, subKit);
      const decoded = JSON.parse(decrypted);
      if (expectBlob) {
        assert.equal(decoded._blob, true, `len=${len} should have used blob`);
        assert.ok(decoded.key);
        assert.ok(decoded.url.endsWith(`/blob/${decoded.key}`));
      } else {
        assert.notEqual(decoded._blob, true, `len=${len} should have been inline`);
        assert.equal(decoded.type, 'x');
      }
    }
  });

  it('CJK payload uses UTF-8 bytes (not .length): triggers blob', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('x'),
    });
    const blobAdapter = createMemoryBlobStore();
    // 1000 Chinese characters = 1000 UTF-16 .length, ~3000 UTF-8 bytes —
    // exceeds the default 2600 cap.
    const cjk = '中'.repeat(1000);
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      blobStore: { adapter: blobAdapter },
      onLLMOutput: () => ({
        decision: 'finish',
        pushPayloads: [{ type: 'cjk', p: cjk }],
      }),
    });
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    assert.equal(res.status, 200);
    const decrypted = await decryptCapturedPushBody(router.pushCalls[0].body, subKit);
    assert.equal(JSON.parse(decrypted)._blob, true);
  });

  it('no blobStore + oversize payload → PayloadTooLargeError', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('x'),
    });
    const events = [];
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onEvent: (e) => events.push(e),
      onLLMOutput: () => ({
        decision: 'finish',
        pushPayloads: [{ type: 'big', p: 'a'.repeat(5000) }],
      }),
    });
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
    assert.ok(events.find((e) => e.type === 'payload_too_large'));
  });
});

// ─── /blob/:key endpoint ────────────────────────────────────────────────

describe('/blob/:key endpoint', () => {
  it('GET returns stored body with ACAO:* — multiple reads return same body', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('x'),
    });
    const blobAdapter = createMemoryBlobStore();
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      blobStore: { adapter: blobAdapter },
      onLLMOutput: () => ({
        decision: 'finish',
        pushPayloads: [{ type: 'big', p: 'a'.repeat(5000) }],
      }),
    });
    await handler(makeRequest('http://h/instant', basePayload()));
    const decrypted = await decryptCapturedPushBody(router.pushCalls[0].body, subKit);
    const envelope = JSON.parse(decrypted);
    assert.equal(envelope._blob, true);

    const blobReq1 = new Request(envelope.url, { method: 'GET' });
    const blobRes1 = await handler(blobReq1);
    assert.equal(blobRes1.status, 200);
    assert.equal(blobRes1.headers.get('Access-Control-Allow-Origin'), '*');
    const body1 = await blobRes1.json();
    assert.equal(body1.type, 'big');

    // Second read — must still succeed (non-destructive).
    const blobRes2 = await handler(new Request(envelope.url, { method: 'GET' }));
    assert.equal(blobRes2.status, 200);
    const body2 = await blobRes2.json();
    assert.deepEqual(body2, body1);
  });

  it('rejects non-UUIDv4 keys with 400', async () => {
    const handler = createInstantHandler({
      vapid,
      fetch: globalThis.fetch,
      blobStore: { adapter: createMemoryBlobStore() },
      onLLMOutput: () => ({ decision: 'skip-push' }),
    });
    const res = await handler(new Request('http://h/blob/not-a-uuid', { method: 'GET' }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'invalid_key');
  });

  it('returns 404 when not configured', async () => {
    const handler = createInstantHandler({
      vapid,
      fetch: globalThis.fetch,
      onLLMOutput: () => ({ decision: 'skip-push' }),
    });
    const res = await handler(new Request(
      'http://h/blob/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { method: 'GET' }
    ));
    assert.equal(res.status, 404);
  });

  it('returns 404 for missing/expired keys', async () => {
    const handler = createInstantHandler({
      vapid,
      fetch: globalThis.fetch,
      blobStore: { adapter: createMemoryBlobStore() },
      onLLMOutput: () => ({ decision: 'skip-push' }),
    });
    const res = await handler(new Request(
      'http://h/blob/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { method: 'GET' }
    ));
    assert.equal(res.status, 404);
  });
});

// ─── memory adapter full ────────────────────────────────────────────────

describe('memory adapter — capacity', () => {
  it('throws MemoryStoreFullError after maxEntries (no LRU eviction)', async () => {
    const adapter = createMemoryBlobStore({ maxEntries: 2 });
    await adapter.put('a', '1', 60);
    await adapter.put('b', '2', 60);
    await assert.rejects(
      () => adapter.put('c', '3', 60),
      (err) => err instanceof MemoryStoreFullError
    );
    // Existing keys remain readable.
    assert.equal(await adapter.read('a'), '1');
    assert.equal(await adapter.read('b'), '2');
  });

  it('multi-read in TTL returns same body each time', async () => {
    const adapter = createMemoryBlobStore();
    await adapter.put('k1', 'body-v', 60);
    assert.equal(await adapter.read('k1'), 'body-v');
    assert.equal(await adapter.read('k1'), 'body-v');
    assert.equal(await adapter.read('k1'), 'body-v');
  });

  it('honours TTL — read returns null after expiry', async () => {
    let now = 1_000_000;
    const adapter = createMemoryBlobStore({ now: () => now });
    await adapter.put('k', 'v', 60);
    assert.equal(await adapter.read('k'), 'v');
    now += 61_000;
    assert.equal(await adapter.read('k'), null);
  });
});

// ─── /continue endpoint ─────────────────────────────────────────────────

describe('/continue endpoint', () => {
  it('full round-trip: instant → tool-request → /continue → finish', async () => {
    let llmCalls = 0;
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse(`round-${++llmCalls}`),
    });
    let lastSessionId;
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: (ctx) => {
        lastSessionId = ctx.sessionId;
        if (ctx.iteration === 0) {
          return {
            decision: 'tool-request',
            pushPayloads: [{ type: 'tool-request', tool: 'fetch_x' }],
          };
        }
        return {
          decision: 'finish',
          pushPayloads: [{ type: 'finish', text: ctx.llmOutputText }],
        };
      },
    });

    // Round 1: /instant
    const res1 = await handler(makeRequest('http://h/instant', basePayload()));
    assert.equal(res1.status, 200);
    assert.equal(router.pushCalls.length, 1);

    // Round 2: /continue with sessionId + iteration: 1
    const continueBody = basePayload({
      sessionId: lastSessionId,
      iteration: 1,
      messages: [
        { role: 'user', content: 'kick the loop' },
        { role: 'assistant', content: 'round-1' },
        { role: 'tool', content: 'tool-result-here', tool_call_id: 'fake' },
      ],
    });
    const res2 = await handler(makeRequest('http://h/continue', continueBody));
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.data.status, 'finished');
    assert.equal(router.pushCalls.length, 2);
    assert.equal(llmCalls, 2);
  });

  it('rejects iteration ≥ maxLoopIterations', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('x'),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      maxLoopIterations: 5,
      onLLMOutput: () => ({ decision: 'skip-push' }),
    });
    const res = await handler(makeRequest('http://h/continue', basePayload({
      iteration: 5,
      messages: [{ role: 'user', content: 'hi' }],
    })));
    assert.equal(res.status, 400);
  });

  it('rejects completePrompt on /continue', async () => {
    const handler = createInstantHandler({
      vapid,
      fetch: globalThis.fetch,
      onLLMOutput: () => ({ decision: 'skip-push' }),
    });
    const body = basePayload();
    delete body.messages;
    body.completePrompt = 'do something';
    const res = await handler(makeRequest('http://h/continue', body));
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, 'COMPLETE_PROMPT_NOT_SUPPORTED_ON_HOOK_PATH');
  });

  it('rejects /continue with clear 400 when handler has no onLLMOutput', async () => {
    // Regression: without this guard the request would pass validation,
    // crash inside runAgenticLoop on `ctx.onLLMOutput(...)`, and ship the
    // operator a misleading HOOK_THREW for what is really a deploy
    // misconfiguration.
    const handler = createInstantHandler({ vapid, fetch: globalThis.fetch });
    const res = await handler(makeRequest('http://h/continue', basePayload({
      iteration: 1,
      messages: [{ role: 'user', content: 'x' }],
    })));
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, 'CONTINUE_NOT_AVAILABLE');
  });
});

// ─── hook-path rejection of completePrompt on /instant ──────────────────

describe('hook path — /instant validation', () => {
  it('rejects completePrompt when onLLMOutput is configured', async () => {
    const handler = createInstantHandler({
      vapid,
      fetch: globalThis.fetch,
      onLLMOutput: () => ({ decision: 'skip-push' }),
    });
    const body = basePayload({ completePrompt: 'hello' });
    delete body.messages;
    const res = await handler(makeRequest('http://h/instant', body));
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error.code, 'COMPLETE_PROMPT_NOT_SUPPORTED_ON_HOOK_PATH');
  });
});

// ─── validators direct ──────────────────────────────────────────────────

describe('validateContinuePayload direct', () => {
  it('accepts valid /continue body', () => {
    const r = validateContinuePayload(basePayload({
      iteration: 1,
      messages: [{ role: 'user', content: 'x' }],
    }));
    assert.equal(r.valid, true);
  });

  it('rejects missing sessionId', () => {
    const r = validateContinuePayload({});
    assert.equal(r.valid, false);
  });

  it('rejects negative iteration', () => {
    const r = validateContinuePayload(basePayload({
      iteration: -1,
      messages: [{ role: 'user', content: 'x' }],
    }));
    assert.equal(r.valid, false);
  });
});

describe('validateInstantPayload hookPath flag', () => {
  it('rejects completePrompt under hookPath:true', () => {
    const r = validateInstantPayload(
      {
        contactName: 'r',
        completePrompt: 'hi',
        apiUrl: LLM_URL,
        apiKey: 'k',
        primaryModel: 'm',
        pushSubscription: { endpoint: 'https://p/x' },
      },
      { hookPath: true }
    );
    assert.equal(r.valid, false);
    assert.equal(r.errorCode, 'COMPLETE_PROMPT_NOT_SUPPORTED_ON_HOOK_PATH');
  });

  it('accepts completePrompt under hookPath:false (default)', () => {
    const r = validateInstantPayload({
      contactName: 'r',
      completePrompt: 'hi',
      apiUrl: LLM_URL,
      apiKey: 'k',
      primaryModel: 'm',
      pushSubscription: { endpoint: 'https://p/x' },
    });
    assert.equal(r.valid, true);
  });
});

// ─── next.4 — decision contract: pushPayloads ──────────────────────────

describe('next.4 — decision contract: pushPayloads', () => {
  async function dispatchHookReturn(hookReturn) {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('llm answer'),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: () => hookReturn,
    });
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    return { res, body: await res.json(), router };
  }

  it('rejects singular pushPayload field with HookError + migration message', async () => {
    const { res, body } = await dispatchHookReturn({
      decision: 'finish',
      pushPayload: { messageKind: 'content', message: 'hi' },
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /pushPayload \(singular\) is removed in next\.4, use pushPayloads: \[yourPayload\]/);
  });

  it('rejects when BOTH pushPayload and pushPayloads are set', async () => {
    const { res, body } = await dispatchHookReturn({
      decision: 'finish',
      pushPayload: { messageKind: 'content', message: 'a' },
      pushPayloads: [{ messageKind: 'content', message: 'b' }],
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /pushPayload \(singular\) is removed in next\.4, use pushPayloads/);
  });

  it('rejects pushPayloads: [] (empty array)', async () => {
    const { res, body } = await dispatchHookReturn({
      decision: 'finish',
      pushPayloads: [],
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /use decision: skip-push to skip notification entirely/);
  });

  it('rejects a push that carries splitPattern', async () => {
    const { res, body } = await dispatchHookReturn({
      decision: 'finish',
      pushPayloads: [{ messageKind: 'content', message: 'hi', splitPattern: '([。！？!?]+)' }],
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /splitPattern is removed in next\.4/);
  });
});

// ─── next.4 — pushPayloads happy paths ─────────────────────────────────

describe('next.4 — pushPayloads happy paths', () => {
  it('sends N pushes from a 3-element pushPayloads array with messageIndex/totalMessages auto-fill', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('whatever'),
    });
    const sleeps = [];
    const result = await processInstantMessage(basePayload(), {
      vapid,
      fetch: router.fetch,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      onLLMOutput: () => ({
        decision: 'finish',
        pushPayloads: [
          { messageKind: 'content', message: 'first' },
          { messageKind: 'content', message: 'second' },
          { messageKind: 'content', message: 'third' },
        ],
      }),
      autoEmitReasoning: false,
      requestUrl: 'http://localhost/instant',
    });
    assert.equal(result.status, 'finished');
    assert.equal(router.pushCalls.length, 3);
    const decoded = [];
    for (const c of router.pushCalls) decoded.push(JSON.parse(await decryptCapturedPushBody(c.body, subKit)));
    assert.deepEqual(decoded.map(p => p.message), ['first', 'second', 'third']);
    assert.deepEqual(decoded.map(p => p.messageIndex), [1, 2, 3]);
    assert.deepEqual(decoded.map(p => p.totalMessages), [3, 3, 3]);
    // 1500 between push 1↔2 and 2↔3
    assert.deepEqual(sleeps, [1500, 1500]);
  });

  it('preserves hook-set messageId, overwrites caller-set messageIndex/totalMessages', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('whatever'),
    });
    await processInstantMessage(basePayload(), {
      vapid,
      fetch: router.fetch,
      sleep: () => Promise.resolve(),
      onLLMOutput: () => ({
        decision: 'finish',
        pushPayloads: [
          { messageKind: 'content', message: 'a', messageId: 'custom-id-1', messageIndex: 99, totalMessages: 99 },
          { messageKind: 'content', message: 'b' },
        ],
      }),
      autoEmitReasoning: false,
      requestUrl: 'http://localhost/instant',
    });
    const decoded = [];
    for (const c of router.pushCalls) decoded.push(JSON.parse(await decryptCapturedPushBody(c.body, subKit)));
    assert.equal(decoded[0].messageId, 'custom-id-1', 'caller messageId kept');
    assert.notEqual(decoded[1].messageId, decoded[0].messageId, 'auto messageId distinct');
    assert.equal(decoded[0].messageIndex, 1, 'lib overwrites caller messageIndex');
    assert.equal(decoded[0].totalMessages, 2, 'lib overwrites caller totalMessages');
    assert.equal(decoded[1].messageIndex, 2);
    assert.equal(decoded[1].totalMessages, 2);
  });

  it('mid-array push failure aborts remaining pushes, no final_pushed event', async () => {
    let pushIdx = 0;
    const events = [];
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('whatever'),
      pushHandler: () => {
        pushIdx++;
        if (pushIdx === 2) {
          return { ok: false, status: 502, statusText: 'Bad Gateway', async text() { return 'fail'; } };
        }
        return { ok: true, status: 201, async text() { return ''; } };
      },
    });
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
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'mid-array failure should propagate');
    assert.equal(pushIdx, 2, 'second push attempted, third skipped');
    assert.equal(events.some(e => e.type === 'final_pushed'), false, 'no final_pushed on partial delivery');
  });
});
