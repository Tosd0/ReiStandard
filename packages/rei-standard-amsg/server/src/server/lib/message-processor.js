/**
 * Message Processor (SDK version)
 * ReiStandard SDK v2.0.0-pre1
 *
 * Handles single message content generation and Web Push delivery.
 * Receives its dependencies (encryption helpers, webpush, VAPID config)
 * via a context object so that it stays free of process.env references.
 */

import { randomUUID } from 'crypto';
import { decryptFromStorage, deriveUserEncryptionKey } from './encryption.js';

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

    if (decryptedPayload.messageType === 'fixed') {
      messageContent = decryptedPayload.userMessage;

    } else if (decryptedPayload.messageType === 'instant') {
      if (decryptedPayload.completePrompt && decryptedPayload.apiUrl && decryptedPayload.apiKey && decryptedPayload.primaryModel) {
        messageContent = await _callAI(decryptedPayload);
      } else if (decryptedPayload.userMessage) {
        messageContent = decryptedPayload.userMessage;
      } else {
        throw new Error('Invalid instant message: no content source available');
      }

    } else if (decryptedPayload.messageType === 'prompted' || decryptedPayload.messageType === 'auto') {
      messageContent = await _callAI(decryptedPayload);
    } else {
      throw new Error('Invalid message configuration: no content source available');
    }

    // Sentence splitting
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

    const messages = sentences.length > 0 ? sentences : [messageContent];

    if (!ctx.vapid.email || !ctx.vapid.publicKey || !ctx.vapid.privateKey) {
      throw new Error('VAPID configuration missing - push notifications cannot be sent');
    }

    const pushSubscription = decryptedPayload.pushSubscription;

    for (let i = 0; i < messages.length; i++) {
      const notificationPayload = {
        title: `来自 ${decryptedPayload.contactName}`,
        message: messages[i],
        contactName: decryptedPayload.contactName,
        messageId: `msg_${randomUUID()}_${task.id || 'instant'}_${i}`,
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

      await ctx.webpush.sendNotification(pushSubscription, JSON.stringify(notificationPayload));

      if (i < messages.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
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
 * @private
 */
async function _callAI(payload) {
  const normalizedApiUrl = normalizeAiApiUrl(payload.apiUrl);

  const aiResponse = await fetch(normalizedApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${payload.apiKey}`
    },
    body: JSON.stringify({
      model: payload.primaryModel,
      messages: [{ role: 'user', content: payload.completePrompt }],
      max_tokens: 500,
      temperature: 0.8
    }),
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

  return content.trim();
}

/**
 * Normalize AI API URL with minimal, non-breaking rules:
 * - trim whitespace
 * - remove redundant trailing slashes from pathname
 * - keep query string untouched
 *
 * Note: This function does NOT auto-append /v1 or /chat/completions.
 *
 * @param {string} apiUrl
 * @returns {string}
 */
function normalizeAiApiUrl(apiUrl) {
  if (typeof apiUrl !== 'string' || !apiUrl.trim()) {
    throw new Error(
      'Invalid apiUrl: apiUrl is required. ' +
      'Please provide a full chat endpoint URL (for example: https://api.openai.com/v1/chat/completions).'
    );
  }

  const trimmedApiUrl = apiUrl.trim();
  let parsedUrl;

  try {
    parsedUrl = new URL(trimmedApiUrl);
  } catch {
    throw new Error(
      `Invalid apiUrl: "${apiUrl}". ` +
      'Please provide a valid absolute URL that points to a full chat endpoint.'
    );
  }

  parsedUrl.pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
  return parsedUrl.toString();
}
