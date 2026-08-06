---
"@rei-standard/amsg-server": minor
---

任务行新增 `last_error` 列（失败原因的明文脱敏摘要）；导出 `NonRetryableError`（确定性失败不重试）

**last_error**：之前行标 `failed` 但不存原因——payload 里的 `lastError` 是密文，且 `GET /message` 对非 pending 行只回一句 409，最典型的失败（payload 解析失败、hook 在 onBeforeFire 里拒掉）用户一个字都看不到。现在 `scheduled_messages` 加 `last_error` 列（JSON：`{ at, occurrence, reason }`，`reason` 经 `sanitizeErrorSummary` 脱敏：Bearer/key 形态的 token 遮掉、截断 500 字符）：

- 每次投递失败都写（等重试期间也看得到当前原因），成功后清掉；
- `GET /message?id=` 对已失败/已完成的行，409 响应的 `error.details` 带 `{ status, lastError }`；pending 行的投影里 `lastError` 也会在 payload 没记录时退回这一列；
- 升级后还没重跑 `POST /init-tenant`（补列迁移）的库，写入自动退掉这个字段重试，状态推进不受影响。

**NonRetryableError**：fire_pack 缺失/解析失败这类重试必然同败的错，之前也按投递失败重试 3 次（2/4/6 分钟），用户白等 12 分钟、hook 里的计费调用白烧三轮。现在 hook 抛 `NonRetryableError`（或任何带 `permanent: true` 的错误），run-tick 直接终审处置：一次性任务标 `failed`，循环任务作废本次 occurrence；instant 路径（`processMessagesByUuid`）同样不再重试。判定用 `permanent` 属性而不是 instanceof，跨包/双实例场景安全。

新导出：`NonRetryableError`、`isNonRetryableError`、`sanitizeErrorSummary`。适配器接口新增可选 `getTaskStatusInfo(uuid, userId)`（三个内置适配器都实现）。特性位：`task-last-error`、`non-retryable-error`。
