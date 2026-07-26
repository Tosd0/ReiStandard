---
"@rei-standard/amsg-server": minor
---

定时触发改为「先占位再投递」，同一条任务不会被相邻几跳重复发出

cron 一分钟一跳、跳与跳之间互不相让，而一次投递「组 prompt → 调 LLM → 跑工具 → 推送」跑过一分钟很常见。之前每跳都是一条裸 SELECT 捞待发任务，任务行在整个投递期间一直是 `pending` 且时间已过，于是同一条任务会被后面几跳反复捞出来重跑，用户那边收到好几遍。

现在每条任务开跑前先占位：把库里的 `next_send_at` 顶到「现在 + 租期」，本次投递期间这一行对其他调用不再是「到点待发」；占位改到 0 行说明别人先领走了，本次直接跳过。租期默认 10 分钟，配了 `totalTimeoutMs` 的按它 + 2 分钟往上抬，也可以用 `claimLeaseMs` 自己定。跳过的条数记在 tick 返回值的 `details.claimSkippedTasks` 里。

hook 的 `ctx.task.nextSendAt` 拿到的仍是这条任务原本的触发时刻（不是占位后的租期时间），循环任务也按原始触发时刻推进到下一次。

适配器接口新增可选的 `claimTask(taskId, expectedNextSendAt, leaseUntil)`，D1 / pg / neon 三个内置适配器都已实现；自定义适配器不实现也能跑，只是回到不占位的行为。
