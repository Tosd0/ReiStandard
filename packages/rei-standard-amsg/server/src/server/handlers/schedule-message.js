/**
 * Handler: schedule-message
 * ReiStandard SDK v2.0.0-pre1
 *
 * @param {Object} ctx - Server context.
 * @returns {{ POST: function }}
 */

import { randomUUID } from 'crypto';
import { deriveUserEncryptionKey, decryptPayload, encryptForStorage } from '../lib/encryption.js';
import { isUniqueViolation } from '../lib/db-errors.js';
import { getHeader, isPlainObject, parseEncryptedBody } from '../lib/request.js';
import { validateScheduleMessagePayload, isValidUUIDv4 } from '../lib/validation.js';
import { processMessagesByUuid } from '../lib/message-processor.js';

export function createScheduleMessageHandler(ctx) {
  async function POST(headers, body) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers);
    if (!tenantResult.ok) {
      return tenantResult.error;
    }

    const tenantCtx = tenantResult.context;
    const db = tenantCtx.db;
    const masterKey = tenantCtx.masterKey;
    const isEncrypted = getHeader(headers, 'x-payload-encrypted') === 'true';
    const encryptionVersion = getHeader(headers, 'x-encryption-version');
    const userId = getHeader(headers, 'x-user-id');

    if (!isEncrypted) {
      return { status: 400, body: { success: false, error: { code: 'ENCRYPTION_REQUIRED', message: '请求体必须加密' } } };
    }
    if (!userId) {
      return { status: 400, body: { success: false, error: { code: 'USER_ID_REQUIRED', message: '缺少用户标识符' } } };
    }
    if (!isValidUUIDv4(userId)) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_USER_ID_FORMAT', message: 'X-User-Id 必须是 UUID v4 格式' } } };
    }
    if (encryptionVersion !== '1') {
      return { status: 400, body: { success: false, error: { code: 'UNSUPPORTED_ENCRYPTION_VERSION', message: '加密版本不支持' } } };
    }

    // Decrypt request body
    const parsedBody = parseEncryptedBody(body);
    if (!parsedBody.ok) {
      return { status: 400, body: { success: false, error: parsedBody.error } };
    }

    const encryptedBody = parsedBody.data;

    let payload;
    try {
      const userKey = deriveUserEncryptionKey(userId, masterKey);
      payload = decryptPayload(encryptedBody, userKey);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return { status: 400, body: { success: false, error: { code: 'INVALID_PAYLOAD_FORMAT', message: '解密后的数据不是有效 JSON' } } };
      }

      const message = typeof error.message === 'string' ? error.message : '';
      if (message.includes('auth') || message.includes('Unsupported state')) {
        return { status: 400, body: { success: false, error: { code: 'DECRYPTION_FAILED', message: '请求体解密失败' } } };
      }

      return { status: 400, body: { success: false, error: { code: 'DECRYPTION_FAILED', message: '请求体解密失败' } } };
    }

    if (!isPlainObject(payload)) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_PAYLOAD_FORMAT', message: '解密后的数据必须是 JSON 对象' } } };
    }

    // Validate
    const validationResult = validateScheduleMessagePayload(payload);
    if (!validationResult.valid) {
      return { status: 400, body: { success: false, error: { code: validationResult.errorCode, message: validationResult.errorMessage, details: validationResult.details } } };
    }

    const taskUuid = payload.uuid || randomUUID();
    const userKey = deriveUserEncryptionKey(userId, masterKey);

    const fullTaskData = {
      contactName: payload.contactName,
      avatarUrl: payload.avatarUrl || null,
      messageType: payload.messageType,
      messageSubtype: payload.messageSubtype || 'chat',
      userMessage: payload.userMessage || null,
      firstSendTime: payload.firstSendTime,
      recurrenceType: payload.recurrenceType || 'none',
      apiUrl: payload.apiUrl || null,
      apiKey: payload.apiKey || null,
      primaryModel: payload.primaryModel || null,
      completePrompt: payload.completePrompt || null,
      maxTokens: payload.maxTokens ?? null,
      pushSubscription: payload.pushSubscription,
      metadata: payload.metadata || {}
    };

    const encryptedPayload = encryptForStorage(JSON.stringify(fullTaskData), userKey);

    // Instant type: check VAPID before creating the task to avoid orphaned rows
    if (payload.messageType === 'instant') {
      if (!ctx.vapid.email || !ctx.vapid.publicKey || !ctx.vapid.privateKey) {
        return {
          status: 500,
          body: {
            success: false,
            error: {
              code: 'VAPID_CONFIG_ERROR',
              message: 'VAPID 配置缺失，无法发送即时消息',
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
    }

    // Insert into database
    let dbResult;
    try {
      dbResult = await db.createTask({
        user_id: userId,
        uuid: taskUuid,
        encrypted_payload: encryptedPayload,
        next_send_at: payload.firstSendTime,
        message_type: payload.messageType
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return {
          status: 409,
          body: {
            success: false,
            error: {
              code: 'TASK_UUID_CONFLICT',
              message: '任务 UUID 已存在，请使用新的 uuid 重新提交'
            }
          }
        };
      }
      throw error;
    }

    if (!dbResult) {
      return { status: 500, body: { success: false, error: { code: 'TASK_CREATE_FAILED', message: '创建任务失败' } } };
    }

    // Instant type: send immediately
    if (payload.messageType === 'instant') {
      try {
        const sendResult = await processMessagesByUuid(taskUuid, {
          ...ctx,
          db,
          masterKey
        }, 2, userId, masterKey);

        if (!sendResult.success) {
          return { status: 500, body: { success: false, error: { code: 'MESSAGE_SEND_FAILED', message: '消息发送失败', details: sendResult.error } } };
        }

        return {
          status: 200,
          body: {
            success: true,
            data: {
              uuid: taskUuid,
              contactName: payload.contactName,
              messagesSent: sendResult.messagesSent,
              sentAt: new Date().toISOString(),
              status: 'sent',
              retriesUsed: sendResult.retriesUsed || 0
            }
          }
        };
      } catch (error) {
        return { status: 500, body: { success: false, error: { code: 'MESSAGE_SEND_FAILED', message: '消息发送失败', details: { error: error.message } } } };
      }
    }

    // Non-instant: return scheduled response
    return {
      status: 201,
      body: {
        success: true,
        data: {
          id: dbResult.id,
          uuid: dbResult.uuid,
          contactName: payload.contactName,
          nextSendAt: dbResult.next_send_at,
          status: dbResult.status,
          createdAt: dbResult.created_at
        }
      }
    };
  }

  return { POST };
}
