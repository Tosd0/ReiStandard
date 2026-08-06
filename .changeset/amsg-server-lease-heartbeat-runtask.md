---
"@rei-standard/amsg-server": minor
---

租约按心跳滚动续租，isolate 死亡后任务分钟级被接手；新增 `runTask(ctx, uuid)` 单任务入口

之前租约是认领时一次性写死的长租约（默认 10 分钟）。isolate 在 claim 后被平台回收（fetch 的 `waitUntil` 预算远小于一次 fire 的上限），行就焊死到租约走完——用户盯着「正在输入…」十几分钟。而且租期是全局一个值，为 instant 场景调短，定时任务的慢投递就会被下一跳重复触发。

现在投递期间按心跳续租：占位只写一小段租约（默认 90 秒），之后每 30 秒把 `lease_until` 推到 now + 90s。isolate 活着租约永远够用；isolate 死了租约在 ~90 秒内到期，下一分钟的 cron 就能接手。失败路径照旧主动清租约。心跳间隔用 `leaseHeartbeatMs` 配置（0 = 关掉，退回一次性长租约 `claimLeaseMs`）。适配器接口新增可选 `renewTaskLease(taskId, leaseUntil)`（D1 / pg / neon 都已实现；只在行仍持有租约时生效，收尾放掉后迟到的心跳不会复活它）；没实现的自定义适配器自动退回老行为。

**runTask(ctx, uuid)**：单跑一条任务的官方入口，与 cron tick 走完全同一条投递链（占位、心跳、过期守卫、重试/终态、hook 全套）。给「fetch 里只 enqueue、真正的 fire 交给 CF Queue 消费者（15 分钟预算）跑」的宿主用。行没到点或在退避窗口内不跑（`{ ran: false, reason }`）。

新导出：`runTask`、`DEFAULT_CLAIM_LEASE_MS`、`DEFAULT_LEASE_HEARTBEAT_MS`、`DEFAULT_HEARTBEAT_LEASE_TTL_MS`。特性位：`tick-lease-heartbeat`、`run-task-entrypoint`。
