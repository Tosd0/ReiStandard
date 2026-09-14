/**
 * OpenAI-compatible LLM HTTP 调用核心 — 单一事实来源。
 *
 * `@rei-standard/amsg-instant`（message-processor 的 callLlmRaw）与
 * `@rei-standard/amsg-server`（lib/llm.js 的 callLlm）此前各写一份
 * 「构造请求体 + fetch + 超时 + 解析响应 + trim」，并已出现漂移
 * （stream 字段、messages 模式探测、超时可配性）。现在公共核心收敛到
 * 这里，两侧差异通过 options 参数化，各包保留自己的导出名与错误码
 * 包装：
 *
 *   - `stream`       — instant 传 `false`（一次性、非流式契约，字段显式
 *                      出现在请求体里）；server 不传（字段缺省，行为与
 *                      之前逐字节一致）。
 *   - `forwardTools` — server 转发 payload.tools / payload.toolChoice
 *                      （v2.6.0 起）；instant 传 `false` 维持既有
 *                      「忽略 tools」行为。
 *   - `timeoutMs`    — server 的 agentic 循环传剩余墙钟预算；instant 传
 *                      300000 维持现状。默认 300000。
 *
 * messages 模式探测统一为 `Array.isArray(payload.messages) &&
 * payload.messages.length > 0`（server 语义）：`messages: []` 回退
 * completePrompt 模式，而不是把空数组原样发给上游。
 */

import { concatBytes, utf8Decode } from './webcrypto-utils.js';

// 上游错误说明能留多长。provider 的报错偶尔会把请求内容整段回显（内容审核类
// 的报错尤其爱这么干），而这段文本最终会落进 server 的 last_error 明文列、也
// 会随 instant 的 502 原样回给调用方。够看清原因就行，正文不必全留。
// server 的 sanitizeErrorSummary 还会把整条消息再截到 500 字符，这里留得比它
// 短一截，状态行和请求 URL 才不至于被说明文字挤掉。
const UPSTREAM_ERROR_DETAIL_MAX_CHARS = 300;

// provider 错误码的长度上限。code 是标识符不是人话，但也别让一个来路不明的超长
// 串撑大错误消息（与 server 记 last_error.errorCode 时的口径一致）。
const UPSTREAM_ERROR_CODE_MAX_CHARS = 64;

// 读上游错误响应体最多读这么多字节，读够就断开。错误信封
//（`{"error":{"message":…}}`）永远在最前面，而中转出问题时能把整个请求体回显
// 回来——任务正文上限接近 1MB，一次网关故障把一批任务同时打挂时，这些只为留
// 300 字符而读进来的整段文本会一起压在 Worker 的内存上限上。
const UPSTREAM_ERROR_BODY_MAX_BYTES = 16 * 1024;

/**
 * Call an OpenAI-compatible API.
 *
 * Returns the full response object alongside the extracted (trimmed)
 * `content` string. Callers that only need the text can ignore
 * `response`; callers that want `reasoning_content` / `tool_calls`
 * read from `response.choices[0].message`.
 *
 * @param {Object} payload
 * @param {{
 *   requireContent?: boolean,
 *   timeoutMs?: number,
 *   fetch?: typeof globalThis.fetch,
 *   stream?: boolean,
 *   forwardTools?: boolean,
 * }} [options]
 *   requireContent defaults to true (legacy single-shot behavior:
 *   throw when the response carries no content). Tool rounds legitimately
 *   return no content (pure tool_calls), so agentic loops pass
 *   `{ requireContent: false }`. It only decides whether an empty
 *   `content` counts as a failure; a 2xx body that is not a chat
 *   completion at all throws either way (see @throws).
 *   timeoutMs defaults to 300000 (the legacy per-call ceiling).
 *   fetch defaults to `globalThis.fetch` (resolved at call time so test
 *   stubs on the global still take effect).
 *   stream / forwardTools are forwarded to {@link buildLlmRequestBody}.
 * @returns {Promise<{ response: unknown, content: string }>}
 * @throws {Error} 上游答复了、但没给出能用的结果时抛，错误上带机读标注（见
 *   {@link buildUpstreamError}）：`code` = `'LLM_CALL_FAILED'`、`llmStatus` =
 *   上游的 HTTP 状态码、`providerCode` = provider 自己的错误码（拿得到才有）。
 *   两种情况：
 *   - 上游回非 2xx；
 *   - 上游回 2xx，但响应体解析不成 JSON，或者没有非空的 `choices` 数组（中转站
 *     把报错塞进 200 响应体就是这样）。这时 `llmStatus` 就是那个 2xx，而且不管
 *     requireContent 取什么都抛。
 *   这三个字段只在上游确实答复了的时候出现——网络直接炸、超时的时候不会有，接入
 *   方据此也能分清「上游拒了」和「根本没连上」。
 *   `choices` 在、只是 content 为空（纯 tool_calls、被内容审核拦下）是合法的空
 *   生成，requireContent 为 false 时照常返回；为 true 时抛的那条错误不带上面这些
 *   标注。
 */
