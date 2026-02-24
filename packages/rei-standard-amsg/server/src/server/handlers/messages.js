/**
 * Handler: messages
 * ReiStandard SDK v2.0.0
 *
 * @param {Object} ctx - Server context.
 * @returns {{ GET: function }}
 */

import { deriveUserEncryptionKey, decryptFromStorage, encryptPayload } from '../lib/encryption.js';
import { getHeader } from '../lib/request.js';
import { isValidUUIDv4 } from '../lib/validation.js';

export function createMessagesHandler(ctx) {
  async function GET(url, headers) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers, { url });
    if (!tenantResult.ok) {
      return tenantResult.error;
    }

    const tenantCtx = tenantResult.context;
    const db = tenantCtx.db;
    const masterKey = tenantCtx.masterKey;
    const userId = getHeader(headers, 'x-user-id');

    if (!userId) {
      return {
        status: 400,
        body: { success: false, error: { code: 'USER_ID_REQUIRED', message: '必须提供 X-User-Id 请求头' } }
      };
    }
    if (!isValidUUIDv4(userId)) {
      return {
        status: 400,
        body: { success: false, error: { code: 'INVALID_USER_ID_FORMAT', message: 'X-User-Id 必须是 UUID v4 格式' } }
      };
    }

    const u = new URL(url, 'https://dummy');
    const status = u.searchParams.get('status') || 'all';
    const limit = Math.min(parseInt(u.searchParams.get('limit') || '20', 10), 100);
    const offset = parseInt(u.searchParams.get('offset') || '0', 10);

    if (isNaN(limit) || limit < 1) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_PARAMETERS', message: 'limit 参数无效，必须为正整数' } } };
    }

    if (isNaN(offset) || offset < 0) {
      return { status: 400, body: { success: false, error: { code: 'INVALID_PARAMETERS', message: 'offset 参数无效，必须为非负整数' } } };
    }

    const { tasks, total } = await db.listTasks(userId, { status, limit, offset });

    const userKey = deriveUserEncryptionKey(userId, masterKey);

    const decryptedTasks = tasks.map(task => {
      const decrypted = JSON.parse(decryptFromStorage(task.encrypted_payload, userKey));
      return {
        id: task.id,
        uuid: task.uuid,
        contactName: decrypted.contactName,
        messageType: task.message_type,
        messageSubtype: decrypted.messageSubtype,
        nextSendAt: task.next_send_at,
        recurrenceType: decrypted.recurrenceType,
        status: task.status,
        retryCount: task.retry_count,
        createdAt: task.created_at,
        updatedAt: task.updated_at
      };
    });

    const responsePayload = {
      tasks: decryptedTasks,
      pagination: { total, limit, offset, hasMore: offset + limit < total }
    };
    const encryptedResponse = encryptPayload(responsePayload, userKey);

    return {
      status: 200,
      body: {
        success: true,
        encrypted: true,
        version: 1,
        data: encryptedResponse
      }
    };
  }

  return { GET };
}
