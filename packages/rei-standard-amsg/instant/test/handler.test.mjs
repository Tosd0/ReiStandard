import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInstantHandler,
  validateInstantPayload,
} from '../src/index.js';
import {
  generateTestVapid,
  generateTestSubscription,
  createFetchRouter,
  decryptCapturedPushBody,
  makeLlmResponse,
  consumeSse,
} from './helpers.mjs';

const ACCEPT_JSON = { accept: 'application/json' };

const LLM_URL = 'https://api.example.com/v1/chat/completions';

let vapid;
let subKit;

before(async () => {
  vapid = await generateTestVapid();
  subKit = await generateTestSubscription();
});

function makeRequest({ body, headers = {}, method = 'POST' } = {}) {
  const defaultHeaders = { 'content-type': 'application/json' };
  return new Request('http://localhost/instant', {
    method,
    headers: { ...defaultHeaders, ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function makeValidPayload(overrides = {}) {
  return {
    contactName: 'Rei',
    completePrompt: 'say hi briefly',
    apiUrl: LLM_URL,
    apiKey: 'sk-test',
    primaryModel: 'model-x',
    pushSubscription: subKit.subscription,
    ...overrides,
  };
}

function llmRouter(content) {
  return createFetchRouter({
    pushEndpoint: subKit.subscription.endpoint,
    llm: async () => makeLlmResponse(content),
  });
}

// ─── Unit: validation ──────────────────────────────────────────────────

describe('validateInstantPayload', () => {
  it('accepts a minimal valid payload', () => {
    const result = validateInstantPayload(makeValidPayload());
    assert.equal(result.valid, true);
  });

  it('rejects firstSendTime (scheduled-only field)', () => {
    const result = validateInstantPayload(
      makeValidPayload({ firstSendTime: new Date().toISOString() })
    );
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'INVALID_PAYLOAD_FORMAT');
    assert.match(result.errorMessage, /firstSendTime/);
  });

  it('rejects recurrenceType other than "none"', () => {
    const result = validateInstantPayload(makeValidPayload({ recurrenceType: 'daily' }));
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, 'INVALID_PAYLOAD_FORMAT');
  });

  it('rejects messageType other than instant', () => {
    const result = validateInstantPayload(makeValidPayload({ messageType: 'fixed' }));
    assert.equal(result.valid, false);
  });

  it('rejects when both completePrompt and messages are missing', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    const result = validateInstantPayload(p);
    assert.equal(result.valid, false);
    assert.match(result.errorMessage, /completePrompt.*messages|messages.*completePrompt/);
  });

  it('rejects invalid maxTokens', () => {
    const result = validateInstantPayload(makeValidPayload({ maxTokens: -1 }));
    assert.equal(result.valid, false);
  });

  it('accepts maxTokens null/undefined', () => {
    assert.equal(validateInstantPayload(makeValidPayload({ maxTokens: null })).valid, true);
    assert.equal(validateInstantPayload(makeValidPayload({ maxTokens: undefined })).valid, true);
  });

  // ── messages array support (0.5.0) ─────────────────────────────────
  it('accepts messages array (without completePrompt)', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    p.messages = [
      { role: 'system', content: 'you are Rei' },
      { role: 'user', content: 'say hi' },
    ];
    const result = validateInstantPayload(p);
    assert.equal(result.valid, true);
  });

  it('rejects when both completePrompt and messages are present', () => {
    const p = makeValidPayload({
      messages: [{ role: 'user', content: 'hi' }],
    });
    const result = validateInstantPayload(p);
    assert.equal(result.valid, false);
    assert.match(result.errorMessage, /completePrompt.*messages|exactly one/);
  });

  it('rejects empty messages array', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    p.messages = [];
    const result = validateInstantPayload(p);
    assert.equal(result.valid, false);
    assert.match(result.errorMessage, /messages/);
  });

  it('rejects messages with invalid role', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    p.messages = [{ role: 'human', content: 'hi' }];
    const result = validateInstantPayload(p);
    assert.equal(result.valid, false);
    assert.match(result.errorMessage, /role/);
  });

  it('rejects messages with empty string content', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    p.messages = [{ role: 'user', content: '' }];
    const result = validateInstantPayload(p);
    assert.equal(result.valid, false);
  });

  it('accepts messages with array content (multimodal future-proofing)', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    p.messages = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    assert.equal(validateInstantPayload(p).valid, true);
  });

  it('rejects messages content that is neither string nor array', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    p.messages = [{ role: 'user', content: 123 }];
    assert.equal(validateInstantPayload(p).valid, false);
  });

  // ── assistant tool_call carrier (OpenAI 协议: 带 tool_calls 时 content 可空) ──
  it('accepts assistant + tool_calls + empty content string', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    p.messages = [
      { role: 'user', content: '搜小红书' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'xhs_browse', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"notes":[]}' },
    ];
    assert.equal(validateInstantPayload(p).valid, true);
  });

  it('accepts assistant + tool_calls + null content', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    p.messages = [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } },
        ],
      },
    ];
    assert.equal(validateInstantPayload(p).valid, true);
  });

  it('accepts assistant + tool_calls + missing content key', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    p.messages = [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        tool_calls: [
          { id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } },
        ],
      },
    ];
    assert.equal(validateInstantPayload(p).valid, true);
  });

  it('rejects assistant with empty content AND empty tool_calls', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    p.messages = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', tool_calls: [] },
    ];
    const r = validateInstantPayload(p);
    assert.equal(r.valid, false);
    assert.match(r.errorMessage, /不能是空字符串/);
  });

  it('rejects assistant with malformed tool_calls entry', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    p.messages = [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c' }] }, // 缺 function
    ];
    const r = validateInstantPayload(p);
    assert.equal(r.valid, false);
    assert.match(r.errorMessage, /tool_calls\[0\] 形状非法/);
  });

  it('accepts tool message with empty-string content (空结果合法)', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    p.messages = [
      { role: 'user', content: 'x' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '' },
    ];
    assert.equal(validateInstantPayload(p).valid, true);
  });

  it('requires tool_call_id on tool messages', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    p.messages = [
      { role: 'user', content: 'x' },
      { role: 'tool', content: 'result' }, // 缺 tool_call_id
    ];
    const r = validateInstantPayload(p);
    assert.equal(r.valid, false);
    assert.match(r.errorMessage, /tool_call_id 必填/);
  });

  it('accepts optional temperature', () => {
    assert.equal(validateInstantPayload(makeValidPayload({ temperature: 0.3 })).valid, true);
    assert.equal(validateInstantPayload(makeValidPayload({ temperature: null })).valid, true);
  });

  it('rejects non-numeric temperature', () => {
    assert.equal(validateInstantPayload(makeValidPayload({ temperature: 'hot' })).valid, false);
  });

  // ── avatarUrl (0.6.1 → soft-strip in 0.7.1) ──────────────────────────
  it('accepts a normal https avatarUrl', () => {
    const payload = makeValidPayload({ avatarUrl: 'https://example.com/a.png' });
    const r = validateInstantPayload(payload);
    assert.equal(r.valid, true);
    assert.equal(payload.avatarUrl, 'https://example.com/a.png');
  });

  it('treats avatarUrl=null / undefined as absent', () => {
    assert.equal(validateInstantPayload(makeValidPayload({ avatarUrl: null })).valid, true);
    assert.equal(validateInstantPayload(makeValidPayload({ avatarUrl: undefined })).valid, true);
  });

  it('soft-strips data: avatarUrl and continues', () => {
    const payload = makeValidPayload({
      avatarUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQ',
    });
    const r = validateInstantPayload(payload);
    assert.equal(r.valid, true);
    assert.equal(payload.avatarUrl, null);
  });

  it('soft-strips uppercase DATA: avatarUrl (case-insensitive)', () => {
    const payload = makeValidPayload({ avatarUrl: 'DATA:image/png;base64,xxx' });
    const r = validateInstantPayload(payload);
    assert.equal(r.valid, true);
    assert.equal(payload.avatarUrl, null);
  });

  it('soft-strips avatarUrl longer than 2048 chars', () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2048);
    const payload = makeValidPayload({ avatarUrl: longUrl });
    const r = validateInstantPayload(payload);
    assert.equal(r.valid, true);
    assert.equal(payload.avatarUrl, null);
  });

  it('accepts avatarUrl exactly at the 2048 char limit', () => {
    const url = 'https://x/' + 'a'.repeat(2048 - 'https://x/'.length);
    assert.equal(url.length, 2048);
    const payload = makeValidPayload({ avatarUrl: url });
    const r = validateInstantPayload(payload);
    assert.equal(r.valid, true);
    assert.equal(payload.avatarUrl, url);
  });

  it('soft-strips avatarUrl that is not a string', () => {
    const payload = makeValidPayload({ avatarUrl: 123 });
    const r = validateInstantPayload(payload);
    assert.equal(r.valid, true);
    assert.equal(payload.avatarUrl, null);
  });

  it('soft-strips avatarUrl that is not a valid URL', () => {
    const payload = makeValidPayload({ avatarUrl: 'not a url' });
    const r = validateInstantPayload(payload);
    assert.equal(r.valid, true);
    assert.equal(payload.avatarUrl, null);
  });
});

