/**
 * Shared SQL schema constants
 */

export const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    uuid VARCHAR(36),
    encrypted_payload TEXT NOT NULL,
    message_type VARCHAR(50) NOT NULL CHECK (message_type IN ('fixed', 'prompted', 'auto', 'instant')),
    next_send_at TIMESTAMP WITH TIME ZONE NOT NULL,
    lease_until TIMESTAMP WITH TIME ZONE,
    status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
  )
`;

/**
 * 建表语句用的是 CREATE TABLE IF NOT EXISTS，已经存在的表不会被改动，所以
 * 后加的列要单独补。initSchema 每次都会跑一遍，Postgres 的 IF NOT EXISTS
 * 让重复执行也没事。
 */
export const MIGRATIONS = [
  {
    name: 'add_lease_until',
    sql: 'ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS lease_until TIMESTAMP WITH TIME ZONE',
    description: 'Task claim lease (2.6.0)'
  }
];

export const INDEXES = [
  {
    name: 'idx_pending_tasks_optimized',
    sql: `CREATE INDEX IF NOT EXISTS idx_pending_tasks_optimized
          ON scheduled_messages (status, next_send_at, id, retry_count)
          WHERE status = 'pending'`,
    description: 'Main query index (Cron Job finds pending tasks)'
  },
  {
    name: 'idx_cleanup_completed',
    sql: `CREATE INDEX IF NOT EXISTS idx_cleanup_completed
          ON scheduled_messages (status, updated_at)
          WHERE status IN ('sent', 'failed')`,
    description: 'Cleanup query index'
  },
  {
    name: 'idx_failed_retry',
    sql: `CREATE INDEX IF NOT EXISTS idx_failed_retry
          ON scheduled_messages (status, retry_count, next_send_at)
          WHERE status = 'failed' AND retry_count < 3`,
    description: 'Failed retry index'
  },
  {
    name: 'idx_user_id',
    sql: `CREATE INDEX IF NOT EXISTS idx_user_id
          ON scheduled_messages (user_id)`,
    description: 'User task query index'
  },
  {
    name: 'uidx_uuid',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uidx_uuid
          ON scheduled_messages (uuid)
          WHERE uuid IS NOT NULL`,
    description: 'UUID uniqueness guard',
    critical: true
  }
];

export const VERIFY_TABLE_SQL = `
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name = 'scheduled_messages'
`;

export const COLUMNS_SQL = `
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'scheduled_messages'
  ORDER BY ordinal_position
`;

// Update methods build a dynamic SET clause from object keys. Callers pass only
// hardcoded column names today, but enforcing a whitelist keeps a future caller
// from ever turning a caller-supplied key into interpolated SQL.
// (The D1 adapter enforces the same list with its own in-file copy.)
export const UPDATABLE_COLUMNS = new Set([
  'user_id', 'uuid', 'encrypted_payload', 'message_type',
  'next_send_at', 'lease_until', 'status', 'retry_count', 'created_at', 'updated_at'
]);
