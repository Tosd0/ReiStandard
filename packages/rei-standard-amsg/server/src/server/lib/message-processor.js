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
  DEFAULT_MULTIPART_CHUNK_BYTES,
  DEFAULT_MULTIPART_MAX_CHUNKS,
  DEFAULT_MULTIPART_MAX_TOTAL_BYTES,
  DEFAULT_MULTIPART_TTL_MS,
} from '@rei-standard/amsg-shared';
import { measurePushPayload } from './webpush-webcrypto.js';

import { decryptFromStorage, deriveUserEncryptionKey } from './encryption.js';
import { callLlm } from './llm.js';
import { runAgenticFire, taskNeedsLlm, occurrenceSuffix, occurrenceMsOf, stampTaskIdentity } from './agentic-fire.js';
import { resolvePushSubscription } from './push-subscription-store.js';
import { hasChatCredRef, resolveFireCredentials } from './llm-credentials-store.js';
import { appendPushesToOutbox, discardUndeliveredPushes, markPushesDelivered } from './outbox-store.js';
import { shouldSendPush } from './push-policy.js';
import {
  buildErrorExtra,
  isNonRetryableError,
  isPermanentDeliveryFailure,
  isTaskCancelledError,
  readPushStatusCode,
  sanitizeErrorSummary,
  sendTaggedPush,
} from './errors.js';

const DEFAULT_SPLIT_REGEX = /([。！？!?]+)/;

// Pacing between consecutive Web Push deliveries (reasoning → content, and
// between content sentences) so the client renders a natural typing cadence.
// Kept equal to amsg-instant's SLEEP_BETWEEN_MESSAGES_MS default.
const SLEEP_BETWEEN_MESSAGES_MS = 1500;

// 一整批分片能占用的重组窗口比例。
//
// 接收端的重组窗口（「攒着半截分片等剩下的能等多久」）从**它收到第一片**起算，
// 而窗口里还要装上每一片自己的网络耗时、推送服务的排队——这些发送端量不到。所以
// 只按窗口的一半来排发送节奏，别掐着边缘发。
const MULTIPART_WINDOW_USAGE = 0.5;

// 分片之间的最小间隔。分片本身不弹通知（要收齐还原了才走派发），间隔的意义只是
// 别把推送服务一口气打到限流，所以片数多时收紧是安全的；收紧到这个下限还塞不进
// 窗口，就说明这批分片怎么发都拼不回来，发之前直接拒绝。
const MIN_SLEEP_BETWEEN_CHUNKS_MS = 50;

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
 * @returns {Promise<{ shipped: boolean, error?: string }>} shipped=false 时
 *   error 是这条没发成的原因，正文继续发。
 */
async function deliverReasoningPush(ctx, pushSubscription, reasoningPush) {
  const multipart = resolveMultipartOptions(ctx);
  try {
    const serialized = JSON.stringify(reasoningPush);
    const { bytes, withinLimit } = measurePushPayload(serialized);

    if (withinLimit) {
      await sendTaggedPush(ctx.webpush, pushSubscription, serialized);
      return { shipped: true };
    }

    // 分片也有量级上限，超了就别发，发出去也是被 sw 拒收。判据要跟接收端那份
    // 对齐——宿主把 installReiSW 的 multipart 收窄了，这里不知道的话，切出来
    // 的分片到了那边一片都拼不回来（见 resolveMultipartOptions）。
    if (bytes > multipart.maxTotalBytes) {
      throw new Error(`思考过程 ${bytes} 字节，超过分片传输的 ${multipart.maxTotalBytes} 字节上限`);
    }
    const parts = buildMultipartPushPayloads(reasoningPush, {
      serializedPayload: serialized,
      maxChunkBytes: multipart.maxChunkBytes,
      ttlMs: multipart.ttlMs,
    });
    if (parts.length > multipart.maxChunks) {
      throw new Error(`思考过程要切 ${parts.length} 片，超过分片传输的 ${multipart.maxChunks} 片上限`);
    }

    // 整批分片必须在接收端的重组窗口内发完（见 resolveChunkIntervalMs）。塞不进
    // 去就一片都不发：发一半的下场是接收端窗口一到就写死墓碑、迟到的分片被静默
    // 丢弃，用户那边整条思考过程凭空消失，而这边每一片都发成功、看不出任何异常。
    const intervalMs = resolveChunkIntervalMs(parts.length, multipart.ttlMs);
    if (intervalMs === null) {
      throw new Error(
        `思考过程要切 ${parts.length} 片，${multipart.ttlMs} 毫秒的分片重组窗口内发不完`
      );
    }

    for (let i = 0; i < parts.length; i++) {
      await sendTaggedPush(ctx.webpush, pushSubscription, JSON.stringify(parts[i]));
      // 分片跟正文的段一样按节奏发：一口气推几十条，推送服务会限流，而这里的
      // 失败只会让整条思考过程收不齐。
      if (i < parts.length - 1) {
        await sleepFor(ctx, intervalMs);
      }
    }
    return { shipped: true };

  } catch (error) {
    // 取消不是「思考过程没发成」，是整条任务的中止信号（见 run-tick 的
    // guardWebpushWithLease）。吞掉它的话，日志会说「正文照常发送」，而实际上
    // 下一条 push 就会把整条任务中止掉——正好把真相说反了。
    if (isTaskCancelledError(error)) throw error;
    const reason = sanitizeErrorSummary(error && error.message);
    console.warn('[amsg-server] 思考过程未送达（正文照常发送）:', reason);
    return { shipped: false, error: reason };
  }
}

