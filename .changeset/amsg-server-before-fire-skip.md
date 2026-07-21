---
"@rei-standard/amsg-server": minor
---

onBeforeFire 新增 `{ skip: true }` 出口：在第一次 LLM 调用之前结束本次 fire

宿主在 fire 时刻就能判断这条消息已经多余（比如排程之后对话又有了新进展）时，`onBeforeFire` 返回 `{ skip: true }` 即可作废本次触发。这次 fire 算作一次零推送的成功投递（`status: 'skipped'`）：一次性任务照删、循环任务照推进到下次，且不调用 LLM、不消耗 token。

返回 `null` 的既有语义不变（回退到排程时冻结的 completePrompt 老链路）。
