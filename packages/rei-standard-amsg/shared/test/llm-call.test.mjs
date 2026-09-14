import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callLlm } from '../src/index.js';

// ─── callLlm：上游非 2xx 的错误细节 ──────────────────────────────────────
// 上游拒掉请求时，真正的原因（模型名写错 / 余额不够 / 上下文超长 / 被内容审核
// 拦下）全在响应体里，状态行一律只说 "400 Bad Request"。这组用例钉住三件事：
// 响应体读了、机读字段挂上了、外传前脱敏截断过了。

const API_URL = 'https://api.example.com/v1/chat/completions';

function makePayload(overrides = {}) {
  return {
    apiUrl: API_URL,
    apiKey: 'sk-test',
    primaryModel: 'model-x',
    completePrompt: 'hi',
    ...overrides,
  };
}

/** 一个只回错误的假上游。`body` 是响应体原文（字符串）。 */
function upstream({ status = 400, statusText = 'Bad Request', body = '', textThrows = false } = {}) {
  return async () => ({
    ok: false,
    status,
    statusText,
    async text() {
      if (textThrows) throw new Error('connection reset while reading body');
      return body;
    },
  });
}

/**
 * 一个把响应体按流分块给出来的假上游。callLlm 只读前 16KB 就断开——中转把整个
 * 请求原样回显时，读到的就是一段被切坏的 JSON 前缀。
 */
function streamingUpstream({ status = 400, statusText = 'Bad Request', body = '' } = {}) {
  return async () => ({
    ok: false,
    status,
    statusText,
    body: {
      getReader() {
        const bytes = new TextEncoder().encode(body);
        let offset = 0;
        return {
          async read() {
            if (offset >= bytes.length) return { done: true, value: undefined };
            const chunk = bytes.subarray(offset, offset + 4096);
            offset += chunk.length;
            return { done: false, value: chunk };
          },
          async cancel() {},
        };
      },
    },
  });
}

/** 一段够长的回显正文，保证响应体被 16KB 上限切断。 */
const ECHOED_PROMPT = 'echoed prompt text '.repeat(2000);

async function callAndCatch(fetchImpl, payload = makePayload(), options = {}) {
  try {
    await callLlm(payload, { ...options, fetch: fetchImpl });
  } catch (error) {
    return error;
  }
  throw new Error('callLlm 应该抛错，但它没抛');
}

test('callLlm: OpenAI 形状的错误体 —— 说明进 message，code 进 providerCode', async () => {
  const error = await callAndCatch(upstream({
    status: 401,
    statusText: 'Unauthorized',
    body: JSON.stringify({
      error: {
        message: 'Incorrect API key provided. You can find your API key at https://example.com/keys.',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    }),
  }));

  // 人看的那句：状态行照旧，后面接上 provider 自己的说明。
  assert.match(error.message, /AI API error: 401 Unauthorized/);
  assert.match(error.message, /Incorrect API key provided/);
  assert.match(error.message, /\(provider code: invalid_api_key\)/);

  // 机器读的那几个字段。
  assert.equal(error.code, 'LLM_CALL_FAILED');
  assert.equal(error.llmStatus, 401);
  assert.equal(error.providerCode, 'invalid_api_key');
});

test('callLlm: 上游状态码不挂 statusCode —— 那个字段是推送服务专用的', async () => {
  // amsg-server 的投递侧对捕获到的异常一律读 error.statusCode 当推送状态码用，
  // 410 / 404 / 413 会被判成终态。LLM 回的 404（模型名写错）、413（请求体过大）
  // 要是借用同一个字段名，任务就会被当成「订阅已失效」永久判死。
  const notFound = await callAndCatch(upstream({
    status: 404,
    statusText: 'Not Found',
    body: JSON.stringify({ error: { message: 'The model `gpt-nope` does not exist', code: 'model_not_found' } }),
  }));
  assert.equal(notFound.llmStatus, 404);
  assert.equal(notFound.statusCode, undefined);

  const tooLarge = await callAndCatch(upstream({ status: 413, statusText: 'Payload Too Large' }));
  assert.equal(tooLarge.llmStatus, 413);
  assert.equal(tooLarge.statusCode, undefined);
});

test('callLlm: Anthropic 形状 —— 没有 code 时退到 type', async () => {
  const error = await callAndCatch(upstream({
    status: 429,
    statusText: 'Too Many Requests',
    body: JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded' },
    }),
  }));

  assert.equal(error.llmStatus, 429);
  assert.equal(error.providerCode, 'overloaded_error');
  assert.match(error.message, /Overloaded/);
});

