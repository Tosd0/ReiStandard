/**
 * Handler: update-message
 * ReiStandard SDK v2.0.1
 *
 * @param {Object} ctx - Server context.
 * @returns {{ PUT: function }}
 */

import { deriveUserEncryptionKey, decryptPayload, encryptForStorage, decryptFromStorage } from '../lib/encryption.js';
import { getHeader, isPlainObject, parseEncryptedBody } from '../lib/request.js';
import { isValidISO8601, isValidUUIDv4, validateLlmMessagesArray, validateSplitPattern, validateAvatarUrl } from '../lib/validation.js';

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

    if (
      Object.prototype.hasOwnProperty.call(updates, 'maxTokens') &&
      updates.maxTokens !== null &&
      (!Number.isInteger(updates.maxTokens) || updates.maxTokens <= 0)
    ) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: '更新数据格式错误', details: { invalidFields: ['maxTokens'] } } } };
    }

    // Reject updates that try to set both completePrompt and messages at
    // once. We don't enforce one-of-required here (callers may patch other
    // fields), but the two prompt sources are mutually exclusive and must
    // stay that way in storage too.
    if (
      updates.completePrompt &&
      updates.messages !== undefined && updates.messages !== null
    ) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: 'completePrompt 与 messages 不能同时更新（二选一）', details: { invalidFields: ['completePrompt', 'messages'] } } } };
    }
    if (updates.messages !== undefined && updates.messages !== null) {
      const msgErr = validateLlmMessagesArray(updates.messages);
      if (msgErr) {
        return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: msgErr, details: { invalidFields: ['messages'] } } } };
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(updates, 'temperature') &&
      updates.temperature !== null &&
      (typeof updates.temperature !== 'number' || !Number.isFinite(updates.temperature))
    ) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: '更新数据格式错误', details: { invalidFields: ['temperature'] } } } };
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'splitPattern')) {
      const splitErr = validateSplitPattern(updates.splitPattern);
      if (splitErr) {
        return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: splitErr, details: { invalidFields: ['splitPattern'] } } } };
      }
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'avatarUrl')) {
      const avatarErr = validateAvatarUrl(updates.avatarUrl);
      if (avatarErr) {
        return { status: 400, body: { success: false, error: { code: 'INVALID_UPDATE_DATA', message: avatarErr, details: { invalidFields: ['avatarUrl'] } } } };
      }
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

    // When the caller switches prompt source (completePrompt ↔ messages),
    // null out the other so storage stays one-of (matches schedule-message
    // shape and prevents buildAiRequestBody from accidentally seeing both).
    const promptUpdates = {};
    if (updates.completePrompt) {
      promptUpdates.completePrompt = updates.completePrompt;
      promptUpdates.messages = null;
    } else if (updates.messages !== undefined && updates.messages !== null) {
      promptUpdates.messages = updates.messages;
      promptUpdates.completePrompt = null;
    }

    const updatedData = {
      ...existingData,
      ...promptUpdates,
      ...(updates.userMessage && { userMessage: updates.userMessage }),
      ...(updates.recurrenceType && { recurrenceType: updates.recurrenceType }),
      ...(updates.avatarUrl && { avatarUrl: updates.avatarUrl }),
      ...(updates.metadata && { metadata: updates.metadata }),
      ...(Object.prototype.hasOwnProperty.call(updates, 'maxTokens') && { maxTokens: updates.maxTokens ?? null }),
      ...(Object.prototype.hasOwnProperty.call(updates, 'temperature') && { temperature: updates.temperature ?? null }),
      // splitPattern: hasOwnProperty so that explicit `null` (= revert to
      // default) doesn't get swallowed by truthy-spread the way the optional
      // string fields above are.
      ...(Object.prototype.hasOwnProperty.call(updates, 'splitPattern') && { splitPattern: updates.splitPattern ?? null })
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
