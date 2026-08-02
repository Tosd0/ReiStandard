/**
 * 任务行的对外投影：`GET /messages` 列出来的那一份形状。
 *
 * 一份实现两处用：HTTP 列表接口，以及 fire-time hook 的
 * `ctx.scheduleTask()` 撞 uuid 时回给宿主的那条已存在任务。两边给出的字段
 * 一样，宿主拿到哪一份都能直接进自己的任务面板。
 *
 * 白名单式取字段：解密后的 payload 里还躺着 `apiKey` / `apiUrl` /
 * `pushSubscription` 等凭据，投影只挑下面列出的那几个，凭据一个都不出现。
 */

/**
 * @typedef {Object} TaskProjection
 * @property {number|null}  id
 * @property {string|null}  uuid
 * @property {string}       contactName
 * @property {string}       messageType
 * @property {string}       messageSubtype
 * @property {string|null}  nextSendAt
 * @property {string}       recurrenceType
 * @property {string|null}  tzId          - 循环推进用的 IANA 时区 id；没设 → null（按 UTC 推进）
 * @property {string|null}  status
 * @property {number}       retryCount
 * @property {string|null}  createdAt
 * @property {string|null}  updatedAt
 * @property {string|null}  charId        - 取自 metadata.charId
 * @property {string|null}  clientTaskId  - 取自 metadata.amsgClientTaskId
 * @property {{ at: string, occurrence: string, reason: string }|null} lastError
 */

/**
 * @param {Object} row - 数据库任务行
 * @param {Object} decryptedPayload - 解密后的任务 payload
 * @returns {TaskProjection}
 */
export function projectTask(row, decryptedPayload) {
  const payload = decryptedPayload || {};
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  return {
    id: row.id ?? null,
    uuid: row.uuid ?? null,
    contactName: payload.contactName,
    // 行上的 message_type 是索引列，payload 里的是同一个值；列表接口一直读
    // 行上那个，这里保持一致，行上没有时退回 payload。
    messageType: row.message_type ?? payload.messageType,
    messageSubtype: payload.messageSubtype,
    nextSendAt: row.next_send_at ?? null,
    recurrenceType: payload.recurrenceType,
    tzId: payload.tzId ?? null,
    status: row.status ?? null,
    retryCount: row.retry_count ?? 0,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    // 角色归属 / 客户端侧的任务身份，取自排程方写进 metadata 的字段，宿主
    // 靠它按角色过滤（contactName 会跨角色重名）。metadata 的其余部分可能是
    // 宿主私有数据，留在服务端。缺席 → null。
    charId: metadata.charId ?? null,
    clientTaskId: metadata.amsgClientTaskId ?? null,
    // 上一次没发出去的原因（run-tick 记进 payload 的 lastError）。
    // reason 'stale' 表示错过触发时刻太久被判定不再补发；其余是投递失败的
    // 错误信息。没有记录 → null。
    lastError: payload.lastError ?? null,
  };
}
