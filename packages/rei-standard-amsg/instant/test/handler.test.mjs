import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'crypto';

import {
  createInstantHandler,
  deriveUserEncryptionKey,
  splitMessageIntoSentences,
  validateInstantPayload
} from '../src/index.js';

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_MASTER_KEY = 'a'.repeat(64); // 64-char hex (32 bytes of entropy)

function encryptForTransport(payloadObj, userKeyHex) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(userKeyHex, 'hex'), iv);
  const plaintext = JSON.stringify(payloadObj);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    encryptedData: encrypted.toString('base64')
  };
}

function makeRequest({ body, headers = {} }) {
  const defaultHeaders = {
    'content-type': 'application/json',
    'x-user-id': TEST_USER_ID,
    'x-payload-encrypted': 'true',
    'x-encryption-version': '1'
  };
  return new Request('http://localhost/instant', {
    method: 'POST',
    headers: { ...defaultHeaders, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
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
    // The regex /([。！？!?]+)/ deliberately excludes `.` to match amsg-server.
    assert.deepEqual(result, ['Hello. World!', 'Done?']);
  });

  it('returns single-element array when no terminal punctuation', () => {
    const result = splitMessageIntoSentences('no terminal punctuation here');
    assert.deepEqual(result, ['no terminal punctuation here']);
  });
});

// ─── Handler: full request → response ──────────────────────────────────

describe('createInstantHandler — request validation', () => {
  it('rejects non-POST methods', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      masterKey: TEST_MASTER_KEY,
      webpush: makeMockWebpush().mod
    });
    const res = await handler(new Request('http://localhost/instant', { method: 'GET' }));
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
  });

  it('rejects unencrypted body', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      masterKey: TEST_MASTER_KEY,
      webpush: makeMockWebpush().mod
    });
    const req = makeRequest({ body: {}, headers: { 'x-payload-encrypted': 'false' } });
    const res = await handler(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'ENCRYPTION_REQUIRED');
  });

  it('rejects missing user id', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      masterKey: TEST_MASTER_KEY,
      webpush: makeMockWebpush().mod
    });
    const req = new Request('http://localhost/instant', {
      method: 'POST',
      headers: {
        'x-payload-encrypted': 'true',
        'x-encryption-version': '1'
      },
      body: '{}'
    });
    const res = await handler(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'USER_ID_REQUIRED');
  });

  it('rejects invalid user id format', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      masterKey: TEST_MASTER_KEY,
      webpush: makeMockWebpush().mod
    });
    const req = makeRequest({ body: {}, headers: { 'x-user-id': 'not-a-uuid' } });
    const res = await handler(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_USER_ID_FORMAT');
  });

  it('rejects unsupported encryption version', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      masterKey: TEST_MASTER_KEY,
      webpush: makeMockWebpush().mod
    });
    const req = makeRequest({ body: {}, headers: { 'x-encryption-version': '99' } });
    const res = await handler(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'UNSUPPORTED_ENCRYPTION_VERSION');
  });

  it('returns DECRYPTION_FAILED on bad ciphertext', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      masterKey: TEST_MASTER_KEY,
      webpush: makeMockWebpush().mod
    });
    const req = makeRequest({
      body: {
        iv: Buffer.alloc(12).toString('base64'),
        authTag: Buffer.alloc(16).toString('base64'),
        encryptedData: Buffer.alloc(8).toString('base64')
      }
    });
    const res = await handler(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'DECRYPTION_FAILED');
  });

  it('returns INVALID_PAYLOAD_FORMAT on missing envelope fields', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      masterKey: TEST_MASTER_KEY,
      webpush: makeMockWebpush().mod
    });
    const req = makeRequest({ body: { iv: 'only iv' } });
    const res = await handler(req);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_PAYLOAD_FORMAT');
  });
});

describe('createInstantHandler — happy path & push payload contract', () => {
  it('decrypts, calls LLM, splits, pushes, and returns 200', async () => {
    const userKey = deriveUserEncryptionKey(TEST_USER_ID, TEST_MASTER_KEY);
    const envelope = encryptForTransport(makeValidPayload(), userKey);

    const webpush = makeMockWebpush();
    const handler = createInstantHandler({
      vapid: validVapid,
      masterKey: TEST_MASTER_KEY,
      webpush: webpush.mod,
      fetch: makeMockFetch(async () => ({
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: '你好。今天好天气！' } }] };
        }
      }))
    });

    const req = makeRequest({ body: envelope });
    const res = await handler(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.data.messagesSent, 2);
    assert.match(body.data.sentAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(webpush.calls.length, 2);

    // ── Push payload shape MUST mirror amsg-server scheduled/instant ──
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
    const userKey = deriveUserEncryptionKey(TEST_USER_ID, TEST_MASTER_KEY);
    const envelope = encryptForTransport(makeValidPayload(), userKey);
    const handler = createInstantHandler({
      vapid: validVapid,
      masterKey: TEST_MASTER_KEY,
      webpush: makeMockWebpush().mod,
      fetch: makeMockFetch(async () => ({ ok: false, status: 500, statusText: 'oops' }))
    });
    const res = await handler(makeRequest({ body: envelope }));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'LLM_CALL_FAILED');
  });

  it('returns PUSH_SEND_FAILED on web-push error', async () => {
    const userKey = deriveUserEncryptionKey(TEST_USER_ID, TEST_MASTER_KEY);
    const envelope = encryptForTransport(makeValidPayload(), userKey);
    const handler = createInstantHandler({
      vapid: validVapid,
      masterKey: TEST_MASTER_KEY,
      webpush: {
        setVapidDetails() {},
        async sendNotification() {
          const err = new Error('push gateway 410');
          err.statusCode = 410;
          throw err;
        }
      },
      fetch: makeMockFetch(async () => ({
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'one sentence' } }] };
        }
      }))
    });
    const res = await handler(makeRequest({ body: envelope }));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PUSH_SEND_FAILED');
  });

  it('rejects request when tokenSigningKey is set but Authorization missing', async () => {
    const handler = createInstantHandler({
      vapid: validVapid,
      masterKey: TEST_MASTER_KEY,
      tokenSigningKey: 'signing-secret',
      webpush: makeMockWebpush().mod
    });
    const userKey = deriveUserEncryptionKey(TEST_USER_ID, TEST_MASTER_KEY);
    const envelope = encryptForTransport(makeValidPayload(), userKey);
    const res = await handler(makeRequest({ body: envelope }));
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'UNAUTHORIZED');
  });
});

describe('createInstantHandler — VAPID config', () => {
  it('returns VAPID_CONFIG_ERROR when vapid keys are missing', async () => {
    const handler = createInstantHandler({
      vapid: { email: '', publicKey: '', privateKey: '' },
      masterKey: TEST_MASTER_KEY,
      webpush: makeMockWebpush().mod
    });
    const userKey = deriveUserEncryptionKey(TEST_USER_ID, TEST_MASTER_KEY);
    const envelope = encryptForTransport(makeValidPayload(), userKey);
    const res = await handler(makeRequest({ body: envelope }));
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error.code, 'VAPID_CONFIG_ERROR');
  });
});
