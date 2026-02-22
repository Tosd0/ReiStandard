/**
 * Handler: send-notifications
 * ReiStandard SDK v1.1.0
 *
 * @param {Object} ctx - Server context.
 * @returns {{ POST: function }}
 */

import { deriveUserEncryptionKey } from '../lib/encryption.js';
import { decryptFromStorage } from '../lib/encryption.js';
import { processSingleMessage } from '../lib/message-processor.js';

export function createSendNotificationsHandler(ctx) {
  async function POST(headers) {
    if (!ctx.vapid.email || !ctx.vapid.publicKey || !ctx.vapid.privateKey) {
      return {
        status: 500,
        body: {
          success: false,
          error: {
            code: 'VAPID_CONFIG_ERROR',
            message: 'VAPID 配置缺失，无法发送推送通知',
            details: {
              missingKeys: [
                !ctx.vapid.email && 'VAPID_EMAIL',
                !ctx.vapid.publicKey && 'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
                !ctx.vapid.privateKey && 'VAPID_PRIVATE_KEY'
              ].filter(Boolean)
            }
          }
        }
      };
    }

    // Verify Cron Secret
    const authHeader = (headers['authorization'] || '').trim();
    const expectedAuth = `Bearer ${ctx.cronSecret}`;

    if (authHeader !== expectedAuth) {
      return { status: 401, body: { success: false, error: { code: 'UNAUTHORIZED', message: 'Cron Secret 验证失败' } } };
    }

    const startTime = Date.now();
    const tasks = await ctx.db.getPendingTasks(50);

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
          await ctx.db.updateTaskById(task.id, { status: 'failed' });
          results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count, status: 'permanently_failed' });
        } else {
          const nextRetryTime = new Date(Date.now() + (task.retry_count + 1) * 2 * 60 * 1000);
          await ctx.db.updateTaskById(task.id, { next_send_at: nextRetryTime.toISOString(), retry_count: task.retry_count + 1 });
          results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count + 1, nextRetryAt: nextRetryTime.toISOString() });
        }
      } catch (updateError) {
        results.failedTasks.push({
          taskId: task.id,
          reason,
          status: 'retry_update_failed',
          updateError: updateError.message
        });
      }
    }

    async function handlePostSendPersistenceFailure(task, reason) {
      results.failedCount++;

      let markedSent = false;
      try {
        await ctx.db.updateTaskById(task.id, { status: 'sent', retry_count: 0 });
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
        sendResult = await processSingleMessage(task, ctx);
      } catch (error) {
        await handleDeliveryFailure(task, error.message || '消息发送失败');
        return;
      }

      if (!sendResult.success) {
        await handleDeliveryFailure(task, sendResult.error || '消息发送失败');
        return;
      }

      try {
        const userKey = deriveUserEncryptionKey(task.user_id, ctx.encryptionKey);
        const decryptedPayload = JSON.parse(decryptFromStorage(task.encrypted_payload, userKey));

        if (decryptedPayload.recurrenceType === 'none') {
          await ctx.db.deleteTaskById(task.id);
          results.deletedOnceOffTasks++;
        } else {
          let nextSendAt;
          const currentSendAt = new Date(task.next_send_at);
          if (decryptedPayload.recurrenceType === 'daily') {
            nextSendAt = new Date(currentSendAt.getTime() + 24 * 60 * 60 * 1000);
          } else if (decryptedPayload.recurrenceType === 'weekly') {
            nextSendAt = new Date(currentSendAt.getTime() + 7 * 24 * 60 * 60 * 1000);
          }
          await ctx.db.updateTaskById(task.id, { next_send_at: nextSendAt.toISOString(), retry_count: 0 });
          results.updatedRecurringTasks++;
        }

        results.successCount++;
      } catch (error) {
        await handlePostSendPersistenceFailure(task, error.message || '发送后状态更新失败');
      }
    }

    // Dynamic task pool
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

    // Cleanup old tasks
    await ctx.db.cleanupOldTasks(7);

    const executionTime = Date.now() - startTime;

    return {
      status: 200,
      body: {
        success: true,
        data: {
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
        }
      }
    };
  }

  return { POST };
}
