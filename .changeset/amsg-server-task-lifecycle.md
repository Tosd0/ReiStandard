---
"@rei-standard/amsg-server": minor
---

任务生命周期：撞车回已存在的任务、循环过期也有回执、循环推进认时区

- **`ctx.scheduleTask()` 撞 uuid 时回已存在那一行的投影**：`{ created: false, reason: 'duplicate', uuid, task }`。`task` 与 `GET /messages` 列出来的形状一样（`id` / `uuid` / `contactName` / `messageType` / `messageSubtype` / `nextSendAt` / `recurrenceType` / `tzId` / `status` / `retryCount` / `createdAt` / `updatedAt` / `charId` / `clientTaskId` / `lastError`），不含任何凭据。用确定性 uuid 做重试幂等时，重跑那轮此前什么信息都拿不到，那条任务只活在数据库里——宿主的面板列不出、用户取消不了，却照样到点触发烧 LLM。行读不回来（已经不是 pending）→ `task` 为 `null`。投影实现与 `GET /messages` 共用一份，两边不会漂。
- **循环任务的过期快进也走 `onStaleSkip`、也写 `lastError`。** 此前一次性任务错过太久会标 `failed`、写 `lastError`、调 hook，而循环任务直接把 `next_send_at` 快进到下一次，不回调、不记录、零痕迹——宿主完全无从知道「昨天那次没响」。两种情况现在共用一个 hook，靠 `info.action` 区分：`expired`（一次性，行已标 `failed`）/ `fast_forwarded`（循环，排期已快进，行仍是 `pending`）。载荷补齐 `recurrenceType` / `occurrenceMs` / `skippedCount`（跳过几次，含名义那一次）/ `skippedOccurrences`（被跳过的名义时刻，超过 32 次时只给首末两个并置 `skippedTruncated`）/ `nextSendAt`。tick 返回值的 `staleTasks` 每项也多一个 `skippedCount`。
- **任务行支持 `tzId`（IANA 时区 id），`daily` / `weekly` 按该时区的墙钟推进**：同一钟点，日期 +1 天 / +7 天。此前是固定 +24h / +7×24h，跨过夏令时切换点之后墙钟永久漂一小时——用户设的「每天早八点」从此变成早九点。`POST /schedule-message`、`PUT /update-message`（传 `null` 改回按 UTC 推进）、`ctx.scheduleTask({ tzId })`（默认继承当前任务）三个入口都认这个字段，`GET /messages` 每条任务多返回一个 `tzId`（没设 → `null`）。不带 `tzId` 的任务按 UTC 推进。时区换算全部走 `Intl`，不做偏移加减：春令时被跳过的墙钟落到切换之后的等价时刻，秋令时重复出现的墙钟取其中一个、不触发两次。
- **新增导出** `isValidTimeZoneId` / `advanceOccurrence` / `nextFutureOccurrence` / `planNextOccurrence`，宿主想自己算「下次什么时候」时用的是同一份实现。
- **`GET /capabilities` 的 features 追加** `schedule-task-duplicate-row` / `recurring-stale-skip-hook` / `task-timezone`。
