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

async function callAndCatch(fetchImpl, payload = makePayload()) {
  try {
    await callLlm(payload, { fetch: fetchImpl });
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
