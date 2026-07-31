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
 * 这条任务立刻可以被下一跳接手（失败重试的退避只有 2 分钟，比租期短得多，
 * 不放掉的话退避就白设了）。
 *
 * 领了任务的 tick 中途没了（Worker 被回收之类）就没人来放租约，这条任务要
 * 等租约到期才会被接手——这是租约本身的代价，把租期设得比最慢的一次投递长
 * 一点就行。
 *
 * @param {Object} ctx - { db, masterKey, vapid, webpush, claimLeaseMs?, onStaleSkip? }
 *   ctx.onStaleSkip?.(task, { reason: 'stale', metadata })：一次性任务错过触发
 *   时刻太久、被判定不再补发时调用（best-effort，hook 抛错只记日志不影响主
 *   流程）。task 是 D1 行原样（payload 是密文）；metadata 是解密 payload 里的
 *   metadata 子字段（没有则为 null），消费方靠它对上角色、写「这条错过了」的
 *   回执。只透传 metadata——解密 payload 里的 apiKey / pushSubscription 等凭据
 *   不会递给 hook。
 * @returns {Promise<Object>} summary { totalTasks, successCount, failedCount, processedAt, executionTime, details }
 */

import { deriveUserEncryptionKey, decryptFromStorage, encryptForStorage } from './encryption.js';
import { processSingleMessage } from './message-processor.js';

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

const RECURRENCE_PERIOD_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
};

/**
 * 从名义触发时刻往后推，找到第一个在未来的 occurrence（至少推一个周期）。
 * 循环任务的推进基准永远是名义时刻，所以停摆多久都不会漂移到别的钟点。
 */
function nextFutureOccurrence(occurrenceMs, recurrenceType, nowMs) {
  const periodMs = RECURRENCE_PERIOD_MS[recurrenceType];
  let next = occurrenceMs + periodMs;
  while (next <= nowMs) next += periodMs;
  return new Date(next).toISOString();
}

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