describe('0.8.0 — split-pattern fields removed', () => {
  it('rejects request body splitPattern with INVALID_PAYLOAD_FORMAT', () => {
    const r = validateInstantPayload(makeValidPayload({ splitPattern: '([。！？!?]+)' }));
    assert.equal(r.valid, false);
    assert.equal(r.errorCode, 'INVALID_PAYLOAD_FORMAT');
    assert.match(r.errorMessage, /splitPattern is removed in 0\.8\.0/);
  });
  it('rejects request body reasoningSplitPattern', () => {
    const r = validateInstantPayload(makeValidPayload({ reasoningSplitPattern: '([。！？!?]+)' }));
    assert.equal(r.valid, false);
    assert.match(r.errorMessage, /reasoningSplitPattern is removed in 0\.8\.0/);
  });
  it('rejects request body errorSplitPattern', () => {
    const r = validateInstantPayload(makeValidPayload({ errorSplitPattern: '([。！？!?]+)' }));
    assert.equal(r.valid, false);
    assert.match(r.errorMessage, /errorSplitPattern is removed in 0\.8\.0/);
  });
});

// ─── Handler: request validation ───────────────────────────────────────

describe('createInstantHandler — request validation', () => {
  it('rejects non-POST methods', async () => {
    const handler = createInstantHandler({ vapid });
    const res = await handler(new Request('http://localhost/instant', { method: 'GET' }));
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
  });

  it('rejects non-JSON body', async () => {
    const handler = createInstantHandler({ vapid });
    const req = makeRequest({ body: 'not json {' });
    const res = await handler(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_PAYLOAD_FORMAT');
  });

  it('rejects payload missing required fields', async () => {
    const handler = createInstantHandler({ vapid });
    const req = makeRequest({ body: { contactName: 'only this' } });
    const res = await handler(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_PAYLOAD_FORMAT');
  });
});

// ─── Handler: clientToken weak auth ────────────────────────────────────

describe('createInstantHandler — clientToken', () => {
  it('opt-out (Accept: application/json): passes through when clientToken is not configured (open mode)', async () => {
    const router = llmRouter('hi.');
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(makeRequest({ body: makeValidPayload(), headers: ACCEPT_JSON }));
    assert.equal(res.status, 200);
    assert.equal(router.pushCalls.length, 1);
  });

  it('SSE (default): passes through when clientToken is not configured (open mode)', async () => {
    const router = llmRouter('hi.');
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const { payloads, doneReceived } = await consumeSse(res);
    assert.equal(payloads.length, 1);
    assert.equal(doneReceived, true);
    // SSE happy path must not fall back to Web Push.
    assert.equal(router.pushCalls.length, 0);
  });

  it('returns 401 INVALID_CLIENT_TOKEN when header missing', async () => {
    const handler = createInstantHandler({ vapid, clientToken: 'shared-secret-xyz' });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_CLIENT_TOKEN');
  });

  it('returns 401 INVALID_CLIENT_TOKEN when header mismatches', async () => {
    const handler = createInstantHandler({ vapid, clientToken: 'shared-secret-xyz' });
    const res = await handler(makeRequest({
      body: makeValidPayload(),
      headers: { 'x-client-token': 'wrong-token' },
    }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_CLIENT_TOKEN');
  });

  it('opt-out (Accept: application/json): returns 200 when header matches clientToken', async () => {
    const router = llmRouter('matched.');
    const handler = createInstantHandler({
      vapid,
      clientToken: 'shared-secret-xyz',
      fetch: router.fetch,
    });
    const res = await handler(makeRequest({
      body: makeValidPayload(),
      headers: { 'x-client-token': 'shared-secret-xyz', ...ACCEPT_JSON },
    }));
    assert.equal(res.status, 200);
    assert.equal(router.pushCalls.length, 1);
  });

  it('SSE (default): returns 200 stream when header matches clientToken', async () => {
    const router = llmRouter('matched.');
    const handler = createInstantHandler({
      vapid,
      clientToken: 'shared-secret-xyz',
      fetch: router.fetch,
    });
    const res = await handler(makeRequest({
      body: makeValidPayload(),
      headers: { 'x-client-token': 'shared-secret-xyz' },
    }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const { payloads, doneReceived } = await consumeSse(res);
    assert.equal(payloads.length, 1);
    assert.equal(doneReceived, true);
    assert.equal(router.pushCalls.length, 0);
  });
});

// ─── Handler: happy path & push delivery ──────────────────────────────

describe('createInstantHandler — happy path', () => {
  it('opt-out (Accept: application/json): parses plaintext, calls LLM, splits, pushes each sentence, returns 200', async () => {
    const router = llmRouter('你好。今天好天气！');
    const handler = createInstantHandler({ vapid, fetch: router.fetch });

    const res = await handler(makeRequest({ body: makeValidPayload(), headers: ACCEPT_JSON }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.messagesSent, 2);
    assert.match(body.data.sentAt, /^\d{4}-\d{2}-\d{2}T/);

    assert.equal(router.pushCalls.length, 2);
    for (const call of router.pushCalls) {
      assert.equal(call.headers['content-encoding'], 'aes128gcm');
      assert.equal(call.headers['content-type'], 'application/octet-stream');
      assert.match(call.headers['authorization'], /^vapid t=/);
      assert.match(call.headers['authorization'], new RegExp(`k=${vapid.publicKey}`));
    }
  });

  it('SSE (default): parses plaintext, calls LLM, splits, streams each sentence as event: payload, no Web Push', async () => {
    const router = llmRouter('你好。今天好天气！');
    const handler = createInstantHandler({ vapid, fetch: router.fetch });

    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const { payloads, doneReceived } = await consumeSse(res);
    assert.equal(doneReceived, true);
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].messageKind, 'content');
    assert.equal(payloads[0].message, '你好。');
    assert.equal(payloads[0].messageIndex, 1);
    assert.equal(payloads[1].message, '今天好天气！');
    assert.equal(payloads[1].messageIndex, 2);
    // Same sessionId across the stream.
    assert.equal(payloads[0].sessionId, payloads[1].sessionId);
    // SSE direct delivery — no Web Push fallback hit.
    assert.equal(router.pushCalls.length, 0);
  });

  it('opt-out (Accept: application/json): returns LLM_CALL_FAILED on upstream error', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async () => ({ ok: false, status: 500, statusText: 'oops' }),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(makeRequest({ body: makeValidPayload(), headers: ACCEPT_JSON }));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'LLM_CALL_FAILED');
    assert.equal(router.pushCalls.length, 0);
  });

  it('SSE (default): emits event: error with LLM_CALL_FAILED on upstream error', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async () => ({ ok: false, status: 500, statusText: 'oops' }),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    // SSE responses always 200 even on business errors — the error rides as event: error.
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
    const { payloads, errors } = await consumeSse(res);
    assert.equal(payloads.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'LLM_CALL_FAILED');
    assert.equal(errors[0].messageKind, 'error');
    assert.equal(router.pushCalls.length, 0);
  });

  it('opt-out (Accept: application/json): returns PUSH_SEND_FAILED when push gateway returns non-2xx', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async () => makeLlmResponse('one sentence'),
      onPush: () => new Response('gone', { status: 410, statusText: 'Gone' }),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(makeRequest({ body: makeValidPayload(), headers: ACCEPT_JSON }));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PUSH_SEND_FAILED');
  });

  it('SSE (default): push gateway failure is irrelevant — SSE writes succeed without fallback', async () => {
    // In SSE happy path, the push gateway is never touched. We still wire
    // it up as an always-failing endpoint to prove the handler does not
    // silently fall back; the test asserts zero push calls AND a clean stream.
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async () => makeLlmResponse('one sentence'),
      onPush: () => new Response('gone', { status: 410, statusText: 'Gone' }),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 200);
    const { payloads, errors, doneReceived } = await consumeSse(res);
    assert.equal(doneReceived, true);
    assert.equal(payloads.length, 1);
    assert.equal(errors.length, 0);
    assert.equal(router.pushCalls.length, 0);
  });

  it('rejects request when tokenSigningKey is set but Authorization missing', async () => {
    const handler = createInstantHandler({ vapid, tokenSigningKey: 'signing-secret' });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'UNAUTHORIZED');
  });
});