export async function callLlm(payload, options = {}) {
  const requireContent = options.requireContent !== false;
  const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 300000;
  const fetchImpl = options.fetch || globalThis.fetch;
  const normalizedApiUrl = normalizeAiApiUrl(payload.apiUrl);
  const requestBody = buildLlmRequestBody(payload, options);

  const aiResponse = await fetchImpl(normalizedApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${payload.apiKey}`
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!aiResponse.ok) {
    // 失败原因全在响应体里（模型名写错 / 余额不够 / 上下文超长 / 被内容审核拦
    // 下，状态行一律只说 400 Bad Request）。这一步的 fetch signal 还没解除，读
    // body 同样受 timeoutMs 约束，不会在这里挂死。
    const detail = await readUpstreamErrorDetail(aiResponse);

    if (aiResponse.status === 405) {
      throw buildUpstreamError(
        `AI API error: 405 Method Not Allowed. ` +
        `apiUrl must point to a full chat endpoint (for example: /chat/completions). ` +
        `Received: ${normalizedApiUrl}`,
        aiResponse.status,
        detail
      );
    }

    throw buildUpstreamError(
      `AI API error: ${aiResponse.status} ${aiResponse.statusText || 'Unknown Error'}. ` +
      `Request URL: ${normalizedApiUrl}`,
      aiResponse.status,
      detail
    );
  }

  // 2xx 不等于拿到了 chat completion：不少中转站出错时照样回 200，响应体里装的
  // 是 `{"error":{…}}`、没有 choices；反代返回的 HTML 页面也可能是 200。这些都
  // 按上游报错抛出去，不看 requireContent——它管的是「content 为空算不算错」，
  // 不管「响应格式坏了算不算错」。放过去的话下游拿到的是一个空输出，会当成「模型
  // 这轮没说话」跳过，任务被当成功消费，失败原因一个字都不留。
  // ok 为真却没带 status 的只可能是假响应，按 200 记。
  const okStatus = Number.isInteger(aiResponse.status) ? aiResponse.status : 200;
  const body = await readCompletionBody(aiResponse);

  if (!body.parsed) {
    throw buildUpstreamError(
      `AI API error: HTTP ${okStatus} but body is not valid JSON. ` +
      `Request URL: ${normalizedApiUrl}`,
      okStatus,
      describeUnparsableBody(body.raw)
    );
  }

  const aiData = body.data;
  if (!isChatCompletionShape(aiData)) {
    throw buildUpstreamError(
      `AI API error: HTTP ${okStatus} but body is not a chat completion (no choices). ` +
      `Request URL: ${normalizedApiUrl}`,
      okStatus,
      describeNonCompletionBody(aiData)
    );
  }

  const rawContent = aiData.choices[0]?.message?.content;
  if (requireContent && (typeof rawContent !== 'string' || !rawContent.trim())) {
    throw new Error('AI API error: response missing choices[0].message.content');
  }

  return { response: aiData, content: typeof rawContent === 'string' ? rawContent.trim() : '' };
}

/**
 * Build OpenAI-compatible request body.
 *
 * messages mode: forward the caller's OpenAI-style array verbatim — no
 * auto role injection, no concatenation back to a single user message.
 * Lets the upstream app preserve system / multi-turn context
 * byte-for-byte. A missing / empty `payload.messages` falls back to
 * wrapping `payload.completePrompt` into a single user message.
 *
 * `temperature`: only inject the 0.8 default for the legacy
 * completePrompt path; messages mode forwards whatever the upstream app
 * set (or nothing) so behavior matches their main chat path.
 *
 * `max_tokens` is optional:
 * - include it only when payload.maxTokens is provided
 * - omit it when payload.maxTokens is undefined / null
 *
 * `tools` / `tool_choice` are optional as well: forwarded only when
 * `options.forwardTools` is not `false` and the caller passes a
 * non-empty payload.tools. An empty array is treated as "no tools"
 * because some OpenAI-compatible relays reject `tools: []`.
 *
 * `payload.llmExtraBody`（可选，普通对象）：原样展开进请求体，给上游中转的
 * 非标准参数用（thinking / reasoning_effort 之类库不认识也不该认识的字段）。
 * 先展开它、再写核心字段——model / messages / temperature / max_tokens /
 * tools 永远以库的口径为准，extra body 撞了这些键也盖不掉。
 *
 * @param {Object} payload
 * @param {{ stream?: boolean, forwardTools?: boolean }} [options]
 *   stream — set to include an explicit `stream` field in the body
 *   (instant passes `false`: one-shot, non-streaming by contract);
 *   omit to leave the field out entirely (server behavior).
 * @returns {Object}
 */
export function buildLlmRequestBody(payload, options = {}) {
  const llmMessages = Array.isArray(payload.messages) && payload.messages.length > 0
    ? payload.messages
    : [{ role: 'user', content: payload.completePrompt }];

  const extraBody = payload.llmExtraBody && typeof payload.llmExtraBody === 'object' && !Array.isArray(payload.llmExtraBody)
    ? payload.llmExtraBody
    : null;

  const requestBody = {
    // 先展开 extra body，核心字段随后写入（撞键时核心字段赢）。
    ...(extraBody || {}),
    model: payload.primaryModel,
    messages: llmMessages,
  };

  if (options.stream !== undefined) {
    requestBody.stream = options.stream;
  }

  if (payload.temperature !== undefined && payload.temperature !== null) {
    requestBody.temperature = payload.temperature;
  } else if (!Array.isArray(payload.messages)) {
    requestBody.temperature = 0.8;
  }

  if (options.forwardTools !== false && Array.isArray(payload.tools) && payload.tools.length > 0) {
    requestBody.tools = payload.tools;
    if (payload.toolChoice !== undefined && payload.toolChoice !== null) {
      requestBody.tool_choice = payload.toolChoice;
    }
  }

  if (payload.maxTokens === undefined || payload.maxTokens === null) {
    return requestBody;
  }

  if (!Number.isInteger(payload.maxTokens) || payload.maxTokens <= 0) {
    throw new Error('Invalid maxTokens: maxTokens must be a positive integer when provided.');
  }

  requestBody.max_tokens = payload.maxTokens;
  return requestBody;
}

/**
 * Normalize the AI API URL for OpenAI-compatible chat endpoints.
 *
 * Rules (idempotent — running it twice is the same as running it once):
 *   - Already ends with `/chat/completions`           → leave as-is.
 *   - Bare host (no path or just `/`)                  → append `/v1/chat/completions`.
 *   - Path ends with a version segment like `/v1`,
 *     `/v2`, … (with or without trailing slash)       → append only `/chat/completions`
 *     (never doubles `/v1` for callers who already
 *      include it).
 *   - Anything else (custom path that doesn't match
 *     the OpenAI shape, e.g. `/v1/messages` for
 *     Anthropic-style proxies, or `/openai/api/foo`)   → leave as-is. We don't
 *     guess — the caller knows their own routing.
 *
 * The query string is preserved verbatim.
 *
 * @param {string} apiUrl
 * @returns {string}
 */
export function normalizeAiApiUrl(apiUrl) {
  const trimmed = String(apiUrl || '').trim();
  if (!trimmed) {
    throw new Error(
      'Invalid apiUrl: apiUrl is required. Please provide a chat endpoint URL ' +
      '(for example: https://api.openai.com or https://api.openai.com/v1/chat/completions).'
    );
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid apiUrl: "${apiUrl}". Please provide a valid absolute URL.`
    );
  }

  let path = parsed.pathname.replace(/\/+$/, '') || '/';

  if (/\/chat\/completions$/.test(path)) {
    // Already a complete OpenAI-style endpoint. Don't double-suffix.
  } else if (path === '/') {
    // Bare host → assume OpenAI shape.
    path = '/v1/chat/completions';
  } else if (/\/v\d+$/.test(path)) {
    // Path ends in a version segment (e.g. `/v1`, `/v2`). User already
    // versioned the URL — just append `/chat/completions`, never re-add `/v1`.
    path = `${path}/chat/completions`;
  }
  // Any other custom path is left untouched on purpose.

  parsed.pathname = path;
  return parsed.toString();
}

