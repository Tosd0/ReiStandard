---
"@rei-standard/amsg-server": major
---

升到 3.0.0：推送订阅改为用户级登记（`PUT /push-subscription`），`POST /schedule-message` 与 `PUT /update-message` 不再接受请求体里的 `pushSubscription`。

从 2.5.3 升级的多租户部署（`createReiServer`）和排程客户端都会受这次变更影响。如果只升服务端而不挂载 `/api/v1/push-subscription` 路由、也不更新客户端登记用户级订阅，新的 `POST /schedule-message` 请求会因携带 `pushSubscription` 收到 `400 PUSH_SUBSCRIPTION_NOT_ACCEPTED`，或因未登记订阅收到 `409 PUSH_SUBSCRIPTION_MISSING`。单用户 Cloudflare Worker + D1 部署线、服务端收件箱（`/outbox`）、`client_state` 云端镜像、Fire 时刻 hooks 等属于 3.0.0 新增能力，不影响 2.5.3 存量多租户接入，用法见包内 `README.md`。

### 必须改动

#### 1. 推荐升级顺序

1. 先部署 `@rei-standard/amsg-server@3.0.0`，在多租户路由里挂上新增的 `rei.handlers.pushSubscription`（按需挂上 `getMessage`、`llmCredentials`）。升级前已入库的老任务在投递时若查不到用户级订阅，会自动回退使用老任务 payload 里内嵌的订阅，过渡期不会断投。
2. 客户端升级到 `@rei-standard/amsg-client@2.9.0`（建议同步将 `@rei-standard/amsg-sw` 升到 `2.4.0`）。
3. 客户端在 `subscribePush()` 拿到订阅后、以及每次应用启动确认订阅仍有效时，调用 `await client.putPushSubscription(subscription)` 登记用户级订阅。
4. 客户端调用 `client.scheduleMessage()` 和 `client.updateMessage()` 时去掉 `pushSubscription` 字段。

#### 2. 推送订阅改为用户级登记

2.5.3 时，`POST /schedule-message` 要求在每条任务的请求体里带 `pushSubscription`。3.0.0 改为每个用户存一份订阅（`push_subscriptions` 表），任务行不再存订阅：

- `POST /schedule-message` 和 `PUT /update-message` 请求体只要带了 `pushSubscription` 字段，一律返回 HTTP `400` `PUSH_SUBSCRIPTION_NOT_ACCEPTED`。
- `POST /schedule-message` 在该用户尚未通过 `PUT /push-subscription` 登记过订阅时，返回 HTTP `409` `PUSH_SUBSCRIPTION_MISSING`（若数据库读取订阅抛错则返回 `503` `PUSH_SUBSCRIPTION_LOOKUP_FAILED`）。

改前（2.5.3 + `amsg-client` 2.8.0）：

```js
const subscription = await client.subscribePush(vapidPublicKey, registration);

await client.scheduleMessage({
  contactName: 'Rei',
  messageType: 'fixed',
  userMessage: '下班记得带伞',
  firstSendTime: new Date(Date.now() + 60_000).toISOString(),
  recurrenceType: 'none',
  pushSubscription: subscription.toJSON(),
});
```

改后（3.0.0 + `amsg-client` 2.9.0）：

```js
const subscription = await client.subscribePush(vapidPublicKey, registration);
// 首次订阅后、以及每次应用启动确认订阅有效时调用（幂等覆盖）
await client.putPushSubscription(subscription);

await client.scheduleMessage({
  contactName: 'Rei',
  messageType: 'fixed',
  userMessage: '下班记得带伞',
  firstSendTime: new Date(Date.now() + 60_000).toISOString(),
  recurrenceType: 'none',
});
```

#### 3. 多租户服务端挂载新路由

`createReiServer` 返回的 `rei.handlers` 比 2.5.3 新增了 3 组处理器：

| Handler | HTTP 方法 | 标准路由 | 是否必挂 |
|---|---|---|---|
| `rei.handlers.pushSubscription` | `PUT` / `GET` / `DELETE` | `/api/v1/push-subscription` | 必挂 |
| `rei.handlers.getMessage` | `GET` | `/api/v1/message` | 按需 |
| `rei.handlers.llmCredentials` | `PUT` / `GET` / `DELETE` | `/api/v1/llm-credentials` | 按需 |

三组路由的鉴权方式与既有业务端点相同（`Authorization: Bearer <tenantToken>` + `X-User-Id`）。`pushSubscription` 必须挂上，否则客户端无法登记订阅；`getMessage` 用于按 `?id=<uuid>` 读取单条 `pending` 任务（比 `/messages` 列表多返回完整的 `metadata`，方便 `PUT /update-message` 做读-改-写）；`llmCredentials` 用于集中登记用户级 LLM 凭据并在排程时通过 `credRefs: { chat: '<credId>' }` 引用。

