---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-server": minor
---

LLM 请求体支持 `llmExtraBody` 透传（thinking / reasoning_effort 等中转非标准参数）

- shared 的 `buildLlmRequestBody`：`payload.llmExtraBody`（普通对象）原样展开进请求体，先展开再写核心字段——`model` / `messages` / `temperature` / `max_tokens` / `tools` 永远以库的口径为准，extra body 撞键盖不掉。非对象/数组静默忽略。
- server 的 `POST /schedule-message`：payload 白名单加 `llmExtraBody`（存进任务 payload，fire 时随 `buildLlmRequestBody` 进请求体）；fire 里 `ctx.scheduleTask` 自排的后续任务继承它。形状校验只查普通对象——里面的字段是调用方与中转之间的契约。

特性位：`llm-extra-body`。
