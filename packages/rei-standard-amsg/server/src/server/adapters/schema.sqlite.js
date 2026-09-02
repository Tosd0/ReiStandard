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

// client_state 的索引。条目形状与 SQLITE_INDEXES 相同，initSchema 一起建。
//
// 这几张表上的例行清理是 cron 每分钟跑一遍的：一条语句走不了索引就是每分钟
// 全表扫一次，扫过的行全算进 D1 的 rows read，表稍微涨一点免费额度就见底。
// 所以每一条按时间戳删行的语句都得有自己的索引，缺了只是慢（critical: false），
// 但慢到把额度扫穿之后整个 worker 都不响应。
export const CLIENT_STATE_INDEXES = [
  {
    name: 'idx_client_state_cleanup',
    // 服务 cleanupClientState 的
    //   DELETE FROM client_state WHERE namespace = ? AND updated_at < ?
    // 主键 (user_id, namespace, key) 最左列是 user_id，按 namespace 起头的条件
    // 吃不到它。
    sql: `CREATE INDEX IF NOT EXISTS idx_client_state_cleanup
          ON client_state (namespace, updated_at)`,
    description: 'TTL cleanup index (cleanupClientState by namespace + updated_at)',
    critical: false
  }
];

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

// llm_credentials: LLM API 凭据（apiUrl / apiKey / primaryModel）的用户级存放
// 处，任务行不再各自冻结一份、改带 credRefs 引用（payload 里的
// `credRefs: { <purpose>: <cred_id> }`），到点解析时按 cred_id 现读这里。
// 换 Key 覆盖对应行就够了，不用把每条任务翻出来逐行刷（角色自排的任务客户端
// 根本不知道存在，逐行刷本来也刷不到它——与 push_subscriptions 同一个动机）。
// `cred_id` 是客户端起名的不透明字符串（约定形如 `char:<id>/<purpose>`、
// `global/<purpose>`，服务端不解释）；`encrypted_value` 是 encryptForStorage
// 密文（与任务 payload 同一把 per-user key）；时间戳是 ISO8601 UTC TEXT。
export const LLM_CREDENTIALS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS llm_credentials (
    user_id TEXT NOT NULL,
    cred_id TEXT NOT NULL,
    encrypted_value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, cred_id)
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

// message_outbox 的索引。表上自带的只有主键 id 和 UNIQUE (user_id, message_id)，
// 按时间戳 / 按任务删行的语句都得另配索引，理由见 CLIENT_STATE_INDEXES 头上那段。
export const MESSAGE_OUTBOX_INDEXES = [
  {
    name: 'idx_outbox_unacked',
    // 服务 listUnackedOutbox 的
    //   SELECT … WHERE user_id = ? AND acked_at IS NULL AND id > ? ORDER BY id
    sql: `CREATE INDEX IF NOT EXISTS idx_outbox_unacked
          ON message_outbox (user_id, id)
          WHERE acked_at IS NULL`,
    description: 'Unacked outbox paging index (GET /outbox)',
    critical: false
  },
  {
    name: 'idx_outbox_created',
    // 服务 cleanupOutbox 的
    //   DELETE FROM message_outbox WHERE created_at < ?
    sql: `CREATE INDEX IF NOT EXISTS idx_outbox_created
          ON message_outbox (created_at)`,
    description: 'Outbox retention cleanup index (cleanupOutbox by created_at)',
    critical: false
  },
  {
    name: 'idx_outbox_acked',
    // 服务 cleanupOutbox 的
    //   DELETE FROM message_outbox WHERE acked_at IS NOT NULL AND acked_at < ?
    // 部分索引只收已 ack 的行：未 ack 的那部分本来就不是这条语句的目标，
    // idx_outbox_unacked 的 WHERE 条件与它正好互补。
    sql: `CREATE INDEX IF NOT EXISTS idx_outbox_acked
          ON message_outbox (acked_at)
          WHERE acked_at IS NOT NULL`,
    description: 'Acked outbox cleanup index (cleanupOutbox by acked_at)',
    critical: false
  },
  {
    name: 'idx_outbox_task_undelivered',
    // 服务 discardUndeliveredOutboxForTask 的
    //   DELETE FROM message_outbox
    //   WHERE user_id = ? AND task_uuid = ? AND delivered_at IS NULL AND acked_at IS NULL
    // 没有它这条只能靶着 user_id 走 (user_id, message_id) 或 idx_outbox_unacked，
    // 单用户部署下 user_id 对每一行都成立，等于把整个未 ack 积压扫一遍。
    sql: `CREATE INDEX IF NOT EXISTS idx_outbox_task_undelivered
          ON message_outbox (user_id, task_uuid)
          WHERE delivered_at IS NULL AND acked_at IS NULL`,
    description: 'Undelivered-by-task discard index (cancel / supersede)',
    critical: false
  }
];

/** 三张表的索引合在一起，initSchema 按这份顺序逐条建。 */
export const SQLITE_ALL_INDEXES = [
  ...SQLITE_INDEXES,
  ...CLIENT_STATE_INDEXES,
  ...MESSAGE_OUTBOX_INDEXES
];

// ── schema 自查用的「这一版需要什么」 ─────────────────────────────────────
//
// 建表语句是 CREATE TABLE IF NOT EXISTS，已经存在的表不会被改动，所以升级后
// 老部署的表可能缺列。lib/schema-version.js 拿下面这份清单和活库里实际有的表
// 列对照，回答「够不够用」。
//
// 清单不手抄，直接从上面那几段 DDL 里解析出来：手抄一份就会漏——加了列忘了同
// 步，自查照样报「一切正常」，而 cron 每分钟静默挂在那条缺的列上。

/** CREATE TABLE 语句里的表名。 */
function parseTableName(sql) {
  const match = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql);
  return match ? match[1] : '';
}

/**
 * CREATE TABLE 语句里的列名。按括号深度切顶层逗号（CHECK (... IN ('a', 'b'))
 * 里的逗号不算），再把 PRIMARY KEY (…) / UNIQUE (…) 这类表级约束行滤掉。
 */
function parseColumnNames(sql) {
  const body = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  const TABLE_CONSTRAINTS = new Set(['primary', 'unique', 'foreign', 'check', 'constraint']);
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(/\s+/)[0])
    .filter((name) => !TABLE_CONSTRAINTS.has(name.toLowerCase()));
}

function describeTable(sql) {
  return [parseTableName(sql), parseColumnNames(sql)];
}

/**
 * 这一版代码跑起来需要的表 / 列 / 索引。
 *
 * 索引只列 critical 的那几个（uidx_uuid 之类）：其余索引缺了只是慢，缺了它则
 * 是正确性问题。
 *
 * @type {{ tables: Record<string, string[]>, indexes: string[] }}
 */
export const SQLITE_REQUIRED_SCHEMA = Object.freeze({
  tables: Object.freeze(Object.fromEntries([
    describeTable(SQLITE_TABLE_SQL),
    describeTable(CLIENT_STATE_TABLE_SQL),
    describeTable(PUSH_SUBSCRIPTION_TABLE_SQL),
    describeTable(LLM_CREDENTIALS_TABLE_SQL),
    describeTable(MESSAGE_OUTBOX_TABLE_SQL)
  ])),
  indexes: Object.freeze(SQLITE_ALL_INDEXES.filter((index) => index.critical).map((index) => index.name))
});