改前（2.5.3）：

```js
const rei = await createReiServer(config);
// 仅挂载 initTenant / getUserKey / scheduleMessage / sendNotifications /
// updateMessage / cancelMessage / messages
```

改后（3.0.0）：

```js
const rei = await createReiServer(config);
// 除原有 7 个路由外，新增挂载：
// PUT  /api/v1/push-subscription   -> rei.handlers.pushSubscription.PUT
// GET  /api/v1/push-subscription   -> rei.handlers.pushSubscription.GET
// DELETE /api/v1/push-subscription -> rei.handlers.pushSubscription.DELETE
// GET  /api/v1/message?id={uuid}   -> rei.handlers.getMessage.GET
// PUT  /api/v1/llm-credentials     -> rei.handlers.llmCredentials.PUT
// GET  /api/v1/llm-credentials     -> rei.handlers.llmCredentials.GET
// DELETE /api/v1/llm-credentials   -> rei.handlers.llmCredentials.DELETE
```

#### 4. 包根导出的加密函数改为 async

2.5.3 时，包根导出的 `deriveUserEncryptionKey`、`decryptPayload`、`encryptForStorage`、`decryptFromStorage` 基于 `node:crypto` 同步执行。3.0.0 底层改为 Web Crypto API（`globalThis.crypto.subtle`），四个函数全部变为 `async`、返回 `Promise`。直接调用它们的宿主代码必须补上 `await`。传输层（12 字节 IV，base64 `{ iv, authTag, encryptedData }`）和落库层（16 字节 IV，hex `iv:authTag:encryptedData`）的密文格式完全不变，存量密文无需迁移。

改前（2.5.3）：

```js
const userKey = deriveUserEncryptionKey(userId, masterKey);
const payload = decryptPayload(encryptedBody, userKey);
const cipherText = encryptForStorage(JSON.stringify(payload), userKey);
const plainText = decryptFromStorage(cipherText, userKey);
```

改后（3.0.0）：

```js
const userKey = await deriveUserEncryptionKey(userId, masterKey);
const payload = await decryptPayload(encryptedBody, userKey);
const cipherText = await encryptForStorage(JSON.stringify(payload), userKey);
const plainText = await decryptFromStorage(cipherText, userKey);
```

#### 5. 自定义数据库适配器（`tenant.adapterFactory`）接口补齐

使用内置 `pg` / `neon` 适配器的部署无需改动代码。如果通过 `tenant.adapterFactory` 传入了自定义适配器：

- **必选新增方法**：`getPushSubscription(userId)`、`upsertPushSubscription(userId, encryptedSubscription, updatedAt)`、`deletePushSubscription(userId)`。缺少任一方法时，`/push-subscription` 与 `POST /schedule-message` 会返回 HTTP `501` `PUSH_SUBSCRIPTION_NOT_SUPPORTED`。
- **查询返回列补充**：`getPendingTasks` 与 `getTaskByUuidOnly` 返回的行应包含 `retry_after` 列（缺失时 `runTask` 退避窗口检查不生效并打印一次告警）；`listTasks` 与 `getTaskByUuid` 建议包含 `last_error` 列（若 `updateTaskById` 不支持写 `last_error` 列，调度器会自动降级并仍将 `lastError` 保存在加密 payload 中）。
- **其他可选方法及缺失后果**：
  - `claimTask(taskId, expectedNextSendAt, leaseUntil, serializeGroup?)`：缺失时退回不占位的旧行为（慢任务跨分钟可能被下一跳重复触发），失败退避时间写回 `next_send_at` 而非 `retry_after`，且不支持 `onBeforeFire` 返回 `{ defer }`；若实现但忽略第 4 个参数 `serializeGroup`，则 `serializeBy` 只在同一跳内串行、跨跳不互斥。
  - `renewTaskLease(taskId, leaseUntil)`：缺失时关闭执行期心跳续租，退回一次性长租约（默认 10 分钟），无法在生成中途通过心跳主动感知任务被取消。
  - `createTaskSuperseding(params, supersedesUuid)`：缺失时 `POST /schedule-message` 传 `supersedesUuid` 退回先 `createTask` 再 `deleteTaskByUuid` 两步执行。
  - `getTaskStatusInfo(uuid, userId)`：缺失时 `GET /message` 访问已结束任务退回调 `getTaskStatus(uuid, userId)`，返回的 `409 TASK_ALREADY_COMPLETED` 中 `details.lastError` 为 `null`。
  - `getTaskStatusByUuidOnly(uuid)`：缺失时 `runTask(ctx, uuid)` 找不到待发任务行时无法区分 `already_settled` 与 `not_found`，统一返回 `reason: 'not_found'`。
  - `upsertLlmCredentials` / `getLlmCredentials` / `listLlmCredentials` / `deleteLlmCredentials`：缺少任一方法时，`/llm-credentials` 及带 `credRefs` 的排程/更新返回 `501` `LLM_CREDENTIALS_NOT_SUPPORTED`。
  - `deleteLlmCredentialsByPrefix(userId, credIdPrefix)`：缺失时 `DELETE /llm-credentials` 传 `{ credIdPrefix }` 返回 `501` `LLM_CREDENTIALS_PREFIX_DELETE_NOT_SUPPORTED`（内置 `pg` / `neon` 也未实现该方法，仅 D1 实现）。

