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
 * 思考过程是正文之外的附赠内容：它发不出去只影响它自己，正文照发（见
 * `deliverReasoningPush`）。一条 push 装不下的思考过程切成 `_multipart`
 * 分片发，sw 收齐后还原。
 */

import { randomUUID } from './webcrypto-utils.js';
import {
  buildContentPush,
  buildMultipartPushPayloads,
  buildReasoningPush,
  readReasoningContent,
  stripReasoningTags,
  DEFAULT_MULTIPART_MAX_CHUNKS,
  DEFAULT_MULTIPART_MAX_TOTAL_BYTES,
} from '@rei-standard/amsg-shared';
import { measurePushPayload } from './webpush-webcrypto.js';

import { decryptFromStorage, deriveUserEncryptionKey } from './encryption.js';
import { callLlm } from './llm.js';
import { runAgenticFire, taskNeedsLlm, occurrenceSuffix, occurrenceMsOf, stampTaskIdentity } from './agentic-fire.js';
import { resolvePushSubscription } from './push-subscription-store.js';
import { hasChatCredRef, resolveFireCredentials } from './llm-credentials-store.js';
import { appendPushesToOutbox, discardPushesFromOutbox, markPushesDelivered } from './outbox-store.js';
import {
  buildErrorExtra,
  isNonRetryableError,
  isPermanentDeliveryFailure,
  isTaskCancelledError,
  readPushStatusCode,
  sanitizeErrorSummary,
  tagPushStatusCode,
} from './errors.js';

const DEFAULT_SPLIT_REGEX = /([。！？!?]+)/;

// Pacing between consecutive Web Push deliveries (reasoning → content, and
// between content sentences) so the client renders a natural typing cadence.
// Kept equal to amsg-instant's SLEEP_BETWEEN_MESSAGES_MS default.
const SLEEP_BETWEEN_MESSAGES_MS = 1500;

// 思考过程切片时给分片标的重组窗口。sw 那边按 min(这个值, 它自己的
// multipart.ttlMs) 取，两边谁更紧听谁的。定时消息是设备离线也要送到的
// （传输层 TTL 四周），所以发送端这边不再额外收窄——窗口开多大由 sw 的
// multipart.ttlMs 说了算。
const REASONING_MULTIPART_TTL_MS = 2_419_200_000; // 4 weeks

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
 * 发这一轮的 ReasoningPush。
 *
 * 思考过程是正文之外的附赠内容，所以这一步的失败就地吞掉、只留一行日志，
 * 调用方照常发正文。
 *
 * 单条 push 的明文有上限（见 lib/webpush-webcrypto.js 的
 * MAX_PUSH_PAYLOAD_BYTES，约 3993 字节 ≈ 1300 汉字），推理模型的思考过程
 * 常常一条装不下。装不下就切成通用 `_multipart` 分片逐条发，sw 收齐后还原
 * 成原样的 ReasoningPush 再走正常派发（切片格式在
 * @rei-standard/amsg-shared，amsg-instant 发的是同一种）。
 *
 * @param {ProcessorContext} ctx
 * @param {Object} pushSubscription
 * @param {Object} reasoningPush
 * @returns {Promise<boolean>} 送出去了没有。false = 这条没发成，正文继续发。
 */
