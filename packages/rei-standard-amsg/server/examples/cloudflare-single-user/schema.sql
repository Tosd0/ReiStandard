-- 单用户 amsg-server 的 D1 建表脚本。
-- 用法：wrangler d1 execute amsg --file schema.sql
-- 也可以部署后 POST /init-tenant 让服务端自动建（幂等）。

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
);

CREATE INDEX IF NOT EXISTS idx_pending_tasks_optimized
  ON scheduled_messages (status, next_send_at, id, retry_count)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_cleanup_completed
  ON scheduled_messages (status, updated_at)
  WHERE status IN ('sent', 'failed');
CREATE INDEX IF NOT EXISTS idx_failed_retry
  ON scheduled_messages (status, retry_count, next_send_at)
  WHERE status = 'failed' AND retry_count < 3;
CREATE INDEX IF NOT EXISTS idx_user_id
  ON scheduled_messages (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_uuid
  ON scheduled_messages (uuid)
  WHERE uuid IS NOT NULL;
