---
"@rei-standard/amsg-server": minor
---

任务占位带 `lease_token`（需要补列）；推送订阅、时间戳、`metadata` 等入参校验收紧；租户 token 默认不过期

**1. `scheduled_messages` 多一列 `lease_token`，升级先补列**

占位时往这列写一个随机 token，续租和收尾写库（改排期、删行、写失败）都带着它比对，租约过期后被别的 tick 接手的任务，原来那一跳的收尾不会盖掉接手者的进度。老库没这列的话每条到期任务都占位失败、一条不发（tick 汇总里每条进 `details.failedTasks`、`status: 'claim_failed'`）：

- 多租户（`createReiServer`）：进程首次拿到租户适配器时自动跑 `initSchema`，不用动手。
- 单用户 D1：升级后重跑一次 `POST /init-tenant`，或宿主调 `ensureSchema`。`getSchemaVersion` 缺列时回 `ok: false`。
- 手工维护表结构：照 `examples/cloudflare-single-user/schema.sql` 加列。

自定义适配器契约（以 `adapters/interface.js` 为准，全部可选、向后兼容）：`claimTask` 的 `options.leaseToken` / `options.userId`；`renewTaskLease` 的 `options.leaseToken`，返回 `false` 表示行没了或租约已归别人；`updateTaskById` / `deleteTaskById` 的 `options.leaseToken`，只改 / 删 token 仍匹配的行。`listTasks` 排序带 `, id ASC`；`cleanupOldTasks` 一跳最多删 `CLEANUP_BATCH_LIMIT`（100）条。

**2. tick 汇总与收尾**

- `details` 新增 `leaseLostTasks`（`[{ taskId, status }]`）：租约过期后被别的 tick 接手、这一跳不再写的任务。`cancelledTasks` 的 `status` 多一个 `cancelled_before_delivery`（过期收场写库时发现行已不在）。
- 心跳租约每次续到「现在 + max(90 秒, 3 × `leaseHeartbeatMs`)」。
- 过期收场（`expired` / `fast_forwarded`）的任务撤掉名下所有未投递、未 ack 的收件箱行，包括之前几次 occurrence 留下的。
- 投递中途租约丢失时，由 `runScheduledTick` 收尾：确认任务行已删除才撤未投递的行，行还在就归接手者管。直接调 `processSingleMessage`、不经 `runScheduledTick` 的宿主要自己做这一步。

**3. 入参校验**

- `PUT /push-subscription`：`endpoint` 必须是不带用户名密码的 `https` URL，`http`、`localhost` / `*.localhost`、IP 字面量回 `400 INVALID_PUSH_SUBSCRIPTION`。已登记的订阅不重新校验；升级前任务 payload 里冻结的老订阅走兜底读取时按同一规则判，不合格视为没有。
- `firstSendTime` / `nextSendAt` 只收 ISO 8601 字符串（`YYYY-MM-DD[THH:mm[:ss[.fff]][Z|±hh:mm]]`），否则 `INVALID_TIMESTAMP` / `INVALID_UPDATE_DATA`；`PUT /update-message` 的 `nextSendAt` 必须在未来，改了之后 payload 的 `firstSendTime` 跟着改。
- `metadata` 必须是普通对象，数组、字符串等回 `400 INVALID_PARAMETERS`（schedule）/ `INVALID_UPDATE_DATA`（update）；`null` 按没传。
- `GET /messages` 的 `status` 只认 `all / pending / sent / failed`，否则 `400 INVALID_PARAMETERS`。
- `owner.type` / `owner.id` 空白拒绝，`owner.label` 可省、是 ≤ 300 字符的字符串；cleanup plan 与 client-state / task 的显式 owner 同一套规则。

**4. 云端数据**

- `PUT /client-state`：单条 `owner` / `ownerGeneration` 形状不对只进 `data.rejected`（`INVALID_CLOUD_OWNER` / `INVALID_CLOUD_OWNER_GENERATION`），其余照常写；归属停用等守卫错误整批 409。单用户 Worker 对带 4xx `status` 和 `code` 的异常按其状态码回。
- 同一 key 的并发写入后写赢、已有归属保留；连续三次撞车才 `409 CLOUD_RESOURCE_CHANGED`。
- `/cloud-data/*` 的兜底错误顶层 `code` 固定 `CLOUD_DATA_FAILED`。
- cron 的云端清理排在消息投递之后，每跳大约 20 秒预算，一跳内尽量把到期操作跑完；HTTP 发起的那次仍只处理 25 条。

**5. 多租户 token**

`createTenantToken` 不传 `expiresInSeconds` 签出的 token 不过期，`/init-tenant` 返回的 token 长期有效，吊销靠删租户配置；`verifyTenantToken` 接受无 `exp` 的 token。升级前签发的、带过期时间的 token 到期照样失效，要重签。并发同 `tenantId` 的 `/init-tenant` 后到的回 `409 TENANT_ALREADY_INITIALIZED`（依赖 `@netlify/blobs` ^10.7.13 的条件写）。

**6. agentic fire 与推送**

- `onBeforeFire` / `onLLMOutput` / `executeToolCalls` 都受 `totalTimeoutMs` 约束，超时时宿主拿到的 `signal` 中止、任务按可重试失败收场，`last_error.errorCode` 为 `AGENTIC_TOTAL_TIMEOUT`。工具内部的 `fetch` 要带上 `ctx.signal`。
- `createWebCryptoWebPush().sendNotification(subscription, payload, { signal, timeoutMs })` 第三参可选，返回对象带 `acceptsSendOptions: true`；任务取消或租约丢失时未发出的推送会被中止。`createReiServer` 默认用的 npm `web-push` 没有这个口，推送收不到取消信号。VAPID 没配齐的失败 `last_error.errorCode` 为 `VAPID_CONFIG_MISSING`。
- `advanceOccurrence` / `planNextOccurrence` / `nextFutureOccurrence` 新增可选第五参 `anchorMs`（任务首发时刻）；每天固定钟点的任务在春令时顺延一次后，第二天回到原钟点。

**7. Node 版本要求 ≥ 20.3.0**

`package.json` 的 `engines` 定为 `node >= 20.3.0`。
