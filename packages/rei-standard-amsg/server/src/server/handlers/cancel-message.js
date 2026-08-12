/**
 * Handler: cancel-message
 *
 * @param {Object} ctx - Server context.
 * @returns {{ DELETE: function }}
 */

import { requireUserId } from '../lib/request.js';
import { discardUndeliveredPushesForTask } from '../lib/outbox-store.js';

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

    const gate = requireUserId(headers);
    if (gate.error) return gate.error;
    const { userId } = gate;

    const deleted = await db.deleteTaskByUuid(taskUuid, userId);

    if (!deleted) {
      return {
        status: 404,
        body: { success: false, error: { code: 'TASK_NOT_FOUND', message: '指定的任务不存在或已被删除' } }
      };
    }

    // 删掉任务行只挡住了「以后还会发的」。这条任务此前投递到一半失败过的话，
    // 没发出去的那几段还留在 message_outbox 里等客户端补收——不撤掉的话，用户
    // 看到的就是「取消接口回了成功，消息还是来了」。已经推到设备上的分段不在
    // 此列，留着让客户端照常 ack。清理是 best-effort，失败也不翻掉这次取消。
    await discardUndeliveredPushesForTask({ db, userId, taskUuid });

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