test('callLlm: Gemini 形状 —— code 是数字时取 status，不取那个数字', async () => {
  // Gemini 的 error.code 就是 HTTP 状态码的复读（已经在 llmStatus 里了），
  // 真正能分类的是 status 那个字符串。
  const error = await callAndCatch(upstream({
    status: 400,
    statusText: 'Bad Request',
    body: JSON.stringify({
      error: {
        code: 400,
        message: 'Request contains an invalid argument.',
        status: 'INVALID_ARGUMENT',
      },
    }),
  }));

  assert.equal(error.llmStatus, 400);
  assert.equal(error.providerCode, 'INVALID_ARGUMENT');
  assert.match(error.message, /Request contains an invalid argument/);
});

test('callLlm: 中转的几种非标准形状也认', async () => {
  const stringError = await callAndCatch(upstream({ status: 403, body: JSON.stringify({ error: 'forbidden by relay' }) }));
  assert.match(stringError.message, /forbidden by relay/);
  assert.equal(stringError.providerCode, undefined);

  const topLevelMessage = await callAndCatch(upstream({ status: 402, body: JSON.stringify({ message: '当前分组上游负载已饱和', code: 'quota_exhausted' }) }));
  assert.match(topLevelMessage.message, /当前分组上游负载已饱和/);
  assert.equal(topLevelMessage.providerCode, 'quota_exhausted');

  const fastapiDetail = await callAndCatch(upstream({ status: 422, body: JSON.stringify({ detail: 'model field required' }) }));
  assert.match(fastapiDetail.message, /model field required/);
});

test('callLlm: 响应体不是 JSON 时，原文当说明', async () => {
  // 反代 / 网关挂掉时回的是 HTML 错误页或纯文本，一句没解析出来的原文也比一句
  // 都没有强。
  const error = await callAndCatch(upstream({
    status: 502,
    statusText: 'Bad Gateway',
    body: '<html><head><title>502 Bad Gateway</title></head><body>nginx/1.24.0</body></html>',
  }));

  assert.equal(error.llmStatus, 502);
  assert.equal(error.providerCode, undefined);
  assert.match(error.message, /nginx\/1\.24\.0/);
});

// ─── 上游 JSON 被 16KB 上限切断 ──────────────────────────────────────────
// 中转出问题时会把整个请求原样回显回来，响应体轻松超过 16KB。切出来的前缀不是
// 合法 JSON，硬 parse 必挂——不能因此就把这段裸 JSON 当作「上游说了什么」。

test('callLlm: 响应体被截断时，说明取上游那句话而不是裸 JSON 前缀', async () => {
  const body = JSON.stringify({
    error: {
      message: 'This model is not available in your region.',
      // 回显的请求正文把 code 顶到了 16KB 之外。
      echoed_request: ECHOED_PROMPT,
      code: 'model_not_available',
    },
  });
  const error = await callAndCatch(streamingUpstream({ status: 403, statusText: 'Forbidden', body }));

  assert.match(error.message, /This model is not available in your region/);
  assert.ok(!error.message.includes('{'), `说明里不该出现裸 JSON：${error.message}`);
  assert.ok(!error.message.includes('echoed prompt text'), `说明里不该出现被回显的正文：${error.message}`);
  assert.equal(error.llmStatus, 403);
  // code 落在截断点之后，拿不到就别硬凑。
  assert.equal(error.providerCode, undefined);
});

test('callLlm: 响应体被截断时，截断点之前的 code 照样能拿到', async () => {
  const body = JSON.stringify({
    error: {
      code: 'context_length_exceeded',
      message: "This model's maximum context length is 8192 tokens.",
      echoed_request: ECHOED_PROMPT,
    },
  });
  const error = await callAndCatch(streamingUpstream({ status: 400, body }));

  assert.equal(error.providerCode, 'context_length_exceeded');
  assert.match(error.message, /maximum context length is 8192 tokens/);
  assert.ok(!error.message.includes('{'), `说明里不该出现裸 JSON：${error.message}`);
});

