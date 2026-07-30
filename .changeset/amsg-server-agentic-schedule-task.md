---
"@rei-standard/amsg-server": minor
---

fire hook 能给自己排后续任务：ctx 上新增 `scheduleTask`

- `onBeforeFire` / `onLLMOutput` / `executeToolCalls` 的 ctx 上多一个 `scheduleTask(options)`，在这次 fire 里给同一个用户再建一条定时任务（「这条发完，一个半小时后再接着说一句」）。建出来的是一条正常的任务行，到点由 cron 触发，用户离线也不影响。写口在 `onLLMOutput` 的 ctx 上也给，是因为「要不要接着说」往往是看完这轮 LLM 输出才定的。
- 凭据与投递配置（`pushSubscription` / `apiUrl` / `apiKey` / `primaryModel` / `maxTokens` / `temperature` / `splitPattern`）以及 `contactName` / `avatarUrl` / `messageSubtype` / `userMessage` 从当前任务继承，宿主只提供「什么时候、说什么方向」，全程看不到凭据。`completePrompt` / `messages` 不继承（都置 `null`）：hook 每次现场重组 prompt，把排程时冻结的旧 prompt 带过去，新任务万一走回冻结 prompt 老链路就会静默顶替宿主的意图。
- 返回 `{ created: true, id, uuid, nextSendAt }`；`uuid` 撞车时返回 `{ created: false, reason: 'duplicate', uuid }` 而不是抛错——fire 失败会整条重跑，宿主传一个由「任务 id + 触发时刻」推出来的确定性 uuid 就天然幂等。
- 护栏：`firstSendTime` 必填且至少比当前晚 60 秒（cron 一分钟一跳，排得更近等于让下一跳立刻捡走）；`messageType` 只收 `auto` / `prompted` / `fixed`；`fixed` 必须有 `userMessage`；单次 fire 最多建 2 条，factory 配置 `maxScheduledTasksPerFire` 可调（`0` 表示不许自排）；数据库适配器没有 `createTask` 时抛 `AGENTIC_SCHEDULE_UNSUPPORTED`，不静默成功。
- `GET /capabilities` 的 features 随之多一个 `agentic-schedule-task`，前端可以据此判断部署的 worker 认不认这条链路。