// ─── 上游错误体解析 ─────────────────────────────────────────────────────

/**
 * 上游 HTTP 失败 → 带机读标注的 Error。
 *
 * 挂在错误上的三个字段都是给接入方分流用的（「Key 失效 → 提示用户去改配置」
 * 这类判断，不该靠正则匹配面向人的那句话）：
 *
 *   - `code` —— 稳定的失败类别。取 `'LLM_CALL_FAILED'` 与 amsg-instant 的
 *     LlmCallError 同值，那边包装一层之后仍然是它；server 侧会把它记进
 *     last_error 的 `errorCode`，「这一跳是 LLM 挂了还是推送挂了」一眼能分。
 *   - `llmStatus` —— 上游回的 HTTP 状态码。**刻意不叫 `statusCode`**：
 *     sendWebPush 用 `statusCode` 挂推送服务的状态码，而 amsg-server 的投递侧
 *     对捕获到的异常一律读 `error.statusCode` 当推送状态用，410 / 404 / 413
 *     会被判成终态。LLM 回的 404（模型名写错）、413（请求体过大）要是借用同一
 *     个字段名，就会被当成「订阅已失效」把任务永久判死。两条上游各用各的字段
 *     名，数字才不会串台。
 *   - `providerCode` —— provider 自己的机读错误码（`invalid_api_key` /
 *     `insufficient_quota` / `context_length_exceeded` / `content_filter` …），
 *     拿不到就不挂这个字段。
 *
 * 说明文字同时并进 `message`：server 侧的 last_error 只透 `reason` 和
 * `errorCode` 两样，状态码和 provider code 不写进消息里就彻底看不到了。拼接
 * 格式跟 webpush.js 的 `Web Push delivery failed: 410 Gone — …` 对齐。
 *
 * @param {string} summary - 状态行 + 请求 URL 那段固定说明
 * @param {number} status - 上游回的 HTTP 状态码
 * @param {{ message: string, code: string }} detail - 见 {@link readUpstreamErrorDetail}
 * @returns {Error}
 */
