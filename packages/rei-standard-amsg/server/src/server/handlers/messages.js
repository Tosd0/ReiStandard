/**
 * Handler: messages
 *
 * @param {Object} ctx - Server context.
 * @returns {{ GET: function }}
 */

import { deriveUserEncryptionKey, decryptFromStorage, encryptPayload } from '../lib/encryption.js';
import { requireUserId } from '../lib/request.js';
import { projectTask } from '../lib/task-projection.js';

export function createMessagesHandler(ctx) {
  async function GET(url, headers) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers, { url });
    if (!tenantResult.ok) {
      return tenantResult.error;
    }

    const tenantCtx = tenantResult.context;
    const db = tenantCtx.db;
    const masterKey = tenantCtx.masterKey;
    const gate = requireUserId(headers);
    if (gate.error) return gate.error;
    const { userId } = gate;

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

    const userKey = await deriveUserEncryptionKey(userId, masterKey);

    // 投影形状住在 lib/task-projection.js —— fire-time hook 的
    // ctx.scheduleTask() 撞 uuid 时回给宿主的那条任务用的是同一份，两边不会漂。
    const decryptedTasks = await Promise.all(tasks.map(async task => {
      const decrypted = JSON.parse(await decryptFromStorage(task.encrypted_payload, userKey));
      return projectTask(task, decrypted);
    }));

    const responsePayload = {
      tasks: decryptedTasks,
      pagination: { total, limit, offset, hasMore: offset + limit < total }
    };
    const encryptedResponse = await encryptPayload(responsePayload, userKey);

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
