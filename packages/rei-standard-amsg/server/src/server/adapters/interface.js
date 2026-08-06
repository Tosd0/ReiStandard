/**
 * Database Adapter Interface
 *
 * Defines the contract that every database adapter must fulfil.
 * Implementations live in ./neon.js, ./pg.js, etc.
 */

/**
 * @typedef {Object} TaskRow
 * @property {number}  id
 * @property {string}  user_id
 * @property {string}  uuid
 * @property {string}  encrypted_payload
 * @property {string}  message_type
 * @property {string}  next_send_at
 * @property {string}  status
 * @property {number}  retry_count
 * @property {string}  created_at
 * @property {string}  updated_at
 */

/**
 * @typedef {Object} InsertTaskParams
 * @property {string}  user_id
 * @property {string}  uuid
 * @property {string}  encrypted_payload
 * @property {string}  next_send_at
 * @property {string}  message_type
 */

/**
 * @typedef {Object} InitSchemaResult
 * @property {number} columnsCreated
 * @property {number} indexesCreated
 * @property {number} indexesFailed
 * @property {Array}  columns
 * @property {Array}  indexes
 */

/**
 * @typedef {Object} DbAdapter
 * @property {() => Promise<InitSchemaResult>} initSchema
 *   Create the scheduled_messages table and all indexes.
 * @property {() => Promise<void>} dropSchema
 *   Drop the scheduled_messages table (CASCADE).
 * @property {(params: InsertTaskParams) => Promise<TaskRow>} createTask
 *   Insert a new task row and return the created record.
 * @property {(uuid: string, userId: string) => Promise<TaskRow|null>} getTaskByUuid
 *   Fetch a single pending task by uuid + user_id.
 * @property {(uuid: string) => Promise<TaskRow|null>} getTaskByUuidOnly
 *   Fetch a single pending task by uuid only (used by instant processing).
 * @property {(taskId: number, updates: Object) => Promise<TaskRow|null>} updateTaskById
 *   Partially update a task row by its numeric id.
 *   实现了 `claimTask` 的适配器还要认 `lease_until` 和 `retry_after`（含写
 *   null）：投递收尾时 runScheduledTick 用前者把租约放掉，用后者写/清投递失败
 *   的退避时刻。
 * @property {(uuid: string, userId: string, encryptedPayload: string, extraFields?: Object) => Promise<TaskRow|null>} updateTaskByUuid
 *   Update a pending task's encrypted_payload (and optional index fields) by uuid + user_id.
 * @property {(taskId: number) => Promise<boolean>} deleteTaskById
 *   Delete a task by numeric id. Returns true if a row was affected.
 * @property {(uuid: string, userId: string) => Promise<boolean>} deleteTaskByUuid
 *   Delete a task by uuid + user_id. Returns true if a row was affected.
 * @property {(limit?: number) => Promise<TaskRow[]>} getPendingTasks
 *   Fetch pending tasks whose next_send_at <= NOW(), ordered ASC.
 *   跳过两种还不该动的行：租约没到期的（`lease_until`，有人正在跑）、退避没到
 *   点的（`retry_after`，上次投递失败在等重试）。两列都是空或已过期才算待发。
 * @property {(taskId: number, expectedNextSendAt: string|Date, leaseUntil: string|Date, serializeGroup?: string|null) => Promise<boolean>} [claimTask]
 *   领取一条到点的任务，返回是否领到。cron 每分钟一跳而一次投递可能跑几分
 *   钟，runScheduledTick 靠它保证同一行同时只被一个 tick 跑。
 *   三个条件同时成立才领得走：行仍是 pending；`lease_until` 为空或已过期
 *   （没别人正在跑）；`next_send_at` 还等于 `expectedNextSendAt`（读这行时
 *   拿到的值，用户中途改了排期就不发了）。领到就把 `lease_until` 写成
 *   `leaseUntil`，`next_send_at` 不动。
 *   传了非空 `serializeGroup` 时还多一个条件：同一分组里没有别的行拿着未到期
 *   的租约（同一分组同时只跑一条，`runScheduledTick` 的 `serializeBy` 用）。
 *   领到时把这个值写进 `serialize_group` 列。判定和占位必须在同一条语句里，
 *   「先查再占」中间的空档会让两个 tick 同时进同一个分组。
 *   自定义适配器可以不实现（runScheduledTick 会退回不占位的行为，代价是慢
 *   任务可能被下一跳重复触发）；实现了但忽略第四个参数的，分组串行退化成只在
 *   同一跳内生效。
 * @property {(userId: string, opts: {status?: string, limit?: number, offset?: number}) => Promise<{tasks: TaskRow[], total: number}>} listTasks
 *   List tasks for a user with optional filters and pagination.
 * @property {(days?: number) => Promise<number>} cleanupOldTasks
 *   Delete completed / failed tasks older than `days` (default 7).
 * @property {(uuid: string, userId: string) => Promise<string|null>} getTaskStatus
 *   Return the status string of a task (used to distinguish 404 from 409).
 * @property {(userId: string, entries: Array<{namespace: string, key: string, value: string, updatedAt: number}>, cleanups?: Array<{namespace: string, key?: string, keyPrefix?: string, updatedAt: number}>) => Promise<{upserted: number, skipped: number, outcomes?: boolean[]}>} [upsertClientState]
 *   (optional; single-user/D1 only) Batch upsert of client state, last-write-wins on updatedAt.
 *   `cleanups` 先于 upsert 在同一事务里删旧行，两种形态：带 `keyPrefix` 的按 key 前缀删（清理大值
 *   旧写入留下的切片行，见 lib/state-chunks.js），带 `key` 的删这一个 key（删整条状态；前缀会连带
 *   删掉同前缀的兄弟 key）。两种都只删 `updated_at <= updatedAt` 的行。自定义 adapter 忽略前缀形态
 *   只损失存储卫生；忽略精确 key 形态则删不掉状态，`ctx.writeState()` 的删除会失效。
 *   `outcomes` 逐条报告 entries[i] 是否真的写入（缺席时调用方按物理行计数兜底）。
 * @property {(userId: string, namespace: string) => Promise<Array<{namespace: string, key: string, value: string, updated_at: number}>>} [getClientState]
 *   (optional; single-user/D1 only) All entries of one namespace; values still encrypted.
 * @property {(userId: string) => Promise<number>} [clearClientState]
 *   (optional; single-user/D1 only) Delete every entry of this user; returns rows deleted.
 * @property {(userId: string) => Promise<{ subscription: string, updated_at: number }|null>} [getPushSubscription]
 *   这个用户当前登记的 Web Push 订阅（`subscription` 是密文，解密在上层）。没有登记过 → null。
 *   一个用户一份：任务行不携带订阅，到点投递时读这里。
 * @property {(userId: string, encryptedSubscription: string, updatedAt: number) => Promise<boolean>} [upsertPushSubscription]
 *   覆盖写这个用户的订阅（`updatedAt` 是 epoch 毫秒）。没有 last-write-wins 比较——
 *   客户端拿到的新订阅永远比旧的有效，旧的那份只会 410。
 * @property {(userId: string) => Promise<boolean>} [deletePushSubscription]
 *   删掉这个用户的订阅；返回是否真的删掉了一行。
 *
 *   上面三个方法要么都实现、要么都不实现：缺任何一个，`PUT/GET/DELETE
 *   /push-subscription` 返回 501，`POST /schedule-message` 也会拒绝建任务
 *   （建了也永远发不出去）。内置的 D1 / pg / neon 适配器都实现了。
 * @property {(taskId: number, leaseUntil: string|Date) => Promise<boolean>} [renewTaskLease]
 *   （可选）投递期间的租约续期（runScheduledTick 的心跳）。只在行仍是
 *   pending 且 lease_until 非空时生效——收尾放掉租约之后，迟到的心跳不会把
 *   它复活。不实现 → 心跳自动关闭，退回一次性长租约（claimLeaseMs）。
 * @property {(uuid: string, userId: string) => Promise<{ status: string, last_error: string|null }|null>} [getTaskStatusInfo]
 *   （可选）状态 + last_error 列（脱敏失败摘要的 JSON 串）。GET /message 用
 *   它把「为什么失败」透给已失败的行；不实现时退回 getTaskStatus（409 里就
 *   没有 lastError）。
 * @property {(params: InsertTaskParams, supersedesUuid: string) => Promise<TaskRow & { superseded: boolean }>} [createTaskSuperseding]
 *   （可选）建新任务的同一事务里取消旧的那条（POST /schedule-message 的
 *   supersedesUuid）。不实现时 handler 退回「先删再建」两步（失去原子性）。
 * @property {(userId: string, rows: Array<Object>) => Promise<number>} [appendOutboxMessages]
 *   （可选；单用户/D1）push 发送前把整批落进 message_outbox（密文 payload），
 *   (user_id, message_id) 冲突时更新未 ack 的行、不动已 ack 的。
 * @property {(userId: string, messageIds: string[], deliveredAt: number) => Promise<number>} [markOutboxDelivered]
 *   （可选；单用户/D1）把发出去的段标 delivered_at。
 * @property {(userId: string, sinceId: number, limit: number) => Promise<Array<Object>>} [listUnackedOutbox]
 *   （可选；单用户/D1）未 ack 的行，id 升序游标翻页（GET /outbox）。
 * @property {(userId: string, messageIds: string[], ackedAt: number) => Promise<number>} [ackOutboxMessages]
 *   （可选；单用户/D1）客户端确认收到（POST /outbox/ack，幂等）。
 * @property {(opts: { ackedBeforeMs?: number, allBeforeMs?: number }) => Promise<number>} [cleanupOutbox]
 *   （可选；单用户/D1）outbox 例行清理（runScheduledTick 每跳顺手调）。
 *
 *   outbox 五个方法要么都实现、要么都不实现：缺写入侧的（append / mark），
 *   发送链路静默跳过落行；缺读取侧的（list / ack），`GET /outbox` 与
 *   `POST /outbox/ack` 返回 501。内置只有 D1 实现（与 client_state 同待遇）。
 */

export {};
