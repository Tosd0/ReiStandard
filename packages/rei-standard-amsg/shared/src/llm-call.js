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

// 上游错误说明能留多长。provider 的报错偶尔会把请求内容整段回显（内容审核类
// 的报错尤其爱这么干），而这段文本最终会落进 server 的 last_error 明文列、也
// 会随 instant 的 502 原样回给调用方。够看清原因就行，正文不必全留。
// server 的 sanitizeErrorSummary 还会把整条消息再截到 500 字符，这里留得比它
// 短一截，状态行和请求 URL 才不至于被说明文字挤掉。
const UPSTREAM_ERROR_DETAIL_MAX_CHARS = 300;

// provider 错误码的长度上限。code 是标识符不是人话，但也别让一个来路不明的超长
// 串撑大错误消息（与 server 记 last_error.errorCode 时的口径一致）。
const UPSTREAM_ERROR_CODE_MAX_CHARS = 64;

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
 *   `{ requireContent: false }`.
 *   timeoutMs defaults to 300000 (the legacy per-call ceiling).
 *   fetch defaults to `globalThis.fetch` (resolved at call time so test
 *   stubs on the global still take effect).
 *   stream / forwardTools are forwarded to {@link buildLlmRequestBody}.
 * @returns {Promise<{ response: unknown, content: string }>}
 * @throws {Error} 上游回非 2xx 时抛，错误上带机读标注（见
 *   {@link buildUpstreamError}）：`code` = `'LLM_CALL_FAILED'`、`llmStatus` =
 *   上游的 HTTP 状态码、`providerCode` = provider 自己的错误码（拿得到才有）。
 *   这三个字段只在上游确实答复了的时候出现——网络直接炸、超时、响应体不是
 *   合法 JSON 时不会有，接入方据此也能分清「上游拒了」和「根本没连上」。
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

  const aiData = await aiResponse.json();
  const rawContent = aiData?.choices?.[0]?.message?.content;
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
 *   - 自建中转 / 反代出问题时干脆不是 JSON：HTML 错误页、纯文本
 *
 * 所以按「先找最精确的，找不到退一层」的顺序取，认不出来就退回响应体原文——
 * 一句没解析出来的原文也比一句都没有强。
 *
 * code 只认字符串：实测里数字 code 基本就是 HTTP 状态码本身（Gemini 就是这
 * 样），那个数字已经在 `llmStatus` 里了，取字符串码才有增量信息。
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
  try {
    raw = typeof response.text === 'function' ? await response.text() : '';
  } catch {
    return { message: '', code: '' };
  }
  if (typeof raw !== 'string' || !raw.trim()) return { message: '', code: '' };

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    // 不是 JSON（HTML 错误页、纯文本）——原文就是唯一的线索。
    return { message: clampDetail(raw), code: '' };
  }

  const envelope = body && typeof body === 'object' ? body : {};
  const inner = envelope.error && typeof envelope.error === 'object' ? envelope.error : {};

  const message = firstNonEmptyString(
    inner.message,                                          // OpenAI / Anthropic / Gemini
    typeof envelope.error === 'string' ? envelope.error : '', // `{ error: "unauthorized" }`
    envelope.message,                                        // 一批中转把 message 放最外层
    envelope.detail                                          // FastAPI 风格的自建中转
  ) || raw;                                                  // 是 JSON 但字段一个都不认识

  const code = firstNonEmptyString(
    inner.code,    // OpenAI：invalid_api_key / insufficient_quota / context_length_exceeded
    inner.status,  // Gemini：INVALID_ARGUMENT / RESOURCE_EXHAUSTED
    inner.type,    // Anthropic：invalid_request_error / overloaded_error
    envelope.code
  );

  return { message: clampDetail(message), code: clampCode(code) };
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
 * 遮掉长得像凭据的串。
 *
 * 规则与 amsg-server 的 `sanitizeErrorSummary` 对齐（同一批正则、同一个判断
 * 标准）。那份在 server 包里，shared 是它的上游，反过来 import 不成立，所以
 * 这里留一份同规则的实现——改脱敏规则时两边一起改。
 *
 * 这一层必须自己遮一遍，不能全指望下游：server 那份只覆盖落库的 last_error，
 * amsg-instant 的 502 响应体不经过它；而上游报错里最常见的凭据回显恰好是
 * 「Incorrect API key provided: sk-…」这种把 Key 原样抄回来的写法。
 *
 * @param {string} text
 * @returns {string}
 */
function redactCredentials(text) {
  let s = text;
  // Bearer 头与常见「前缀-长随机串」形态的 key。
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]');
  s = s.replace(/\b[A-Za-z]{2,6}-[A-Za-z0-9_-]{16,}/g, '[redacted]');
  // 光长随机串（base64 / JWT 片段）也不放行。
  s = s.replace(/[A-Za-z0-9+/_.-]{48,}/g, '[redacted]');
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
