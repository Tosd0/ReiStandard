/**
 * Scheduled tick core: fetch due tasks, deliver, reschedule/retry, cleanup.
 * Extracted verbatim from the send-notifications handler so both the HTTP
 * handler (multi-tenant) and the CF scheduled() path (single-user) share it.
 *
 * 每个 tick 是一次独立调用（cron 每分钟一跳，不会因为上一跳还没跑完就跳过
 * 这一跳），而一次投递「组 prompt → 调 LLM → 跑工具 → 推送」可能要几分钟。
 * 所以每条任务开跑前先占位：在这一行的 lease_until 上写下「归我管到什么时
 * 候」，本次投递期间别的 tick 领不走它。占位失败（0 行）说明别人先领走了，
 * 直接跳过。
 *
 * 租约写在自己的列上，next_send_at 全程不动——那一列是用户设的触发时刻，
 * 任务列表要读它、循环任务推进下一次也要拿它当基准。投递收尾时把租约放掉，
 * 这条任务立刻可以被下一跳接手。
 *
 * 投递失败的退避写在另一列（retry_after）上，不跟租约挤在一起：租约的意思只
 * 有「这条正在跑」，而正在等重试的任务其实闲着——两件事共用一列的话，分组串行
 * （见下）会把一条闲着的任务当成「这个分组忙着」，同组别的任务白等一轮退避。
 *
 * 领了任务的 tick 中途没了（Worker 被回收之类）就没人来放租约，这条任务要
 * 等租约到期才会被接手——这是租约本身的代价，把租期设得比最慢的一次投递长
 * 一点就行。
 *
 * @param {Object} ctx - { db, masterKey, vapid, webpush, claimLeaseMs?, serializeBy?, onStaleSkip? }
 *   ctx.serializeBy?.(task)：可选的分组串行。返回一个分组标识（同一个角色、
 *   同一份台账……宿主自己定义），同一分组的任务同时只放行一条；返回 null /
 *   空串 / 不配这个函数 = 这条任务不参与串行，行为与以前完全一致。参数是与
 *   `onBeforeFire` 的 `ctx.task` 同一份的只读任务视图（凭据已剔除）。被拦下
 *   的任务是**推迟**不是丢弃：库一个字段都不动它，下一跳原样再捞一次。
 *   函数自身抛错时这条任务这一跳不跑——分不清它属于哪一组，就不该冒着破坏
 *   宿主台账的风险跑下去。
 *   ctx.onStaleSkip?.(task, info)：任务错过触发时刻太久、这一次（或这几次）
 *   不再补发时调用（best-effort，hook 抛错只记日志不影响主流程）。一次性任务
 *   和循环任务都会调，靠 info.action 区分——见 StaleSkipInfo。task 是数据库
 *   行原样（payload 是密文），所以解密出来的 metadata 单独放在 info 里；只透传
 *   metadata 这一个子字段，解密 payload 里的 apiKey / pushSubscription 等凭据
 *   不会递给 hook。
 * @returns {Promise<Object>} summary { totalTasks, successCount, failedCount, processedAt, executionTime, details }
 */

import { hmacSha256, bytesToBase64Url, utf8 } from './webcrypto-utils.js';
import { deriveUserEncryptionKey, decryptFromStorage, encryptForStorage } from './encryption.js';
import { processSingleMessage } from './message-processor.js';
import { buildHookTask } from './agentic-fire.js';
import { createStateAccessors } from './state-accessors.js';
import { nextFutureOccurrence, planNextOccurrence } from './recurrence.js';

// 占位租期：要盖住最慢的一次投递。老链路单次 LLM 调用上限 300s，agentic 链路
// 整链默认 240s，再留出推送节奏的余量。
export const DEFAULT_CLAIM_LEASE_MS = 10 * 60 * 1000;
// 宿主把 totalTimeoutMs 调大时租期跟着抬，别让下一跳在投递还没跑完时就把行
// 捞回去。（onBeforeFire 里按次放宽的预算这里看不到，那种情况请显式设
// ctx.claimLeaseMs。）
const CLAIM_LEASE_MARGIN_MS = 2 * 60 * 1000;

