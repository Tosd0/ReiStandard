import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInstantHandler,
  splitMessageIntoSentences,
  validateInstantPayload
} from '../src/index.js';

function makeRequest({ body, headers = {}, method = 'POST' } = {}) {
  const defaultHeaders = { 'content-type': 'application/json' };
  return new Request('http://localhost/instant', {
    method,
    headers: { ...defaultHeaders, ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  });
}

function makeValidPayload(overrides = {}) {
  return {
    contactName: 'Rei',
    completePrompt: 'say hi briefly',
    apiUrl: 'https://api.example.com/v1/chat/completions',
    apiKey: 'sk-test',
    primaryModel: 'model-x',
    pushSubscription: {
      endpoint: 'https://push.example.com/sub',
      keys: { p256dh: 'aaa', auth: 'bbb' }
    },
    ...overrides
  };
}

function makeMockWebpush(sendNotificationImpl) {
  const calls = [];
  return {
    calls,
    mod: {
      setVapidDetails() {},
      async sendNotification(sub, payload) {
        calls.push({ sub, payload: JSON.parse(payload) });
        if (sendNotificationImpl) return sendNotificationImpl(sub, payload);
      }
    }
  };
}

function makeMockFetch(handler) {
  return async (url, options) => handler(url, options);
}

function llmReply(content) {
  return makeMockFetch(async () => ({
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content } }] };
    }
  }));
}

const validVapid = {
  email: 'vapid@example.com',
  publicKey: 'public-key',
  privateKey: 'private-key'
};

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

  it('rejects missing completePrompt', () => {
    const p = makeValidPayload();
    delete p.completePrompt;
    const result = validateInstantPayload(p);
    assert.equal(result.valid, false);
    assert.match(result.errorMessage, /completePrompt/);
  });

  it('rejects invalid maxTokens', () => {
    const result = validateInstantPayload(makeValidPayload({ maxTokens: -1 }));
    assert.equal(result.valid, false);
  });

  it('accepts maxTokens null/undefined', () => {
    assert.equal(validateInstantPayload(makeValidPayload({ maxTokens: null })).valid, true);
    assert.equal(validateInstantPayload(makeValidPayload({ maxTokens: undefined })).valid, true);
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
});

// ─── Handler: request validation ───────────────────────────────────────

describe('createInstantHandler — request validation', () => {
  it('rejects non-POST methods', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      webpush: makeMockWebpush().mod
    });
    const res = await handler(new Request('http://localhost/instant', { method: 'GET' }));
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
  });

  it('rejects non-JSON body', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      webpush: makeMockWebpush().mod
    });
    const req = makeRequest({ body: 'not json {' });
    const res = await handler(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_PAYLOAD_FORMAT');
  });

  it('rejects payload missing required fields', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      webpush: makeMockWebpush().mod
    });
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
    const webpush = makeMockWebpush();
    const handler = createInstantHandler({
      vapid: validVapid,
      webpush: webpush.mod,
      fetch: llmReply('hi.')
    });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 200);
  });

  it('returns 401 INVALID_CLIENT_TOKEN when header missing', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      webpush: makeMockWebpush().mod,
      clientToken: 'shared-secret-xyz'
    });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_CLIENT_TOKEN');
  });

  it('returns 401 INVALID_CLIENT_TOKEN when header mismatches', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      webpush: makeMockWebpush().mod,
      clientToken: 'shared-secret-xyz'
    });
    const res = await handler(makeRequest({
      body: makeValidPayload(),
      headers: { 'x-client-token': 'wrong-token' }
    }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_CLIENT_TOKEN');
  });

  it('returns 200 when header matches clientToken', async () => {
    const webpush = makeMockWebpush();
    const handler = createInstantHandler({
      vapid: validVapid,
      webpush: webpush.mod,
      clientToken: 'shared-secret-xyz',
      fetch: llmReply('matched.')
    });
    const res = await handler(makeRequest({
      body: makeValidPayload(),
      headers: { 'x-client-token': 'shared-secret-xyz' }
    }));
    assert.equal(res.status, 200);
    assert.equal(webpush.calls.length, 1);
  });
});

// ─── Handler: happy path & push payload contract ──────────────────────

describe('createInstantHandler — happy path & push payload contract', () => {
  it('parses plaintext, calls LLM, splits, pushes, and returns 200', async () => {
    const webpush = makeMockWebpush();
    const handler = createInstantHandler({
      vapid: validVapid,
      webpush: webpush.mod,
      fetch: llmReply('你好。今天好天气！')
    });

    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.messagesSent, 2);
    assert.match(body.data.sentAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(webpush.calls.length, 2);

    const first = webpush.calls[0].payload;
    assert.equal(first.title, '来自 Rei');
    assert.equal(first.message, '你好。');
    assert.equal(first.contactName, 'Rei');
    assert.match(first.messageId, /^msg_[0-9a-f-]+_instant_0$/);
    assert.equal(first.messageIndex, 1);
    assert.equal(first.totalMessages, 2);
    assert.equal(first.messageType, 'instant');
    assert.equal(first.messageSubtype, 'chat');
    assert.equal(first.taskId, null);
    assert.equal(first.source, 'instant');
    assert.equal(first.avatarUrl, null);
    assert.deepEqual(first.metadata, {});
    assert.match(first.timestamp, /^\d{4}-\d{2}-\d{2}T/);

    const second = webpush.calls[1].payload;
    assert.equal(second.messageIndex, 2);
    assert.match(second.messageId, /^msg_[0-9a-f-]+_instant_1$/);
  });

  it('returns LLM_CALL_FAILED on upstream error', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      webpush: makeMockWebpush().mod,
      fetch: makeMockFetch(async () => ({ ok: false, status: 500, statusText: 'oops' }))
    });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'LLM_CALL_FAILED');
  });

  it('returns PUSH_SEND_FAILED on web-push error', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      webpush: {
        setVapidDetails() {},
        async sendNotification() {
          const err = new Error('push gateway 410');
          err.statusCode = 410;
          throw err;
        }
      },
      fetch: llmReply('one sentence')
    });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PUSH_SEND_FAILED');
  });

  it('rejects request when tokenSigningKey is set but Authorization missing', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      tokenSigningKey: 'signing-secret',
      webpush: makeMockWebpush().mod
    });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'UNAUTHORIZED');
  });
});

describe('createInstantHandler — VAPID config', () => {
  it('returns VAPID_CONFIG_ERROR when vapid keys are missing', async () => {
    const handler = createInstantHandler({
      vapid: { email: '', publicKey: '', privateKey: '' },
      webpush: makeMockWebpush().mod
    });
    const res = await handler(makeRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, 'VAPID_CONFIG_ERROR');
  });
});