test('callLlm: Anthropic 信封被截断时，providerCode 取里层的 type 而不是最外层的判别字段', async () => {
  // Anthropic 风格的信封最外层就有一个 "type":"error"，它只说「这是一条错误」，
  // 真正的类别在 error.type 上——完整 parse 那条路也只读里层。截断走 salvage
  // 时最外层那个不该抢先变成 providerCode，否则靠 providerCode 停止重试鉴权
  // 失败的接入方拿到的是没法判的 'error'。
  const body = JSON.stringify({
    type: 'error',
    error: { type: 'authentication_error', message: 'invalid x-api-key' },
    request: { echoed: ECHOED_PROMPT },
  });
  const error = await callAndCatch(streamingUpstream({ status: 401, statusText: 'Unauthorized', body }));

  assert.equal(error.providerCode, 'authentication_error');
  assert.match(error.message, /invalid x-api-key/);
  assert.equal(error.llmStatus, 401);
});

test('callLlm: 截断的 JSON 里一个字段都捞不到时，也不外传裸 JSON', async () => {
  const body = JSON.stringify({ echoed_request: ECHOED_PROMPT });
  const error = await callAndCatch(streamingUpstream({ status: 502, statusText: 'Bad Gateway', body }));

  assert.ok(!error.message.includes('echoed prompt text'), `说明里不该出现被回显的正文：${error.message}`);
  assert.ok(!error.message.includes('{'), `说明里不该出现裸 JSON：${error.message}`);
  assert.match(error.message, /truncated/);
  assert.equal(error.llmStatus, 502);
});

test('callLlm: 流式响应体没超上限时，按普通 JSON 解析', async () => {
  const body = JSON.stringify({ error: { message: 'Overloaded', type: 'overloaded_error' } });
  const error = await callAndCatch(streamingUpstream({ status: 429, statusText: 'Too Many Requests', body }));

  assert.match(error.message, /Overloaded/);
  assert.equal(error.providerCode, 'overloaded_error');
  assert.equal(error.llmStatus, 429);
});

test('callLlm: 上游把 Key 抄回来时会遮掉', async () => {
  // OpenAI 的原文就长这样：Incorrect API key provided: sk-…。这段文字会落进
  // server 的 last_error 明文列、也会随 instant 的 502 回给调用方。
  const apiKey = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  const error = await callAndCatch(upstream({
    status: 401,
    body: JSON.stringify({ error: { message: `Incorrect API key provided: ${apiKey}. Check your key.` } }),
  }));

  assert.ok(!error.message.includes(apiKey), `错误消息里不该出现原始 Key：${error.message}`);
  assert.match(error.message, /\[redacted\]/);
  assert.match(error.message, /Incorrect API key provided/);

  const bearer = await callAndCatch(upstream({
    status: 401,
    body: JSON.stringify({ error: { message: 'bad header: Bearer abcdefghijklmnop' } }),
  }));
  assert.match(bearer.message, /Bearer \[redacted\]/);

  // 自建网关发的 Key 常常全小写、按短横线分段、前缀不认识，跟模型 ID 同形。
  const gatewayKey = 'mycorp-aaaabbbbcccc-ddddeeeeffff';
  const gateway = await callAndCatch(upstream({
    status: 401,
    body: JSON.stringify({ error: { message: `Incorrect API key provided: ${gatewayKey}` } }),
  }));
  assert.ok(!gateway.message.includes(gatewayKey), `错误消息里不该出现原始 Key：${gateway.message}`);
  assert.match(gateway.message, /\[redacted\]/);
});

test('callLlm: 超长的上游说明会截断', async () => {
  // 内容审核类的报错常把整段请求内容回显回来，不截断的话 server 那边一条
  // last_error 就能撑满明文列。
  const echoed = '把用户输入原样回显'.repeat(200);
  const error = await callAndCatch(upstream({
    status: 400,
    body: JSON.stringify({ error: { message: echoed, code: 'content_filter' } }),
  }));

  assert.ok(error.message.length < 600, `截断后不该这么长：${error.message.length}`);
  assert.match(error.message, /…/);
  // 截断不影响机读字段。
  assert.equal(error.providerCode, 'content_filter');
  assert.equal(error.llmStatus, 400);
});

test('callLlm: 读响应体本身失败时，仍按 HTTP 失败报出来', async () => {
  // 真正要报的是那条 HTTP 失败，不能被读 body 的二次失败盖掉。
  const error = await callAndCatch(upstream({ status: 500, statusText: 'Internal Server Error', textThrows: true }));

  assert.match(error.message, /AI API error: 500 Internal Server Error/);
  assert.equal(error.code, 'LLM_CALL_FAILED');
  assert.equal(error.llmStatus, 500);
  assert.equal(error.providerCode, undefined);
});

