import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInstantHandler,
  splitMessageIntoSentences,
  validateInstantPayload,
} from '../src/index.js';
import {
  generateTestVapid,
  generateTestSubscription,
  createFetchRouter,
  makeLlmResponse,
} from './helpers.mjs';

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

  it('accepts optional temperature', () => {
    assert.equal(validateInstantPayload(makeValidPayload({ temperature: 0.3 })).valid, true);
    assert.equal(validateInstantPayload(makeValidPayload({ temperature: null })).valid, true);
  });

  it('rejects non-numeric temperature', () => {
    assert.equal(validateInstantPayload(makeValidPayload({ temperature: 'hot' })).valid, false);
  });

  // ── splitPattern (0.6.0) ───────────────────────────────────────────
  it('accepts splitPattern as a single string', () => {
    assert.equal(validateInstantPayload(makeValidPayload({ splitPattern: '([\\n]+)' })).valid, true);
  });

  it('accepts splitPattern as an array of strings (cascade)', () => {
    assert.equal(
      validateInstantPayload(makeValidPayload({ splitPattern: ['(\\n\\n+)', '([。！？!?]+)'] })).valid,
      true
    );
  });

  it('treats empty splitPattern array as absent (uses default)', () => {
    assert.equal(validateInstantPayload(makeValidPayload({ splitPattern: [] })).valid, true);
  });

  it('treats splitPattern=null as absent', () => {
    assert.equal(validateInstantPayload(makeValidPayload({ splitPattern: null })).valid, true);
  });

  it('rejects splitPattern array element that is not a string', () => {
    const r = validateInstantPayload(makeValidPayload({ splitPattern: ['ok', 123] }));
    assert.equal(r.valid, false);
    assert.match(r.errorMessage, /splitPattern\[1\]/);
  });

  it('rejects splitPattern item longer than 200 chars', () => {
    const long = 'a'.repeat(201);
    const r = validateInstantPayload(makeValidPayload({ splitPattern: long }));
    assert.equal(r.valid, false);
    assert.match(r.errorMessage, /200/);
  });

  it('rejects splitPattern array with more than 10 items', () => {
    const r = validateInstantPayload(makeValidPayload({
      splitPattern: Array.from({ length: 11 }, () => '.'),
    }));
    assert.equal(r.valid, false);
    assert.match(r.errorMessage, /10/);
  });

  it('rejects splitPattern that is not a valid RegExp source', () => {
    const r = validateInstantPayload(makeValidPayload({ splitPattern: '[' }));
    assert.equal(r.valid, false);
    assert.match(r.errorMessage, /正则|RegExp|regex/i);
  });

  it('rejects splitPattern array element that is not a valid RegExp', () => {
    const r = validateInstantPayload(makeValidPayload({ splitPattern: ['(\\n+)', '['] }));
    assert.equal(r.valid, false);
    assert.match(r.errorMessage, /splitPattern\[1\]/);
  });
});

// ─── Unit: sentence splitting ─────────────────────────────────────────

describe('splitMessageIntoSentences', () => {
  it('splits on Chinese punctuation', () => {
    const result = splitMessageIntoSentences('你好。今天天气真好！要带伞吗？');
    assert.deepEqual(result, ['你好。', '今天天气真好！', '要带伞吗？']);
  });

  it('splits on English ! and ? but NOT . (mirrors amsg-server regex)', () => {
    const result = splitMessageIntoSentences('Hello. World! Done?');
    assert.deepEqual(result, ['Hello. World!', 'Done?']);
  });

  it('returns single-element array when no terminal punctuation', () => {
    const result = splitMessageIntoSentences('no terminal punctuation here');
    assert.deepEqual(result, ['no terminal punctuation here']);
  });

  // ── splitPattern override (0.6.0) ──────────────────────────────────
  it('accepts a single splitPattern string and uses it instead of default', () => {
    const result = splitMessageIntoSentences('行一\n行二\n行三', '([\\n]+)');
    assert.deepEqual(result, ['行一\n', '行二\n', '行三']);
  });

  it('accepts splitPattern as a string[] cascade (paragraph → sentence)', () => {
    const result = splitMessageIntoSentences(
      '段一句一。段一句二。\n\n段二句一。',
      ['(\\n\\n+)', '([。！？!?]+)']
    );
    // Cascade:
    //   1. split by (\n\n+) → ['段一句一。段一句二。\n\n', '段二句一。']
    //   2. split each by ([。！？!?]+); the trailing \n\n in chunk 1 becomes an
    //      empty trimmed part and is dropped by the existing filter.
    assert.deepEqual(result, ['段一句一。', '段一句二。', '段二句一。']);
  });

  it('uses default when splitPattern is null / undefined / []', () => {
    const expected = ['你好。', '世界！'];
    assert.deepEqual(splitMessageIntoSentences('你好。世界！', null), expected);
    assert.deepEqual(splitMessageIntoSentences('你好。世界！', undefined), expected);
    assert.deepEqual(splitMessageIntoSentences('你好。世界！', []), expected);
  });

  it('falls back to [original] when splitPattern matches everything', () => {
    const result = splitMessageIntoSentences('abc', '.*');
    assert.deepEqual(result, ['abc']);
  });

  it('passes chunk through unchanged when cascade regex does not match', () => {
    // First regex matches nothing → chunk passed as-is to second regex which splits.
    const result = splitMessageIntoSentences('a.b.c', ['(z+)', '(\\.)']);
    assert.deepEqual(result, ['a.', 'b.', 'c']);
  });

  it('without a capture group, splitter does NOT re-attach delimiter (documented behavior)', () => {
    // No capture group → split() returns only text parts; reduce keeps even
    // indices and `arr[i+1]` is the next text chunk, not a delimiter — so we
    // see the documented quirk where every other chunk is concatenated.
    const result = splitMessageIntoSentences('a.b.c', '\\.');
    // 'a.b.c'.split(/\./) === ['a','b','c']; reduce picks i=0 and i=2.
    // i=0 → 'a' + arr[1] ('b') = 'ab'; i=2 → 'c' + undefined → 'c'.
    assert.deepEqual(result, ['ab', 'c']);
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
  it('passes through when clientToken is not configured (open mode)', async () => {
    const router = llmRouter('hi.');
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 200);
    assert.equal(router.pushCalls.length, 1);
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

  it('returns 200 when header matches clientToken', async () => {
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
    assert.equal(router.pushCalls.length, 1);
  });
});

// ─── Handler: happy path & push delivery ──────────────────────────────

describe('createInstantHandler — happy path', () => {
  it('parses plaintext, calls LLM, splits, pushes each sentence, returns 200', async () => {
    const router = llmRouter('你好。今天好天气！');
    const handler = createInstantHandler({ vapid, fetch: router.fetch });

    const res = await handler(makeRequest({ body: makeValidPayload() }));
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

  it('returns LLM_CALL_FAILED on upstream error', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async () => ({ ok: false, status: 500, statusText: 'oops' }),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'LLM_CALL_FAILED');
    assert.equal(router.pushCalls.length, 0);
  });

  it('returns PUSH_SEND_FAILED when push gateway returns non-2xx', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async () => makeLlmResponse('one sentence'),
      onPush: () => new Response('gone', { status: 410, statusText: 'Gone' }),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PUSH_SEND_FAILED');
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
