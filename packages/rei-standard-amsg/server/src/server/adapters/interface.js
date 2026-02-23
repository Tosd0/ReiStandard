/**
 * Database Adapter Interface
 * ReiStandard SDK v1.2.0
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
 *   Create the scheduled_messages/system_config tables and all indexes.
 * @property {() => Promise<string|null>} getMasterKey
 *   Read master key from system_config (key = 'master_key').
 * @property {(masterKey: string) => Promise<boolean>} setMasterKeyOnce
 *   Insert master key once. Returns false if already initialized.
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
 * @property {(userId: string, opts: {status?: string, limit?: number, offset?: number}) => Promise<{tasks: TaskRow[], total: number}>} listTasks
 *   List tasks for a user with optional filters and pagination.
 * @property {(days?: number) => Promise<number>} cleanupOldTasks
 *   Delete completed / failed tasks older than `days` (default 7).
 * @property {(uuid: string, userId: string) => Promise<string|null>} getTaskStatus
 *   Return the status string of a task (used to distinguish 404 from 409).
 */

export {};