test('callLlm: 405 的排障提示保留，并一样带上机读字段', async () => {
  const error = await callAndCatch(upstream({
    status: 405,
    statusText: 'Method Not Allowed',
    body: JSON.stringify({ error: { message: 'GET only', code: 'method_not_allowed' } }),
  }));

  // apiUrl 指错端点是最常见的接入错误，那句提示是这条路径的主要价值。
  assert.match(error.message, /apiUrl must point to a full chat endpoint/);
  assert.match(error.message, /GET only/);
  assert.equal(error.llmStatus, 405);
  assert.equal(error.providerCode, 'method_not_allowed');
});

test('callLlm: 2xx 正常返回时不受影响', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      return { choices: [{ message: { content: '  你好  ' } }] };
    },
  });

  const { content, response } = await callLlm(makePayload(), { fetch: fetchImpl });
  assert.equal(content, '你好');
  assert.equal(response.choices[0].message.content, '  你好  ');
});

// ─── callLlm：HTTP 2xx，但响应体不是 chat completion ─────────────────────
// 不少中转站出错时照样回 200，响应体里装的是 `{"error":{…}}`、没有 choices；反代
// 返回的 HTML 页面也可能是 200。这些本质都是上游报错，不能被当成「模型这轮没说
// 话」放过去。requireContent 管的是「content 为空算不算错」，不管「响应格式坏了
// 算不算错」，所以两种取值下都得抛。

/** 一个回 2xx 的假上游。用真的 Response：响应体只能读一次，读第二遍会直接炸。 */
function okUpstream({ status = 200, statusText = 'OK', body = '', contentType = 'application/json' } = {}) {
  return async () => new Response(body, { status, statusText, headers: { 'Content-Type': contentType } });
}

test('callLlm: 200 但响应体是报错信封 —— 抛上游错误，带上中转站的原话', async () => {
  const error = await callAndCatch(okUpstream({
    body: JSON.stringify({
      error: { message: '当前分组上游负载已饱和，请稍后再试', type: 'new_api_error', code: 'upstream_saturated' },
    }),
  }));

  // 人看的那句：要看得出 HTTP 是 200，但这不是一次正常返回。
  assert.match(error.message, /HTTP 200/);
  assert.match(error.message, /not a chat completion/);
  assert.ok(error.message.includes(API_URL), `错误里该带请求 URL：${error.message}`);
  assert.match(error.message, /当前分组上游负载已饱和/);
  assert.match(error.message, /\(provider code: upstream_saturated\)/);

  // 机读字段跟非 2xx 那条路同一套。
  assert.equal(error.code, 'LLM_CALL_FAILED');
  assert.equal(error.llmStatus, 200);
  assert.equal(error.providerCode, 'upstream_saturated');
});

test('callLlm: 200 报错信封在 requireContent: false 下照样抛', async () => {
  // agentic 循环传的就是 requireContent: false。这条路要是把报错当成「纯
  // tool_calls、这轮没说话」原样返回，下游会判成空输出跳过，任务被当成功消费，
  // 失败原因一个字都不留。
  const error = await callAndCatch(okUpstream({
    body: JSON.stringify({ error: { message: 'Invalid token (request id: 20250914000000001)', code: 'invalid_token' } }),
  }), makePayload(), { requireContent: false });

  assert.match(error.message, /HTTP 200/);
  assert.match(error.message, /Invalid token/);
  assert.equal(error.code, 'LLM_CALL_FAILED');
  assert.equal(error.llmStatus, 200);
  assert.equal(error.providerCode, 'invalid_token');
});

test('callLlm: 200 但 choices 是空数组，一样按报错处理', async () => {
  const error = await callAndCatch(okUpstream({
    body: JSON.stringify({ choices: [], error: { message: 'upstream request timed out' } }),
  }), makePayload(), { requireContent: false });

  assert.match(error.message, /not a chat completion/);
  assert.match(error.message, /upstream request timed out/);
  assert.equal(error.llmStatus, 200);
});

test('callLlm: 200 但响应体不是 JSON —— 抛带 URL 的上游错误，不是裸 SyntaxError', async () => {
  const error = await callAndCatch(okUpstream({
    body: '<html><head><title>Just a moment...</title></head><body>checking your browser</body></html>',
    contentType: 'text/html',
  }), makePayload(), { requireContent: false });

  assert.ok(!(error instanceof SyntaxError), `不该是裸 SyntaxError：${error.name}: ${error.message}`);
  assert.match(error.message, /HTTP 200/);
  assert.match(error.message, /not valid JSON/);
  assert.ok(error.message.includes(API_URL), `错误里该带请求 URL：${error.message}`);
  // 跟非 2xx 一样，解析不了的原文就是唯一的线索。
  assert.match(error.message, /Just a moment/);
  assert.equal(error.code, 'LLM_CALL_FAILED');
  assert.equal(error.llmStatus, 200);
  assert.equal(error.providerCode, undefined);
});