### 行为变化与自动迁移

#### 1. 升级前创建的老任务平滑投递

升级前已入库的老任务不需要迁移即可照常投递。投递时服务端先查 `push_subscriptions` 表；如果该用户还没有登记过用户级订阅，会自动回退读取老任务加密 payload 里内嵌的 `pushSubscription`。一旦用户登记了新订阅，后续所有存量任务都会优先使用用户级订阅。

#### 2. 表结构自动补齐（Postgres / Neon）

多租户 `createReiServer` 在每个进程首次通过 `resolveTenant` 或 `initializeTenant` 拿到某个租户的数据库适配器时，会自动跑一遍幂等的 `adapter.initSchema()`（见 `adapters/schema.js`）：

- 新建表（`CREATE TABLE IF NOT EXISTS`）：`push_subscriptions`（`user_id`、`subscription`、`updated_at`）、`llm_credentials`（`user_id`、`cred_id`、`encrypted_value`、`created_at`、`updated_at`）。
- `scheduled_messages` 表补 4 列（`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`）：`lease_until`、`retry_after`、`serialize_group`、`last_error`。
- 新建部分索引（`CREATE INDEX IF NOT EXISTS`）：`idx_serialize_group_lease`（`ON scheduled_messages (serialize_group, lease_until) WHERE serialize_group IS NOT NULL AND status = 'pending'`）。

注意事项：连接数据库的账号必须有 `CREATE TABLE`、`ALTER TABLE`、`CREATE INDEX` 的 DDL 权限；`CREATE INDEX IF NOT EXISTS` 不带 `CONCURRENTLY`，若存量 `scheduled_messages` 表很大，首次建索引期间可能短暂阻塞写入，大表建议在升级前手动执行 `CREATE INDEX CONCURRENTLY`。

#### 3. 错过触发时刻过久的任务不再补发

默认过期阈值 `STALE_AFTER_MS` 为 **60 分钟**（`3_600_000` ms，见 `lib/run-tick.js`）。当任务的名义触发时刻 `next_send_at` 距今超过 60 分钟，且不在新鲜的重试窗口内（`retry_count === 0`，或 `retry_after` 距今也已超过 60 分钟）时，不再补发：

- 一次性任务（`recurrenceType: 'none'`）：行状态直接标为 `'failed'`，在 `last_error` 列和加密 payload 的 `lastError` 中写入 `{ at, occurrence, reason: 'stale' }`。
- 循环任务（`daily` / `weekly`）：跳过攒下的过期轮次，把 `next_send_at` 快进到未来第一个触发时刻，`retry_count` 归零，状态保持 `'pending'`，并在 `lastError` 中写入 `{ at, occurrence, reason: 'stale', skippedCount, nextSendAt }`。

多租户 `createReiServer` 内置的 `rei.handlers.sendNotifications.POST` 固定使用 60 分钟默认阈值，不能通过 `createReiServer(config)` 调整；若多租户宿主需要自定义 `staleAfterMs`（或 `claimLeaseMs`、`serializeBy`、`onStaleSkip`），需在自己的 cron 路由中直接调用包根导出的 `runScheduledTick({ ...ctx, staleAfterMs })`。

#### 4. 重试语义变化

- **LLM 上游确定性错误不再重试**：当 `LLM_CALL_FAILED` 的上游 HTTP 状态码 `llmStatus` 为 `400`、`401`、`402`、`403`、`404`、`405`、`413`、`422` 之一时，错误标为 `permanent: true`，不再进退避重试，当场按终态结算（一次性任务标 `failed`，循环任务跳过本次推进到下一周期）。`408`、`409`、`425`、`429`、所有 `5xx`、网络超时或断连、以及 HTTP `200` 但响应体包含报错的情况照旧重试。
- **推送服务终态错误不再重试**：Web Push 推送服务返回 HTTP `404`、`410`（订阅失效或已注销）或 `413`（单条密文超限），以及本地报错 `PUSH_SUBSCRIPTION_MISSING`、`PUSH_SUBSCRIPTION_STORE_UNSUPPORTED`、`PUSH_PAYLOAD_TOO_LARGE`，均不再重试直接终审。推送服务返回 `400` / `401` / `403`（多为部署级 VAPID 配置问题）或 `429` / `5xx` 仍走退避重试。此外，在没有服务端收件箱的多租户线上，若同一批次已经成功发出至少 1 条 push 后中途失败，也会直接终审不再重试，避免重新生成导致客户端收到两份不同版本的前后半截内容。

