---
"@rei-standard/amsg-server": minor
---

新增单用户模式：可在单个 Cloudflare Worker 上运行，定时消息存 D1、定时投递由 CF Cron Trigger 触发，无需多租户注册表 / Blob / tenant token。新增导出 `createSingleUserServer`、`createSingleUserCloudflareWorker`、`createD1Adapter`、`runScheduledTick`、`createWebCryptoWebPush`（Worker 上可用的纯 Web Crypto Web Push）。可选 `serverToken` 共享密钥，配置后所有 amsg-server 端点校验 `X-Client-Token`。可跑通的示例见 `examples/cloudflare-single-user/`。
