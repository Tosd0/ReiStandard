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
 * @property {(uuid: string, userId: string, encryptedPayload: string, extraFields?: Object) => Promise<TaskRow|null>} updateTaskByUuid
 *   Update a pending task's encrypted_payload (and optional index fields) by uuid + user_id.
 * @property {(taskId: number) => Promise<boolean>} deleteTaskById
 *   Delete a task by numeric id. Returns true if a row was affected.
 * @property {(uuid: string, userId: string) => Promise<boolean>} deleteTaskByUuid
 *   Delete a task by uuid + user_id. Returns true if a row was affected.
 * @property {(limit?: number) => Promise<TaskRow[]>} getPendingTasks
 *   Fetch pending tasks whose next_send_at <= NOW(), ordered ASC.
 * @property {(taskId: number, expectedNextSendAt: string|Date, leaseUntil: string|Date) => Promise<boolean>} [claimTask]
 *   领取一条到点的任务：只有当行仍是 pending 且 next_send_at 还等于
 *   `expectedNextSendAt`（读这行时拿到的值）时，才把 next_send_at 顶到
 *   `leaseUntil`，返回是否改到了行。cron 每分钟一跳而一次投递可能跑几分钟，
 *   runScheduledTick 靠它保证同一行同时只被一个 tick 跑。
 *   自定义适配器可以不实现（runScheduledTick 会退回不占位的老行为，代价是
 *   慢任务可能被下一跳重复触发）。
 * @property {(userId: string, opts: {status?: string, limit?: number, offset?: number}) => Promise<{tasks: TaskRow[], total: number}>} listTasks
 *   List tasks for a user with optional filters and pagination.
 * @property {(days?: number) => Promise<number>} cleanupOldTasks
 *   Delete completed / failed tasks older than `days` (default 7).
 * @property {(uuid: string, userId: string) => Promise<string|null>} getTaskStatus
 *   Return the status string of a task (used to distinguish 404 from 409).
 * @property {(userId: string, entries: Array<{namespace: string, key: string, value: string, updatedAt: number}>, cleanups?: Array<{namespace: string, keyPrefix: string, updatedAt: number}>) => Promise<{upserted: number, skipped: number, outcomes?: boolean[]}>} [upsertClientState]
 *   (optional; single-user/D1 only) Batch upsert of client state, last-write-wins on updatedAt.
 *   `cleanups` 先于 upsert 在同一事务里按 key 前缀删旧切片行（分块存储清理，见 lib/state-chunks.js；
 *   自定义 adapter 可忽略，只损失存储卫生不影响正确性）；`outcomes` 逐条报告 entries[i] 是否真的
 *   写入（缺席时 handler 按物理行计数兜底）。
 * @property {(userId: string, namespace: string) => Promise<Array<{namespace: string, key: string, value: string, updated_at: number}>>} [getClientState]
 *   (optional; single-user/D1 only) All entries of one namespace; values still encrypted.
 * @property {(userId: string) => Promise<number>} [clearClientState]
 *   (optional; single-user/D1 only) Delete every entry of this user; returns rows deleted.
 */

export {};