#### 5. 大小上限与默认 `messageId` 格式

- **单条 Web Push 明文上限**：`MAX_PUSH_PAYLOAD_BYTES = 3993` UTF-8 字节（推送服务密文上限 `4096` 字节减去 `aes128gcm` 固定开销 `103` 字节；Fire hook 预留信封字节 `PUSH_ENVELOPE_RESERVED_BYTES = 384` 后剩余 `3609` 字节）。超限在发送前直接抛 `PUSH_PAYLOAD_TOO_LARGE`。
- **单条任务正文上限**：`MAX_TASK_PAYLOAD_BYTES = 995871` UTF-8 字节（约 972.5 KB）。`POST /schedule-message` 或 `PUT /update-message`（更新后正文变大时）超出上限返回 HTTP `400` `TASK_PAYLOAD_TOO_LARGE`。
- **压缩请求体解压上限**：支持 `Content-Encoding: gzip` 请求体，解压后默认上限 `DEFAULT_MAX_REQUEST_BODY_BYTES = 33554432` 字节（32 MB），超出返回 HTTP `413` `REQUEST_BODY_TOO_LARGE`；不支持的编码（如 `br`、`deflate`）返回 `415` `UNSUPPORTED_CONTENT_ENCODING`。未压缩的明文请求体不受此 32 MB 阈值限制。
- **默认 `messageId` 与 `sessionId` 格式**：2.5.3 对循环任务每次触发都生成相同的 `msg_task_<id>_<i>` 和 `sess_task_<id>`；3.0.0 在 `task.next_send_at` 可解析为毫秒时间戳 `occurrenceMs` 时拼入 `@<occurrenceMs>`，避免循环任务不同周期的推送在客户端去重时互相冲掉：
  - `sessionId`：`sess_task_<id>@<occurrenceMs>`（无 `task.id` 时为 `sess_<uuid>`）
  - 正文第 `i` 段（0-based）：`msg_task_<id>@<occurrenceMs>_<i>`
  - 思考过程：`msg_task_<id>@<occurrenceMs>_reasoning`
  - 自定义结果第 `seq` 条（0-based）：`msg_task_<id>@<occurrenceMs>_result_<seq>`

### 新老版本混用兼容性

| 服务端版本 | 客户端 / SW 版本 | 兼容结论 |
|---|---|---|
| `amsg-server` 3.0.0 | `amsg-client` ≤ 2.8.0 | 不兼容（无法新建排程） |
| `amsg-server` 2.5.3 | `amsg-client` 2.9.0 | 新方法 404，排程需传旧字段 |
| `amsg-server` 3.0.0 | `amsg-sw` 2.3.2 | 基本可用，两项新特性降级 |

- **`amsg-server` 3.0.0 + `amsg-client` ≤ 2.8.0**：server 3.0.0 要求先通过 `PUT /push-subscription` 提交加密订阅，且拒绝排程请求体里的 `pushSubscription`。老 client 没有 `putPushSubscription()` 方法，且 `scheduleMessage()` 会附带 `pushSubscription`，排程会直接收到 `400 PUSH_SUBSCRIPTION_NOT_ACCEPTED`。升级 server 3.0.0 要求客户端升到 `amsg-client >= 2.9.0`。
- **`amsg-client` 2.9.0 + `amsg-server` 2.5.3**：调用 2.9.0 新增的 `putPushSubscription()`、`getMessage()`、`putLlmCredentials()`、`getOutbox()`、`putClientState()` 等方法会收到 HTTP `404`；`client.getCapabilities()` 遇到 `404` 返回 `null`；调用 `scheduleMessage()` 若不传 `pushSubscription` 会被老服务端以 `400 INVALID_PARAMETERS` 拒绝。
- **`amsg-server` 3.0.0 + `amsg-sw` 2.3.2**：常规 `content` / `reasoning` / `tool_request` / `error` 推送与 `_multipart` 重组照常工作，但老 SW 不认识 `messageKind: 'result'`（不会触发 `rei-amsg-result-received` 分支，不过 `emitResult` 默认带 `notification.show: 'always'`，系统通知仍会弹出），并且会把 `notification.silent: 'when-visible'` 按布尔真值当成一律静音（页面在后台时也不会响铃）。建议将 `@rei-standard/amsg-sw` 同步升到 `2.4.0`。