export async function runScheduledTick(ctx) {
  const db = ctx.db;
  const masterKey = ctx.masterKey;
  const claimLeaseMs = resolveClaimLeaseMs(ctx);

  const startTime = Date.now();
  const tasks = await db.getPendingTasks(50);

  const MAX_CONCURRENT = 8;
  const results = {
    totalTasks: tasks.length,
    successCount: 0,
    failedCount: 0,
    claimSkippedTasks: 0,
    deletedOnceOffTasks: 0,
    updatedRecurringTasks: 0,
    staleTasks: [],
    failedTasks: []
  };

  // 适配器没实现 claimTask（自定义适配器）→ 退回不占位的老行为：跑得动，只是
  // 超过一跳间隔的慢任务仍可能被下一跳重复触发。
  const supportsClaim = typeof db.claimTask === 'function';

  async function claimForThisTick(task) {
    if (!supportsClaim) return true;
    const leaseUntil = new Date(Date.now() + claimLeaseMs).toISOString();
    return !!(await db.claimTask(task.id, task.next_send_at, leaseUntil));
  }

  /**
   * 投递收尾时写库，顺手把租约放掉。占位之后的每一次写库都要走这里，漏掉
   * 一条那条任务就得等租约到期才动得了。
   *
   * 没实现 claimTask 的适配器不会有 lease_until 这一列，就别往它的
   * updateTaskById 里塞这个字段了。
   */
  async function updateAndRelease(taskId, fields) {
    return db.updateTaskById(taskId, supportsClaim ? { ...fields, lease_until: null } : fields);
  }

  /**
   * 把这次的错误记进 payload 的 lastError（best-effort）：GET /messages 解密
   * payload 时会把它透出来，宿主能看到「上次为什么没发出去」。加密不了就算了，
   * 记录失败不该拖垮状态推进。
   */
  async function encryptPayloadWithLastError(task, decryptedPayload, userKey, reason) {
    if (!decryptedPayload || !userKey) return null;
    try {
      return await encryptForStorage(JSON.stringify({
        ...decryptedPayload,
        lastError: {
          at: new Date().toISOString(),
          occurrence: task.next_send_at,
          reason
        }
      }), userKey);
    } catch (_encryptError) {
      return null;
    }
  }

  /**
   * 投递失败的处置。重试没用完时安排退避重试；用完时一次性任务标 'failed'
   * 终态，循环任务只作废本次 occurrence（推进到下个周期、重试归零）——循环
   * 任务永远不进终态，一次雷暴不该让每日消息从此消失。
   *
   * 退避写在 lease_until 上（捞取条件会滤掉租约未到期的行，到点自然放行），
   * next_send_at 全程保持名义时刻：它是循环推进和过期判定的基准，被退避时间
   * 改写过一次，这条任务的钟点就永久漂了。没有租约列的适配器（没实现
   * claimTask）退回老行为，把重试时刻写进 next_send_at。
   */
  async function handleDeliveryFailure(task, reason, recurrenceType, decryptedPayload, userKey) {
    results.failedCount++;
    try {
      if (task.retry_count >= 3) {
        const encrypted = await encryptPayloadWithLastError(task, decryptedPayload, userKey, reason);
        if (isRecurringType(recurrenceType)) {
          const nextSendAt = nextFutureOccurrence(Date.parse(task.next_send_at), recurrenceType, Date.now());
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
          await db.updateTaskById(task.id, { lease_until: nextRetryTime.toISOString(), retry_count: task.retry_count + 1 });
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
  async function handlePostSendPersistenceFailure(task, reason, recurrenceType) {
    results.failedCount++;
    if (isRecurringType(recurrenceType)) {
      let advanced = false;
      let nextSendAt = null;
      try {
        nextSendAt = nextFutureOccurrence(Date.parse(task.next_send_at), recurrenceType, Date.now());
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

  async function processTask(task) {
    let claimed;
    try {
      claimed = await claimForThisTick(task);
    } catch (error) {
      // 占位这一步就出错，说明库有问题——此时不知道别人有没有在跑这条，宁可
      // 不发。行还是 pending，下一跳会重新捞。
      results.failedCount++;
      results.failedTasks.push({ taskId: task.id, reason: error.message || '任务占位失败', status: 'claim_failed' });
      return;
    }
    if (!claimed) {
      // 另一个 tick 已经领走了这条，本次什么都不做。
      results.claimSkippedTasks++;
      return;
    }

    // 先解密拿到 recurrenceType：过期判定、终审失败的处置都要看它。解密不了
    // 的话投递也必然失败（processSingleMessage 解的是同一份），按投递失败走
    // 既有的重试/终态逻辑。
    let decryptedPayload = null;
    let userKey = null;
    try {
      userKey = await deriveUserEncryptionKey(task.user_id, masterKey);
      decryptedPayload = JSON.parse(await decryptFromStorage(task.encrypted_payload, userKey));
    } catch (error) {
      await handleDeliveryFailure(task, error.message || '任务载荷解密失败', null, null, null);
      return;
    }
    const recurrenceType = decryptedPayload.recurrenceType;

    // —— 补发新鲜度守卫 ——
    // 服务停摆 N 天恢复后，攒下的旧任务不照常补发：一次性任务标 'failed'
    // 并通知宿主「错过了」；循环任务把排期快进到未来第一个名义时刻。正在
    // 重试链上的（retry_count > 0）不算过期，见 STALE_AFTER_MS 的注释。
    const occurrenceMs = Date.parse(task.next_send_at);
    if (Number.isFinite(occurrenceMs)
        && Date.now() - occurrenceMs > STALE_AFTER_MS
        && (task.retry_count || 0) === 0) {
      try {
        if (isRecurringType(recurrenceType)) {
          const nextSendAt = nextFutureOccurrence(occurrenceMs, recurrenceType, Date.now());
          await updateAndRelease(task.id, { next_send_at: nextSendAt, retry_count: 0 });
          results.staleTasks.push({ taskId: task.id, reason: 'stale', action: 'fast_forwarded', nextSendAt });
        } else {
          const encrypted = await encryptPayloadWithLastError(task, decryptedPayload, userKey, 'stale');
          await updateAndRelease(task.id, {
            status: 'failed',
            ...(encrypted ? { encrypted_payload: encrypted } : {})
          });
          results.staleTasks.push({ taskId: task.id, reason: 'stale', action: 'expired' });
          // 消费方用它写「错过了」回执；best-effort，hook 抛错不影响主流程。
          // task 是 D1 行原样（metadata 锁在 encrypted_payload 密文里），所以
          // 把解密出的 metadata 单独递过去，hook 才能对上是哪个角色的任务。
          // 只透传 metadata 这一个子字段——解密 payload 里还有 apiKey /
          // pushSubscription 等凭据，不能整个递出去。
          if (typeof ctx.onStaleSkip === 'function') {
            try {
              await ctx.onStaleSkip(task, { reason: 'stale', metadata: decryptedPayload.metadata ?? null });
            } catch (hookError) {
              console.warn('[amsg-server] onStaleSkip hook 抛错（已忽略）:', hookError && hookError.message);
            }
          }
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
        const nextSendAt = nextFutureOccurrence(occurrenceMs, recurrenceType, Date.now());
        await updateAndRelease(task.id, { next_send_at: nextSendAt, retry_count: 0 });
        results.updatedRecurringTasks++;
      }

      results.successCount++;
    } catch (error) {
      await handlePostSendPersistenceFailure(task, error.message || '发送后状态更新失败', recurrenceType);
    }
  }

  const taskQueue = [...tasks];
  const processing = [];

  while (taskQueue.length > 0 || processing.length > 0) {
    while (processing.length < MAX_CONCURRENT && taskQueue.length > 0) {
      const task = taskQueue.shift();
      const promise = processTask(task);
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
      deletedOnceOffTasks: results.deletedOnceOffTasks,
      updatedRecurringTasks: results.updatedRecurringTasks,
      staleTasks: results.staleTasks,
      failedTasks: results.failedTasks
    }
  };
}
