/**
 * OpenAI-compatible LLM call for the server-side fire chain.
 *
 * Extracted from message-processor.js so the agentic fire loop
 * (lib/agentic-fire.js) can call the LLM without a circular import.
 * The legacy single-shot path (processSingleMessage) and the multi-round
 * loop share this one function.
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
 * @param {{ requireContent?: boolean }} [options]
 *   requireContent defaults to true (legacy single-shot behavior:
 *   throw when the response carries no content). Tool rounds legitimately
 *   return no content (pure tool_calls), so the agentic loop passes
 *   `{ requireContent: false }` — same precedent as amsg-instant's
 *   callLlmRaw.
 * @returns {Promise<{ response: unknown, content: string }>}
 */
export async function callLlm(payload, options = {}) {
  const requireContent = options.requireContent !== false;
  const normalizedApiUrl = normalizeAiApiUrl(payload.apiUrl);
  const requestBody = buildAiRequestBody(payload);

  const aiResponse = await fetch(normalizedApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${payload.apiKey}`
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(300000)
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
 * `max_tokens` is optional:
 * - include it only when payload.maxTokens is provided
 * - omit it when payload.maxTokens is undefined / null
 *
 * @param {Object} payload
 * @returns {Object}
 */
export function buildAiRequestBody(payload) {
  // messages mode (added in v2.2.0): forward the caller's OpenAI-style array
  // verbatim — same contract as @rei-standard/amsg-instant 0.5.0+. No auto
  // role injection, no concatenation back to a single user message. Lets
  // the upstream app preserve system / multi-turn context byte-for-byte
  // across the schedule-message path.
  const llmMessages = Array.isArray(payload.messages) && payload.messages.length > 0
    ? payload.messages
    : [{ role: 'user', content: payload.completePrompt }];

  const requestBody = {
    model: payload.primaryModel,
    messages: llmMessages,
  };

  // Match the instant package's behavior: only inject default temperature
  // for the legacy completePrompt path; messages mode forwards whatever the
  // upstream app set (or nothing) so behavior matches their main chat path.
  if (payload.temperature !== undefined && payload.temperature !== null) {
    requestBody.temperature = payload.temperature;
  } else if (!Array.isArray(payload.messages)) {
    requestBody.temperature = 0.8;
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
 * Normalize AI API URL for OpenAI-compatible chat endpoints.
 *
 * **Keep in sync** with `@rei-standard/amsg-instant`'s
 * `src/message-processor.js` `normalizeAiApiUrl` — same rules, same
 * tests. The two packages share this logic but each carry their own copy
 * to avoid an architectural dependency (server should not depend on the
 * stateless worker package).
 *
 * @param {string} apiUrl
 * @returns {string}
 */
export function normalizeAiApiUrl(apiUrl) {
  if (typeof apiUrl !== 'string' || !apiUrl.trim()) {
    throw new Error(
      'Invalid apiUrl: apiUrl is required. ' +
      'Please provide a chat endpoint URL ' +
      '(for example: https://api.openai.com or https://api.openai.com/v1/chat/completions).'
    );
  }

  const trimmedApiUrl = apiUrl.trim();
  let parsedUrl;

  try {
    parsedUrl = new URL(trimmedApiUrl);
  } catch {
    throw new Error(
      `Invalid apiUrl: "${apiUrl}". Please provide a valid absolute URL.`
    );
  }

  let path = parsedUrl.pathname.replace(/\/+$/, '') || '/';

  if (/\/chat\/completions$/.test(path)) {
    // Already a complete OpenAI-style endpoint. Don't double-suffix.
  } else if (path === '/') {
    // Bare host → assume OpenAI shape.
    path = '/v1/chat/completions';
  } else if (/\/v\d+$/.test(path)) {
    // Path ends in `/v1`, `/v2`, … — caller already versioned the URL.
    // Append only `/chat/completions`; never re-add `/v1`.
    path = `${path}/chat/completions`;
  }
  // Any other custom path is left untouched on purpose.

  parsedUrl.pathname = path;
  return parsedUrl.toString();
}
