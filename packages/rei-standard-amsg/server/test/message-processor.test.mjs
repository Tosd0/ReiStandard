import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processSingleMessage } from '../src/server/lib/message-processor.js';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_MASTER_KEY = 'a'.repeat(64);

function createEncryptedTask(payload) {
  const userKey = deriveUserEncryptionKey(TEST_USER_ID, TEST_MASTER_KEY);
  const encryptedPayload = encryptForStorage(JSON.stringify(payload), userKey);
  return {
    id: 1,
    user_id: TEST_USER_ID,
    encrypted_payload: encryptedPayload
  };
}

function createContext(sendNotificationSpy = async () => {}) {
  return {
    masterKey: TEST_MASTER_KEY,
    webpush: {
      async sendNotification(...args) {
        await sendNotificationSpy(...args);
      }
    },
    vapid: {
      email: 'vapid@example.com',
      publicKey: 'public',
      privateKey: 'private'
    },
    db: {}
  };
}

describe('message processor AI apiUrl handling', () => {
  it('normalizes trailing slashes before calling fetch', async () => {
    const task = createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      completePrompt: 'say hi',
      apiUrl: ' https://api.example.com/v1/chat/completions/// ',
      apiKey: 'secret',
      primaryModel: 'model-x',
      pushSubscription: { endpoint: 'https://push.example.com/sub' }
    });

    const calledUrls = [];
    const requestBodies = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (url, options) => {
      calledUrls.push(url);
      requestBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'hello world' } }] };
        }
      };
    };

    let pushedPayload = null;
    const ctx = createContext(async (_subscription, payload) => {
      pushedPayload = payload;
    });

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, true);
      assert.equal(calledUrls.length, 1);
      assert.equal(calledUrls[0], 'https://api.example.com/v1/chat/completions');
      assert.equal(Object.hasOwn(requestBodies[0], 'max_tokens'), false);
      assert.equal(typeof pushedPayload, 'string');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('passes max_tokens only when maxTokens is provided', async () => {
    const task = createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      completePrompt: 'say hi',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'secret',
      primaryModel: 'model-x',
      maxTokens: 256,
      pushSubscription: { endpoint: 'https://push.example.com/sub' }
    });

    const requestBodies = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'hello world' } }] };
        }
      };
    };

    const ctx = createContext();

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, true);
      assert.equal(requestBodies.length, 1);
      assert.equal(requestBodies[0].max_tokens, 256);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns a clear error when AI endpoint responds with 405', async () => {
    const task = createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      completePrompt: 'say hi',
      apiUrl: 'https://api.example.com',
      apiKey: 'secret',
      primaryModel: 'model-x',
      pushSubscription: { endpoint: 'https://push.example.com/sub' }
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: false,
      status: 405,
      statusText: 'Method Not Allowed'
    });

    const ctx = createContext();

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, false);
      assert.match(result.error, /405 Method Not Allowed/);
      assert.match(result.error, /full chat endpoint/);
      assert.match(result.error, /\/chat\/completions/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
