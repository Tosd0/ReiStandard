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
 * @param {Object} ctx - { db, masterKey, vapid, webpush, claimLeaseMs? }
 * @returns {Promise<Object>} summary { totalTasks, successCount, failedCount, processedAt, executionTime, details }
 */

import { deriveUserEncryptionKey, decryptFromStorage } from './encryption.js';
import { processSingleMessage } from './message-processor.js';

// 占位租期：要盖住最慢的一次投递。老链路单次 LLM 调用上限 300s，agentic 链路
// 整链默认 240s，再留出推送节奏的余量。
export const DEFAULT_CLAIM_LEASE_MS = 10 * 60 * 1000;
// 宿主把 totalTimeoutMs 调大时租期跟着抬，别让下一跳在投递还没跑完时就把行
// 捞回去。（onBeforeFire 里按次放宽的预算这里看不到，那种情况请显式设
// ctx.claimLeaseMs。）
const CLAIM_LEASE_MARGIN_MS = 2 * 60 * 1000;

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

  async function handleDeliveryFailure(task, reason) {
    results.failedCount++;
    try {
      if (task.retry_count >= 3) {
        await updateAndRelease(task.id, { status: 'failed' });
        results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count, status: 'permanently_failed' });
      } else {
        const nextRetryTime = new Date(Date.now() + (task.retry_count + 1) * 2 * 60 * 1000);
        await updateAndRelease(task.id, { next_send_at: nextRetryTime.toISOString(), retry_count: task.retry_count + 1 });
        results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count + 1, nextRetryAt: nextRetryTime.toISOString() });
      }
    } catch (updateError) {
      results.failedTasks.push({ taskId: task.id, reason, status: 'retry_update_failed', updateError: updateError.message });
    }
  }

  async function handlePostSendPersistenceFailure(task, reason) {
    results.failedCount++;
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

    let sendResult;
    try {
      sendResult = await processSingleMessage(task, { ...ctx, db, masterKey }, masterKey);
    } catch (error) {
      await handleDeliveryFailure(task, error.message || '消息发送失败');
      return;
    }

    if (!sendResult.success) {
      await handleDeliveryFailure(task, sendResult.error || '消息发送失败');
      return;
    }

    try {
      const userKey = await deriveUserEncryptionKey(task.user_id, masterKey);
      const decryptedPayload = JSON.parse(await decryptFromStorage(task.encrypted_payload, userKey));

      if (decryptedPayload.recurrenceType === 'none') {
        await db.deleteTaskById(task.id);
        results.deletedOnceOffTasks++;
      } else {
        let nextSendAt;
        // 以这条任务原本的触发时刻为基准往后推。
        const currentSendAt = new Date(task.next_send_at);
        if (decryptedPayload.recurrenceType === 'daily') {
          nextSendAt = new Date(currentSendAt.getTime() + 24 * 60 * 60 * 1000);
        } else if (decryptedPayload.recurrenceType === 'weekly') {
          nextSendAt = new Date(currentSendAt.getTime() + 7 * 24 * 60 * 60 * 1000);
        }
        await updateAndRelease(task.id, { next_send_at: nextSendAt.toISOString(), retry_count: 0 });
        results.updatedRecurringTasks++;
      }

      results.successCount++;
    } catch (error) {
      await handlePostSendPersistenceFailure(task, error.message || '发送后状态更新失败');
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
      failedTasks: results.failedTasks
    }
  };
}