function buildUpstreamError(summary, status, detail) {
  const error = new Error(
    summary +
    (detail.message ? ` — ${detail.message}` : '') +
    (detail.code ? ` (provider code: ${detail.code})` : '')
  );
  error.code = 'LLM_CALL_FAILED';
  error.llmStatus = status;
  if (detail.code) error.providerCode = detail.code;
  return error;
}

/**
 * 读上游的错误响应体，挖出「人能看懂的原因」和「机器能判的码」。
 *
 * OpenAI 兼容生态里错误体的形状并不统一，常见的几种：
 *   - OpenAI / Azure / 多数中转：`{ error: { message, type, code, param } }`
 *   - Anthropic：`{ type: 'error', error: { type, message } }` —— 没有 code，
 *     判类别靠 `type`
 *   - Gemini：`{ error: { code: 400, message, status: 'INVALID_ARGUMENT' } }`
 *     —— 这里的 `code` 就是 HTTP 状态码的复读，机读的类别在 `status` 上
 *   - 国内中转常见的 `{ code, msg }`
 *   - 自建中转 / 反代出问题时干脆不是 JSON：HTML 错误页、纯文本
 *
 * 所以按「先找最精确的，找不到退一层」的顺序取（见
 * {@link extractErrorEnvelopeDetail}），认不出来就退回响应体原文——一句没解析
 * 出来的原文也比一句都没有强。
 *
 * 读响应体本身也可能失败（连接读到一半断了、调用方喂的是没有 `text()` 的假
 * 响应），这时只当作「没拿到细节」：真正要报的是那条 HTTP 失败，不能被读
 * body 的二次失败盖掉。
 *
 * @param {Response} response
 * @returns {Promise<{ message: string, code: string }>} 拿不到的字段是空串
 */
async function readUpstreamErrorDetail(response) {
  let raw;
  let truncated = false;
  try {
    ({ text: raw, truncated } = await readBoundedBody(response));
  } catch {
    return { message: '', code: '' };
  }
  if (typeof raw !== 'string' || !raw.trim()) return { message: '', code: '' };

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    // 被 UPSTREAM_ERROR_BODY_MAX_BYTES 切断的 JSON：前缀不可能 parse 得过，而
    // 「中转把整个请求原样回显」恰恰是那个上限唯一要挡的场景。这时退回原文的话，
    // detail 会变成 300 字符的裸 JSON（里面还是被回显的 prompt），上游真正那句
    // 话和 code 全丢，所以先从残缺前缀里把字段捞出来。
    if (truncated && looksLikeJson(raw)) {
      const salvaged = salvageJsonStringFields(raw);
      return {
        message: clampDetail(salvaged.message || TRUNCATED_BODY_NOTE),
        code: clampCode(salvaged.code),
      };
    }
    // 不是 JSON（HTML 错误页、纯文本）——原文就是唯一的线索。
    return { message: clampDetail(raw), code: '' };
  }

  // 是 JSON 但字段一个都不认识时，退回原文。
  return extractErrorEnvelopeDetail(body, { fallbackMessage: raw });
}

/**
 * 从已经解析好的错误信封里取「人能看懂的原因」和「机器能判的码」。认得的形状
 * 见 {@link readUpstreamErrorDetail}。
 *
 * code 默认只认字符串：非 2xx 的响应体里，数字 code 基本就是 HTTP 状态码本身
 *（Gemini 就是这样），那个数字已经在 `llmStatus` 里了，取字符串码才有增量信息。
 * 2xx 却装着报错的响应体不一样，`llmStatus` 是 200，响应体里的 `401` 才是真实
 * 原因，这时传 `keepNumericCode`：找不到字符串码就把数字码转成字符串留下。
 *
 * @param {unknown} body - 已经解析好的响应体
 * @param {{ fallbackMessage?: string, keepNumericCode?: boolean }} [options]
 *   fallbackMessage —— 一个说明字段都认不出时用的话，默认空串。
 * @returns {{ message: string, code: string }} 拿不到的字段是空串
 */
