---
"@rei-standard/amsg-server": minor
---

补发新鲜度守卫、循环任务不进终态、退避写租约、occurrence 级 push id、发送后 hook、update-message 认凭据字段

- **补发新鲜度守卫：错过触发时刻超过 60 分钟的任务不再照常补发。** 服务停摆几天恢复后，cron 捞到的旧任务按「错过了」处理，不把积压一口气倒给用户：
  - 一次性任务：不发，行标 `failed`，原因记在 payload 的 `lastError`（`{ at, occurrence, reason: 'stale' }`）上，`GET /messages` 每条任务随之多返回一个 `lastError` 字段（没有记录 → `null`）。同时调用新增的可选 hook `ctx.onStaleSkip?.(task, { reason: 'stale', metadata })`（单用户 worker 从 config 的 `onStaleSkip` 透传），宿主用它写「这条错过了」的回执。`task` 是任务行原样（payload 是密文）；`metadata` 是解密 payload 里的 `metadata` 子字段（没有则为 `null`），宿主靠它对上是哪个角色的任务——解密 payload 里的 `apiKey` / `pushSubscription` 等凭据不会递给 hook。hook 抛错只记日志，不影响主流程。
  - daily / weekly 任务：不发，`next_send_at` 快进到未来第一个名义时刻（保持钟点不变），`retry_count` 归零，行保持 `pending`。
  - 正在重试链上的任务（`retry_count > 0`）不算过期：它的 `next_send_at` 一直是名义时刻，重试拖过一小时不等于用户错过了它。
  - tick 返回值的 `details` 多一个 `staleTasks` 数组（`{ taskId, reason, action: 'expired' | 'fast_forwarded' }`）。
- **循环任务永不进终态：终审失败改为跳过本次 occurrence。** daily / weekly 任务重试用尽时不再标 `failed`（发送成功但发送后写库失败的场景也不再标 `sent`）——两种终态都会让循环任务从此退出捞取、每日消息无声消失。现在这两条路都改为：`next_send_at` 从名义时刻推进到下个周期、`retry_count` 归零、错误记在 payload 的 `lastError` 上（`GET /messages` 可见）。一次性任务维持既有终态行为。
- **重试退避改写在租约上，`next_send_at` 全程保持名义时刻。** 投递失败安排重试时，退避时刻写进 `lease_until`（捞取条件里的租约过滤到点自然放行），不再改写 `next_send_at`。循环任务的推进基准、hook 拿到的 `nextSendAt`、过期判定因此都始终对着用户设的触发时刻，不会每失败一次漂几分钟。没实现 `claimTask` 的自定义适配器没有租约列，维持老行为（退避写进 `next_send_at`）。
- **默认 messageId / sessionId 掺入名义触发时刻。** 有任务行的推送，默认 id 变为 `msg_task_<id>@<occurrenceMs>_<i>`（agentic 路径为 `..._hook_<i>`）与 `sess_task_<id>@<occurrenceMs>`，`occurrenceMs` 取 `Date.parse(task.next_send_at)`。循环任务跨天复用同一行，之前的 id 只含 task.id，离线设备一次性收到多天积压推送（push TTL 四周）时会在 service worker 端互相去重、收件箱按 messageId 覆盖，几天的消息只剩一条；掺入名义时刻后每个 occurrence 一套 id，同一 occurrence 的重试仍复用同一套（重投已送达的段照旧被去重）。调用方在 pushPayloads 里显式带了 `messageId` / `sessionId` 时仍以调用方为准；行上没有可解析的 `next_send_at` 时保持旧格式。
- **新增发送后 hook `ctx.onAfterSend?.({ task, sentCount, total, error })`。** agentic 路径的 pushPayloads 逐段发完（或中途发挂）后调用（单用户 worker / `createSingleUserServer` 从 config 的 `onAfterSend` 透传）。载荷带 `task`（任务行本身）：tick 内最多 8 个任务并发投递，宿主按任务写回执时靠它对号入座。全部成功时 `error` 为 `null`；第 k 段失败时 `sentCount = k`、`error` 带原始错误，且 hook 会在错误往上抛之前调用完。宿主用它把「真的发出去了几段」写回自己的存储——发送前的 hook（`onBeforeFire` / `onLLMOutput`）写的副作用，在推送全挂时会变成「云端记得说过、用户没收到」。hook 自身抛错只记日志，不影响主流程。
- **`PUT /update-message` 认 `apiUrl` / `apiKey` / `primaryModel` / `pushSubscription` 四个字段。** 消费方换了聊天 API 配置或重新订阅推送后，已挂任务里冻结的旧值可以刷新掉了（此前这四个字段不在合并白名单里，传了会被静默丢弃）。校验口径与 `schedule-message` 一致：前三个只要求 truthy，`pushSubscription` 带值时必须是对象（否则 400 `INVALID_UPDATE_DATA`）。四个字段都是 truthy 合并——传 `null` 不清空、只是忽略（清掉任何一个，任务到点就发不出去）。
- **`GET /capabilities` 的 features 追加** `tick-stale-guard` / `recurring-skip-occurrence` / `occurrence-scoped-push-ids` / `after-send-hook` / `update-message-credentials`，前端可以据此判断部署的 worker 认不认这些行为。
