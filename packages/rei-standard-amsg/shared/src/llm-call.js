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
    if (aiResponse.status === 405) {
      throw new Error(
        `AI API error: 405 Method Not Allowed. ` +
        `apiUrl must point to a full chat endpoint (for example: /chat/completions). ` +
        `Received: ${normalizedApiUrl}`
      );
    }

    throw new Error(
      `AI API error: ${aiResponse.status} ${aiResponse.statusText || 'Unknown Error'}. ` +
      `Request URL: ${normalizedApiUrl}`
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
