/**
 * Message Processor (SDK version)
 * ReiStandard amsg-server v2.4.0
 *
 * Handles single message content generation and Web Push delivery for
 * scheduled tasks (`fixed` / `prompted` / `auto`) and the
 * in-server instant path (`messageType: 'instant'`).
 *
 * Push wire shape comes from `@rei-standard/amsg-shared`'s
 * discriminated union (`AmsgPush`). The SW (`@rei-standard/amsg-sw`)
 * routes on `messageKind`. Server-driven pushes always carry
 * `source: 'instant'` (for the in-server instant path) or
 * `source: 'scheduled'` (for everything else).
 *
 * v2.4.0: when the LLM response carries non-empty
 * `choices[0].message.reasoning_content`, the processor now emits a
 * standalone `ReasoningPush` **before** the `ContentPush` burst.
 * `messagesSent` in the return value continues to reflect the sentence
 * count only (reasoning is an auxiliary push, not a sentence).
 */

import { randomUUID } from 'crypto';
import {
  buildContentPush,
  buildReasoningPush,
  readReasoningContent,
  stripReasoningTags,
} from '@rei-standard/amsg-shared';

import { decryptFromStorage, deriveUserEncryptionKey } from './encryption.js';

const DEFAULT_SPLIT_REGEX = /([。！？!?]+)/;

// Pacing between consecutive Web Push deliveries (reasoning → content, and
// between content sentences) so the client renders a natural typing cadence.
// Kept equal to amsg-instant's SLEEP_BETWEEN_MESSAGES_MS default.
const SLEEP_BETWEEN_MESSAGES_MS = 1500;

/**
 * Split a single chunk by one regex; on no-match return [chunk] so a later
 * regex in a cascade can still take a swing at it.
 */
function splitOnceByRegex(chunk, regex) {
  const out = chunk
    .split(regex)
    .reduce((acc, part, i, arr) => {
      if (i % 2 === 0 && part.trim()) {
        const punctuation = arr[i + 1] || '';
        acc.push(part.trim() + punctuation);
      }
      return acc;
    }, [])
    .filter(s => s.length > 0);
  return out.length > 0 ? out : [chunk];
}

/**
 * Sentence splitter for amsg-server's scheduled `splitPattern` feature
 * (see standards §6.1). Server-only: amsg-instant 0.8.0 dropped its
 * request-level `splitPattern`, so there is no instant counterpart to keep
 * in lockstep.
 *
 * @param {string} messageContent
 * @param {string | string[] | null} [splitPattern=null]
 * @returns {string[]}
 */
function splitMessageIntoSentences(messageContent, splitPattern = null) {
  const sources =
    splitPattern == null ? null :
    Array.isArray(splitPattern) ? splitPattern :
    [splitPattern];

  const regexes = (sources && sources.length > 0)
    ? sources.map(s => new RegExp(s))
    : [DEFAULT_SPLIT_REGEX];

  let chunks = [messageContent];
  for (const regex of regexes) {
    chunks = chunks.flatMap(c => splitOnceByRegex(c, regex));
  }

  return chunks.length > 0 ? chunks : [messageContent];
}

/**
 * @typedef {Object} ProcessorContext
 * @property {Object}  webpush           - The web-push module instance (already VAPID-configured).
 * @property {Object}  vapid             - { email, publicKey, privateKey }
 * @property {import('../adapters/interface.js').DbAdapter} db
 */

/**
 * Process a single database task row: decrypt → generate content → push.
 *
 * @param {import('../adapters/interface.js').TaskRow} task
 * @param {ProcessorContext} ctx
 * @param {string} [providedMasterKey]
 * @returns {Promise<{ success: boolean, messagesSent: number, error?: string }>}
 */
