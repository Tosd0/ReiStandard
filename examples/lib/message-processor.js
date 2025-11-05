/**
 * 消息处理工具函数库
 * 用于处理单个消息任务的生成和发送
 * ReiStandard v1.1.0
 */

const webpush = require('web-push');
const { deriveUserEncryptionKey, decryptFromStorage } = require('./encryption');
// const { sql } = require('@vercel/postgres');

// 初始化 VAPID，确保在所有调用路径都可用
const VAPID_EMAIL = process.env.VAPID_EMAIL;
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_EMAIL && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    `mailto:${VAPID_EMAIL}`,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  console.log('[message-processor] VAPID configured');
} else {
  console.error('[message-processor] VAPID configuration error:', {
    hasEmail: !!VAPID_EMAIL,
    hasPublicKey: !!VAPID_PUBLIC_KEY,
    hasPrivateKey: !!VAPID_PRIVATE_KEY
  });
}

/**
 * 处理单个消息任务（生成内容 + 发送推送）
 * @param {object} task - 任务对象（从数据库读取）
 * @param {string} task.user_id - 用户ID（用于解密）
 * @param {string} task.uuid - 任务UUID
 * @param {string} task.encrypted_payload - 加密的完整任务数据
 * @param {string} task.message_type - 消息类型（索引字段）
 * @param {string} task.next_send_at - 下次发送时间（索引字段）
 * @param {string} task.status - 任务状态
 * @returns {Promise<{success: boolean, messagesSent: number, error?: string}>}
 */
async function processSingleMessage(task) {
  try {
    // 派生用户专属密钥
    const userKey = deriveUserEncryptionKey(task.user_id);
    
    // 解密整个payload获取完整数据
    const decryptedPayload = JSON.parse(decryptFromStorage(task.encrypted_payload, userKey));
    
    console.log('[message-processor] Processing task:', {
      taskId: task.id,
      contactName: decryptedPayload.contactName,
      messageType: decryptedPayload.messageType
    });

    let messageContent;

    // 根据消息类型生成内容
    if (decryptedPayload.messageType === 'fixed') {
      // 固定消息：直接使用用户消息
      messageContent = decryptedPayload.userMessage;

    } else if (decryptedPayload.messageType === 'instant') {
      // instant 类型：优先使用 AI，否则使用固定消息
      if (decryptedPayload.completePrompt && decryptedPayload.apiUrl && decryptedPayload.apiKey && decryptedPayload.primaryModel) {
        // AI 生成
        const apiUrl = decryptedPayload.apiUrl;
        const apiKey = decryptedPayload.apiKey;
        const completePrompt = decryptedPayload.completePrompt;

        const aiResponse = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: decryptedPayload.primaryModel,
            messages: [
              {
                role: 'user',
                content: completePrompt
              }
            ],
            max_tokens: 500,
            temperature: 0.8
          }),
          signal: AbortSignal.timeout(300000) // 300秒超时
        });

        if (!aiResponse.ok) {
          throw new Error(`AI API error: ${aiResponse.status} ${aiResponse.statusText}`);
        }

        const aiData = await aiResponse.json();
        messageContent = aiData.choices[0].message.content.trim();
      } else if (decryptedPayload.userMessage) {
        // 固定消息
        messageContent = decryptedPayload.userMessage;
      } else {
        throw new Error('Invalid instant message: no content source available');
      }

    } else if (decryptedPayload.messageType === 'prompted' || decryptedPayload.messageType === 'auto') {
      // AI 消息：调用 AI API
      const apiUrl = decryptedPayload.apiUrl;
      const apiKey = decryptedPayload.apiKey;
      const completePrompt = decryptedPayload.completePrompt;

      // 调用 AI API（OpenAI 兼容接口）
      const aiResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: decryptedPayload.primaryModel,
          messages: [
            {
              role: 'user',
              content: completePrompt
            }
          ],
          max_tokens: 500,
          temperature: 0.8
        }),
        signal: AbortSignal.timeout(300000) // 300秒超时
      });

      if (!aiResponse.ok) {
        throw new Error(`AI API error: ${aiResponse.status} ${aiResponse.statusText}`);
      }

      const aiData = await aiResponse.json();
      messageContent = aiData.choices[0].message.content.trim();
    } else {
      throw new Error('Invalid message configuration: no content source available');
    }

    // 消息分句处理（按句号、问号、感叹号分割）
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

    // 如果没有句子，作为单条消息发送
    const messages = sentences.length > 0 ? sentences : [messageContent];

    // 验证 VAPID 配置
    if (!VAPID_EMAIL || !VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
      throw new Error('VAPID configuration missing - push notifications cannot be sent');
    }

    // 批量推送通知（消息间添加延迟）
    const pushSubscription = decryptedPayload.pushSubscription;

    for (let i = 0; i < messages.length; i++) {
      const notificationPayload = {
        title: `来自 ${decryptedPayload.contactName}`,
        message: messages[i],
        contactName: decryptedPayload.contactName,
        messageId: `msg_${Date.now()}_${task.id || 'instant'}_${i}`,
        messageIndex: i + 1,
        totalMessages: messages.length,
        messageType: decryptedPayload.messageType,
        messageSubtype: decryptedPayload.messageSubtype || 'chat',
        taskId: task.id || null,
        timestamp: new Date().toISOString(),
        source: decryptedPayload.messageType === 'instant' ? 'instant' : 'scheduled',
        avatarUrl: decryptedPayload.avatarUrl || null,
        metadata: decryptedPayload.metadata || {}
      };

      await webpush.sendNotification(
        pushSubscription,
        JSON.stringify(notificationPayload)
      );

      console.log('[push] Notification sent:', {
        taskId: task.id,
        messageIndex: i + 1,
        totalMessages: messages.length
      });

      // 消息间延迟（避免过快发送）
      if (i < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    return {
      success: true,
      messagesSent: messages.length
    };

  } catch (error) {
    console.error('[message-processor] Error:', {
      taskId: task.id,
      errorType: error.name,
      errorMessage: error.message
    });

    return {
      success: false,
      messagesSent: 0,
      error: error.message
    };
  }
}

