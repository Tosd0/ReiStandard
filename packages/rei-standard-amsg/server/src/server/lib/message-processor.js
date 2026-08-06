/**
 * Message Processor (SDK version)
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

import { randomUUID } from './webcrypto-utils.js';
import {
  buildContentPush,
  buildReasoningPush,
  readReasoningContent,
  stripReasoningTags,
} from '@rei-standard/amsg-shared';

import { decryptFromStorage, deriveUserEncryptionKey } from './encryption.js';
import { callLlm } from './llm.js';
import { runAgenticFire, taskNeedsLlm, occurrenceSuffix, occurrenceMsOf, stampTaskIdentity } from './agentic-fire.js';
import { resolvePushSubscription } from './push-subscription-store.js';

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
 * @param {{ userKey: string, payload: Object } | null} [predecrypted] - 调用方
 *   （run-tick 的预扫描）已经解好的 payload；传了就不再解第二遍。
 * @returns {Promise<{ success: boolean, messagesSent: number, error?: string, errorCode?: string|null }>}
 */
export async function processSingleMessage(task, ctx, providedMasterKey, predecrypted = null) {
  try {
    const masterKey = providedMasterKey || ctx.masterKey;
    if (!masterKey) {
      return { success: false, messagesSent: 0, error: 'TENANT_MASTER_KEY_MISSING' };
    }

    const userKey = (predecrypted && predecrypted.userKey)
      || await deriveUserEncryptionKey(task.user_id, masterKey);
    const decryptedPayload = (predecrypted && predecrypted.payload)
      || JSON.parse(await decryptFromStorage(task.encrypted_payload, userKey));

    // Fire-time hooks: when the host configured onBeforeFire and the task
    // needs the LLM, offer the agentic path first. onBeforeFire → null
    // falls straight through to the frozen-prompt chain below, and
    // deployments without hooks never enter this branch — legacy behavior
    // is byte-identical. onBeforeFire → { skip: true } completes the fire
    // here as a zero-push success (no LLM call, no frozen-prompt fallback):
    // use it when the host can tell at fire time the message is moot.
    if (ctx.hooks && typeof ctx.hooks.onBeforeFire === 'function' && taskNeedsLlm(decryptedPayload)) {
      const agentic = await runAgenticFire({ task, decryptedPayload, userKey, ctx });
      if (agentic.handled) return agentic.result;
    }

    let messageContent;
    /** @type {unknown} */
    let llmResponse = null;

    if (decryptedPayload.messageType === 'fixed') {
      messageContent = decryptedPayload.userMessage;

    } else if (decryptedPayload.messageType === 'instant') {
      const hasPrompt = !!decryptedPayload.completePrompt
        || (Array.isArray(decryptedPayload.messages) && decryptedPayload.messages.length > 0);
      if (hasPrompt && decryptedPayload.apiUrl && decryptedPayload.apiKey && decryptedPayload.primaryModel) {
        const aiResult = await callLlm(decryptedPayload);
        messageContent = aiResult.content;
        llmResponse = aiResult.response;
      } else if (decryptedPayload.userMessage) {
        messageContent = decryptedPayload.userMessage;
      } else {
        throw new Error('Invalid instant message: no content source available');
      }

    } else if (decryptedPayload.messageType === 'prompted' || decryptedPayload.messageType === 'auto') {
      const aiResult = await callLlm(decryptedPayload);
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

    // 订阅是用户级的一份，投递时现读（任务行不携带它）。取不到就抛，走既有
    // 的失败/重试逻辑——静默不发会让任务「成功」地什么都没做。升级前创建的
    // 任务把订阅冻结在 payload 里，用户级存储没有时兜底用那一份，存量任务
    // 不必等用户重新登记。
    const pushSubscription = await resolvePushSubscription({
      db: ctx.db,
      userId: task.user_id,
      userKey,
      legacyFallback: decryptedPayload.pushSubscription ?? null
    });
    // sessionId is shared across the optional ReasoningPush and every
    // ContentPush from this LLM round. Pin it to (task id + 名义触发时刻)
    // when available (scheduled tasks) so retries of the same occurrence
    // reuse the same id while循环任务的不同 occurrence 各有一套（见
    // agentic-fire.js 的 occurrenceSuffix）; otherwise mint a UUID.
    const sessionId = task.id != null
      ? `sess_task_${task.id}${occurrenceSuffix(task)}`
      : `sess_${randomUUID()}`;
    const source = decryptedPayload.messageType === 'instant' ? 'instant' : 'scheduled';
    const messageSubtype = decryptedPayload.messageSubtype || 'chat';
    const avatarUrl = decryptedPayload.avatarUrl || null;
    const metadata = decryptedPayload.metadata || {};

    // `messageId` format — deterministic when we have a task.id so a
    // retry produces the same id for the same (task, occurrence, sentence)
    // tuple (downstream dedupers can key on it); different occurrences of
    // a recurring task get distinct ids (see occurrenceSuffix). Falls back
    // to a UUID for the in-server instant path that has no row id.
    const messageIdBase = task.id != null
      ? `msg_task_${task.id}${occurrenceSuffix(task)}`
      : `msg_${randomUUID()}_instant`;
    // 任务的调度身份（taskId / taskUuid / recurrenceType / occurrenceMs）由库
    // 统一补进每条 push，客户端据此认领这条任务、判断它还会不会再来。
    const occurrenceMs = occurrenceMsOf(task);

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
      stampTaskIdentity(reasoningPush, task, decryptedPayload, occurrenceMs);
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
        metadata,
      });
      stampTaskIdentity(contentPush, task, decryptedPayload, occurrenceMs);

      await ctx.webpush.sendNotification(pushSubscription, JSON.stringify(contentPush));

      if (i < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, SLEEP_BETWEEN_MESSAGES_MS));
      }
    }

    return { success: true, messagesSent: messages.length };

  } catch (error) {
    // errorCode 透传底层错误的稳定 `code`（如 PUSH_SUBSCRIPTION_MISSING），
    // run-tick 按它区分「重试也好不了」的永久性失败。
    return { success: false, messagesSent: 0, error: error.message, errorCode: error.code || null };
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

// LLM call plumbing lives in ./llm.js since the agentic fire loop
// (./agentic-fire.js) shares it. Re-exported here so existing importers
// (tests, downstream code) keep working unchanged.
export { normalizeAiApiUrl } from './llm.js';
