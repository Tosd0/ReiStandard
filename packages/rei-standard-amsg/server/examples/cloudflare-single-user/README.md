# 单用户 amsg-server · Cloudflare Worker

定时消息存 D1，定时投递用 CF Cron Trigger。适合只有自己一个人用、想全程跑在 Cloudflare 上的场景。

## 跑通步骤

1. 建 D1 数据库，把返回的 id 填进 `wrangler.toml` 的 `database_id`：
   ```bash
   wrangler d1 create amsg
   ```
2. 建表（二选一）：
   - 命令行：`wrangler d1 execute amsg --file schema.sql`
   - 或部署后调一次 `POST /init-tenant`（幂等；配了 serverToken 要带 `X-Client-Token`）
3. 配 secrets：
   ```bash
   wrangler secret put AMSG_MASTER_KEY      # 随机 32 字节 hex，见下
   wrangler secret put VAPID_EMAIL          # 例如 mailto:you@example.com
   wrangler secret put VAPID_PUBLIC_KEY
   wrangler secret put VAPID_PRIVATE_KEY
   wrangler secret put AMSG_SERVER_TOKEN    # 可选：共享密钥，配了才校验 X-Client-Token
   ```
   生成 `AMSG_MASTER_KEY`：
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. 部署：`wrangler deploy`

## 端点

`/get-user-key`、`/schedule-message`、`/messages`、`/update-message`、`/cancel-message`、`/init-tenant`。
**没有 HTTP `/send-notifications`**——定时投递由 CF Cron Trigger 直接触发 `scheduled()`。

VAPID 和 webpush 都要配齐：定时投递（cron）和 `instant` 类型消息都靠它推送，缺了就发不出去。

## 导入入口

Worker 从 `@rei-standard/amsg-server/cloudflare` 导入（不是包根）。这个子路径只含单用户 + D1 + Web Crypto 推送那条路径，不牵扯 pg / neon / web-push，所以只装了 D1 的环境也能打包通过。

## 客户端

`@rei-standard/amsg-client` 配 `baseUrl` 指向本 Worker；若设了 `AMSG_SERVER_TOKEN`，client 也要配同样的 `serverToken`。