function extractErrorEnvelopeDetail(body, { fallbackMessage = '', keepNumericCode = false } = {}) {
  const envelope = body && typeof body === 'object' ? body : {};
  const inner = envelope.error && typeof envelope.error === 'object' ? envelope.error : {};

  const message = firstNonEmptyString(
    inner.message,                                          // OpenAI / Anthropic / Gemini
    typeof envelope.error === 'string' ? envelope.error : '', // `{ error: "unauthorized" }`
    envelope.message,                                        // 一批中转把 message 放最外层
    envelope.msg,                                            // 国内中转的 `{ code, msg }`
    envelope.detail                                          // FastAPI 风格的自建中转
  ) || fallbackMessage;

  const code = firstNonEmptyString(
    inner.code,    // OpenAI：invalid_api_key / insufficient_quota / context_length_exceeded
    inner.status,  // Gemini：INVALID_ARGUMENT / RESOURCE_EXHAUSTED
    inner.type,    // Anthropic：invalid_request_error / overloaded_error
    envelope.code
  ) || (keepNumericCode ? firstIntegerString(inner.code, envelope.code) : '');

  return { message: clampDetail(message), code: clampCode(code) };
}

// ─── 2xx 响应体解析 ─────────────────────────────────────────────────────

/** 2xx 响应体是空的时说的话。 */
const EMPTY_BODY_NOTE = 'response body is empty';

/** 2xx 却不是 chat completion、又认不出报错字段时，最多列这么多个顶层字段名。 */
const NON_COMPLETION_KEYS_MAX = 10;

/**
 * 读 2xx 的响应体，只读一次。
 *
 * 先按原文读、再自己 parse（真 Response 的 `json()` 做的也就是这两步），原文留
 * 着：解析不成 JSON 时原文是唯一的线索，而流已经读完了，没法再读第二遍。成功的
 * 响应体不设读取上限，正文就是要用的东西，不能像错误体那样只读开头。
 *
 * 没有 `text()` 的假响应（经 options.fetch 注入的桩常常只实现了 `json()`）退回
 * `json()`，这时拿不到原文。只有 SyntaxError 算「不是 JSON」，其余异常（连接读
 * 到一半断了、超时）原样往外抛——那是没连上，不是上游答复了一个坏响应。
 *
 * @param {Response} response
 * @returns {Promise<{ parsed: true, data: unknown } | { parsed: false, raw: string|null }>}
 *   `raw` 为 null 表示拿不到原文
 */
async function readCompletionBody(response) {
  if (typeof response.text === 'function') {
    const raw = await response.text();
    try {
      return { parsed: true, data: JSON.parse(raw) };
    } catch {
      return { parsed: false, raw: typeof raw === 'string' ? raw : null };
    }
  }

  try {
    return { parsed: true, data: await response.json() };
  } catch (error) {
    if (error && /** @type {any} */ (error).name === 'SyntaxError') return { parsed: false, raw: null };
    throw error;
  }
}

/**
 * @param {unknown} data
 * @returns {boolean} 有非空的 `choices` 数组
 */
function isChatCompletionShape(data) {
  return !!data
    && typeof data === 'object'
    && Array.isArray(/** @type {any} */ (data).choices)
    && /** @type {any} */ (data).choices.length > 0;
}

/**
 * 2xx 响应体解析不成 JSON → 错误说明。
 *
 * 反代的 HTML 页面、纯文本跟非 2xx 一样原文照抄（脱敏、截断），那就是唯一的
 * 线索。
 *
 * SSE 流例外，只给一句固定说明、**不回显原文**：库里的 LLM 调用都是非流式的，
 * 2xx 回来一段 `data: {…"delta":{"content":…}}`，只可能是中转站无视了
 * `stream: false`。这时原文就是模型生成的聊天正文，而这句话会落进 server 的
 * last_error 明文列——跟 {@link describeNonCompletionBody} 只列字段名是同一个理由。
 *
 * 流的第一行不一定是 `data:`：可能是注释保活行（OpenRouter 的
 * `: OPENROUTER PROCESSING`），也可能是 `id:` / `retry:` 字段，正文在后面几行。
 * 所以开头是注释、或者任意一行的行首是 SSE 字段，都当成流。误判的方向是安全的：
 * 一段恰好有一行以 `id:` 开头的纯文本报错，只是少了原文说明。
 *
 * @param {string|null} raw - 响应体原文；null 表示拿不到
 * @returns {{ message: string, code: string }}
 */
function describeUnparsableBody(raw) {
  if (raw === null) return { message: '', code: '' };
  const trimmed = raw.trim();
  if (!trimmed) return { message: EMPTY_BODY_NOTE, code: '' };
  if (looksLikeSseStream(trimmed)) return { message: SSE_BODY_NOTE, code: '' };
  return { message: clampDetail(raw), code: '' };
}