/**
 * 一批分片之间该隔多久发一条。
 *
 * 接收端的重组窗口是「收到第一片之后，攒着半截等剩下的能等多久」，窗口一到就写
 * 死墓碑：之后到的分片被静默丢掉，推送服务重投也救不回来。窗口从它收到第一片起
 * 算，所以整批分片的**发送跨度**必须落在窗口里——片数一多，固定
 * SLEEP_BETWEEN_MESSAGES_MS 的节奏（1.5 秒一片）几十片就把窗口用光了。
 *
 * 片少时保持原来的 1.5 秒不变；片多时按片数把间隔压到刚好装得下（不低于
 * MIN_SLEEP_BETWEEN_CHUNKS_MS）。压到下限还装不下 → null，调用方发之前就拒绝。
 *
 * @param {number} chunkCount
 * @param {number} windowMs - 声明给这批分片的重组窗口（= 接收端实际会用的那个值，
 *   见 resolveMultipartOptions 的 ttlMs）
 * @returns {number|null} 每片之间的间隔毫秒；null = 这批分片怎么发都装不进窗口
 */
function resolveChunkIntervalMs(chunkCount, windowMs) {
  if (chunkCount <= 1) return 0;
  const budgetMs = Math.floor(windowMs * MULTIPART_WINDOW_USAGE);
  const evenlySpaced = Math.floor(budgetMs / (chunkCount - 1));
  if (evenlySpaced < MIN_SLEEP_BETWEEN_CHUNKS_MS) return null;
  return Math.min(SLEEP_BETWEEN_MESSAGES_MS, evenlySpaced);
}

/**
 * 发送节奏用的等待。
 *
 * `ctx._pushSleep` 是给测试留的注入口——「整批分片在重组窗口内发完」这类断言真
 * 等几十秒不现实。宿主不配它，走真的 setTimeout（与 agentic 循环的
 * `ctx._agenticSleep` 同一个路数）。
 *
 * @param {ProcessorContext} ctx
 * @param {number} ms
 */
