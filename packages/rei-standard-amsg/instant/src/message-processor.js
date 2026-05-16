/**
 * Instant message processor.
 * ReiStandard amsg-instant
 *
 * Lifecycle of a single instant request:
 *   decrypt → call LLM (OpenAI-compatible) → split into sentences →
 *   send each sentence as its own Web Push notification (1500ms spacing) →
 *   return success.
 *
 * Push payload field shape MUST stay identical to
 * `server/src/server/lib/message-processor.js:78-93` so the same SW
 * (`@rei-standard/amsg-sw`) handles both scheduled and instant pushes
 * uniformly via the `source` discriminator.
 */

import { randomUUID } from 'crypto';

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
 * Normalize the AI API URL: trim whitespace, strip trailing slashes,
 * preserve query string. Does NOT auto-append /v1 or /chat/completions.
 */
function normalizeAiApiUrl(apiUrl) {
  const trimmed = String(apiUrl || '').trim();
  if (!trimmed) {
    throw new Error(
      'Invalid apiUrl: apiUrl is required. Please provide a full chat endpoint URL ' +
      '(for example: https://api.openai.com/v1/chat/completions).'
    );
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid apiUrl: "${apiUrl}". Please provide a valid absolute URL that points to a full chat endpoint.`
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.toString();
}

function buildAiRequestBody(payload) {
  const body = {
    model: payload.primaryModel,
    messages: [{ role: 'user', content: payload.completePrompt }],
    temperature: 0.8
  };

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
 * @param {Object} payload - Decrypted instant payload (already validated).
 * @param {Object} ctx
 * @param {Object} ctx.webpush         - web-push module (VAPID already applied).
 * @param {Function} [ctx.fetch]       - fetch impl (globalThis.fetch by default).
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
    const notificationPayload = {
      title: `来自 ${contactName}`,
      message: messages[i],
      contactName,
      messageId: `msg_${randomUUID()}_instant_${i}`,
      messageIndex: i + 1,
      totalMessages: messages.length,
      messageType: 'instant',
      messageSubtype,
      taskId: null,
      timestamp: new Date().toISOString(),
      source: 'instant',
      avatarUrl,
      metadata
    };

    try {
      await ctx.webpush.sendNotification(pushSubscription, JSON.stringify(notificationPayload));
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
