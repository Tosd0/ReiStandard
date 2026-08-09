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
 * @property {Object|null}  credRefs      - 凭据引用（{ <purpose>: <cred_id> }）；引用不是机密，客户端对账要看。没带 → null
 * @property {Object|null}  [metadata]    - 只有 includeMetadata 时才有，见下
 * @property {{ at: string, occurrence: string, reason: string }|null} lastError
 */

/**
 * @param {Object} row - 数据库任务行
 * @param {Object} decryptedPayload - 解密后的任务 payload
 * @param {{ includeMetadata?: boolean }} [options]
 *   includeMetadata 时多带一个完整的 `metadata`。列表接口不带：一页最多 100
 *   条，每条都驮着宿主的整份 metadata 会把响应撑得很大，而列表要的只是「有哪
 *   些任务」。要整份 metadata 的是另一件事——`PUT /update-message` 对 metadata
 *   是整体替换，宿主想只改其中一个子字段就必须先读回完整的那份，那条路径走
 *   `GET /message?id=<uuid>`（单条，带完整 metadata）。
 * @returns {TaskProjection}
 */
export function projectTask(row, decryptedPayload, options = {}) {
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
    // 靠它按角色过滤（contactName 会跨角色重名）。缺席 → null。
    charId: metadata.charId ?? null,
    clientTaskId: metadata.amsgClientTaskId ?? null,
    // 凭据引用只是名字（cred_id），本体在 llm_credentials 表里，凭据字段本身
    // 照旧被白名单挡在外面。
    credRefs: payload.credRefs ?? null,
    // 整份 metadata 只在单条查询里给（见上面的 includeMetadata）。
    ...(options.includeMetadata ? { metadata: payload.metadata ?? null } : {}),
    // 上一次没发出去的原因（run-tick 记进 payload 的 lastError）。
    // reason 'stale' 表示错过触发时刻太久被判定不再补发；其余是投递失败的
    // 错误信息。payload 里没有时退回行上的 last_error 列（同形状的脱敏摘要，
    // 等重试期间的失败也记在那里）。没有记录 → null。
    lastError: payload.lastError ?? parseRowLastError(row.last_error),
  };
}

/** 行上 last_error 列的 JSON 解析（形状 { at, occurrence, reason }）；解析不动
 *  就把原文包成 { reason }，别让一条坏记录把投影拖挂。 */
function parseRowLastError(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try { return JSON.parse(raw); }
  catch (_error) { return { reason: raw }; }
}