// 补发新鲜度：错过名义触发时刻超过这个时长的任务不再照常补发。服务停摆几天
// 恢复后，一次性任务不该把攒了几天的旧话一口气倒出来，循环任务更不该每分钟
// 补发一天。正在重试链上的任务（retry_count > 0）不算过期——它的 next_send_at
// 一直是名义时刻，重试拖过一小时不等于用户错过了它。
export const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * @typedef {Object} StaleSkipInfo
 * @property {'stale'} reason
 * @property {'expired'|'fast_forwarded'} action
 *   `expired` = 一次性任务，这一次永远不会补发了，行已标 failed；
 *   `fast_forwarded` = 循环任务，攒下的这几次都跳过，排期已快进到未来第一个
 *   名义时刻，行仍是 pending，下一次照常触发。
 * @property {Object|null} metadata - 解密 payload 里的 metadata 子字段
 * @property {string} recurrenceType - 'none' / 'daily' / 'weekly'
 * @property {number|null} occurrenceMs - 被跳过的第一个名义时刻（epoch 毫秒）
 * @property {number} skippedCount - 一共跳过几次（一次性任务恒为 1）
 * @property {number[]} skippedOccurrences - 被跳过的名义时刻列表（epoch 毫秒）；
 *   超过 32 次时只给首末两个，并把 skippedTruncated 置 true
 * @property {boolean} skippedTruncated
 * @property {string|null} nextSendAt - 循环任务快进到的下一次触发时刻；一次性任务为 null
 * @property {(namespace: string) => Promise<Array>} readState
 * @property {(namespace: string, entries: Array) => Promise<Object>} writeState
 */

function isRecurringType(recurrenceType) {
  return recurrenceType === 'daily' || recurrenceType === 'weekly';
}

function positiveNumber(value) {
  return (typeof value === 'number' && Number.isFinite(value) && value > 0) ? value : 0;
}

function resolveClaimLeaseMs(ctx) {
  return positiveNumber(ctx.claimLeaseMs)
    || Math.max(DEFAULT_CLAIM_LEASE_MS, positiveNumber(ctx.totalTimeoutMs) + CLAIM_LEASE_MARGIN_MS);
}

/**
 * 把宿主给的分组 key 变成落库用的分组标识。
 *
 * 不直接存 key 本身：它多半是角色 id / 联系人名这类宿主数据，而任务内容一律
 * 加密落库，多开一列明文出口不合适。这里用该用户的存储密钥做 HMAC——同一个
 * 用户的同一个 key 每次都得到同一个值（分组判定要的就是相等性），换个用户
 * 得到的值必然不同（分组天然按用户隔开，SQL 那边不用再比 user_id），拿到数
 * 据库也反推不回原 key。
 *
 * @param {string} userKey - 该用户的存储密钥（deriveUserEncryptionKey 的结果）
 * @param {string} rawKey - serializeBy 返回的分组 key
 * @returns {Promise<string>} 43 字符的 base64url 串（列宽 64 够放）
 */
export async function deriveSerializeGroup(userKey, rawKey) {
  return bytesToBase64Url(await hmacSha256(utf8(userKey), utf8(rawKey)));
}

