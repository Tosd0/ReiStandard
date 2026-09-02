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
  -- lease_until：这条正在跑（某个 tick 占位时写，投递收尾放掉）
  -- retry_after：这条没在跑，上次没发成，在等重试
  -- serialize_group：这条属于哪个串行分组（serializeBy 算出来的派生值）
  lease_until TEXT,
  retry_after TEXT,
  serialize_group TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  -- last_error：上一次投递失败的脱敏摘要（JSON），payload 里那份的明文出口
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 老库缺哪列就补哪列（新库会报「列已存在」，忽略即可）。走
-- POST /init-tenant 的话服务端会自动处理，这几句只给手工维护表结构的人用。
-- ALTER TABLE scheduled_messages ADD COLUMN lease_until TEXT;
-- ALTER TABLE scheduled_messages ADD COLUMN retry_after TEXT;
-- ALTER TABLE scheduled_messages ADD COLUMN serialize_group TEXT;
-- ALTER TABLE scheduled_messages ADD COLUMN last_error TEXT;

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
-- 分组串行的判定索引（占位时查「这一组有没有任务正拿着租约」）。
CREATE INDEX IF NOT EXISTS idx_serialize_group_lease
  ON scheduled_messages (serialize_group, lease_until)
  WHERE serialize_group IS NOT NULL AND status = 'pending';

-- 客户端状态的云端镜像（/client-state 端点用）。
-- value 是密文；updated_at 是客户端给的 epoch 毫秒整数，用于 last-write-wins。
CREATE TABLE IF NOT EXISTS client_state (
  user_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, namespace, key)
);
-- 按命名空间过期清理（clientStateTtl）用：cron 每分钟按 namespace + updated_at
-- 删行，主键最左列是 user_id 帮不上它，没有这个索引就是每分钟全表扫一次。
CREATE INDEX IF NOT EXISTS idx_client_state_cleanup
  ON client_state (namespace, updated_at);

-- Web Push 订阅（/push-subscription 端点用）。一个用户一份，任务行不携带
-- 订阅，到点投递时读这里。subscription 是密文；updated_at 是 epoch 毫秒。
CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- LLM API 凭据（/llm-credentials 端点用）。任务 payload 里的 credRefs 按
-- cred_id 引用这里的行，到点解析时现读——换 Key 覆盖对应行就够，不用逐任务
-- 刷。encrypted_value 是密文；时间戳是 ISO8601 UTC 文本。
CREATE TABLE IF NOT EXISTS llm_credentials (
  user_id TEXT NOT NULL,
  cred_id TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, cred_id)
);

-- 服务端消息收件箱（/outbox 与 /outbox/ack 用）。每条 push 发送前先落一行，
-- 客户端上线后拉未 ack 的补收。payload 是整条 push JSON 的密文；delivered_at
-- 记 Web Push 有没有发出去；acked_at 由客户端确认时写。
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
);
CREATE INDEX IF NOT EXISTS idx_outbox_unacked
  ON message_outbox (user_id, id)
  WHERE acked_at IS NULL;
-- 下面三个给 cron 每分钟跑的清理和取消任务时的撤回用。这几条 DELETE 按时间戳
-- / 按 task_uuid 选行，表上自带的索引一个都用不上，缺了就是每分钟全表扫描，
-- 扫过的行全算进 D1 的 rows read 额度。
CREATE INDEX IF NOT EXISTS idx_outbox_created
  ON message_outbox (created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_acked
  ON message_outbox (acked_at)
  WHERE acked_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_task_undelivered
  ON message_outbox (user_id, task_uuid)
  WHERE delivered_at IS NULL AND acked_at IS NULL;

-- 手工建完想确认够不够用：worker.getSchemaVersion(env) 会逐条点名缺的表 / 列 /
-- 关键索引，worker.ensureSchema(env) 直接补齐。
