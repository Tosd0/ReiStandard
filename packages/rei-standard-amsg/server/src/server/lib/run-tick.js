/**
 * Scheduled tick core: fetch due tasks, deliver, reschedule/retry, cleanup.
 * Extracted verbatim from the send-notifications handler so both the HTTP
 * handler (multi-tenant) and the CF scheduled() path (single-user) share it.
 *
 * @param {Object} ctx - { db, masterKey, vapid, webpush }
 * @returns {Promise<Object>} summary { totalTasks, successCount, failedCount, processedAt, executionTime, details }
 */

import { deriveUserEncryptionKey, decryptFromStorage } from './encryption.js';
import { processSingleMessage } from './message-processor.js';

export async function runScheduledTick(ctx) {
  const db = ctx.db;
  const masterKey = ctx.masterKey;

  const startTime = Date.now();
  const tasks = await db.getPendingTasks(50);

  const MAX_CONCURRENT = 8;
  const results = {
    totalTasks: tasks.length,
    successCount: 0,
    failedCount: 0,
    deletedOnceOffTasks: 0,
    updatedRecurringTasks: 0,
    failedTasks: []
  };

  async function handleDeliveryFailure(task, reason) {
    results.failedCount++;
    try {
      if (task.retry_count >= 3) {
        await db.updateTaskById(task.id, { status: 'failed' });
        results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count, status: 'permanently_failed' });
      } else {
        const nextRetryTime = new Date(Date.now() + (task.retry_count + 1) * 2 * 60 * 1000);
        await db.updateTaskById(task.id, { next_send_at: nextRetryTime.toISOString(), retry_count: task.retry_count + 1 });
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
      await db.updateTaskById(task.id, { status: 'sent', retry_count: 0 });
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
      const userKey = deriveUserEncryptionKey(task.user_id, masterKey);
      const decryptedPayload = JSON.parse(decryptFromStorage(task.encrypted_payload, userKey));

      if (decryptedPayload.recurrenceType === 'none') {
        await db.deleteTaskById(task.id);
        results.deletedOnceOffTasks++;
      } else {
        let nextSendAt;
        const currentSendAt = new Date(task.next_send_at);
        if (decryptedPayload.recurrenceType === 'daily') {
          nextSendAt = new Date(currentSendAt.getTime() + 24 * 60 * 60 * 1000);
        } else if (decryptedPayload.recurrenceType === 'weekly') {
          nextSendAt = new Date(currentSendAt.getTime() + 7 * 24 * 60 * 60 * 1000);
        }
        await db.updateTaskById(task.id, { next_send_at: nextSendAt.toISOString(), retry_count: 0 });
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
      deletedOnceOffTasks: results.deletedOnceOffTasks,
      updatedRecurringTasks: results.updatedRecurringTasks,
      failedTasks: results.failedTasks
    }
  };
}