/**
 * @param {string} trimmed - 去掉首尾空白的响应体原文
 * @returns {boolean} 开头是 SSE 注释行，或者有一行的行首是 SSE 字段
 */
function looksLikeSseStream(trimmed) {
  return trimmed.startsWith(':') || SSE_FIELD_LINE.test(trimmed);
}

/** 行首是 SSE 字段（`data:` / `event:` / `id:` / `retry:`）的一行，不分大小写、逐行匹配。 */
const SSE_FIELD_LINE = /^(?:data|event|id|retry):/im;

/** 2xx 响应体是 SSE 流时说的话。原文是生成的正文，不回显。 */
const SSE_BODY_NOTE = 'response body looks like an SSE stream (the endpoint ignored stream: false)';

/**
 * 2xx 响应体是 JSON、但不是 chat completion → 错误说明。
 *
 * 认得出报错字段（中转站把报错塞进 200 的那种）就跟非 2xx 一样取原话和错误码，
 * 数字错误码也留下，理由见 {@link extractErrorEnvelopeDetail}。
 *
 * 一个报错字段都认不出时**不回显原文**，只列顶层字段名。这种响应多半本身是成功
 * 的，只是形状不对（apiUrl 指到了 Anthropic 原生 /v1/messages 这类端点），里面
 * 装着生成出来的正文；而这句话会落进 server 的 last_error 明文列。看出「这是哪
 * 家的格式」，有字段名就够了。
 *
 * @param {unknown} data - 已经解析好的响应体
 * @returns {{ message: string, code: string }}
 */
function describeNonCompletionBody(data) {
  const detail = extractErrorEnvelopeDetail(data, { keepNumericCode: true });
  if (detail.message || detail.code) return detail;

  let shape;
  if (Array.isArray(data)) {
    shape = 'response body is a JSON array';
  } else if (data && typeof data === 'object') {
    const keys = Object.keys(data);
    shape = keys.length === 0
      ? 'response body is an empty object'
      : `top-level keys: ${keys.slice(0, NON_COMPLETION_KEYS_MAX).join(', ')}` +
        (keys.length > NON_COMPLETION_KEYS_MAX ? ', …' : '');
  } else {
    shape = `response body is ${data === null ? 'null' : `a JSON ${typeof data}`}`;
  }
  return { message: clampDetail(shape), code: '' };
}

/**
 * 读上游错误响应体的开头一段（最多 {@link UPSTREAM_ERROR_BODY_MAX_BYTES}
 * 字节），读够就把流断开。
 *
 * 能拿到 `response.body` 就边读边数字节；拿不到（调用方喂的是只实现了
 * `text()` 的假响应）退回整段读。
 *
 * `truncated` 告诉调用方「这段文本是被上限切出来的前缀」，好让 JSON 解析失败
 * 时知道该走容错提取而不是把前缀当原文外传。正好读满上限的完整响应体也会被算
 * 成 truncated，但那种情况下 JSON 本来就 parse 得过，这个标记不起作用。
 *
 * @param {Response} response
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
async function readBoundedBody(response) {
  const body = response && response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = typeof response.text === 'function' ? await response.text() : '';
    return { text, truncated: false };
  }

  const reader = body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (bytes < UPSTREAM_ERROR_BODY_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      chunks.push(value);
      bytes += value.length;
    }
  } finally {
    // 读完了再 cancel 是空操作；连接早断了则抛在这里——那跟这次要报的 HTTP
    // 失败无关，不能让它盖掉。
    try { await reader.cancel(); } catch { /* 读 body 的二次失败不外传 */ }
  }

  return {
    text: utf8Decode(concatBytes(...chunks)),
    truncated: bytes >= UPSTREAM_ERROR_BODY_MAX_BYTES,
  };
}

/** 截断的 JSON 前缀里一个字段都没捞到时说的话。总比一段裸 JSON 强。 */
const TRUNCATED_BODY_NOTE = 'upstream error body was truncated before any readable message';

/**
 * 从残缺的 JSON 前缀里扫字符串字段：`"message": "…"` 这种形状，值里的转义
 *（`\"` / `\\`）跟着一起吃掉，免得在半个转义序列上断开。值本身要是被截断了
 *（没有收尾的引号）就匹配不上，那种半截话不如不要。
 */