export async function processSingleMessage(task, ctx, providedMasterKey) {
  try {
    const masterKey = providedMasterKey || ctx.masterKey;
    if (!masterKey) {
      return { success: false, messagesSent: 0, error: 'TENANT_MASTER_KEY_MISSING' };
    }

    const userKey = deriveUserEncryptionKey(task.user_id, masterKey);
    const decryptedPayload = JSON.parse(decryptFromStorage(task.encrypted_payload, userKey));

    let messageContent;
    /** @type {unknown} */
    let llmResponse = null;

    if (decryptedPayload.messageType === 'fixed') {
      messageContent = decryptedPayload.userMessage;

    } else if (decryptedPayload.messageType === 'instant') {
      const hasPrompt = !!decryptedPayload.completePrompt
        || (Array.isArray(decryptedPayload.messages) && decryptedPayload.messages.length > 0);
      if (hasPrompt && decryptedPayload.apiUrl && decryptedPayload.apiKey && decryptedPayload.primaryModel) {
        const aiResult = await _callAI(decryptedPayload);
        messageContent = aiResult.content;
        llmResponse = aiResult.response;
      } else if (decryptedPayload.userMessage) {
        messageContent = decryptedPayload.userMessage;
      } else {
        throw new Error('Invalid instant message: no content source available');
      }

    } else if (decryptedPayload.messageType === 'prompted' || decryptedPayload.messageType === 'auto') {
      const aiResult = await _callAI(decryptedPayload);
      messageContent = aiResult.content;
      llmResponse = aiResult.response;
    } else {
      throw new Error('Invalid message configuration: no content source available');
    }

    // Auto-extract reasoning BEFORE the sentence split: when reasoning
    // came from the `<think>` fallback inside message.content, the same
    // span is still embedded in messageContent and would otherwise leak
    // as raw markup into ContentPush.
    const reasoning = readReasoningContent(llmResponse);
    if (reasoning) {
      messageContent = stripReasoningTags(messageContent);
    }

    // Sentence splitting (mirrors @rei-standard/amsg-instant
    // splitMessageIntoSentences — keep in lockstep; do not drift). Caller may
    // override the default regex via decryptedPayload.splitPattern (string
    // for a single regex, string[] for a cascade). Validation already enforces
    // length cap + RegExp compilability upstream.
    const messages = splitMessageIntoSentences(messageContent, decryptedPayload.splitPattern ?? null);

    if (!ctx.vapid.email || !ctx.vapid.publicKey || !ctx.vapid.privateKey) {
      throw new Error('VAPID configuration missing - push notifications cannot be sent');
    }

    const pushSubscription = decryptedPayload.pushSubscription;
    // sessionId is shared across the optional ReasoningPush and every
    // ContentPush from this LLM round. Pin it to the task id when
    // available (scheduled tasks) so retries reuse the same id;
    // otherwise mint a UUID.
    const sessionId = task.id != null
      ? `sess_task_${task.id}`
      : `sess_${randomUUID()}`;
    const source = decryptedPayload.messageType === 'instant' ? 'instant' : 'scheduled';
    const messageSubtype = decryptedPayload.messageSubtype || 'chat';
    const avatarUrl = decryptedPayload.avatarUrl || null;
    const metadata = decryptedPayload.metadata || {};

    // `messageId` format — deterministic when we have a task.id so a
    // retry produces the same id for the same (task, sentence) pair
    // (downstream dedupers can key on it). Falls back to a UUID for
    // the in-server instant path that has no row id.
    const messageIdBase = task.id != null
      ? `msg_task_${task.id}`
      : `msg_${randomUUID()}_instant`;

    // ReasoningPush — auto-emitted before the content burst when the
    // LLM response carried non-empty reasoning_content. `fixed` and
    // explicit-userMessage paths produce no LLM response, so this
    // block is naturally skipped for them (llmResponse stays null).
    if (reasoning) {
      const reasoningPush = buildReasoningPush({
        messageType: decryptedPayload.messageType,
        source,
        messageId: `${messageIdBase}_reasoning`,
        sessionId,
        reasoningContent: reasoning,
        timestamp: new Date().toISOString(),
        title: `来自 ${decryptedPayload.contactName}`,
        contactName: decryptedPayload.contactName,
        avatarUrl,
        messageSubtype,
        metadata,
      });
      await ctx.webpush.sendNotification(pushSubscription, JSON.stringify(reasoningPush));
      await new Promise(resolve => setTimeout(resolve, SLEEP_BETWEEN_MESSAGES_MS));
    }

    for (let i = 0; i < messages.length; i++) {
      const contentPush = buildContentPush({
        messageType: decryptedPayload.messageType,
        source,
        messageId: `${messageIdBase}_${i}`,
        sessionId,
        message: messages[i],
        timestamp: new Date().toISOString(),
        title: `来自 ${decryptedPayload.contactName}`,
        contactName: decryptedPayload.contactName,
        avatarUrl,
        messageSubtype,
        messageIndex: i + 1,
        totalMessages: messages.length,
        taskId: task.id || null,
        metadata,
      });

      await ctx.webpush.sendNotification(pushSubscription, JSON.stringify(contentPush));

      if (i < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, SLEEP_BETWEEN_MESSAGES_MS));
      }
    }

    return { success: true, messagesSent: messages.length };

  } catch (error) {
    return { success: false, messagesSent: 0, error: error.message };
  }
}

