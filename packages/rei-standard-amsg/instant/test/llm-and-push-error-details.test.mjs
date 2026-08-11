import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { createInstantHandler } from '../src/index.js';
import {
  generateTestVapid,
  generateTestSubscription,
  createFetchRouter,
  buildHandlerRequest,
  makeLlmResponse,
} from './helpers.mjs';

// ─── 失败信封里的上游状态码 ─────────────────────────────────────────────
// README 承诺「SDK 消费者只需读 body.error.code 分支」，但光有 code 分不出
// 「订阅死了，让用户重新订阅」和「推送服务抽风，等会儿再来」——前者重试多少
// 次都是同一个结果，而 instant 是先跑 LLM 再推送，每次重试都要把整轮生成重跑
// 一遍。LLM 那边同理：一句 "AI API error: 401 Unauthorized" 说不出是 Key 失
// 效、余额不够还是上下文超长。这组用例钉住这些机读字段一路传到信封和事件里。

const LLM_URL = 'https://api.example.com/v1/chat/completions';

let vapid;
let subKit;

before(async () => {
  vapid = await generateTestVapid();
  subKit = await generateTestSubscription();
});

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

/** 一个直接拒掉请求的假 LLM 上游。 */
function rejectingLlm({ status, statusText, body }) {
  return async () => ({
    ok: false,
    status,
    statusText,
    async text() { return body; },
  });
}

const OPENAI_401_BODY = JSON.stringify({
  error: {
    message: 'Incorrect API key provided. You can find your API key at https://example.com/keys.',
    type: 'invalid_request_error',
    param: null,
    code: 'invalid_api_key',
  },
});

