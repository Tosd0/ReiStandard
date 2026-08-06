---
"@rei-standard/amsg-server": minor
---

`onFireSettled` 载荷带解密 `metadata` 与最后一轮 `usage`；导出 CORS 头列表与 agentic 预算常量

- `onFireSettled` 的载荷新增 `metadata`（解密 payload 的 metadata 子字段，与 `onStaleSkip` 同待遇——task 行是密文，宿主要靠它对上是哪个角色的哪类任务，尤其是链路在 onBeforeFire 里就失败、侧信道一条都没写上的那种结局）和 `usage`（最后一轮 LLM 响应的 usage；没跑到 LLM → null）。`onAfterSend` 载荷同样带 `usage`。凭据字段照旧不透传。
- 导出 `CORS_ALLOW_HEADERS` / `CORS_ALLOW_METHODS`（单用户 worker 的允许头/方法列表）：在 worker 外面再包一层路由的宿主 import 这一份，不用再手抄第二份等它漂移。
- 导出 `DEFAULT_MAX_TOOL_ITERATIONS` / `DEFAULT_TOTAL_TIMEOUT_MS` / `DEFAULT_MAX_SCHEDULED_TASKS_PER_FIRE` / `MIN_SCHEDULE_LEAD_MS`：包装层要对齐预算档位时用同一份常量。

特性位：`fire-settled-metadata`、`hook-usage`。
