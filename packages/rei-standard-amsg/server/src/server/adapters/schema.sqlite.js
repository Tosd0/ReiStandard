/**
 * SQLite (Cloudflare D1) dialect schema for scheduled_messages.
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
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

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
  }
];
