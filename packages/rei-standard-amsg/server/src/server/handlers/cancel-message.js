/**
 * Handler: cancel-message
 * ReiStandard SDK v1.1.0
 *
 * @param {Object} ctx - Server context.
 * @returns {{ DELETE: function }}
 */

export function createCancelMessageHandler(ctx) {
  async function DELETE(url, headers) {
    const u = new URL(url, 'https://dummy');
    const taskUuid = u.searchParams.get('id');

    if (!taskUuid) {
      return { status: 400, body: { success: false, error: { code: 'TASK_ID_REQUIRED', message: '缺少任务ID' } } };
    }

    const userId = headers['x-user-id'];
    if (!userId) {
      return { status: 400, body: { success: false, error: { code: 'USER_ID_REQUIRED', message: '缺少用户标识符' } } };
    }

    const deleted = await ctx.db.deleteTaskByUuid(taskUuid, userId);

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
