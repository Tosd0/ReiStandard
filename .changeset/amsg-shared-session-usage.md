---
"@rei-standard/amsg-shared": minor
---

`buildSessionContext` 新增 `usage` 字段（`llmResponse.usage` 的直接引用）

`onLLMOutput` 想记本轮 token 用量，之前要自己从 `llmResponse` 里扒（并假定响应形状）。现在 SessionContext 直接带 `usage`（响应没带 → null），amsg-instant 与 amsg-server 的 hook 同步获得。
