import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processSingleMessage, normalizeAiApiUrl } from '../src/server/lib/message-processor.js';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { validateScheduleMessagePayload, validateLlmMessagesArray, validateSplitPattern } from '../src/server/lib/validation.js';

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
      apiUrl: 'https://api.example.com/v1/chat/completions',
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

  it('auto-completes a bare host to /v1/chat/completions before calling fetch', async () => {
    const task = createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      completePrompt: 'say hi',
      apiUrl: 'https://api.example.com',
      apiKey: 'secret',
      primaryModel: 'model-x',
      pushSubscription: { endpoint: 'https://push.example.com/sub' }
    });

    const calledUrls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calledUrls.push(url);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'ok' } }] };
        }
      };
    };

    try {
      const result = await processSingleMessage(task, createContext());
      assert.equal(result.success, true);
      assert.equal(calledUrls[0], 'https://api.example.com/v1/chat/completions');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('auto-appends /chat/completions when apiUrl ends in /v1 (no double v1)', async () => {
    const task = createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      completePrompt: 'say hi',
      apiUrl: 'https://api.example.com/v1',
      apiKey: 'secret',
      primaryModel: 'model-x',
      pushSubscription: { endpoint: 'https://push.example.com/sub' }
    });

    const calledUrls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calledUrls.push(url);
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'ok' } }] };
        }
      };
    };

    try {
      const result = await processSingleMessage(task, createContext());
      assert.equal(result.success, true);
      assert.equal(calledUrls[0], 'https://api.example.com/v1/chat/completions');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Direct unit coverage for normalizeAiApiUrl. Keep these in lockstep with
// `@rei-standard/amsg-instant`'s url-and-cors.test.mjs.
describe('normalizeAiApiUrl', () => {
  it('appends /v1/chat/completions for a bare host', () => {
    assert.equal(
      normalizeAiApiUrl('https://api.openai.com'),
      'https://api.openai.com/v1/chat/completions'
    );
    assert.equal(
      normalizeAiApiUrl('https://api.openai.com/'),
      'https://api.openai.com/v1/chat/completions'
    );
  });

  it('appends only /chat/completions when path ends in /vN', () => {
    assert.equal(
      normalizeAiApiUrl('https://api.openai.com/v1'),
      'https://api.openai.com/v1/chat/completions'
    );
    assert.equal(
      normalizeAiApiUrl('https://my.proxy.com/openai/v2'),
      'https://my.proxy.com/openai/v2/chat/completions'
    );
  });

  it('leaves a full chat/completions URL untouched', () => {
    const full = 'https://api.openai.com/v1/chat/completions';
    assert.equal(normalizeAiApiUrl(full), full);
  });

  it('is idempotent', () => {
    for (const input of [
      'https://api.openai.com',
      'https://api.openai.com/v1',
      'https://api.openai.com/v1/chat/completions',
      'https://my.proxy.com/openai/v2',
    ]) {
      assert.equal(normalizeAiApiUrl(normalizeAiApiUrl(input)), normalizeAiApiUrl(input));
    }
  });

  it('preserves the query string', () => {
    assert.equal(
      normalizeAiApiUrl('https://api.openai.com/v1?beta=1'),
      'https://api.openai.com/v1/chat/completions?beta=1'
    );
  });

  it('leaves custom non-OpenAI paths untouched', () => {
    assert.equal(
      normalizeAiApiUrl('https://api.anthropic.com/v1/messages'),
      'https://api.anthropic.com/v1/messages'
    );
    assert.equal(
      normalizeAiApiUrl('https://my.proxy.com/openai/api/chat'),
      'https://my.proxy.com/openai/api/chat'
    );
  });

  it('rejects empty or invalid input', () => {
    assert.throws(() => normalizeAiApiUrl(''), /required/);
    assert.throws(() => normalizeAiApiUrl('not-a-url'), /Invalid apiUrl/);
  });
});

// ─── messages array (v2.2.0) — parity with @rei-standard/amsg-instant ──
describe('messages array support', () => {
  function basePromptedPayload(overrides = {}) {
    return {
      contactName: 'Rei',
      messageType: 'prompted',
      firstSendTime: new Date(Date.now() + 60_000).toISOString(),
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'secret',
      primaryModel: 'model-x',
      pushSubscription: { endpoint: 'https://push.example.com/sub', keys: { p256dh: 'p', auth: 'a' } },
      ...overrides,
    };
  }

  it('validation: accepts completePrompt only', () => {
    const result = validateScheduleMessagePayload(basePromptedPayload({ completePrompt: 'say hi' }));
    assert.equal(result.valid, true);
  });

  it('validation: accepts messages only', () => {
    const result = validateScheduleMessagePayload(basePromptedPayload({
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    }));
    assert.equal(result.valid, true);
  });

  it('validation: rejects when both completePrompt and messages are provided', () => {
    const result = validateScheduleMessagePayload(basePromptedPayload({
      completePrompt: 'hi',
      messages: [{ role: 'user', content: 'hi' }],
    }));
    assert.equal(result.valid, false);
    assert.match(result.errorMessage, /exactly one|两者不能同时/);
  });

  it('validation: rejects when neither prompt source is provided for prompted type', () => {
    const result = validateScheduleMessagePayload(basePromptedPayload());
    assert.equal(result.valid, false);
    assert.match(result.errorMessage, /缺少必需参数/);
  });

  it('validation: rejects messages with invalid role', () => {
    const result = validateScheduleMessagePayload(basePromptedPayload({
      messages: [{ role: 'robot', content: 'hi' }],
    }));
    assert.equal(result.valid, false);
    assert.match(result.errorMessage, /role/);
  });

  it('validation: rejects empty messages array', () => {
    const result = validateScheduleMessagePayload(basePromptedPayload({ messages: [] }));
    assert.equal(result.valid, false);
    assert.match(result.errorMessage, /non-empty/);
  });

  it('validation: accepts optional temperature, rejects non-number', () => {
    const ok = validateScheduleMessagePayload(basePromptedPayload({
      completePrompt: 'hi', temperature: 0.3,
    }));
    assert.equal(ok.valid, true);

    const bad = validateScheduleMessagePayload(basePromptedPayload({
      completePrompt: 'hi', temperature: 'hot',
    }));
    assert.equal(bad.valid, false);
  });

  it('validateLlmMessagesArray: accepts string and non-empty array content', () => {
    assert.equal(validateLlmMessagesArray([{ role: 'user', content: 'hi' }]), null);
    assert.equal(validateLlmMessagesArray([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]), null);
  });

  it('validateLlmMessagesArray: rejects empty string / empty array / wrong type', () => {
    assert.match(validateLlmMessagesArray([{ role: 'user', content: '' }]), /non-empty string/);
    assert.match(validateLlmMessagesArray([{ role: 'user', content: [] }]), /non-empty/);
    assert.match(validateLlmMessagesArray([{ role: 'user', content: 42 }]), /non-empty/);
  });

  it('LLM call: forwards messages array verbatim (no role injection)', async () => {
    const messages = [
      { role: 'system', content: 'you are Rei' },
      { role: 'user', content: 'multi-turn' },
      { role: 'assistant', content: 'sure' },
      { role: 'user', content: 'continue' },
    ];
    const task = createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      messages,
      temperature: 0.42,
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'secret',
      primaryModel: 'model-x',
      pushSubscription: { endpoint: 'https://push.example.com/sub' },
    });

    const requestBodies = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'ok' } }] };
        },
      };
    };

    try {
      const result = await processSingleMessage(task, createContext());
      assert.equal(result.success, true);
      assert.deepEqual(requestBodies[0].messages, messages);
      assert.equal(requestBodies[0].temperature, 0.42);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('LLM call: legacy completePrompt path still wraps and defaults temperature 0.8', async () => {
    const task = createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      completePrompt: 'legacy hi',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'secret',
      primaryModel: 'model-x',
      pushSubscription: { endpoint: 'https://push.example.com/sub' },
    });

    const requestBodies = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'ok' } }] };
        },
      };
    };

    try {
      const result = await processSingleMessage(task, createContext());
      assert.equal(result.success, true);
      assert.deepEqual(requestBodies[0].messages, [{ role: 'user', content: 'legacy hi' }]);
      assert.equal(requestBodies[0].temperature, 0.8);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('LLM call: messages mode does NOT inject default temperature when caller omits it', async () => {
    const task = createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      messages: [{ role: 'user', content: 'hi' }],
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'secret',
      primaryModel: 'model-x',
      pushSubscription: { endpoint: 'https://push.example.com/sub' },
    });

    const requestBodies = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return {
        ok: true,
        async json() {
          return { choices: [{ message: { content: 'ok' } }] };
        },
      };
    };

    try {
      const result = await processSingleMessage(task, createContext());
      assert.equal(result.success, true);
      assert.equal(Object.hasOwn(requestBodies[0], 'temperature'), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─── splitPattern (v2.3.0) — parity with @rei-standard/amsg-instant ────
describe('splitPattern support', () => {
  function basePayload(overrides = {}) {
    return {
      contactName: 'Rei',
      messageType: 'prompted',
      firstSendTime: new Date(Date.now() + 60_000).toISOString(),
      completePrompt: 'say hi',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'secret',
      primaryModel: 'model-x',
      pushSubscription: { endpoint: 'https://push.example.com/sub', keys: { p256dh: 'p', auth: 'a' } },
      ...overrides,
    };
  }

  it('validateSplitPattern: accepts absent / null / empty array', () => {
    assert.equal(validateSplitPattern(undefined), null);
    assert.equal(validateSplitPattern(null), null);
    assert.equal(validateSplitPattern([]), null);
  });

  it('validateSplitPattern: accepts string and string[]', () => {
    assert.equal(validateSplitPattern('([\\n]+)'), null);
    assert.equal(validateSplitPattern(['(\\n\\n+)', '([。！？!?]+)']), null);
  });

  it('validateSplitPattern: rejects non-string / array element non-string', () => {
    assert.match(validateSplitPattern(42), /必须是字符串/);
    assert.match(validateSplitPattern(['ok', 7]), /splitPattern\[1\]/);
  });

  it('validateSplitPattern: enforces per-item length and array size caps', () => {
    const long = 'a'.repeat(201);
    assert.match(validateSplitPattern(long), /200/);
    assert.match(
      validateSplitPattern(Array.from({ length: 11 }, () => '.')),
      /10/
    );
  });

  it('validateSplitPattern: rejects uncompilable regex source', () => {
    assert.match(validateSplitPattern('['), /正则|RegExp|regex/i);
    assert.match(validateSplitPattern(['(\\n+)', '[']), /splitPattern\[1\]/);
  });

  it('validation: accepts splitPattern in schedule payload', () => {
    const r = validateScheduleMessagePayload(basePayload({ splitPattern: '([\\n]+)' }));
    assert.equal(r.valid, true);
  });

  it('validation: rejects malformed splitPattern with INVALID_PARAMETERS', () => {
    const r = validateScheduleMessagePayload(basePayload({ splitPattern: '[' }));
    assert.equal(r.valid, false);
    assert.equal(r.errorCode, 'INVALID_PARAMETERS');
    assert.deepEqual(r.details.invalidFields, ['splitPattern']);
  });

  it('processSingleMessage: default regex when splitPattern absent (back-compat)', async () => {
    const task = createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      completePrompt: 'x',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 's',
      primaryModel: 'm',
      pushSubscription: { endpoint: 'https://push.example.com/sub' },
      // splitPattern intentionally omitted to simulate pre-2.3.0 stored task
    });

    const pushedMessages = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      async json() { return { choices: [{ message: { content: '你好。世界！再见？' } }] }; },
    });

    const ctx = createContext(async (_sub, payload) => {
      pushedMessages.push(JSON.parse(payload).message);
    });

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, true);
      assert.equal(result.messagesSent, 3);
      assert.deepEqual(pushedMessages, ['你好。', '世界！', '再见？']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('processSingleMessage: uses caller-supplied splitPattern (string)', async () => {
    const task = createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      completePrompt: 'x',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 's',
      primaryModel: 'm',
      pushSubscription: { endpoint: 'https://push.example.com/sub' },
      splitPattern: '([\\n]+)',
    });

    const pushedMessages = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      async json() { return { choices: [{ message: { content: '行一\n行二\n行三' } }] }; },
    });

    const ctx = createContext(async (_sub, payload) => {
      pushedMessages.push(JSON.parse(payload).message);
    });

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, true);
      assert.equal(result.messagesSent, 3);
      assert.deepEqual(pushedMessages, ['行一\n', '行二\n', '行三']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('processSingleMessage: cascades string[] splitPattern in order', async () => {
    const task = createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      completePrompt: 'x',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 's',
      primaryModel: 'm',
      pushSubscription: { endpoint: 'https://push.example.com/sub' },
      splitPattern: ['(\\n\\n+)', '([。！？!?]+)'],
    });

    const pushedMessages = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: '段一句一。段一句二。\n\n段二句一。' } }] };
      },
    });

    const ctx = createContext(async (_sub, payload) => {
      pushedMessages.push(JSON.parse(payload).message);
    });

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, true);
      assert.equal(result.messagesSent, 3);
      assert.deepEqual(pushedMessages, ['段一句一。', '段一句二。', '段二句一。']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
