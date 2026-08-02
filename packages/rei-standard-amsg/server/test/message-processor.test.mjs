import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processSingleMessage, normalizeAiApiUrl } from '../src/server/lib/message-processor.js';
import { buildAiRequestBody } from '../src/server/lib/llm.js';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { validateScheduleMessagePayload, validateLlmMessagesArray, validateSplitPattern, validateAvatarUrl } from '../src/server/lib/validation.js';
import { encryptTestSubscription, withPushSubscriptionStore } from './helpers/push-subscription.mjs';

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_MASTER_KEY = 'a'.repeat(64);
// 用户级订阅：投递时从这里现读（任务行不携带订阅）。
const ENCRYPTED_PUSH_SUB = await encryptTestSubscription(TEST_USER_ID, TEST_MASTER_KEY);

async function createEncryptedTask(payload) {
  const userKey = await deriveUserEncryptionKey(TEST_USER_ID, TEST_MASTER_KEY);
  const encryptedPayload = await encryptForStorage(JSON.stringify(payload), userKey);
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
    db: withPushSubscriptionStore({}, ENCRYPTED_PUSH_SUB)
  };
}

describe('message processor AI apiUrl handling', () => {
  it('normalizes trailing slashes before calling fetch', async () => {
    const task = await createEncryptedTask({
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
    const task = await createEncryptedTask({
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
    const task = await createEncryptedTask({
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
    const task = await createEncryptedTask({
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
    const task = await createEncryptedTask({
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

  // agentic 会话回放（assistant 带 tool_calls + tool 结果）此前会被本包
  // 误拒 — 形状规则现统一在 @rei-standard/amsg-shared，与 amsg-instant 一致。
  it('validateLlmMessagesArray: accepts agentic tool_calls conversation', () => {
    const agentic = [
      { role: 'system', content: 'you are Rei' },
      { role: 'user', content: 'check my notes' },
      {
        role: 'assistant',
        content: null, // OpenAI 协议: 带 tool_calls 时 content 可为 null / 空串 / 缺省
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_notes', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"notes":[]}' },
      { role: 'assistant', content: 'no notes found' },
    ];
    assert.equal(validateLlmMessagesArray(agentic), null);

    // 整条 scheduleMessage 校验链同样放行（bug 场景：此前这里会 400）
    const result = validateScheduleMessagePayload(basePromptedPayload({ messages: agentic }));
    assert.equal(result.valid, true);
  });

  it('validateLlmMessagesArray: still rejects malformed tool shapes', () => {
    assert.match(
      validateLlmMessagesArray([{ role: 'assistant', content: '', tool_calls: [{ id: 'c' }] }]), // 缺 function
      /tool_calls\[0\] is malformed/
    );
    assert.match(
      validateLlmMessagesArray([{ role: 'tool', content: 'result' }]), // 缺 tool_call_id
      /tool_call_id is required/
    );
  });

  it('LLM call: forwards messages array verbatim (no role injection)', async () => {
    const messages = [
      { role: 'system', content: 'you are Rei' },
      { role: 'user', content: 'multi-turn' },
      { role: 'assistant', content: 'sure' },
      { role: 'user', content: 'continue' },
    ];
    const task = await createEncryptedTask({
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
    const task = await createEncryptedTask({
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
    const task = await createEncryptedTask({
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

  it('buildAiRequestBody forwards tools/tool_choice verbatim; absent when not provided', () => {
    const tools = [{ type: 'function', function: { name: 'mcp__x', parameters: { type: 'object' } } }];
    const withTools = buildAiRequestBody({
      primaryModel: 'm', messages: [{ role: 'user', content: 'hi' }], tools, toolChoice: 'auto',
    });
    assert.deepEqual(withTools.tools, tools);
    assert.equal(withTools.tool_choice, 'auto');

    const without = buildAiRequestBody({ primaryModel: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal('tools' in without, false);
    assert.equal('tool_choice' in without, false);

    // 空数组不透传：部分中转把 tools: [] 当协议错误直接拒掉
    const empty = buildAiRequestBody({ primaryModel: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [] });
    assert.equal('tools' in empty, false);
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
    const task = await createEncryptedTask({
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
    const task = await createEncryptedTask({
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

  it('processSingleMessage: emits ContentPush with messageKind/sessionId (v2.4.0 schema)', async () => {
    const task = await createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      completePrompt: 'x',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 's',
      primaryModel: 'm',
      pushSubscription: { endpoint: 'https://push.example.com/sub' },
    });

    const pushed = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      async json() { return { choices: [{ message: { content: '一句。二句！' } }] }; },
    });

    const ctx = createContext(async (_sub, payload) => {
      pushed.push(JSON.parse(payload));
    });

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, true);
      assert.equal(result.messagesSent, 2);
      assert.equal(pushed.length, 2);
      for (const p of pushed) {
        assert.equal(p.messageKind, 'content');
        assert.equal(p.source, 'scheduled');
        assert.equal(p.messageType, 'prompted');
        assert.match(p.sessionId, /^sess_task_/);
        // Legacy 0.7.x fields still present.
        assert.ok('title' in p);
        assert.ok('message' in p);
        assert.ok('messageIndex' in p);
        assert.ok('totalMessages' in p);
        assert.ok('messageId' in p);
        assert.ok('messageSubtype' in p);
        assert.ok('avatarUrl' in p);
        assert.ok('metadata' in p);
        assert.ok('taskId' in p);
      }
      // Same sessionId across both sentences from one LLM round.
      assert.equal(pushed[0].sessionId, pushed[1].sessionId);
      assert.equal(pushed[0].messageIndex, 1);
      assert.equal(pushed[1].messageIndex, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('processSingleMessage: auto-emits ReasoningPush before ContentPush when LLM returns reasoning_content', async () => {
    const task = await createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      completePrompt: 'x',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 's',
      primaryModel: 'm',
      pushSubscription: { endpoint: 'https://push.example.com/sub' },
    });

    const pushed = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: '回答。',
              reasoning_content: '先想想再回答',
            },
          }],
        };
      },
    });

    const ctx = createContext(async (_sub, payload) => {
      pushed.push(JSON.parse(payload));
    });

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, true);
      // messagesSent reflects sentence count, NOT reasoning + sentences.
      assert.equal(result.messagesSent, 1);
      // But on the wire there are 2 pushes: reasoning + content.
      assert.equal(pushed.length, 2);
      assert.equal(pushed[0].messageKind, 'reasoning');
      assert.equal(pushed[0].reasoningContent, '先想想再回答');
      assert.equal('messageIndex' in pushed[0], false, 'reasoning must not carry messageIndex');
      assert.equal('totalMessages' in pushed[0], false, 'reasoning must not carry totalMessages');
      assert.equal(pushed[1].messageKind, 'content');
      // Same sessionId across reasoning + content.
      assert.equal(pushed[0].sessionId, pushed[1].sessionId);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('processSingleMessage: does NOT emit ReasoningPush for fixed messageType (no LLM call)', async () => {
    const task = await createEncryptedTask({
      contactName: 'Rei',
      messageType: 'fixed',
      userMessage: '固定消息',
      pushSubscription: { endpoint: 'https://push.example.com/sub' },
    });

    const pushed = [];
    const ctx = createContext(async (_sub, payload) => {
      pushed.push(JSON.parse(payload));
    });

    const result = await processSingleMessage(task, ctx);
    assert.equal(result.success, true);
    assert.equal(pushed.length, 1, 'fixed path → no reasoning, only the content push');
    assert.equal(pushed[0].messageKind, 'content');
    assert.equal(pushed[0].messageType, 'fixed');
    assert.equal(pushed[0].source, 'scheduled');
  });

  it('processSingleMessage: messageType:"instant" routes to source:"instant" (via-server instant path)', async () => {
    const task = await createEncryptedTask({
      contactName: 'Rei',
      messageType: 'instant',
      completePrompt: 'x',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 's',
      primaryModel: 'm',
      pushSubscription: { endpoint: 'https://push.example.com/sub' },
    });

    const pushed = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      async json() { return { choices: [{ message: { content: 'reply' } }] }; },
    });

    const ctx = createContext(async (_sub, payload) => {
      pushed.push(JSON.parse(payload));
    });

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, true);
      assert.equal(pushed[0].source, 'instant');
      assert.equal(pushed[0].messageType, 'instant');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('processSingleMessage: messageId is deterministic across retries when task.id is present', async () => {
    // Pin the v2.4.0 messageId format: `msg_task_<id>_<i>` for scheduled
    // rows, so a retry produces the same id for the same (task, sentence)
    // pair and downstream dedupers can key on it.
    const task = await createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      completePrompt: 'x',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 's',
      primaryModel: 'm',
      pushSubscription: { endpoint: 'https://push.example.com/sub' },
    });

    async function runOnce() {
      const pushed = [];
      const ctx = createContext(async (_sub, payload) => {
        pushed.push(JSON.parse(payload));
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => ({
        ok: true,
        async json() { return { choices: [{ message: { content: '一句。二句！' } }] }; },
      });
      try {
        await processSingleMessage(task, ctx);
        return pushed;
      } finally {
        globalThis.fetch = originalFetch;
      }
    }

    const a = await runOnce();
    const b = await runOnce();

    assert.equal(a[0].messageId, `msg_task_${task.id}_0`);
    assert.equal(a[1].messageId, `msg_task_${task.id}_1`);
    // Same task → same messageIds across retries.
    assert.equal(a[0].messageId, b[0].messageId);
    assert.equal(a[1].messageId, b[1].messageId);
  });

  it('processSingleMessage: sessionId/messageId use UUID fallback when task.id is null', async () => {
    // The legacy in-server instant path can receive a task row with
    // `id == null`. In that case there's no stable key to derive the
    // sessionId/messageId from, so we fall back to UUIDs.
    const userKey = await deriveUserEncryptionKey(TEST_USER_ID, TEST_MASTER_KEY);
    const encryptedPayload = await encryptForStorage(JSON.stringify({
      contactName: 'Rei',
      messageType: 'instant',
      completePrompt: 'x',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 's',
      primaryModel: 'm',
      pushSubscription: { endpoint: 'https://push.example.com/sub' },
    }), userKey);
    const taskWithoutId = { id: null, user_id: TEST_USER_ID, encrypted_payload: encryptedPayload };

    const pushed = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      async json() { return { choices: [{ message: { content: 'reply' } }] }; },
    });
    const ctx = createContext(async (_sub, payload) => {
      pushed.push(JSON.parse(payload));
    });

    try {
      const result = await processSingleMessage(taskWithoutId, ctx);
      assert.equal(result.success, true);
      assert.match(pushed[0].sessionId, /^sess_[0-9a-f-]{36}$/);
      assert.match(pushed[0].messageId, /^msg_[0-9a-f-]{36}_instant_0$/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('processSingleMessage: cascades string[] splitPattern in order', async () => {
    const task = await createEncryptedTask({
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

// ─── avatarUrl (v2.3.1) — parity with @rei-standard/amsg-instant 0.6.1 ──
describe('avatarUrl validation', () => {
  function basePayload(overrides = {}) {
    return {
      contactName: 'Rei',
      messageType: 'prompted',
      firstSendTime: new Date(Date.now() + 60_000).toISOString(),
      completePrompt: 'say hi',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'secret',
      primaryModel: 'model-x',
      ...overrides,
    };
  }

  it('validateAvatarUrl: accepts absent / null', () => {
    assert.equal(validateAvatarUrl(undefined), null);
    assert.equal(validateAvatarUrl(null), null);
  });

  it('validateAvatarUrl: accepts a normal https URL', () => {
    assert.equal(validateAvatarUrl('https://example.com/a.png'), null);
  });

  it('validateAvatarUrl: rejects data: URI (case-insensitive)', () => {
    assert.match(validateAvatarUrl('data:image/png;base64,xxx'), /data:/);
    assert.match(validateAvatarUrl('DATA:image/png;base64,xxx'), /data:/i);
  });

  it('validateAvatarUrl: rejects strings longer than 2048 chars', () => {
    const long = 'https://example.com/' + 'a'.repeat(2048);
    assert.match(validateAvatarUrl(long), /2048/);
  });

  it('validateAvatarUrl: accepts URL exactly 2048 chars', () => {
    const url = 'https://x/' + 'a'.repeat(2048 - 'https://x/'.length);
    assert.equal(url.length, 2048);
    assert.equal(validateAvatarUrl(url), null);
  });

  it('validateAvatarUrl: rejects non-string', () => {
    assert.match(validateAvatarUrl(42), /字符串/);
  });

  it('validateAvatarUrl: rejects strings that are not valid URLs', () => {
    assert.match(validateAvatarUrl('not a url'), /URL/);
  });

  it('schedule payload: soft-strips data: avatarUrl (v2.3.3+)', () => {
    const payload = basePayload({ avatarUrl: 'data:image/png;base64,xxx' });
    const r = validateScheduleMessagePayload(payload);
    assert.equal(r.valid, true);
    assert.equal(payload.avatarUrl, null);
  });

  it('schedule payload: soft-strips oversized avatarUrl', () => {
    const payload = basePayload({
      avatarUrl: 'https://example.com/' + 'a'.repeat(2048),
    });
    const r = validateScheduleMessagePayload(payload);
    assert.equal(r.valid, true);
    assert.equal(payload.avatarUrl, null);
  });

  it('schedule payload: accepts a normal https avatarUrl', () => {
    const payload = basePayload({ avatarUrl: 'https://example.com/a.png' });
    const r = validateScheduleMessagePayload(payload);
    assert.equal(r.valid, true);
    assert.equal(payload.avatarUrl, 'https://example.com/a.png');
  });
});

// Regression guard for the legacy frozen-prompt chain. The fire-time hooks
// (lib/agentic-fire.js) are strictly additive: a deployment with no hooks
// configured must keep replaying the schedule-time completePrompt in a
// single LLM call, byte-for-byte. If someone ever removes or reroutes the
// legacy chain, this is the test that goes red.
describe('legacy frozen-prompt chain regression guard', () => {
  it('no hooks configured → auto task replays the frozen completePrompt in a single LLM call', async () => {
    const task = await createEncryptedTask({
      contactName: 'Rei',
      messageType: 'auto',
      completePrompt: 'FROZEN',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'secret',
      primaryModel: 'model-x',
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

    let pushes = 0;
    try {
      const result = await processSingleMessage(task, createContext(async () => { pushes++; }));
      assert.equal(result.success, true);
      assert.equal(requestBodies.length, 1);
      assert.deepEqual(requestBodies[0].messages, [{ role: 'user', content: 'FROZEN' }]);
      assert.equal(requestBodies[0].temperature, 0.8);
      assert.equal(pushes, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('messageId/sessionId 掺名义触发时刻（occurrence）', () => {
  // 循环任务跨天复用同一条任务行。id 只用 task.id 的话，离线设备一次性收到
  // 多天积压推送（push TTL 四周）时会在 SW 端互相去重、收件箱按 messageId
  // 覆盖，几天的消息只剩一条。
  async function fireFixedAt(nextSendAt) {
    const task = {
      ...(await createEncryptedTask({
        contactName: 'Rei',
        messageType: 'fixed',
        userMessage: '固定消息',
        pushSubscription: { endpoint: 'https://push.example.com/sub' },
      })),
      next_send_at: nextSendAt,
    };
    const pushed = [];
    const ctx = createContext(async (_sub, payload) => { pushed.push(JSON.parse(payload)); });
    const result = await processSingleMessage(task, ctx);
    assert.equal(result.success, true);
    return pushed;
  }

  it('行上带 next_send_at 时，默认 id 是 msg_task_<id>@<occurrenceMs>_<i> / sess_task_<id>@<occurrenceMs>', async () => {
    const occurrence = '2020-01-01T00:00:00.000Z';
    const occurrenceMs = Date.parse(occurrence);
    const pushed = await fireFixedAt(occurrence);
    assert.equal(pushed[0].messageId, `msg_task_1@${occurrenceMs}_0`);
    assert.equal(pushed[0].sessionId, `sess_task_1@${occurrenceMs}`);
  });

  it('同一任务不同 occurrence 的 id 各不相同；同一 occurrence 重发 id 不变', async () => {
    const day1 = await fireFixedAt('2020-01-01T00:00:00.000Z');
    const day2 = await fireFixedAt('2020-01-02T00:00:00.000Z');
    assert.notEqual(day1[0].messageId, day2[0].messageId);
    assert.notEqual(day1[0].sessionId, day2[0].sessionId);

    const day1Again = await fireFixedAt('2020-01-01T00:00:00.000Z');
    assert.equal(day1[0].messageId, day1Again[0].messageId);
    assert.equal(day1[0].sessionId, day1Again[0].sessionId);
  });
});

describe('冻结 prompt 路径的 push 也带任务的调度身份', () => {
  // 客户端认领任务、判断「它还会不会再来」靠的是这四个字段。宿主往 metadata
  // 里抄一遍是抄漏的温床，所以由库统一补。
  it('ContentPush / ReasoningPush 都带 taskId / taskUuid / recurrenceType / occurrenceMs', async () => {
    const task = await createEncryptedTask({
      contactName: 'Rei',
      messageType: 'prompted',
      completePrompt: 'say hi',
      recurrenceType: 'daily',
      apiUrl: 'https://api.example.com/v1/chat/completions',
      apiKey: 'secret',
      primaryModel: 'model-x',
      pushSubscription: { endpoint: 'https://push.example.com/sub' }
    });
    task.uuid = 'task-uuid-1';
    task.next_send_at = '2020-01-01T00:00:00.000Z';

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: '第一句。第二句。', reasoning_content: '想了想' } }] };
      }
    });

    const pushes = [];
    try {
      const result = await processSingleMessage(
        task,
        createContext(async (_sub, payload) => { pushes.push(JSON.parse(payload)); })
      );
      assert.equal(result.success, true);
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.ok(pushes.length >= 2);
    assert.ok(pushes.some((p) => p.messageKind === 'reasoning'));
    for (const push of pushes) {
      assert.equal(push.taskId, 1, `${push.messageKind} 应带 taskId`);
      assert.equal(push.taskUuid, 'task-uuid-1');
      assert.equal(push.recurrenceType, 'daily');
      assert.equal(push.occurrenceMs, Date.parse('2020-01-01T00:00:00.000Z'));
    }
  });

  it('没有任务行的 instant 路径：身份字段给 null，recurrenceType 归 none', async () => {
    const task = await createEncryptedTask({
      contactName: 'Rei',
      messageType: 'instant',
      userMessage: '你好',
      pushSubscription: { endpoint: 'https://push.example.com/sub' }
    });
    delete task.id;

    const pushes = [];
    const result = await processSingleMessage(
      task,
      createContext(async (_sub, payload) => { pushes.push(JSON.parse(payload)); })
    );
    assert.equal(result.success, true);
    assert.equal(pushes[0].taskId, null);
    assert.equal(pushes[0].taskUuid, null);
    assert.equal(pushes[0].recurrenceType, 'none');
    assert.equal(pushes[0].occurrenceMs, null);
  });
});
