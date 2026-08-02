---
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-shared": minor
---

hook 契约补齐任务身份与状态读写口；push 自带任务的调度身份

- **config 级 hook 拿到状态读写口。** `onAfterSend` / `onStaleSkip` 的载荷里现在有 `readState(ns)` / `writeState(ns, entries)`，语义与 fire 级那套一致（单用户模式下作用于当前用户的命名空间）。此前只有 fire 级 ctx 上有，宿主要在这两个 hook 里写 `client_state` 只能自己缓存一份写口：isolate 冷启动后、本次 tick 里还没有任何 fire 跑过时缓存是空的（服务停摆恢复后那一波过期跳过一条痕迹都留不下，而那正是 `onStaleSkip` 存在的意义），缓存下来的闭包还握着上一次 invocation 的数据库绑定。
- **`onAfterSend` 收到本次 fire 的 `scratch`。** 与 `onBeforeFire` / `onLLMOutput` 是同一个对象引用，所以「这次生成了哪几段正文」这类上下文直接从 `info.scratch` 读，不用再按任务行 id 自建登记表（连带 TTL 清扫和并发隔离）。完整载荷：`{ task, sentCount, total, error, scratch, readState, writeState }`。
- **`onLLMOutput` / `executeToolCalls` 的 ctx 直接带任务身份**：`taskId`（任务行 id）、`taskUuid`、`occurrenceMs`（本次触发的名义时刻，epoch 毫秒）。`sessionId` 是给日志和去重用的不透明字符串（当前格式 `sess_task_<id>@<occurrenceMs>`），拿它切字符串取任务身份是切不稳的。
- **每条 push 顶层带 `taskId` / `taskUuid` / `recurrenceType` / `occurrenceMs`**（冻结 prompt 路径和 fire-time hook 路径都算）。客户端据此认领任务、判断它还会不会再来——角色在 fire 里给自己排的任务客户端从没见过，此前只能靠宿主往 `metadata` 里逐个抄。调用方在 `pushPayloads` 里自己写了这几个字段会被库覆盖：它们描述的是任务行的事实，不是内容。`@rei-standard/amsg-shared` 的 `AmsgPushCommon` 类型随之收录这四个字段（`taskId` 从 `ContentPush` 上移到公共层）。
- **新增导出 `PUSH_ENVELOPE_RESERVED_BYTES`（384 字节）**，以及 `measurePushPayload(payload, { reserveEnvelope: true })` 这个口径。hook 把 payload 交还给库之后，库还会补 `messageId` / `sessionId` / `timestamp` / `messageIndex` / `totalMessages` / `taskId` / `taskUuid` / `recurrenceType` / `occurrenceMs`，hook 手里量到的从来不是最终 payload；不留这一截的话，卡在边界上的消息会「量出来装得下、补完字段就超了」，既没走旁路存储也发不出去。返回值多一个 `envelopeReservedBytes`。
- **`GET /capabilities` 的 features 追加** `hook-state-accessors` / `after-send-scratch` / `fire-task-identity` / `push-task-identity` / `push-envelope-reserved-bytes`。
