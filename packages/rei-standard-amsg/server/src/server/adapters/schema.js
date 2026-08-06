/**
 * Shared SQL schema constants
 *
 * 定时触发用的三列各管一件事，别把它们混着读（见 lib/run-tick.js）：
 *   - `lease_until`：**这条正在跑**。某个 tick 占位时写「归我管到什么时候」，
 *     投递收尾时放掉。捞取待发任务时跳过租约未到期的行。
 *   - `retry_after`：**这条没在跑，等着重试**。投递失败的退避时刻，到点之前
 *     捞不到这行。跟租约分开写，是因为「正在跑」会挡住同分组的其他任务，而
 *     一条正在等重试的任务其实闲着，不该连累别人。
 *   - `serialize_group`：这条属于哪个串行分组（`runScheduledTick` 的
 *     `serializeBy` 算出来的，占位时一起写）。同一分组同时只放行一条。存的是
 *     派生值而不是宿主给的原始 key —— 原始 key 往往是角色 id 之类的宿主数据，
 *     任务内容都是密文落库的，这一列不该成为它的明文出口。
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
    retry_after TIMESTAMP WITH TIME ZONE,
    serialize_group VARCHAR(64),
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
  },
  {
    name: 'add_retry_after',
    sql: 'ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS retry_after TIMESTAMP WITH TIME ZONE',
    description: 'Retry backoff, held apart from the claim lease (2.6.0)'
  },
  {
    name: 'add_serialize_group',
    sql: 'ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS serialize_group VARCHAR(64)',
    description: 'Serialization group for runScheduledTick serializeBy (2.6.0)'
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
  },
  {
    name: 'idx_serialize_group_lease',
    sql: `CREATE INDEX IF NOT EXISTS idx_serialize_group_lease
          ON scheduled_messages (serialize_group, lease_until)
          WHERE serialize_group IS NOT NULL AND status = 'pending'`,
    description: 'Serialization group busy-check index (claimTask)'
  }
];

// push_subscriptions: 一个用户一份 Web Push 订阅，任务行不再各自携带。
// 用户清站点数据 / 重装 PWA / 推送服务轮换 endpoint 之后，客户端覆盖这一行
// 就够了，不用把每条任务翻出来逐行刷（角色自排的任务客户端根本不知道存在，
// 逐行刷本来也刷不到它）。`subscription` 是 encryptForStorage 密文，
// `updated_at` 是 epoch 毫秒（BIGINT，与 SQLite 侧同口径）。
export const PUSH_SUBSCRIPTION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    user_id VARCHAR(255) PRIMARY KEY,
    subscription TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  )
`;

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
// 列名不分方言：pg / neon / D1 三个适配器 import 的都是这一份，加列只改这里。
export const UPDATABLE_COLUMNS = new Set([
  'user_id', 'uuid', 'encrypted_payload', 'message_type',
  'next_send_at', 'lease_until', 'retry_after', 'serialize_group',
  'status', 'retry_count', 'created_at', 'updated_at'
]);
