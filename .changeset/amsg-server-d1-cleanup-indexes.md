---
"@rei-standard/amsg-server": patch
---

`client_state` 与 `message_outbox` 的例行清理走索引，不再每分钟全表扫描

cron 每跳都会顺手跑几条清理：`client_state` 按命名空间过期删行（`clientStateTtl`）、`message_outbox` 删已 ack 的旧行和超过保留期的行；取消 / 顶替任务时还会按 `task_uuid` 撤掉没投递出去的行。这几条 DELETE 用的列上原来没有索引，每跳都是整表扫一遍，扫过的行全算进 D1 的 rows read——两张表合计一千多行就能把免费额度（每天 500 万行）用完，之后整个 worker 报 `exceeded D1's free tier daily row read limit`。

`initSchema()` 现在多建四个索引，全部 `CREATE INDEX IF NOT EXISTS`：

| 索引 | 服务的语句 |
|---|---|
| `idx_client_state_cleanup` `(namespace, updated_at)` | `cleanupClientState` 按命名空间 + 时间戳删 |
| `idx_outbox_created` `(created_at)` | `cleanupOutbox` 按保留期删 |
| `idx_outbox_acked` `(acked_at) WHERE acked_at IS NOT NULL` | `cleanupOutbox` 删已 ack 的旧行 |
| `idx_outbox_task_undelivered` `(user_id, task_uuid) WHERE delivered_at IS NULL AND acked_at IS NULL` | 取消 / 顶替任务时按 `task_uuid` 撤未投递行 |

已有部署重跑一次 `initSchema()`（`POST /init-tenant`，或 `ensureSchema()`）就补上了；这几个索引都不是 critical，`getSchemaVersion()` 不会因为缺它们把老库判成不够用。`examples/cloudflare-single-user/schema.sql` 同步加了这四条。
