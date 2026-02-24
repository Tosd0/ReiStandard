/**
 * Handler: cancel-message
 * ReiStandard SDK v2.0.0-pre1
 *
 * @param {Object} ctx - Server context.
 * @returns {{ DELETE: function }}
 */

import { isValidUUIDv4 } from '../lib/validation.js';
import { getHeader } from '../lib/request.js';

export function createCancelMessageHandler(ctx) {
  async function DELETE(url, headers) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers, { url });
    if (!tenantResult.ok) {
      return tenantResult.error;
    }

    const db = tenantResult.context.db;
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

    const deleted = await db.deleteTaskByUuid(taskUuid, userId);

    if (!deleted) {
      return {
        status: 404,
        body: { success: false, error: { code: 'TASK_NOT_FOUND', message: '指定的任务不存在或已被删除' } }
      };
    }

    return {
      status: 200,
      body: {
        success: true,
        data: { uuid: taskUuid, message: '任务已成功取消', deletedAt: new Date().toISOString() }
      }
    };
  }

  return { DELETE };
}
