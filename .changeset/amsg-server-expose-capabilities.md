---
"@rei-standard/amsg-server": minor
---

错误响应带上真实原因；表结构自查与补齐；单任务入口露到 `/cloudflare` 与 Worker 上

**500 说得出哪儿坏了。** `fetch()` 兜底的 500 之前只有一句写死的「服务器内部错误」，真因（`D1_ERROR: no such table: message_outbox`、存储层写超时……）只进 `console.error`——调用方要拿到它，只能全局劫持 `console.error` 去偷听库的日志。现在 `error.cause` 随响应一起回：`{ stage, name, message, code? }`，`stage` 区分是构建配置时炸的（`config`，少 binding / 环境变量丢了）还是路由与处理器抛的（`request`）。`message` 过脱敏（遮掉长得像凭据的串、截断到 500 字符），只带错误类型和消息文本。`error.code` / `error.message` 两个老字段一个没动。

cron 那条路上没有调用方能读到响应，另开两个出口：worker 工厂新增第二个参数 `{ onError }`，fetch 与 cron 任何一段出错都调一次（`{ stage, error, cause, path }`，best-effort）；它放在 `buildConfig` 外面，所以 `buildConfig` 自己抛错时照样调得到。`scheduled()` 现在也有返回值：`{ ok: true, summary }` 或 `{ ok: false, cause }`（Cloudflare 不看它，是给自己包一层的宿主和测试用的）。

**表结构自查。** 建表是 `CREATE TABLE IF NOT EXISTS`，升级后老部署的表不会自己跟上，然后 cron 每分钟挂在缺的那一列上、任务一条都不发，而前端界面一切正常。新增 `getSchemaVersion(db)`（只读，回 `{ current, required, ok, missing }`，`missing` 逐条点名缺的表 / 列 / 关键索引）与 `ensureSchema(db)`（不够用就跑一次 `initSchema()` 补齐，回 `{ …, migrated, schema }`）。「需要什么」从建表语句里解析，不另抄一份会漂的清单。单用户 Worker 上有走 `env` 的同名方法。什么时候调、缺了怎么提示用户由宿主决定——库不会在每次请求里偷偷迁移，`POST /init-tenant` 的行为也一点没变。适配器接口新增可选 `describeSchema()`（活库现有的表 / 列 / 索引），内置只有 D1 实现，别的适配器调这两个函数会抛错而不是假装正常。

**单任务入口。** `runTask` 之前只在包根导出，`/cloudflare` 子路径引不到，宿主想让刚落库的任务立刻跑起来只能触发一次全量扫描（那样多个执行者会扫同一批任务，只能退回单实例串行）。现在 `/cloudflare` 也导出 `runTask(ctx, uuid)`，单用户 Worker 上还多一个 `worker.runTask(uuid, env)`（从 `env` 拿库和配置，与 cron 共用同一份 tick ctx）。不跑的情形分开回报：`not_found` / `already_settled`（带 `status`）/ `not_due`（带 `nextSendAt`）/ `retry_pending`（带 `retryAfter`）/ `not_configured`（VAPID 没配齐，只有 Worker 那个方法有）。适配器接口新增可选 `getTaskStatusByUuidOnly(uuid)` 支撑 `already_settled`（D1 / pg / neon 都已实现），不实现的自定义适配器把它并进 `not_found`。

新导出：包根与 `/cloudflare` 都有 `getSchemaVersion` / `ensureSchema` / `SCHEMA_VERSION` / `summarizeErrorCause`；`/cloudflare` 补上 `runTask` / `NonRetryableError` / `isNonRetryableError`。特性位：`error-cause`、`schema-self-check`、`worker-run-task`。