test('callLlm: 200 但回的是 SSE 流 —— 抛上游错误，不回显流里的正文', async () => {
  // 有些中转站无视 stream: false 直接回 SSE。这时原文就是模型生成的聊天正文，
  // 而错误消息会落进 server 的 last_error 明文列，不能照抄。
  const sse =
    'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"delta":{"content":"悄悄话"}}]}\n\n' +
    'data: [DONE]\n\n';
  const error = await callAndCatch(okUpstream({ body: sse, contentType: 'text/event-stream' }), makePayload(), { requireContent: false });

  assert.equal(error.code, 'LLM_CALL_FAILED');
  assert.equal(error.llmStatus, 200);
  assert.match(error.message, /not valid JSON/);
  assert.match(error.message, /looks like an SSE stream/);
  assert.ok(!error.message.includes('悄悄话'), `错误里不该出现流里的正文：${error.message}`);
  assert.equal(error.providerCode, undefined);

  // 以 event: 开头、大小写不一的流也认。
  const withEvent = await callAndCatch(okUpstream({
    body: '\n Event: message\ndata: {"choices":[{"delta":{"content":"悄悄话"}}]}\n\n',
    contentType: 'text/event-stream',
  }), makePayload(), { requireContent: false });
  assert.match(withEvent.message, /looks like an SSE stream/);
  assert.ok(!withEvent.message.includes('悄悄话'), `错误里不该出现流里的正文：${withEvent.message}`);

  // 首行是 SSE 注释（OpenRouter 的保活行）或 id: / retry: 字段，正文在后面几行。
  const otherStarts = [
    ': OPENROUTER PROCESSING\n\ndata: {"choices":[{"delta":{"content":"悄悄话"}}]}\n\n',
    'id: 1\ndata: {"choices":[{"delta":{"content":"悄悄话"}}]}\n\n',
    'retry: 3000\n\ndata: {"choices":[{"delta":{"content":"悄悄话"}}]}\n\n',
  ];
  for (const body of otherStarts) {
    const streamed = await callAndCatch(okUpstream({ body, contentType: 'text/event-stream' }), makePayload(), { requireContent: false });
    assert.equal(streamed.code, 'LLM_CALL_FAILED');
    assert.match(streamed.message, /looks like an SSE stream/, `该认成 SSE：${JSON.stringify(body.slice(0, 24))}`);
    assert.ok(!streamed.message.includes('悄悄话'), `错误里不该出现流里的正文：${streamed.message}`);
  }

  // 反向：普通纯文本报错不是流，照旧原文回显。
  const plainText = 'upstream connect error or disconnect/reset before headers. reset reason: connection failure';
  const plain = await callAndCatch(okUpstream({ body: plainText, contentType: 'text/plain' }), makePayload(), { requireContent: false });
  assert.ok(plain.message.includes(plainText), `纯文本报错该原文回显：${plain.message}`);
  assert.doesNotMatch(plain.message, /looks like an SSE stream/);
});

test('callLlm: 200 空响应体也按「不是 JSON」报', async () => {
  const error = await callAndCatch(okUpstream({ body: '' }), makePayload(), { requireContent: false });

  assert.match(error.message, /not valid JSON/);
  assert.match(error.message, /empty/);
  assert.equal(error.code, 'LLM_CALL_FAILED');
  assert.equal(error.llmStatus, 200);
});

test('callLlm: 200 响应体里的数字状态码进 providerCode，但不标成永久失败', async () => {
  // 国内中转常见 `{ code: 401, msg: '…' }` 这种写法。HTTP 已经是 200 了，响应体里
  // 这个数字是唯一说明真实原因的地方，所以留下（非 2xx 那条路丢掉数字 code，是
  // 因为它就是 llmStatus 的复读）。
  //
  // 重试分类不看它：真回 HTTP 401 的 LLM 失败本来也留在重试阶梯上（Key 改好之后，
  // 还在阶梯上的任务能自己发出去），写在响应体里的 401 没有理由判得更重。
  const error = await callAndCatch(okUpstream({
    body: JSON.stringify({ code: 401, msg: '无效的令牌', data: null }),
  }), makePayload(), { requireContent: false });

  assert.match(error.message, /无效的令牌/);
  assert.match(error.message, /\(provider code: 401\)/);
  assert.equal(error.providerCode, '401');
  assert.equal(error.llmStatus, 200);
  assert.equal(error.permanent, undefined);
  // statusCode 是推送服务专用的字段，响应体里的数字更不能挂上去。
  assert.equal(error.statusCode, undefined);

  // 同时有字符串类别时取字符串（Gemini 形状：数字 code 旁边的 status 才是类别）。
  const gemini = await callAndCatch(okUpstream({
    body: JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } }),
  }), makePayload(), { requireContent: false });
  assert.equal(gemini.providerCode, 'RESOURCE_EXHAUSTED');
  assert.match(gemini.message, /Resource has been exhausted/);
});