function sleepFor(ctx, ms) {
  if (!(ms > 0)) return Promise.resolve();
  if (ctx && typeof ctx._pushSleep === 'function') return ctx._pushSleep(ms);
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 分片参数：默认跟 shared 那组默认值走，宿主可以用 `ctx.multipart` 收窄，跟它
 * 给 `installReiSW` 的那份对齐。
 *
 * 接收端的限额是宿主可配的，发送端不跟着走的话，切出来的分片会在到达时被逐片
 * 拒收——一条也拼不回来，而发送端这边两道门槛全都过了，看不出任何异常。
 *
 * ttlMs 的默认值就是接收端的默认重组窗口。声明得比它大没有意义：接收端算的是
 * `min(分片上写的 ttlMs, 它自己的 multipart.ttlMs)`，发送端写多大都会被夹回它那
 * 一份。所以这里当作「接收端实际会用的窗口」来排发送节奏（见
 * resolveChunkIntervalMs）——宿主把 installReiSW 的窗口调宽了、又把同样的值传给
 * 这里，节奏才会跟着放宽。
 *
 * @param {ProcessorContext} ctx
 */
function resolveMultipartOptions(ctx) {
  const configured = (ctx && ctx.multipart && typeof ctx.multipart === 'object') ? ctx.multipart : {};
  return {
    maxChunkBytes: positiveIntegerOr(configured.maxChunkBytes, DEFAULT_MULTIPART_CHUNK_BYTES),
    maxChunks: positiveIntegerOr(configured.maxChunks, DEFAULT_MULTIPART_MAX_CHUNKS),
    maxTotalBytes: positiveIntegerOr(configured.maxTotalBytes, DEFAULT_MULTIPART_MAX_TOTAL_BYTES),
    ttlMs: positiveIntegerOr(configured.ttlMs, DEFAULT_MULTIPART_TTL_MS),
  };
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveIntegerOr(value, fallback) {
  return Number.isInteger(value) && /** @type {number} */ (value) > 0
    ? /** @type {number} */ (value)
    : fallback;
}

/**
 * @typedef {Object} ProcessorContext
 * @property {Object}  webpush           - The web-push module instance (already VAPID-configured).
 * @property {Object}  vapid             - { email, publicKey, privateKey }
 * @property {import('../adapters/interface.js').DbAdapter} db
 * @property {{ maxChunkBytes?: number, maxChunks?: number, maxTotalBytes?: number, ttlMs?: number }} [multipart]
 *   分片传输的限额，宿主传给 `installReiSW` 的那一份原样传过来即可（见
 *   resolveMultipartOptions）。不传 = 两边都用默认值。
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
    const outboxed = await appendPushesToOutbox({ db: ctx.db, userId: task.user_id, userKey, pushes: pushesToSend });

    // 到了客户端不会弹通知的那些不推，只留在 outbox 里等客户端补拉（见
    // lib/push-policy.js）。思考过程正是这一类：SW 那边它本来就是静默送给页面
    // 的，推过去等于白违约一次 `userVisibleOnly` 的约定，而内容在 outbox 里一
    // 个字不少。落行没成的那批不适用——那时候推送是它唯一的腿。
    const pushGate = { outboxed };
    const contentToPush = contentPushes.filter(push => shouldSendPush(push, pushGate));

    const sentIds = [];
    let cancelledMidBurst = false;
    // 思考过程是附赠内容，发不出去不算这条任务失败——但也不能一声不吭：调用方
    // 拿它决定要不要重发 / 要不要提示用户思考过程这次没到。按策略跳过的不算
    // 「没发成」，那条路上内容还在 outbox 里，不设这个字段。
    let reasoningError;
    try {
      // 思考过程先发，且只影响它自己：发不出去（超限、推送服务拒收……）就跳
      // 过，正文一条不少地照发。它排在最前面又和正文共用一个循环的话，一次
      // 失败会把整条消息一起带走。
      if (reasoningPush && shouldSendPush(reasoningPush, pushGate)) {
        const reasoning = await deliverReasoningPush(ctx, pushSubscription, reasoningPush);
        if (reasoning.shipped) {
          sentIds.push(reasoningPush.messageId);
          await sleepFor(ctx, SLEEP_BETWEEN_MESSAGES_MS);
        } else {
          reasoningError = reasoning.error;
        }
      }

      for (let i = 0; i < contentToPush.length; i++) {
        await sendTaggedPush(ctx.webpush, pushSubscription, JSON.stringify(contentToPush[i]));
        sentIds.push(contentToPush[i].messageId);
        if (i < contentToPush.length - 1) {
          await sleepFor(ctx, SLEEP_BETWEEN_MESSAGES_MS);
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
        await discardUndeliveredPushes({
          db: ctx.db, userId: task.user_id, pushes: pushesToSend, sentIds,
        });
      }
    }

    return {
      success: true,
      messagesSent: messages.length,
      ...(reasoningError ? { reasoningError } : {}),
    };

  } catch (error) {
    // errorCode 透传底层错误的稳定 `code`（如 PUSH_SUBSCRIPTION_MISSING），
    // run-tick 按它区分「重试也好不了」的永久性失败；permanent 是 hook 侧
    // NonRetryableError 的透传（见 lib/errors.js），语义相同、来源更宽。
    // pushStatusCode 是推送服务回的 HTTP 状态码：410 / 404 说明这条订阅已经
    // 没了，run-tick 据此判终态——不传出来的话，那个事实只剩错误消息里的一句
    // 人话，谁想用都得去正则匹配。只认发 push 那一步标过的错误（发 push 一律
    // 走 lib/errors.js 的 sendTaggedPush），别改成直接读 `error.statusCode`：
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
 * @returns {Promise<{ success: boolean, messagesSent?: number, retriesUsed?: number, reasoningError?: string, error?: Object }>}
 *   `reasoningError` 只在正文都发出去了、思考过程那一条没发成时出现（思考过程是
 *   附赠内容，它发不出去不算这条消息失败）。调用方拿它提示用户这次没有思考过程，
 *   不带这个字段就是整轮都送到了。
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

    // 思考过程没发成时把原因一路带出去：正文确实发到了，所以这轮仍是成功，但
    // 「这次没有思考过程」得让调用方看得见——丢在这里的话，那条 push 就是静悄悄
    // 消失了，而 reasoningError 存在的意义正是提供这份可见性。
    return {
      success: true,
      messagesSent: result.messagesSent,
      retriesUsed: retryCount,
      ...(result.reasoningError ? { reasoningError: result.reasoningError } : {}),
    };
  }
}

// LLM call plumbing lives in ./llm.js since the agentic fire loop
// (./agentic-fire.js) shares it. Re-exported here so existing importers
// (tests, downstream code) keep working unchanged.
export { normalizeAiApiUrl } from './llm.js';
