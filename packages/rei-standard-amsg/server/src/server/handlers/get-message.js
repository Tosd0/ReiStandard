/**
 * Handler: get-message
 *
 * `GET /message?id=<uuid>` —— 单条任务，比 `GET /messages` 列表多给一个完整的
 * `metadata`。
 *
 * 为什么要这么一个端点：`PUT /update-message` 对 `metadata` 是**整体替换**，
 * 不做深合并。列表投影里只有 `charId` / `clientTaskId` 两个子字段，所以「只改
 * metadata 里的一个键」在客户端本来是做不到的——读不回完整的那份，就没法读-改-
 * 写；盲传一部分字段会把宿主存在里面的其余键（任务指令、锚点时间戳、过期策略
 * 之类）一起冲掉。列表接口不跟着改，是因为一页最多 100 条，每条都驮着整份
 * metadata 会把响应撑得很大，而列表要的只是「有哪些任务」。
 *
 * 只读得到还没发出去的任务（`status = 'pending'`），已完成 / 已失败的返回
 * 409 —— 与 `PUT /update-message` 同一口径：读回来就是为了改，改不动的也没必要
 * 读回来。
 *
 * @param {Object} ctx - Server context.
 * @returns {{ GET: function }}
 */

import { deriveUserEncryptionKey, decryptFromStorage, encryptPayload } from '../lib/encryption.js';
import { requireUserId } from '../lib/request.js';
import { projectTask } from '../lib/task-projection.js';

export function createGetMessageHandler(ctx) {
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

    const taskUuid = new URL(url, 'https://dummy').searchParams.get('id');
    if (!taskUuid) {
      return { status: 400, body: { success: false, error: { code: 'TASK_ID_REQUIRED', message: '缺少任务ID' } } };
    }

    const row = await db.getTaskByUuid(taskUuid, userId);
    if (!row) {
      // 已完成 / 已失败的行读不回 payload，但「为什么失败」必须读得到——用户
      // 等到任务失败后来查，只回一句 409 等于「云端没记下原因」。行上的
      // last_error 列是明文的脱敏摘要（run-tick 失败时写的），随 409 的
      // details 一起透出去。
      const statusInfo = typeof db.getTaskStatusInfo === 'function'
        ? await db.getTaskStatusInfo(taskUuid, userId)
        : null;
      const taskStatus = statusInfo ? statusInfo.status : await db.getTaskStatus(taskUuid, userId);
      if (!taskStatus) {
        return { status: 404, body: { success: false, error: { code: 'TASK_NOT_FOUND', message: '指定的任务不存在或已被删除' } } };
      }
      let lastError = null;
      if (statusInfo && statusInfo.last_error) {
        try { lastError = JSON.parse(statusInfo.last_error); }
        catch (_parseError) { lastError = { reason: statusInfo.last_error }; }
      }
      return {
        status: 409,
        body: {
          success: false,
          error: {
            code: 'TASK_ALREADY_COMPLETED',
            message: '任务已完成或已失败，无法更新',
            details: { status: taskStatus, lastError }
          }
        }
      };
    }

    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    const decrypted = JSON.parse(await decryptFromStorage(row.encrypted_payload, userKey));
    // 投影形状与列表接口共用一份（lib/task-projection.js），凭据一个都不出现。
    const task = projectTask(row, decrypted, { includeMetadata: true });

    return {
      status: 200,
      body: {
        success: true,
        encrypted: true,
        version: 1,
        data: await encryptPayload({ task }, userKey)
      }
    };
  }

  return { GET };
}
