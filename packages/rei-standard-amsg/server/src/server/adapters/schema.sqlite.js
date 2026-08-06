/**
 * SQLite (Cloudflare D1) dialect schema for scheduled_messages.
 *
 * 定时触发用的 `lease_until` / `retry_after` / `serialize_group` 三列分别是什么
 * 意思，写在 Postgres 那份 schema 的文件头（adapters/schema.js）。
 *
 * Differences from the Postgres schema (adapters/schema.js):
 *   - id: INTEGER PRIMARY KEY AUTOINCREMENT (vs SERIAL)
 *   - timestamps stored as TEXT ISO8601 UTC (vs TIMESTAMP WITH TIME ZONE)
 *   - no NOW()/DEFAULT; the adapter always writes timestamps explicitly
 *   - retry_count is NOT NULL here (Postgres omits NOT NULL); every write path
 *     sets it explicitly, so the tighter constraint just documents that intent
 * Partial indexes and CHECK constraints are native to SQLite, so they carry over.
 * Index entries mirror the Postgres INDEXES shape ({ name, sql, description,
 * critical }) so both adapters' initSchema() return the same index metadata.
 */

export const SQLITE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    uuid TEXT,
    encrypted_payload TEXT NOT NULL,
    message_type TEXT NOT NULL CHECK (message_type IN ('fixed', 'prompted', 'auto', 'instant')),
    next_send_at TEXT NOT NULL,
    lease_until TEXT,
    retry_after TEXT,
    serialize_group TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

/**
 * 建表语句用的是 CREATE TABLE IF NOT EXISTS，已经存在的表不会被改动，所以
 * 后加的列要单独补。initSchema 每次都会跑一遍，列已经在了就跳过。
 */
export const SQLITE_MIGRATIONS = [
  {
    name: 'add_lease_until',
    sql: 'ALTER TABLE scheduled_messages ADD COLUMN lease_until TEXT',
    description: 'Task claim lease (2.6.0)'
  },
  {
    name: 'add_retry_after',
    sql: 'ALTER TABLE scheduled_messages ADD COLUMN retry_after TEXT',
    description: 'Retry backoff, held apart from the claim lease (2.6.0)'
  },
  {
    name: 'add_serialize_group',
    sql: 'ALTER TABLE scheduled_messages ADD COLUMN serialize_group TEXT',
    description: 'Serialization group for runScheduledTick serializeBy (2.6.0)'
  },
  {
    name: 'add_last_error',
    // 上一次投递失败的脱敏摘要（JSON：{ at, occurrence, reason }）。payload 里
    // 的 lastError 是密文里的完整记录，这一列是它的明文出口——payload 本身
    // 解密失败时也写得进去，GET /message 对已失败的行也读得出来。
    sql: 'ALTER TABLE scheduled_messages ADD COLUMN last_error TEXT',
    description: 'Sanitized last delivery-failure summary (2.6.0)'
  }
];

export const SQLITE_INDEXES = [
  {
    name: 'idx_pending_tasks_optimized',
    sql: `CREATE INDEX IF NOT EXISTS idx_pending_tasks_optimized
          ON scheduled_messages (status, next_send_at, id, retry_count)
          WHERE status = 'pending'`,
    description: 'Main query index (Cron Job finds pending tasks)',
    critical: false
  },
  {
    name: 'idx_cleanup_completed',
    sql: `CREATE INDEX IF NOT EXISTS idx_cleanup_completed
          ON scheduled_messages (status, updated_at)
          WHERE status IN ('sent', 'failed')`,
    description: 'Cleanup query index',
    critical: false
  },
  {
    name: 'idx_failed_retry',
    sql: `CREATE INDEX IF NOT EXISTS idx_failed_retry
          ON scheduled_messages (status, retry_count, next_send_at)
          WHERE status = 'failed' AND retry_count < 3`,
    description: 'Failed retry index',
    critical: false
  },
  {
    name: 'idx_user_id',
    sql: `CREATE INDEX IF NOT EXISTS idx_user_id
          ON scheduled_messages (user_id)`,
    description: 'User task query index',
    critical: false
  },
  {
    name: 'uidx_uuid',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uidx_uuid
          ON scheduled_messages (uuid)
          WHERE uuid IS NOT NULL`,
    description: 'UUID uniqueness guard',
    critical: true
  },
  {
    name: 'idx_serialize_group_lease',
    sql: `CREATE INDEX IF NOT EXISTS idx_serialize_group_lease
          ON scheduled_messages (serialize_group, lease_until)
          WHERE serialize_group IS NOT NULL AND status = 'pending'`,
    description: 'Serialization group busy-check index (claimTask)',
    critical: false
  }
];

// client_state: cloud mirror of client-side state for the single-user
// deployment. One live copy per (user, namespace, key) — not per-task
// snapshots. The client is the only writer (batch upsert, last-write-wins
// on updated_at); fire-time hooks are the reader. `value` holds
// encryptForStorage ciphertext. `updated_at` is a caller-supplied epoch-ms
// INTEGER (unlike scheduled_messages' ISO TEXT) so conflict resolution
// compares without parsing. Single-user/SQLite only — no Postgres mirror.
export const CLIENT_STATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS client_state (
    user_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, namespace, key)
  )
`;

// push_subscriptions: 一个用户一份 Web Push 订阅，任务行不再各自携带。
// 用户清站点数据 / 重装 PWA / 推送服务轮换 endpoint 之后，客户端覆盖这一行
// 就够了，不用把每条任务翻出来逐行刷（角色自排的任务客户端根本不知道存在，
// 逐行刷本来也刷不到它）。`subscription` 是 encryptForStorage 密文，
// `updated_at` 是 epoch 毫秒 INTEGER。
export const PUSH_SUBSCRIPTION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    user_id TEXT PRIMARY KEY,
    subscription TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

// message_outbox: 服务端发出的每条 push 在发送前先落一行，客户端上线后
// `GET /outbox?since=` 拉未 ack 的、收到（或删除/重 roll）后 `POST
// /outbox/ack` 确认。有了 ack 语义，「哪些消息没送到」是查出来的事实，
// 而不是「messageId 在不在本地近 N 条里」那种猜——补收误判的整族问题
// （删掉的复活、多段丢失、竞态重复上屏）从根上不存在。
//   - `payload` 是整条 push JSON 的 encryptForStorage 密文（与任务 payload
//     同一把 per-user key）；
//   - `delivered_at` 记 Web Push 是否发送成功（null = 发送失败/中断——正是
//     客户端最需要拉的那部分）；
//   - `acked_at` 由客户端 ack 写入；游标是自增 id；
//   - 重试同一 occurrence 会带着同一批 messageId 再来，(user_id, message_id)
//     唯一约束让重试不产生第二行。
// 单用户/SQLite 专属，与 client_state 同待遇——no Postgres mirror。
export const MESSAGE_OUTBOX_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS message_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    task_uuid TEXT,
    session_id TEXT,
    message_index INTEGER,
    total_messages INTEGER,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    acked_at INTEGER,
    UNIQUE (user_id, message_id)
  )
`;

export const MESSAGE_OUTBOX_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_outbox_unacked
    ON message_outbox (user_id, id)
    WHERE acked_at IS NULL
`;
