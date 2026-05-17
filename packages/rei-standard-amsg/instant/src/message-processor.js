/**
 * Instant message processor.
 * ReiStandard amsg-instant
 *
 * Lifecycle of a single instant request:
 *   call LLM (OpenAI-compatible) → split into sentences →
 *   send each sentence as its own Web Push notification (1500ms spacing) →
 *   return success.
 *
 * Push payload field shape MUST stay identical to
 * `server/src/server/lib/message-processor.js:78-93` so the same SW
 * (`@rei-standard/amsg-sw`) handles both scheduled and instant pushes
 * uniformly via the `source` discriminator.
 */

import { sendWebPush } from './webpush.js';
import { randomUUID } from './utils.js';

const SLEEP_BETWEEN_MESSAGES_MS = 1500;

/**
 * Split a message into individual sentences for sequential delivery.
 * Mirrors amsg-server message-processor.js:59-70 (do not drift).
 *
 * @param {string} messageContent
 * @returns {string[]}
 */
export function splitMessageIntoSentences(messageContent) {
  const sentences = messageContent
    .split(/([。！？!?]+)/)
    .reduce((acc, part, i, arr) => {
      if (i % 2 === 0 && part.trim()) {
        const punctuation = arr[i + 1] || '';
        acc.push(part.trim() + punctuation);
      }
      return acc;
    }, [])
    .filter(s => s.length > 0);

  return sentences.length > 0 ? sentences : [messageContent];
}

/**
 * Build the SW-facing JSON payload for a single sentence in an instant
 * burst. Exported so test suites can verify the wire shape without having
 * to decrypt RFC 8291 ciphertext.
 *
 * Field-for-field parity with `amsg-server/src/server/lib/message-processor.js:78-93`
 * is the contract — drift here will break the shared SW.
 *
 * @param {Object} args
 * @param {string} args.message
 * @param {number} args.index           - 0-based.
 * @param {number} args.total
 * @param {string} args.contactName
 * @param {string|null} [args.avatarUrl]
 * @param {string} [args.messageSubtype='chat']
 * @param {Object} [args.metadata={}]
 * @returns {Object}
 */
export function buildInstantPushPayload({
  message,
  index,
  total,
  contactName,
  avatarUrl = null,
  messageSubtype = 'chat',
  metadata = {},
}) {
  return {
    title: `来自 ${contactName}`,
    message,
    contactName,
    messageId: `msg_${randomUUID()}_instant_${index}`,
    messageIndex: index + 1,
    totalMessages: total,
    messageType: 'instant',
    messageSubtype,
    taskId: null,
    timestamp: new Date().toISOString(),
    source: 'instant',
    avatarUrl,
    metadata,
  };
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

function buildAiRequestBody(payload) {
  // messages mode: forward the caller's OpenAI-style array verbatim. No auto
  // role injection, no concatenation back to a single user message — the
  // point of this branch is to let the upstream app preserve system / multi-
  // turn context across the instant-push path.
  const llmMessages = payload.messages
    ? payload.messages
    : [{ role: 'user', content: payload.completePrompt }];

  const body = {
    model: payload.primaryModel,
    messages: llmMessages,
    // Instant path is one-shot, non-streaming by contract.
    stream: false,
  };

  // Default temperature only when caller didn't pick one AND we're in the
  // legacy completePrompt path. In messages mode we forward whatever the
  // upstream app set (or nothing) so behavior matches their main chat path
  // byte-for-byte.
  if (payload.temperature !== undefined && payload.temperature !== null) {
    body.temperature = payload.temperature;
  } else if (!payload.messages) {
    body.temperature = 0.8;
  }

  if (payload.maxTokens === undefined || payload.maxTokens === null) {
    return body;
  }

  if (!Number.isInteger(payload.maxTokens) || payload.maxTokens <= 0) {
    throw new Error('Invalid maxTokens: must be a positive integer when provided.');
  }

  body.max_tokens = payload.maxTokens;
  return body;
}

async function callLlm(payload, fetchImpl) {
  const url = normalizeAiApiUrl(payload.apiUrl);
  const requestBody = buildAiRequestBody(payload);

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${payload.apiKey}`
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(300000)
  });

  if (!res.ok) {
    if (res.status === 405) {
      throw new Error(
        'AI API error: 405 Method Not Allowed. apiUrl must point to a full chat endpoint ' +
        `(for example: /chat/completions). Received: ${url}`
      );
    }
    const statusText = res.statusText || 'Unknown Error';
    throw new Error(`AI API error: ${res.status} ${statusText}. Request URL: ${url}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('AI API error: response missing choices[0].message.content');
  }
  return content.trim();
}

/**
 * Process one instant message: LLM → split → push each sentence.
 *
 * @param {Object} payload - Validated instant payload.
 * @param {Object} ctx
 * @param {{ email: string, publicKey: string, privateKey: string }} ctx.vapid
 * @param {Function} [ctx.fetch]       - fetch impl (globalThis.fetch by default). Used for BOTH LLM and Web Push.
 * @param {Function} [ctx.sleep]       - sleep impl (testability).
 * @param {(e: { type: string }) => void} [ctx.onEvent]
 * @returns {Promise<{ messagesSent: number, sentAt: string }>}
 */
export async function processInstantMessage(payload, ctx) {
  const fetchImpl = ctx.fetch || globalThis.fetch;
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const onEvent = typeof ctx.onEvent === 'function' ? ctx.onEvent : () => {};

  let messageContent;
  try {
    messageContent = await callLlm(payload, fetchImpl);
    onEvent({ type: 'llm_done' });
  } catch (err) {
    const error = new Error(err?.message || 'LLM call failed');
    error.code = 'LLM_CALL_FAILED';
    throw error;
  }

  const messages = splitMessageIntoSentences(messageContent);
  const pushSubscription = payload.pushSubscription;
  const contactName = payload.contactName;
  const avatarUrl = payload.avatarUrl || null;
  const messageSubtype = payload.messageSubtype || 'chat';
  const metadata = payload.metadata || {};

  for (let i = 0; i < messages.length; i++) {
    const notificationPayload = buildInstantPushPayload({
      message: messages[i],
      index: i,
      total: messages.length,
      contactName,
      avatarUrl,
      messageSubtype,
      metadata,
    });

    try {
      await sendWebPush({
        subscription: pushSubscription,
        payload: JSON.stringify(notificationPayload),
        vapid: ctx.vapid,
        fetch: fetchImpl,
      });
      onEvent({ type: 'push_sent', messageIndex: i + 1, totalMessages: messages.length });
    } catch (err) {
      const error = new Error(err?.message || 'Web Push delivery failed');
      error.code = 'PUSH_SEND_FAILED';
      error.statusCode = err?.statusCode;
      error.messageIndex = i + 1;
      throw error;
    }

    if (i < messages.length - 1) {
      await sleep(SLEEP_BETWEEN_MESSAGES_MS);
    }
  }

  return {
    messagesSent: messages.length,
    sentAt: new Date().toISOString()
  };
}