async function deliverReasoningPush(ctx, pushSubscription, reasoningPush) {
  try {
    const serialized = JSON.stringify(reasoningPush);
    const { bytes, withinLimit } = measurePushPayload(serialized);

    if (withinLimit) {
      await ctx.webpush.sendNotification(pushSubscription, serialized);
      return true;
    }

    // 分片也有量级上限，接收端按同一组默认值收——超了就别发，发出去也是被
    // sw 按 maxTotalBytes / maxChunks 拒收。
    if (bytes > DEFAULT_MULTIPART_MAX_TOTAL_BYTES) {
      throw new Error(`思考过程 ${bytes} 字节，超过分片传输的 ${DEFAULT_MULTIPART_MAX_TOTAL_BYTES} 字节上限`);
    }
    const parts = buildMultipartPushPayloads(reasoningPush, {
      serializedPayload: serialized,
      ttlMs: REASONING_MULTIPART_TTL_MS,
    });
    if (parts.length > DEFAULT_MULTIPART_MAX_CHUNKS) {
      throw new Error(`思考过程要切 ${parts.length} 片，超过分片传输的 ${DEFAULT_MULTIPART_MAX_CHUNKS} 片上限`);
    }

    for (const part of parts) {
      await ctx.webpush.sendNotification(pushSubscription, JSON.stringify(part));
    }
    return true;

  } catch (error) {
    console.warn(
      '[amsg-server] 思考过程未送达（正文照常发送）:',
      sanitizeErrorSummary(error && error.message)
    );
    return false;
  }
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
 * @returns {Promise<{ success: boolean, messagesSent: number, error?: string, errorCode?: string|null, pushStatusCode?: number|null, permanent?: boolean }>}
 *   失败时 `pushStatusCode` 是推送服务回的 HTTP 状态码（不是推送阶段炸的 → null）。
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
      const hasChatSource = hasChatCredRef(decryptedPayload)
        || !!(decryptedPayload.apiUrl && decryptedPayload.apiKey && decryptedPayload.primaryModel);
      if (hasPrompt && hasChatSource) {
        // credRefs.chat 任务按引用现读凭据；解析结果只合进发给 callLlm 的这
        // 一个对象，不写回 decryptedPayload（那份会流向 hook / push）。
        const chatCred = await resolveFireCredentials({ db: ctx.db, userId: task.user_id, userKey, decryptedPayload });
        const aiResult = await callLlm(chatCred ? { ...decryptedPayload, ...chatCred } : decryptedPayload);
        messageContent = aiResult.content;
        llmResponse = aiResult.response;
      } else if (decryptedPayload.userMessage) {
        messageContent = decryptedPayload.userMessage;
      } else {
        throw new Error('Invalid instant message: no content source available');
      }

    } else if (decryptedPayload.messageType === 'prompted' || decryptedPayload.messageType === 'auto') {
      const chatCred = await resolveFireCredentials({ db: ctx.db, userId: task.user_id, userKey, decryptedPayload });
      const aiResult = await callLlm(chatCred ? { ...decryptedPayload, ...chatCred } : decryptedPayload);
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

    // 先把整批 push 定稿（含可选的 ReasoningPush），再发送。定稿提前是为了
    // outbox：发送前把每条 push 落进 message_outbox（客户端补收的事实来源，
    // best-effort，见 lib/outbox-store.js），落的必须是发送时的同一份内容。
    const contentPushes = [];

    // ReasoningPush — auto-emitted before the content burst when the
    // LLM response carried non-empty reasoning_content. `fixed` and
    // explicit-userMessage paths produce no LLM response, so this
    // block is naturally skipped for them (llmResponse stays null).
    let reasoningPush = null;
    if (reasoning) {
      reasoningPush = buildReasoningPush({
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
      contentPushes.push(contentPush);
    }

    // outbox 落的是逻辑上的那几条 push：思考过程走分片时，落进去的也是没切
    // 之前的整条——补收走的是 HTTP，没有单条体积上限。
    const pushesToSend = reasoningPush ? [reasoningPush, ...contentPushes] : contentPushes;
    await appendPushesToOutbox({ db: ctx.db, userId: task.user_id, userKey, pushes: pushesToSend });

    const sentIds = [];
    let cancelledMidBurst = false;
    try {
      // 思考过程先发，且只影响它自己：发不出去（超限、推送服务拒收……）就跳
      // 过，正文一条不少地照发。它排在最前面又和正文共用一个循环的话，一次
      // 失败会把整条消息一起带走。
      if (reasoningPush) {
        const reasoningShipped = await deliverReasoningPush(ctx, pushSubscription, reasoningPush);
        if (reasoningShipped) {
          sentIds.push(reasoningPush.messageId);
          await new Promise(resolve => setTimeout(resolve, SLEEP_BETWEEN_MESSAGES_MS));
        }
      }

      for (let i = 0; i < contentPushes.length; i++) {
        try {
          await ctx.webpush.sendNotification(pushSubscription, JSON.stringify(contentPushes[i]));
        } catch (error) {
          // 标一下「这是发 push 那一步抛的」，下面的 catch 才认它的 statusCode。
          throw tagPushStatusCode(error);
        }
        sentIds.push(contentPushes[i].messageId);
        if (i < contentPushes.length - 1) {
          await new Promise(resolve => setTimeout(resolve, SLEEP_BETWEEN_MESSAGES_MS));
        }
      }
    } catch (error) {
      cancelledMidBurst = isTaskCancelledError(error);
      throw error;
    } finally {
      // 半途失败也把已发出的段标掉：delivered_at 为 null 的行就是客户端要补
      // 收的那部分，标多标少都会让补收失真。
      await markPushesDelivered({ db: ctx.db, userId: task.user_id, messageIds: sentIds });
      if (cancelledMidBurst) {
        // 取消只拦住了 Web Push 这一路，可整批在发送前就落进 outbox 了。剩下
        // 这几条不撤掉的话，客户端下一次 GET /outbox 会照样把它们拉回去——用户
        // 看到的就是「取消接口回了成功，消息还是来了」。
        // 投递失败不走这里：那种情况下这些行正是要留着补收的。
        const delivered = new Set(sentIds);
        await discardPushesFromOutbox({
          db: ctx.db,
          userId: task.user_id,
          messageIds: pushesToSend
            .map(push => push.messageId)
            .filter(messageId => !delivered.has(messageId)),
        });
      }
    }

    return { success: true, messagesSent: messages.length };

  } catch (error) {
    // errorCode 透传底层错误的稳定 `code`（如 PUSH_SUBSCRIPTION_MISSING），
    // run-tick 按它区分「重试也好不了」的永久性失败；permanent 是 hook 侧
    // NonRetryableError 的透传（见 lib/errors.js），语义相同、来源更宽。
    // pushStatusCode 是推送服务回的 HTTP 状态码：410 / 404 说明这条订阅已经
    // 没了，run-tick 据此判终态——不传出来的话，那个事实只剩错误消息里的一句
    // 人话，谁想用都得去正则匹配。只认发 push 那一步标过的错误（见
    // lib/errors.js 的 tagPushStatusCode），别改成直接读 `error.statusCode`：
    // 这个 catch 收的是整个函数的异常，LLM 调用、fire-time hook、解密都在里
    // 面，那些错误上的 `statusCode` 不是推送状态码。
    return {
      success: false,
      messagesSent: 0,
      error: error.message,
      errorCode: error.code || null,
      pushStatusCode: readPushStatusCode(error),
      permanent: isNonRetryableError(error)
    };
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
      // 确定性失败不进重试：再跑两轮也是同一个错，白让调用方多等、白烧一整轮
      // LLM 和 hook 里的计费调用。判定口径跟定时任务那条退避阶梯共用一份（见
      // lib/errors.js 的 isPermanentDeliveryFailure）——订阅压根没登记、推送服
      // 务回 410 说订阅没了，这些在哪条链路上都是重试必然同败。
      const permanent = isPermanentDeliveryFailure({
        permanent: result.permanent,
        errorCode: result.errorCode,
        pushStatus: result.pushStatusCode
      });

      if (!permanent && retryCount < maxRetries) {
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        continue;
      }

      try {
        await ctx.db.updateTaskById(task.id, {
          status: 'failed',
          retry_count: retryCount,
          // 记录的形状跟定时任务那条路一致（同一个 buildErrorExtra）：reason
          // 是给用户看的人话，errorCode / pushStatus 是给下游判定用的——410 =
          // 订阅已注销，客户端要据此引导用户重新登记，而不是回去正则匹配
          // reason 里那句话。
          last_error: JSON.stringify({
            at: new Date().toISOString(),
            occurrence: task.next_send_at ?? null,
            reason: sanitizeErrorSummary(result.error),
            ...(buildErrorExtra(result.errorCode, result.pushStatusCode) || {})
          })
        });
      } catch (_updateError) {
        // 缺 last_error 列（升级后还没重跑 /init-tenant）或别的写库问题：退掉
        // 这个字段再试一次，标 failed 不能被一条锦上添花的记录挡住。
        try {
          await ctx.db.updateTaskById(task.id, { status: 'failed', retry_count: retryCount });
        } catch (_retryError) {
          // best-effort status update; keep original processing error as primary signal
        }
      }

      return {
        success: false,
        error: {
          code: 'PROCESSING_ERROR',
          message: result.error,
          retriesAttempted: retryCount,
          ...(permanent ? { permanent: true } : {})
        }
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