const JSON_STRING_FIELD = /"(message|detail|code|status|type)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/** @param {string} raw */
function looksLikeJson(raw) {
  return /^\s*[{[]/.test(raw);
}

/**
 * @param {string} raw 残缺的 JSON 前缀
 * @returns {{ message: string, code: string }} 捞不到的字段是空串
 */
function salvageJsonStringFields(raw) {
  /** @type {Record<string, string>} */
  const found = {};
  for (const match of raw.matchAll(JSON_STRING_FIELD)) {
    // 同名字段只认第一个：错误信封在最前面，后面重复出现的多半来自被回显的请求。
    if (found[match[1]] !== undefined) continue;
    const value = unescapeJsonString(match[2]);
    // Anthropic 信封最外层的 `"type":"error"` 是「这是一条错误」的判别字段，
    // 不是错误类别（完整 parse 那条路也只读 error 里面的 type）。跳过它，
    // 里层真正的 `"type":"authentication_error"` 才轮得上。
    if (match[1] === 'type' && value === 'error') continue;
    found[match[1]] = value;
  }
  return {
    message: firstNonEmptyString(found.message, found.detail),
    code: firstNonEmptyString(found.code, found.status, found.type),
  };
}

/**
 * @param {string} value JSON 字符串字面量的内容（不含两侧引号）
 * @returns {string}
 */
function unescapeJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    // 转义序列本身不合法时原样返回：拿到这句话比转义准确更要紧。
    return value;
  }
}

/**
 * 把上游说明压成能安全外传的一行：压平空白 → 遮凭据 → 截断。
 *
 * @param {unknown} text
 * @returns {string}
 */
function clampDetail(text) {
  const flattened = String(text ?? '').replace(/\s+/g, ' ').trim();
  const safe = redactCredentials(flattened);
  return safe.length > UPSTREAM_ERROR_DETAIL_MAX_CHARS
    ? `${safe.slice(0, UPSTREAM_ERROR_DETAIL_MAX_CHARS - 1)}…`
    : safe;
}

/**
 * @param {unknown} code
 * @returns {string}
 */
function clampCode(code) {
  return String(code ?? '').replace(/\s+/g, ' ').trim().slice(0, UPSTREAM_ERROR_CODE_MAX_CHARS);
}

/**
 * 「短前缀 + 长随机串」形态的 key（`sk-…` / `xai-…` / `sk-ant-api03-…`）。
 *
 * 尾巴按整段算长度，不要求它以字母数字收尾：真实 Key 的随机段里经常夹着 `-`
 * 和 `_`（`sk-9aBcDeFgHiJkLmNo_PqRsTu`），按「结尾必须是一长串字母数字」去卡
 * 的话，这类 Key 只会被遮掉前半截。
 */
const CREDENTIAL_LIKE_TOKEN = /\b[A-Za-z]{2,6}-[A-Za-z0-9_-]{16,}/g;

/** 光长随机串（base64 / JWT 片段）：没有前缀也照遮。 */
const LONG_OPAQUE_RUN = /[A-Za-z0-9+/_.-]{48,}/g;

/**
 * 模型 ID 的形状：全小写字母数字，被 `-` / `.` 切成一串短段，每段不超过 12 个
 * 字符（`gpt-4o-mini-2024-07-18`、`claude-3-5-sonnet-20241022`）。这类串同时
 * 也落在 {@link CREDENTIAL_LIKE_TOKEN} 的形状里，脱敏时得先把它们认出来——上游
 * 那句「你写的这个模型不存在」里最关键的就是模型名，遮掉之后报错只剩「有个东西
 * 不存在」。
 *
 * Key 只要带大写字母、带下划线，或者有任何一段超过 12 个字符，就落不进这个形
 * 状，照常遮掉。光靠这个形状还不够，见 {@link looksLikeModelId}。
 */
const MODEL_ID_LIKE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]{1,12})+$/;

/** 超过这个长度就不再当模型名看待：再长的短段串更可能是 Key，一律遮掉。 */
const MODEL_ID_MAX_CHARS = 64;

/**
 * 公认的凭据前缀：跟在它后面的东西不管长什么形状都不是模型名。自建中转
 *（one-api / new-api / LiteLLM 这类）发的 Key 常常是全小写、按短横线分段的，
 * 大形状跟模型 ID 一模一样，先靠前缀把它们摘出来。
 */
const CREDENTIAL_PREFIX_SEGMENTS = new Set([
  'sk', 'pk', 'ak', 'api', 'apikey', 'key', 'token', 'secret',
  'auth', 'bearer', 'session', 'sess', 'pat', 'xai', 'gsk',
]);

/** uuid（8-4-4-4-12 hex）。中转爱直接拿它当 Key 发，模型名不会长这样。 */
const UUID_SHAPE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

/** 一段里字母块和数字块来回切了几次。段已经由 {@link MODEL_ID_LIKE} 保证是 `[a-z0-9]+`。 */
function alternationCount(segment) {
  return (segment.match(/[a-z]+|[0-9]+/g) || []).length;
}

/** MoE 尺寸段（`8x7b` / `8x22b`）：真实模型名里唯一「字母数字来回切三次以上」的形状。 */
const MOE_SIZE_SEGMENT = /^\d+x\d+b$/;

