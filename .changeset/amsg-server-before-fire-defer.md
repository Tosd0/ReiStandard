---
"@rei-standard/amsg-server": minor
---

onBeforeFire 新增 `{ defer: { afterMs } }` 出口：现在不合适，过一会儿再来问

任务到点时宿主这会儿不方便生成（比如同一段对话里正有另一轮回复在生成），`onBeforeFire` 返回 `{ defer: { afterMs } }` 即可把这次触发往后推。这一次不调 LLM、不推送，也不调 `onLLMOutput` / `onAfterSend`；任务行只把 `retry_after` 写成现在 + `afterMs` 并放掉租约，`retry_count`、`last_error`、`next_send_at`、`status` 都不动，循环任务不推进。到点之后 cron 把它重新捞起来，从 `onBeforeFire` 再走一遍，可以继续推迟。

它不是失败：抛错会占一格重试、写 `last_error`、按 2 / 4 / 6 分钟退避，推迟这三样都没有。

- `afterMs` 必须是有限正数，最大 24 小时（导出为 `MAX_DEFER_AFTER_MS`）；不合法按 `AGENTIC_BAD_BEFORE_FIRE` 一跳终审。
- `onFireSettled` 的 `status` 多一种 `deferred`，载荷新增 `retryAfter`（ISO 时刻，其余结局为 `null`）。
- tick 汇总新增 `details.deferredTasks`（`{ taskId, retryAfter }`），不计入成功或失败；`runTask` 在到点之前再调会回 `retry_pending`。
- 过期线照常生效：名义时刻过去超过 `staleAfterMs` 的任务按过期处理；某次推迟的唤醒时刻已经越过这条线时当场按过期收场，重试链上的任务也一样。
- 只有定时投递（`runScheduledTick` / `runTask`）且适配器实现了 `claimTask` 时可用。请求内当场投递的 `instant` 任务、没实现 `claimTask` 的自定义适配器返回 `{ defer }` 会得到 `AGENTIC_DEFER_UNSUPPORTED` 配置错误。
- `GET /capabilities` 的 features 新增 `before-fire-defer`。