describe('createInstantHandler — messages array forwarding (0.5.0)', () => {
  function captureLlmBody() {
    const captured = {};
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async (_url, init) => {
        captured.body = JSON.parse(init.body);
        return makeLlmResponse('ok.');
      },
    });
    return { router, captured };
  }

  it('forwards messages array verbatim to LLM (no auto role injection)', async () => {
    const { router, captured } = captureLlmBody();
    const handler = createInstantHandler({ vapid, fetch: router.fetch });

    const messages = [
      { role: 'system', content: 'you are Rei' },
      { role: 'user', content: 'first user msg' },
      { role: 'assistant', content: 'first assistant reply' },
      { role: 'user', content: 'follow up' },
    ];
    const payload = makeValidPayload();
    delete payload.completePrompt;
    payload.messages = messages;
    payload.temperature = 0.42;

    const res = await handler(makeRequest({ body: payload }));
    assert.equal(res.status, 200);

    assert.deepEqual(captured.body.messages, messages);
    assert.equal(captured.body.model, 'model-x');
    assert.equal(captured.body.stream, false);
    assert.equal(captured.body.temperature, 0.42);
  });

  it('legacy completePrompt path still wraps into single user message', async () => {
    const { router, captured } = captureLlmBody();
    const handler = createInstantHandler({ vapid, fetch: router.fetch });

    const res = await handler(makeRequest({ body: makeValidPayload({ completePrompt: 'legacy hi' }) }));
    assert.equal(res.status, 200);

    assert.deepEqual(captured.body.messages, [{ role: 'user', content: 'legacy hi' }]);
    assert.equal(captured.body.stream, false);
  });

  it('handler rejects when both completePrompt and messages are present', async () => {
    const handler = createInstantHandler({ vapid });
    const res = await handler(makeRequest({
      body: makeValidPayload({ messages: [{ role: 'user', content: 'hi' }] }),
    }));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_PAYLOAD_FORMAT');
  });
});

describe('createInstantHandler — VAPID config', () => {
  it('returns VAPID_CONFIG_ERROR when vapid keys are missing', async () => {
    const handler = createInstantHandler({
      vapid: { email: '', publicKey: '', privateKey: '' },
    });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, 'VAPID_CONFIG_ERROR');
  });

  it('ignores deprecated options.webpush silently', async () => {
    const router = llmRouter('ok.');
    // Stub console.warn so the deprecation message doesn't litter test output
    // while still letting the handler run.
    const originalWarn = globalThis.console.warn;
    globalThis.console.warn = () => {};
    try {
      const handler = createInstantHandler({
        vapid,
        webpush: { iAm: 'ignored' },
        fetch: router.fetch,
      });
      const res = await handler(makeRequest({ body: makeValidPayload() }));
      assert.equal(res.status, 200);
    } finally {
      globalThis.console.warn = originalWarn;
    }
  });
});