/**
 * 处理指定 UUID 的单个消息（用于 instant 类型）
 * @param {string} uuid - 任务的 UUID
 * @param {number} maxRetries - 最大重试次数（默认2次）
 * @returns {Promise<{success: boolean, messagesSent?: number, error?: object}>}
 */
async function processMessagesByUuid(uuid, maxRetries = 2) {
  let retryCount = 0;
  
  while (retryCount <= maxRetries) {
    try {
      // 查询指定 UUID 的任务（全字段加密版本）
      /*
      const tasks = await sql`
        SELECT
          id, user_id, uuid,
          encrypted_payload,
          message_type, next_send_at,
          status, retry_count
        FROM scheduled_messages
        WHERE uuid = ${uuid} AND status = 'pending'
        LIMIT 1
      `;
      */

      // 模拟数据库查询结果
      const tasks = []; // 实际项目从数据库获取

      if (tasks.length === 0) {
        return {
          success: false,
          error: { code: 'TASK_NOT_FOUND', message: '任务不存在或已处理' }
        };
      }

      const task = tasks[0];

      console.log('[processMessagesByUuid] Processing instant message:', {
        taskId: task.id,
        uuid: task.uuid,
        messageType: task.message_type,  // 使用索引字段
        attempt: retryCount + 1,
        maxRetries: maxRetries + 1
      });

      // 处理消息
      const result = await processSingleMessage(task);

      if (!result.success) {
        // 如果还有重试机会，继续重试
        if (retryCount < maxRetries) {
          retryCount++;
          console.log(`[processMessagesByUuid] Retry ${retryCount}/${maxRetries} for task ${uuid}`);
          await new Promise(resolve => setTimeout(resolve, 1000 * retryCount)); // 递增延迟
          continue;
        }

        // 处理失败，更新任务状态为失败
        /*
        await sql`
          UPDATE scheduled_messages
          SET status = 'failed',
              failure_reason = ${JSON.stringify(result.error)},
              retry_count = ${retryCount},
              updated_at = NOW()
          WHERE id = ${task.id}
        `;
        */

        console.error('[processMessagesByUuid] Final failure after retries:', {
          taskId: task.id,
          uuid: task.uuid,
          retries: retryCount,
          error: result.error
        });

        return {
          success: false,
          error: { 
            code: 'PROCESSING_ERROR', 
            message: result.error,
            retriesAttempted: retryCount
          }
        };
      }

      // 处理成功，删除任务（instant 类型 recurrenceType 固定为 none）
      /*
      await sql`
        DELETE FROM scheduled_messages
        WHERE id = ${task.id}
      `;
      */

      console.log('[processMessagesByUuid] Instant message processed successfully:', {
        taskId: task.id,
        uuid: task.uuid,
        messagesSent: result.messagesSent,
        retriesUsed: retryCount
      });

      return {
        success: true,
        messagesSent: result.messagesSent,
        retriesUsed: retryCount
      };

    } catch (error) {
      // 系统级错误，尝试重试
      if (retryCount < maxRetries) {
        retryCount++;
        console.error(`[processMessagesByUuid] System error, retry ${retryCount}/${maxRetries}:`, error);
        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
        continue;
      }

      // 最终失败
      console.error('[processMessagesByUuid] Final system error:', error);
      
      // 尝试更新数据库状态（如果可能）
      /*
      try {
        await sql`
          UPDATE scheduled_messages
          SET status = 'failed',
              failure_reason = ${JSON.stringify({ 
                code: 'SYSTEM_ERROR', 
                message: error.message 
              })},
              retry_count = ${retryCount},
              updated_at = NOW()
          WHERE uuid = ${uuid} AND status = 'pending'
        `;
      } catch (dbError) {
        console.error('[processMessagesByUuid] Failed to update task status:', dbError);
      }
      */

      return {
        success: false,
        error: { 
          code: 'INTERNAL_ERROR', 
          message: error.message,
          retriesAttempted: retryCount
        }
      };
    }
  }
}

module.exports = {
  processSingleMessage,
  processMessagesByUuid
};