test('callLlm: 200 但 JSON 里既没有 choices 也认不出报错字段 —— 只报字段名，不回显内容', async () => {
  // 典型是 apiUrl 指到了非 OpenAI 形状的端点（比如 Anthropic 原生的 /v1/messages）：
  // 响应本身是成功的，里面装着生成出来的正文。这句话会落进 server 的 last_error
  // 明文列，正文不能跟着进去。
  const error = await callAndCatch(okUpstream({
    body: JSON.stringify({
      id: 'msg_01',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: '只给你一个人看的回复' }],
    }),
  }), makePayload(), { requireContent: false });

  assert.match(error.message, /not a chat completion/);
  assert.match(error.message, /top-level keys: id, type, role, content/);
  assert.ok(!error.message.includes('只给你一个人看的回复'), `错误里不该出现生成的正文：${error.message}`);
  assert.equal(error.llmStatus, 200);
  assert.equal(error.providerCode, undefined);
});

test('callLlm: 200 报错信封里抄回来的 Key 一样遮掉', async () => {
  const apiKey = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  const error = await callAndCatch(okUpstream({
    body: JSON.stringify({ error: { message: `Incorrect API key provided: ${apiKey}` } }),
  }), makePayload(), { requireContent: false });

  assert.ok(!error.message.includes(apiKey), `错误消息里不该出现原始 Key：${error.message}`);
  assert.match(error.message, /\[redacted\]/);
});

test('callLlm: 只实现了 json() 的假响应也走同一套判定', async () => {
  // 经 options.fetch 注入的 fetch 不一定返回真 Response（测试桩尤其如此）。没有
  // text() 时退回 json()：报错信封一样抛，解析失败一样包成上游错误。
  const envelope = await callAndCatch(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() { return { error: { message: 'relay says no', code: 'relay_error' } }; },
  }), makePayload(), { requireContent: false });
  assert.match(envelope.message, /relay says no/);
  assert.equal(envelope.code, 'LLM_CALL_FAILED');
  assert.equal(envelope.providerCode, 'relay_error');

  const malformed = await callAndCatch(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
  }), makePayload(), { requireContent: false });
  assert.ok(!(malformed instanceof SyntaxError), `不该是裸 SyntaxError：${malformed.message}`);
  assert.match(malformed.message, /not valid JSON/);
  assert.ok(malformed.message.includes(API_URL), `错误里该带请求 URL：${malformed.message}`);
  assert.equal(malformed.code, 'LLM_CALL_FAILED');
  assert.equal(malformed.llmStatus, 200);
});

test('callLlm: choices 在、content 是 null 时 requireContent: false 照常返回', async () => {
  // 模型只回了 tool_calls，或者被内容审核拦下，都是合法的空生成，下游有自己的处理。
  const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'recall', arguments: '{}' } }];
  const toolRound = await callLlm(makePayload(), {
    fetch: okUpstream({
      body: JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: toolCalls } }] }),
    }),
    requireContent: false,
  });
  assert.equal(toolRound.content, '');
  assert.deepEqual(toolRound.response.choices[0].message.tool_calls, toolCalls);

  const filtered = await callLlm(makePayload(), {
    fetch: okUpstream({
      body: JSON.stringify({ choices: [{ finish_reason: 'content_filter', message: { role: 'assistant', content: null } }] }),
    }),
    requireContent: false,
  });
  assert.equal(filtered.content, '');
});

test('callLlm: 真 Response 的正常 2xx 照常解析', async () => {
  const { content, response } = await callLlm(makePayload(), {
    fetch: okUpstream({ body: JSON.stringify({ choices: [{ message: { content: '  你好  ' } }], usage: { total_tokens: 3 } }) }),
  });
  assert.equal(content, '你好');
  assert.equal(response.usage.total_tokens, 3);
});
