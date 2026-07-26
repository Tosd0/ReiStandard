---
"@rei-standard/amsg-server": minor
---

定时触发改为「先占位再投递」，同一条任务不会被相邻几跳重复发出

cron 一分钟一跳、跳与跳之间互不相让，而一次投递「组 prompt → 调 LLM → 跑工具 → 推送」跑过一分钟很常见。之前每跳都是一条裸 SELECT 捞待发任务，任务行在整个投递期间一直是 `pending` 且时间已过，于是同一条任务会被后面几跳反复捞出来重跑，用户那边收到好几遍。

现在每条任务开跑前先占位：在这一行的 `lease_until` 上写下「归我管到现在 + 租期为止」，本次投递期间别的 tick 领不走它；占位改到 0 行说明别人先领走了，本次直接跳过。跳过的条数记在 tick 返回值的 `details.claimSkippedTasks` 里。

租期默认 10 分钟，配了 `totalTimeoutMs` 的按它 + 2 分钟往上抬，也可以用 `claimLeaseMs` 自己定。租期要盖住最慢的一次投递；同时它也是「投递中途进程没了之后、这条任务多久能被接手」的等待时间。

`next_send_at` 不参与占位，全程是用户设的那个触发时刻：任务列表读到的是它，循环任务推进下一次以它为基准，hook 的 `ctx.task.nextSendAt` 也是它。投递收尾时租约就放掉，失败重试的退避（2 分钟起）不会被租期压住。

**表结构**：`scheduled_messages` 新增一列 `lease_until`（SQLite `TEXT` / Postgres `timestamptz`，可空）。`initSchema()`（包括 `POST /init-tenant`）会给已有的表补上这一列，跑几次都没事。手工维护表结构的话，D1 执行 `ALTER TABLE scheduled_messages ADD COLUMN lease_until TEXT`，Postgres 执行 `ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS lease_until TIMESTAMP WITH TIME ZONE`。

适配器接口新增可选的 `claimTask(taskId, expectedNextSendAt, leaseUntil)`，D1 / pg / neon 三个内置适配器都已实现；实现了它的适配器，`updateTaskById` 还要认 `lease_until` 字段（含写 null）。自定义适配器不实现 `claimTask` 也能跑，只是回到不占位的行为。
