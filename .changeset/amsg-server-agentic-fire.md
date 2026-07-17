---
"@rei-standard/amsg-server": minor
---

单用户 / Cloudflare 模式新增「fire 时刻现场生成」能力：

- 新表 `client_state`（init-tenant 幂等建表）+ 三个端点：`PUT /client-state` 批量上传状态（按 `updatedAt` last-write-wins，单条 value ≤ 200KB）、`GET /client-state?namespace=` 读取、`DELETE /client-state` 清空。value 用 per-user key 加密落库，鉴权与加密头沿用现有端点。
- `createSingleUserCloudflareWorker` 的 config 接受可选 `hooks: { onBeforeFire, onLLMOutput, executeToolCalls }` 与 `maxToolIterations`（默认 5）、`totalTimeoutMs`（默认 240000，两者都可在 onBeforeFire 返回值里按次覆盖）。配置后，AI 类任务在触发时由 onBeforeFire 现场组装 messages（可经 `ctx.readState(namespace)` 读 client_state），工具在 worker 内就地执行、多轮循环闭环后推送成品；onLLMOutput 的 ctx 与 decision 契约与 `@rei-standard/amsg-instant` 的同名 hook 一致，instant 的 classifier 可直接复用（`tool-request` 同时接受 `toolCalls` 直传与 tool_request pushPayloads 两种形状）。
- 不配 hooks、或 onBeforeFire 返回 null 时，任务照走排程时冻结的 completePrompt 老链路；固定文本任务永远走老链路。hook ctx 不含 apiKey / pushSubscription / VAPID。多租户入口（Netlify/Neon）行为不变。