/**
 * Process a single message identified by UUID (used for instant type).
 *
 * @param {string} uuid
 * @param {ProcessorContext} ctx
 * @param {number} [maxRetries=2]
 * @param {string} [userId]
 * @param {string} [providedMasterKey]
 * @returns {Promise<{ success: boolean, messagesSent?: number, retriesUsed?: number, error?: Object }>}
 */
export async function processMessagesByUuid(uuid, ctx, maxRetries = 2, userId, providedMasterKey) {
  let retryCount = 0;
  const masterKey = providedMasterKey || ctx.masterKey;

  if (!masterKey) {
    return {
      success: false,
      error: { code: 'TENANT_MASTER_KEY_MISSING', message: '租户主密钥不存在或配置异常' }
    };
  }

  while (retryCount <= maxRetries) {
    let task;
    try {
      task = userId
        ? await ctx.db.getTaskByUuid(uuid, userId)
        : await ctx.db.getTaskByUuidOnly(uuid);
    } catch (error) {
      if (retryCount < maxRetries) {
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        continue;
      }

      return {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error.message, retriesAttempted: retryCount }
      };
    }

    if (!task) {
      return { success: false, error: { code: 'TASK_NOT_FOUND', message: '任务不存在或已处理' } };
    }

    const result = await processSingleMessage(task, ctx, masterKey);

    if (!result.success) {
      if (retryCount < maxRetries) {
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        continue;
      }

      try {
        await ctx.db.updateTaskById(task.id, { status: 'failed', retry_count: retryCount });
      } catch (_updateError) {
        // best-effort status update; keep original processing error as primary signal
      }

      return {
        success: false,
        error: { code: 'PROCESSING_ERROR', message: result.error, retriesAttempted: retryCount }
      };
    }

    try {
      await ctx.db.deleteTaskById(task.id);
    } catch (error) {
      try {
        await ctx.db.updateTaskById(task.id, { status: 'sent', retry_count: 0 });
      } catch (_markSentError) {
        // best effort: avoid re-sending if storage mutation partially fails
      }

      return {
        success: false,
        error: {
          code: 'POST_SEND_CLEANUP_FAILED',
          message: '消息已发送，但任务清理失败',
          details: { error: error.message }
        }
      };
    }

    return { success: true, messagesSent: result.messagesSent, retriesUsed: retryCount };
  }
}

/**
 * Call an OpenAI-compatible API.
 *
 * Returns the full response object alongside the extracted (trimmed)
 * `content` string. Callers that only need the text can ignore
 * `response`; callers that want `reasoning_content` / `tool_calls`
 * read from `response.choices[0].message`.
 *
 * @private
 * @param {Object} payload
 * @returns {Promise<{ response: unknown, content: string }>}
 */
async function _callAI(payload) {
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
  const content = aiData?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('AI API error: response missing choices[0].message.content');
  }

  return { response: aiData, content: content.trim() };
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
function buildAiRequestBody(payload) {
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
