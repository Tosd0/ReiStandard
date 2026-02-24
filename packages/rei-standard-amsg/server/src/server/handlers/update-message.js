/**
 * Handler: update-message
 * ReiStandard SDK v2.0.0
 *
 * @param {Object} ctx - Server context.
 * @returns {{ PUT: function }}
 */

import { deriveUserEncryptionKey, decryptPayload, encryptForStorage, decryptFromStorage } from '../lib/encryption.js';
import { getHeader, isPlainObject, parseEncryptedBody } from '../lib/request.js';
import { isValidISO8601, isValidUUIDv4 } from '../lib/validation.js';

export function createUpdateMessageHandler(ctx) {
  async function PUT(url, headers, body) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers, { url });
    if (!tenantResult.ok) {
      return tenantResult.error;
    }

    const tenantCtx = tenantResult.context;
    const db = tenantCtx.db;
    const masterKey = tenantCtx.masterKey;
    const u = new URL(url, 'https://dummy');
    const taskUuid = u.searchParams.get('id');

    if (!taskUuid) {
      return { status: 400, body: { success: false, error: { code: 'TASK_ID_REQUIRED', message: '缺少任务ID' } } };
    }

    const userId = getHeader(headers, 'x-user-id');
    if (!userId) {
      return { status: 400, body: { success: false, error: { code: 'USER_ID_REQUIRED', message: '缺少用户标识符' } } };
    }
    if (!isValidUUIDv4(userId)) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_USER_ID_FORMAT', message: 'X-User-Id 必须是 UUID v4 格式' } } };
    }

    const isEncrypted = getHeader(headers, 'x-payload-encrypted') === 'true';
    const encryptionVersion = getHeader(headers, 'x-encryption-version');

    if (!isEncrypted) {
      return { status: 400, body: { success: false, error: { code: 'ENCRYPTION_REQUIRED', message: '请求体必须加密' } } };
    }

    if (encryptionVersion !== '1') {
      return { status: 400, body: { success: false, error: { code: 'UNSUPPORTED_ENCRYPTION_VERSION', message: '加密版本不支持' } } };
    }

    const parsedBody = parseEncryptedBody(body);
    if (!parsedBody.ok) {
      return { status: 400, body: { success: false, error: parsedBody.error } };
    }

    const encryptedBody = parsedBody.data;
    const userKey = deriveUserEncryptionKey(userId, masterKey);
    let updates;

    try {
      updates = decryptPayload(encryptedBody, userKey);
    } catch (_error) {
      return { status: 400, body: { success: false, error: { code: 'DECRYPTION_FAILED', message: '请求体解密失败' } } };
    }

    if (!isPlainObject(updates)) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: '更新数据格式错误' } } };
    }

    if (updates.nextSendAt && !isValidISO8601(updates.nextSendAt)) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: '更新数据格式错误', details: { invalidFields: ['nextSendAt'] } } } };
    }

    if (updates.recurrenceType && !['none', 'daily', 'weekly'].includes(updates.recurrenceType)) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: '更新数据格式错误', details: { invalidFields: ['recurrenceType'] } } } };
    }

    // Fetch existing task
    const existingTask = await db.getTaskByUuid(taskUuid, userId);

    if (!existingTask) {
      const taskStatus = await db.getTaskStatus(taskUuid, userId);
      if (!taskStatus) {
        return { status: 404, body: { success: false, error: { code: 'TASK_NOT_FOUND', message: '指定的任务不存在或已被删除' } } };
      }
      return { status: 409, body: { success: false, error: { code: 'TASK_ALREADY_COMPLETED', message: '任务已完成或已失败，无法更新' } } };
    }

    const existingData = JSON.parse(decryptFromStorage(existingTask.encrypted_payload, userKey));

    const updatedData = {
      ...existingData,
      ...(updates.completePrompt && { completePrompt: updates.completePrompt }),
      ...(updates.userMessage && { userMessage: updates.userMessage }),
      ...(updates.recurrenceType && { recurrenceType: updates.recurrenceType }),
      ...(updates.avatarUrl && { avatarUrl: updates.avatarUrl }),
      ...(updates.metadata && { metadata: updates.metadata })
    };

    const encryptedPayload = encryptForStorage(JSON.stringify(updatedData), userKey);
    const extraFields = updates.nextSendAt ? { next_send_at: updates.nextSendAt } : undefined;

    const result = await db.updateTaskByUuid(taskUuid, userId, encryptedPayload, extraFields);

    if (!result) {
      return { status: 409, body: { success: false, error: { code: 'UPDATE_CONFLICT', message: '任务更新失败，任务可能已被修改或删除' } } };
    }

    return {
      status: 200,
      body: {
        success: true,
        data: {
          uuid: taskUuid,
          updatedFields: Object.keys(updates),
          updatedAt: result.updated_at
        }
      }
    };
  }

  return { PUT };
}
