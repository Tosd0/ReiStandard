---
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-client": minor
---

单用户 worker 暴露 VAPID 公钥端点，供前端跨源订阅。

- amsg-server：单用户 Worker 新增 `GET /vapid-public-key`，返回本 Worker 自己的 `VAPID_PUBLIC_KEY`（未配置时返回 503 `VAPID_NOT_CONFIGURED`）。和其它端点共用同一套 CORS 与 `serverToken` 校验。前端拿它作为 `applicationServerKey` 来创建 Web Push 订阅——各自部署的 worker 各有各的 VAPID，公钥在运行时从 worker 拉取。
- amsg-client：新增 `ReiClient.getVapidPublicKey()`，GET 该端点并返回公钥字符串（配了 `serverToken` 时带上 `X-Client-Token`）。
