---
"@rei-standard/amsg-client": minor
---

新增可选 `serverToken`：配置后，client 会在 amsg-server 端点（schedule / messages / update / cancel / user-key / init）的请求上带 `X-Client-Token` 共享密钥，用于单用户部署的访问校验。instant 路径不受影响，仍使用 `instantClientToken`。