describe('纯 Push 模式下 LLM 失败的错误细节', () => {
  it('legacy 路径：信封与 error 事件都带上 llmStatus / providerCode', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: rejectingLlm({ status: 401, statusText: 'Unauthorized', body: OPENAI_401_BODY }),
    });
    const events = [];
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onEvent: (e) => events.push(e),
    });

    const res = await handler(buildHandlerRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 502);

    const body = await res.json();
    assert.equal(body.error.code, 'LLM_CALL_FAILED');
    assert.equal(body.error.llmStatus, 401);
    assert.equal(body.error.providerCode, 'invalid_api_key');
    // provider 的原话也在，运维不用再去翻上游日志。
    assert.match(body.error.message, /Incorrect API key provided/);
    // LLM 那一步失败时不该冒出推送侧的字段，两条上游别串台。
    assert.equal(body.error.pushStatus, undefined);
    assert.equal(router.pushCalls.length, 0);

    // 宿主的日志 / 告警读的是事件，不是响应体。
    const errorEvent = events.find((e) => e.type === 'error');
    assert.ok(errorEvent, '应该发出一条 error 事件');
    assert.equal(errorEvent.llmStatus, 401);
    assert.equal(errorEvent.providerCode, 'invalid_api_key');
  });

  // 脱敏是必要的（上游报错常把 Key 原样抄回来），但「模型名写错」正是这套错误
  // 细节要解决的头号场景——把模型名当 Key 遮掉，报错就只剩「有个东西不存在」。
  it('模型名写错时，上游原话里的模型名不被脱敏吃掉；Key 照旧遮住', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: rejectingLlm({
        status: 404,
        statusText: 'Not Found',
        body: JSON.stringify({
          error: {
            message: 'The model `gpt-4o-mini-2024-07-18` does not exist or you do not have access to it.',
            code: 'model_not_found',
          },
        }),
      }),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });

    const res = await handler(buildHandlerRequest({
      body: makeValidPayload({ primaryModel: 'gpt-4o-mini-2024-07-18' }),
    }));
    const body = await res.json();

    assert.equal(body.error.providerCode, 'model_not_found');
    assert.match(
      body.error.message,
      /gpt-4o-mini-2024-07-18/,
      `到底是哪个模型名写错了得看得见：${body.error.message}`,
    );
  });

  it('上游把 API Key 原样抄回来时照旧遮掉', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: rejectingLlm({
        status: 401,
        statusText: 'Unauthorized',
        body: JSON.stringify({
          error: {
            message: 'Incorrect API key provided: sk-proj-AbCdEf0123456789GhIjKlMn.',
            code: 'invalid_api_key',
          },
        }),
      }),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });

    const res = await handler(buildHandlerRequest({ body: makeValidPayload() }));
    const body = await res.json();

    assert.ok(
      !body.error.message.includes('sk-proj-AbCdEf0123456789GhIjKlMn'),
      `凭据不能原样回给调用方：${body.error.message}`,
    );
    assert.match(body.error.message, /redacted/);
  });

  it('hook 路径（agentic loop）：LlmCallError 一样带上这些字段', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: rejectingLlm({
        status: 400,
        statusText: 'Bad Request',
        body: JSON.stringify({
          error: { message: "This model's maximum context length is 8192 tokens.", code: 'context_length_exceeded' },
        }),
      }),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      // 有 onLLMOutput 就走 agentic 循环那条路径（错误在那里被重造成 LlmCallError）。
      onLLMOutput: () => ({ decision: 'skip-push' }),
    });

    // hook 路径用 messages 数组，不带 completePrompt。
    const { completePrompt, ...rest } = makeValidPayload();
    const res = await handler(buildHandlerRequest({
      body: { ...rest, messages: [{ role: 'user', content: 'hi' }] },
    }));
    assert.equal(res.status, 502);

    const body = await res.json();
    assert.equal(body.error.code, 'LLM_CALL_FAILED');
    assert.equal(body.error.llmStatus, 400);
    assert.equal(body.error.providerCode, 'context_length_exceeded');
    assert.match(body.error.message, /maximum context length/);
  });

  it('上游根本没答复时不硬造字段', async () => {
    // 网络直接炸 / 超时：没有状态码可报。字段缺席本身就是信息——接入方据此能
    // 分清「上游拒了」和「根本没连上」。
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async () => { throw new Error('connect ECONNREFUSED'); },
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });

    const res = await handler(buildHandlerRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 502);

    const body = await res.json();
    assert.equal(body.error.code, 'LLM_CALL_FAILED');
    assert.equal(body.error.llmStatus, undefined);
    assert.equal(body.error.providerCode, undefined);
  });
});

describe('纯 Push 模式下推送失败的错误细节', () => {
  it('订阅被推送服务判死（410）时信封与事件都带上 pushStatus', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async () => makeLlmResponse('你好。'),
      pushHandler: () => new Response('push subscription has unsubscribed or expired', {
        status: 410,
        statusText: 'Gone',
      }),
    });
    const events = [];
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onEvent: (e) => events.push(e),
    });

    const res = await handler(buildHandlerRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 502);

    const body = await res.json();
    assert.equal(body.error.code, 'PUSH_SEND_FAILED');
    // 410 / 404 = 这份订阅没了，重发多少次都一样，调用方该让用户重新订阅而
    // 不是重试；靠正则去 message 里捞 410 是这次要修掉的形态。
    assert.equal(body.error.pushStatus, 410);
    assert.equal(body.error.llmStatus, undefined);

    const errorEvent = events.find((e) => e.type === 'error');
    assert.ok(errorEvent, '应该发出一条 error 事件');
    assert.equal(errorEvent.pushStatus, 410);
  });

  it('推送服务临时抽风（500）时 pushStatus 如实反映，与终态区分得开', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async () => makeLlmResponse('你好。'),
      pushHandler: () => new Response('upstream busy', { status: 500, statusText: 'Internal Server Error' }),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });

    const res = await handler(buildHandlerRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 502);

    const body = await res.json();
    assert.equal(body.error.code, 'PUSH_SEND_FAILED');
    assert.equal(body.error.pushStatus, 500);
  });
});
