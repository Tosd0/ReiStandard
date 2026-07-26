/**
 * Database Adapter Interface
 * ReiStandard SDK v2.0.1
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
 *   实现了 `claimTask` 的适配器还要认 `lease_until`（含写 null）：投递收尾
 *   时 runScheduledTick 用它把租约放掉。
 * @property {(uuid: string, userId: string, encryptedPayload: string, extraFields?: Object) => Promise<TaskRow|null>} updateTaskByUuid
 *   Update a pending task's encrypted_payload (and optional index fields) by uuid + user_id.
 * @property {(taskId: number) => Promise<boolean>} deleteTaskById
 *   Delete a task by numeric id. Returns true if a row was affected.
 * @property {(uuid: string, userId: string) => Promise<boolean>} deleteTaskByUuid
 *   Delete a task by uuid + user_id. Returns true if a row was affected.
 * @property {(limit?: number) => Promise<TaskRow[]>} getPendingTasks
 *   Fetch pending tasks whose next_send_at <= NOW(), ordered ASC.
 *   跳过租约还没到期的行（`lease_until` 为空或已过期才算待发）。
 * @property {(taskId: number, expectedNextSendAt: string|Date, leaseUntil: string|Date) => Promise<boolean>} [claimTask]
 *   领取一条到点的任务，返回是否领到。cron 每分钟一跳而一次投递可能跑几分
 *   钟，runScheduledTick 靠它保证同一行同时只被一个 tick 跑。
 *   三个条件同时成立才领得走：行仍是 pending；`lease_until` 为空或已过期
 *   （没别人正在跑）；`next_send_at` 还等于 `expectedNextSendAt`（读这行时
 *   拿到的值，用户中途改了排期就不发了）。领到就把 `lease_until` 写成
 *   `leaseUntil`，`next_send_at` 不动。
 *   自定义适配器可以不实现（runScheduledTick 会退回不占位的行为，代价是慢
 *   任务可能被下一跳重复触发）。
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
 */

export {};