/** 全由 hex 字符组成的段。纯数字（日期段 `20241022`）也算，靠累计长度阈值区分。 */
const HEX_SEGMENT = /^[0-9a-f]+$/;

/**
 * 连续 hex 段累计超过这个长度就当密钥材料。模型名里最长的 hex 形状是日期
 *（`2024-07-18` 拆成段累计 8 个字符），密钥的 hex 段是成串出现的
 *（`aaaabbbbcccc-ddddeeeeffff` 累计 24 个）。
 */
const HEX_RUN_MAX_CHARS = 15;

/**
 * 这个 token 是不是「像模型名」。拿不准时宁可误遮：漏放一个 Key 就是把凭据写
 * 进明文列并回给浏览器，误遮一个冷门模型名只是报错里少了个名字。
 *
 * 光看 {@link MODEL_ID_LIKE} 的形状会把 Key 一起放行：中转发的
 * `sk-550e8400-e29b-41d4-a716-446655440000`、`mycorp-aaaabbbbcccc-ddddeeeeffff`
 * 全小写、每段都不超过 12 个字符，跟模型 ID 完全同形。所以形状之外还要过四道：
 *
 *   - 公认的凭据前缀后面接什么都不豁免；
 *   - uuid 形状永远不是模型名；
 *   - 连续 hex 段累计超过 {@link HEX_RUN_MAX_CHARS} 个字符就不是模型名——
 *     全小写 Key 的随机段基本都落在 hex 字母表里，而字母数字不来回切的
 *     （`aaaabbbbcccc`）光靠下一条认不出来；
 *   - 出现「随机段」（字母数字来回切三次以上）就不是模型名，只有 `8x7b` 这种
 *     MoE 尺寸段例外——`al7b` 这类同样短的随机段不再搭它的便车。
 *
 * 这几道挡的是已知的 Key 形状，不是「凡是 Key 都能认出来」：跟真实模型名
 * 同形的串（全小写非 hex 的词段拼起来）单看形状分不开，那种只能靠上面的
 * 凭据前缀名单兜。
 *
 * @param {string} token
 * @returns {boolean}
 */
function looksLikeModelId(token) {
  if (token.length > MODEL_ID_MAX_CHARS) return false;
  if (!MODEL_ID_LIKE.test(token)) return false;
  if (UUID_SHAPE.test(token)) return false;

  const segments = token.split(/[.-]/);
  if (CREDENTIAL_PREFIX_SEGMENTS.has(segments[0])) return false;

  let hexRunChars = 0;
  for (const segment of segments) {
    if (HEX_SEGMENT.test(segment)) {
      hexRunChars += segment.length;
      if (hexRunChars > HEX_RUN_MAX_CHARS) return false;
    } else {
      hexRunChars = 0;
    }
  }

  return segments.every(
    (segment) => alternationCount(segment) < 3 || MOE_SIZE_SEGMENT.test(segment)
  );
}

/**
 * 遮掉长得像凭据的串。
 *
 * 脱敏规则只有这一处：amsg-server 的 `sanitizeErrorSummary`（落库的
 * `last_error` 列）和 amsg-instant 的 cloudflare 适配器（跨域 502 响应体）都
 * 调这一份，各自只负责后面的截断长度。
 *
 * 这一层必须自己遮一遍，不能全指望下游：上游报错里最常见的凭据回显恰好是
 * 「Incorrect API key provided: sk-…」这种把 Key 原样抄回来的写法。
 *
 * @param {string} text
 * @returns {string}
 */
export function redactCredentials(text) {
  let s = text;
  // Bearer 头与常见「前缀-长随机串」形态的 key。
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]');
  s = s.replace(CREDENTIAL_LIKE_TOKEN, (token) => (looksLikeModelId(token) ? token : '[redacted]'));
  // 长随机串这条也要认模型名，否则 48~64 字符的模型 ID
  //（`deepseek-ai.deepseek-v3-0324-thinking-preview-latest`）会在上一条放行之后
  // 被这里二次吞掉，「你写的这个模型不存在」又变回「有个东西不存在」。
  // 两端的分隔符先剥掉再判：句尾的 `.` 也在这条规则的字符集里，会跟着一起匹进来。
  s = s.replace(LONG_OPAQUE_RUN, (run) => {
    const token = run.replace(/^[._+/-]+/, '').replace(/[._+/-]+$/, '');
    return looksLikeModelId(token) ? run : '[redacted]';
  });
  return s;
}

/**
 * @param {...unknown} values
 * @returns {string} 第一个非空字符串，全都不是就返回空串
 */
function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

/**
 * @param {...unknown} values
 * @returns {string} 第一个整数转成的字符串，全都不是就返回空串
 */
function firstIntegerString(...values) {
  for (const value of values) {
    if (Number.isInteger(value)) return String(value);
  }
  return '';
}