export async function runScheduledTick(ctx) {
  const db = ctx.db;
  const masterKey = ctx.masterKey;
  const claimLeaseMs = resolveClaimLeaseMs(ctx);
  const serializeBy = typeof ctx.serializeBy === 'function' ? ctx.serializeBy : null;

  const startTime = Date.now();
  const tasks = await db.getPendingTasks(50);

  const MAX_CONCURRENT = 8;
  const results = {
    totalTasks: tasks.length,
    successCount: 0,
    failedCount: 0,
    claimSkippedTasks: 0,
    serializeSkippedTasks: 0,
    deletedOnceOffTasks: 0,
    updatedRecurringTasks: 0,
    staleTasks: [],
    failedTasks: []
  };

  // 这一跳已经放行过的分组。一个分组一跳只放行一条：本跳里前面那条跑完之后
  // 也不补跑后面的，剩下的留给下一跳（cron 一分钟就再来一次），免得一跳里排
  // 出一条长长的串行链、把整跳的时间预算耗光。
  const groupsTakenThisTick = new Set();

  // 适配器没实现 claimTask（自定义适配器）→ 退回不占位的老行为：跑得动，只是
  // 超过一跳间隔的慢任务仍可能被下一跳重复触发。
  const supportsClaim = typeof db.claimTask === 'function';

  async function claimForThisTick(task, serializeGroup) {
    if (!supportsClaim) return true;
    const leaseUntil = new Date(Date.now() + claimLeaseMs).toISOString();
    return !!(await db.claimTask(task.id, task.next_send_at, leaseUntil, serializeGroup));
  }

  /**
   * 投递收尾时写库，顺手把租约和退避都清掉。占位之后的每一次写库都要走这
   * 里，漏掉一条那条任务就得等租约到期才动得了。
   *
   * 没实现 claimTask 的适配器不会有这两列，就别往它的 updateTaskById 里塞
   * 这两个字段了。
   */
  async function updateAndRelease(taskId, fields) {
    return db.updateTaskById(
      taskId,
      supportsClaim ? { ...fields, lease_until: null, retry_after: null } : fields
    );
  }

  /**
   * 解密任务 payload。失败不抛——调用方拿到 ok:false 后按投递失败走既有的
   * 重试/终态逻辑（投递本身解的是同一份，解不开就必然发不出去）。
   */
  async function decryptTask(task) {
    try {
      const userKey = await deriveUserEncryptionKey(task.user_id, masterKey);
      const payload = JSON.parse(await decryptFromStorage(task.encrypted_payload, userKey));
      return { ok: true, userKey, payload };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /**
   * 这条任务归哪个串行分组管。
   *
   * 返回 { taken: true } 表示这一跳不跑它（分组已被本跳里别的任务占着，或者
   * serializeBy 自己抛错了）——两种情况都一个字段不动，下一跳原样再来。
   *
   * 占坑必须在同一个同步段里完成（判断完立刻 add）：一跳内最多 8 条任务并发
   * 跑，中间只要有一次 await，同组的两条就能双双通过判断。
   */
  function reserveSerializeGroup(task, decryptedPayload) {
    if (!serializeBy || !decryptedPayload) return { taken: false, rawKey: null };
    let rawKey;
    try {
      rawKey = serializeBy(buildHookTask(task, decryptedPayload));
    } catch (hookError) {
      console.warn('[amsg-server] serializeBy 抛错，本跳跳过这条任务:', hookError && hookError.message);
      return { taken: true, rawKey: null };
    }
    if (typeof rawKey !== 'string' || !rawKey) return { taken: false, rawKey: null };
    if (groupsTakenThisTick.has(rawKey)) return { taken: true, rawKey };
    groupsTakenThisTick.add(rawKey);
    return { taken: false, rawKey };
  }

  /**
   * 把这次的错误记进 payload 的 lastError（best-effort）：GET /messages 解密
   * payload 时会把它透出来，宿主能看到「上次为什么没发出去」。加密不了就算了，
   * 记录失败不该拖垮状态推进。
   *
   * @param {Object} task
   * @param {Object} decryptedPayload
   * @param {string} userKey
   * @param {string} reason
   * @param {Object} [extra] - 额外记进 lastError 的字段（例如快进跳过了几次）
   */
  async function encryptPayloadWithLastError(task, decryptedPayload, userKey, reason, extra) {
    if (!decryptedPayload || !userKey) return null;
    try {
      return await encryptForStorage(JSON.stringify({
        ...decryptedPayload,
        lastError: {
          at: new Date().toISOString(),
          occurrence: task.next_send_at,
          reason,
          ...(extra || {})
        }
      }), userKey);
    } catch (_encryptError) {
      return null;
    }
  }

  /**
   * 过期跳过的回执（best-effort）。一次性任务和循环任务共用一个 hook，靠
   * info.action 区分：宿主只需要在一个地方写「这条（这几条）没响」。
   */
  async function notifyStaleSkip(task, info) {
    if (typeof ctx.onStaleSkip !== 'function') return;
    try {
      await ctx.onStaleSkip(task, info);
    } catch (hookError) {
      console.warn('[amsg-server] onStaleSkip hook 抛错（已忽略）:', hookError && hookError.message);
    }
  }

  /**
   * 投递失败的处置。重试没用完时安排退避重试；用完时一次性任务标 'failed'
   * 终态，循环任务只作废本次 occurrence（推进到下个周期、重试归零）——循环
   * 任务永远不进终态，一次雷暴不该让每日消息从此消失。
   *
   * 退避写在 retry_after 上（捞取条件会滤掉退避未到点的行，到点自然放行），
   * 同时把租约放掉——租约只表示「这条正在跑」，等重试的任务并没有在跑，占着
   * 租约会让分组串行把同组别的任务一起堵住。next_send_at 全程保持名义时刻：
   * 它是循环推进和过期判定的基准，被退避时间改写过一次，这条任务的钟点就永
   * 久漂了。没有这两列的适配器（没实现 claimTask）退回老行为，把重试时刻写
   * 进 next_send_at。
   */
  async function handleDeliveryFailure(task, reason, recurrenceType, decryptedPayload, userKey) {
    results.failedCount++;
    const tzId = decryptedPayload ? (decryptedPayload.tzId ?? null) : null;
    try {
      if (task.retry_count >= 3) {
        const encrypted = await encryptPayloadWithLastError(task, decryptedPayload, userKey, reason);
        if (isRecurringType(recurrenceType)) {
          const nextSendAt = nextFutureOccurrence(Date.parse(task.next_send_at), recurrenceType, Date.now(), tzId);
          await updateAndRelease(task.id, {
            next_send_at: nextSendAt,
            retry_count: 0,
            ...(encrypted ? { encrypted_payload: encrypted } : {})
          });
          results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count, status: 'occurrence_skipped', nextSendAt });
        } else {
          await updateAndRelease(task.id, {
            status: 'failed',
            ...(encrypted ? { encrypted_payload: encrypted } : {})
          });
          results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count, status: 'permanently_failed' });
        }
      } else {
        const nextRetryTime = new Date(Date.now() + (task.retry_count + 1) * 2 * 60 * 1000);
        if (supportsClaim) {
          await db.updateTaskById(task.id, {
            retry_after: nextRetryTime.toISOString(),
            lease_until: null,
            retry_count: task.retry_count + 1
          });
        } else {
          await db.updateTaskById(task.id, { next_send_at: nextRetryTime.toISOString(), retry_count: task.retry_count + 1 });
        }
        results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count + 1, nextRetryAt: nextRetryTime.toISOString() });
      }
    } catch (updateError) {
      results.failedTasks.push({ taskId: task.id, reason, status: 'retry_update_failed', updateError: updateError.message });
    }
  }

  /**
   * 消息已经送达，只是发送后的写库（删行 / 推进排期）没成。一次性任务标
   * 'sent' 防重发（维持既有行为）；循环任务不标 'sent'——那是终态，任务会
   * 从此退出捞取——而是再试一次把排期推进到下个周期。推进也失败时行保持
   * pending，租约到期后会被重发这个 occurrence（推送 id 掺了名义时刻，已
   * 送达的段会在客户端被去重）。
   */
  async function handlePostSendPersistenceFailure(task, reason, recurrenceType, tzId) {
    results.failedCount++;
    if (isRecurringType(recurrenceType)) {
      let advanced = false;
      let nextSendAt = null;
      try {
        nextSendAt = nextFutureOccurrence(Date.parse(task.next_send_at), recurrenceType, Date.now(), tzId);
        await updateAndRelease(task.id, { next_send_at: nextSendAt, retry_count: 0 });
        advanced = true;
      } catch (_advanceError) {
        advanced = false;
      }
      results.failedTasks.push({
        taskId: task.id,
        reason,
        status: advanced ? 'post_send_cleanup_failed_rescheduled' : 'post_send_cleanup_failed',
        messageDelivered: true
      });
      return;
    }
    let markedSent = false;
    try {
      await updateAndRelease(task.id, { status: 'sent', retry_count: 0 });
      markedSent = true;
    } catch (_markSentError) {
      markedSent = false;
    }
    results.failedTasks.push({
      taskId: task.id,
      reason,
      status: markedSent ? 'post_send_cleanup_failed_marked_sent' : 'post_send_cleanup_failed',
      messageDelivered: true
    });
  }

  /**
   * 投递一条任务。payload 在下面的预处理里已经解好了（分组 key 要在占位那一
   * 步就带上，而占位必须是判定和写租约的同一条语句，见适配器的 claimTask），
   * 这里不再解第二遍。
   *
   * @param {{ task: Object, decrypted: Object, serializeKey: string|null }} entry
   */
  async function processTask({ task, decrypted, serializeKey }) {
    const decryptedPayload = decrypted.ok ? decrypted.payload : null;
    const userKey = decrypted.ok ? decrypted.userKey : null;
    const serializeGroup = serializeKey
      ? await deriveSerializeGroup(userKey, serializeKey)
      : null;

    let claimed;
    try {
      claimed = await claimForThisTick(task, serializeGroup);
    } catch (error) {
      // 占位这一步就出错，说明库有问题——此时不知道别人有没有在跑这条，宁可
      // 不发。行还是 pending，下一跳会重新捞。
      results.failedCount++;
      results.failedTasks.push({ taskId: task.id, reason: error.message || '任务占位失败', status: 'claim_failed' });
      return;
    }
    if (!claimed) {
      // 另一个 tick 已经领走了这条，或者同分组有任务正在别的 tick 里跑。两种
      // 情况本次都什么都不做，下一跳再说。
      results.claimSkippedTasks++;
      return;
    }

    // recurrenceType 是过期判定、终审失败处置的依据。解密不了的话投递也必然
    // 失败（processSingleMessage 解的是同一份），按投递失败走既有的重试/终态
    // 逻辑。
    if (!decrypted.ok) {
      await handleDeliveryFailure(task, (decrypted.error && decrypted.error.message) || '任务载荷解密失败', null, null, null);
      return;
    }
    const recurrenceType = decryptedPayload.recurrenceType;
    // 循环推进跟着哪个时区的墙钟走（没设就按 UTC，等价于固定 24h / 7×24h）。
    const tzId = decryptedPayload.tzId ?? null;

    // —— 补发新鲜度守卫 ——
    // 服务停摆 N 天恢复后，攒下的旧任务不照常补发：一次性任务标 'failed'；
    // 循环任务把排期快进到未来第一个名义时刻。两边都写 lastError、都调
    // onStaleSkip——「昨天那次没响」对用户是一样的事实，循环任务不该无声无息
    // 地把它抹掉。正在重试链上的（retry_count > 0）不算过期，见 STALE_AFTER_MS
    // 的注释。
    const occurrenceMs = Date.parse(task.next_send_at);
    if (Number.isFinite(occurrenceMs)
        && Date.now() - occurrenceMs > STALE_AFTER_MS
        && (task.retry_count || 0) === 0) {
      try {
        // hook 的 client_state 读写口：过期跳过往往正是宿主要留一条痕迹的时
        // 候（服务停摆恢复后的第一跳，此前这个 tick 里可能一次 fire 都没跑
        // 过），所以现造一份递给它，而不是让宿主自己去别处找。
        const stateAccessors = createStateAccessors({
          db,
          userId: task.user_id,
          userKey,
          maxStateValueBytes: ctx.maxStateValueBytes
        });

        if (isRecurringType(recurrenceType)) {
          const plan = planNextOccurrence(occurrenceMs, recurrenceType, Date.now(), tzId);
          const nextSendAt = new Date(plan.nextMs).toISOString();
          const encrypted = await encryptPayloadWithLastError(task, decryptedPayload, userKey, 'stale', {
            skippedCount: plan.skippedCount,
            nextSendAt
          });
          await updateAndRelease(task.id, {
            next_send_at: nextSendAt,
            retry_count: 0,
            ...(encrypted ? { encrypted_payload: encrypted } : {})
          });
          results.staleTasks.push({
            taskId: task.id,
            reason: 'stale',
            action: 'fast_forwarded',
            nextSendAt,
            skippedCount: plan.skippedCount
          });
          await notifyStaleSkip(task, {
            reason: 'stale',
            action: 'fast_forwarded',
            metadata: decryptedPayload.metadata ?? null,
            recurrenceType,
            occurrenceMs,
            skippedCount: plan.skippedCount,
            skippedOccurrences: plan.skippedOccurrences,
            skippedTruncated: plan.skippedTruncated,
            nextSendAt,
            ...stateAccessors
          });
        } else {
          const encrypted = await encryptPayloadWithLastError(task, decryptedPayload, userKey, 'stale');
          await updateAndRelease(task.id, {
            status: 'failed',
            ...(encrypted ? { encrypted_payload: encrypted } : {})
          });
          results.staleTasks.push({ taskId: task.id, reason: 'stale', action: 'expired', skippedCount: 1 });
          // 消费方用它写「错过了」回执；best-effort，hook 抛错不影响主流程。
          // task 是数据库行原样（metadata 锁在 encrypted_payload 密文里），所以
          // 把解密出的 metadata 单独递过去，hook 才能对上是哪个角色的任务。
          // 只透传 metadata 这一个子字段——解密 payload 里还有 apiKey /
          // pushSubscription 等凭据，不能整个递出去。
          await notifyStaleSkip(task, {
            reason: 'stale',
            action: 'expired',
            metadata: decryptedPayload.metadata ?? null,
            recurrenceType: recurrenceType || 'none',
            occurrenceMs,
            skippedCount: 1,
            skippedOccurrences: [occurrenceMs],
            skippedTruncated: false,
            nextSendAt: null,
            ...stateAccessors
          });
        }
      } catch (error) {
        results.failedCount++;
        results.failedTasks.push({ taskId: task.id, reason: error.message || '过期任务处理失败', status: 'stale_update_failed' });
      }
      return;
    }

    let sendResult;
    try {
      sendResult = await processSingleMessage(task, { ...ctx, db, masterKey }, masterKey);
    } catch (error) {
      await handleDeliveryFailure(task, error.message || '消息发送失败', recurrenceType, decryptedPayload, userKey);
      return;
    }

    if (!sendResult.success) {
      await handleDeliveryFailure(task, sendResult.error || '消息发送失败', recurrenceType, decryptedPayload, userKey);
      return;
    }

    try {
      if (recurrenceType === 'none') {
        await db.deleteTaskById(task.id);
        results.deletedOnceOffTasks++;
      } else {
        // 以这条任务原本的触发时刻为基准往后推（推进到未来第一个名义时刻）。
        const nextSendAt = nextFutureOccurrence(occurrenceMs, recurrenceType, Date.now(), tzId);
        await updateAndRelease(task.id, { next_send_at: nextSendAt, retry_count: 0 });
        results.updatedRecurringTasks++;
      }

      results.successCount++;
    } catch (error) {
      await handlePostSendPersistenceFailure(task, error.message || '发送后状态更新失败', recurrenceType, tzId);
    }
  }

  // 先按捞取顺序（next_send_at 升序）逐条解密、逐条占分组的坑，再并发投递。
  //
  // 顺序在这一步就定死，是因为分组串行要的是「同一个角色的消息按时间顺序一条
  // 一条来」：并发解密谁先跑完是没准的，让它来决定同组谁先放行的话，两条都到
  // 点时晚的那条可能抢在早的前面发出去——这正是分组串行想避免的事。
  //
  // 没配 serializeBy 时这一步只是顺手把 payload 解出来（下面不会再解第二遍），
  // 谁都不拦。
  const taskQueue = [];
  for (const task of tasks) {
    const decrypted = await decryptTask(task);
    const reserved = reserveSerializeGroup(task, decrypted.ok ? decrypted.payload : null);
    if (reserved.taken) {
      // 同分组已经有任务在这一跳里放行了（或者 serializeBy 抛错）。行一个字段
      // 都不动——这是推迟，不是丢弃，下一跳照常把它捞回来。
      results.serializeSkippedTasks++;
      continue;
    }
    taskQueue.push({ task, decrypted, serializeKey: reserved.rawKey });
  }

  const processing = [];

  while (taskQueue.length > 0 || processing.length > 0) {
    while (processing.length < MAX_CONCURRENT && taskQueue.length > 0) {
      const entry = taskQueue.shift();
      const promise = processTask(entry);
      processing.push(promise);
      promise.finally(() => {
        const index = processing.indexOf(promise);
        if (index > -1) processing.splice(index, 1);
      });
    }
    if (processing.length > 0) {
      await Promise.race(processing);
    }
  }

  await db.cleanupOldTasks(7);

  const executionTime = Date.now() - startTime;

  return {
    totalTasks: results.totalTasks,
    successCount: results.successCount,
    failedCount: results.failedCount,
    processedAt: new Date().toISOString(),
    executionTime,
    details: {
      claimSkippedTasks: results.claimSkippedTasks,
      // 分组串行拦下的条数：本跳里同分组已经放行过别的任务。跨跳被拦下的
      // （分组在别的 tick 里正忙）走的是占位那一步，计在 claimSkippedTasks。
      serializeSkippedTasks: results.serializeSkippedTasks,
      deletedOnceOffTasks: results.deletedOnceOffTasks,
      updatedRecurringTasks: results.updatedRecurringTasks,
      staleTasks: results.staleTasks,
      failedTasks: results.failedTasks
    }
  };
}
