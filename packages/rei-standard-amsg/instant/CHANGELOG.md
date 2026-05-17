# Changelog — @rei-standard/amsg-instant

## 0.4.0 — 2026-05-17

**New**

- **CORS 内置**：handler 在入口处短路 `OPTIONS` 预检请求 → `204 No Content`，所有响应（含 200 / 4xx / 5xx）自动叠 `Access-Control-Allow-Origin / -Methods / -Headers` + `Access-Control-Max-Age: 86400`。浏览器跨域调用零配置 work。
- `options.cors?: { allowOrigin?: string }`：自定义允许来源，默认 `'*'`。配成具体来源时自动附 `Vary: Origin`，避免反向代理缓存把 CORS policy 串到错的站点。
- **`normalizeAiApiUrl(apiUrl)`** 智能补全 OpenAI 兼容路径，**幂等**（跑两次 = 跑一次）：
  - 裸 host（如 `https://api.openai.com`）→ 补 `/v1/chat/completions`
  - 末尾是 `/v1` 或 `/v2` 等版本段 → 只补 `/chat/completions`，**不会重复加 v1**
  - 已含 `/chat/completions` → 原样返回
  - 其他自定义路径（如 Anthropic 的 `/v1/messages`）→ 不动，尊重 caller 的路由

  老调用者传完整 `…/v1/chat/completions` 仍然工作。函数也作为顶层 export 暴露，方便业务在前端做一致的预校验。

**Improvements**

- 验证函数（Bearer / clientToken）的所有 401/4xx 响应现在也带 CORS headers，让浏览器能正常读到 `body.error.code` 而不是 fail 在 CORS 检查上。

**Compatibility**

- 协议字段零变更；推送 payload、subscription、VAPID key 全部不动。0.3.x 直接升级即可。

## 0.3.0 — 2026-05-17

**BREAKING**

- 砍掉 `web-push` 依赖：自实现 RFC 8291 `aes128gcm` payload 加密 + RFC 8292 VAPID JWT。包不再有任何 runtime dependency。
- core 全部改用 Web Crypto API（`globalThis.crypto.subtle`），源码不再 `import 'crypto'` / `'node:crypto'`。
- `options.webpush`（之前用于注入 web-push mock）**deprecated**：参数保留兼容、运行时 `console.warn` 一次后忽略。测试改用 `options.fetch` 拦截 push endpoint 的 POST。
- `processInstantMessage(payload, ctx)` 不再读 `ctx.webpush`；改读 `ctx.vapid`（必填）。如直接调用此底层 API 请同步更新。

**New**

- 新增导出 `sendWebPush({ subscription, payload, vapid, ttl?, fetch? })`：纯 Web Crypto 实现，可单独使用。
- 新增导出 `buildVapidJwt(...)` / `verifyVapidJwt(jwt, publicKey)`：方便自定义鉴权/审计。
- 新增导出 `buildInstantPushPayload({...})`：测试可直接验证 SW 端 payload 形状，无需解密。

**Improvements**

- **Cloudflare Workers 部署不再需要 `nodejs_compat` flag**，`compatibility_date` 也无强约束。贴代码 + 配两个 VAPID secret 即可。
- 原生支持 Vercel Edge / Netlify Edge / Deno / Bun。
- 依赖树彻底清空：`web-push` + 它的 5 个传递依赖（`asn1.js` / `http_ece` / `https-proxy-agent` / `jws` / `minimist`）全部消失，`npm install` 速度和锁文件复杂度显著下降。本包 bundle 略增 ~8 KB（自实现 RFC 8291 + 8292），但 install 期总下载量净减。
- Node 18 部署：`adapters/node` 启动时按需 `import('node:crypto').webcrypto` 兜底 `globalThis.crypto`，不需要 caller 改任何代码。

**Compatibility**

- Push 协议（RFC 8291 `aes128gcm` body + RFC 8292 VAPID header）与 `web-push` 字节级兼容，浏览器订阅、SW、`@rei-standard/amsg-sw` 全部零修改可继续工作。
- VAPID 公私钥格式保持 base64url（公钥 65 B 非压缩 P-256 点 / 私钥 32 B 标量），老订阅可继续用。
- `engines.node` 从 `>=20` 放宽到 `>=18`（adapter 自动 polyfill）。

## 0.2.0 — 2026-05-16

**BREAKING**

- Handler 协议改为**纯明文**。删除 `X-Payload-Encrypted` / `X-User-Id` / `X-Encryption-Version` 三个 header 校验，删除 AES-256-GCM 信封解密路径。请求 body 现在直接是 JSON payload。
- 删除 `options.masterKey`（不再需要派生用户密钥）。
- 主入口删除三个 export：`deriveUserEncryptionKey`、`decryptPayload`、`isValidUUIDv4`。
- 删除对应错误码：`ENCRYPTION_REQUIRED`、`USER_ID_REQUIRED`、`INVALID_USER_ID_FORMAT`、`UNSUPPORTED_ENCRYPTION_VERSION`、`DECRYPTION_FAILED`。
- 删除内部文件 `src/crypto.js`（包内不再 import `createDecipheriv`；保留 `createHmac` / `timingSafeEqual` 给 `tokenSigningKey` + 新 `clientToken` 用，保留 `randomUUID` 给 messageId 用）。

**New**

- `options.clientToken`：可选共享密钥，校验请求头 `X-Client-Token`。缺失或不匹配返回 `401 INVALID_CLIENT_TOKEN`。timing-safe 比对。
- 错误码 `INVALID_CLIENT_TOKEN`（401）。

**Rationale**

- 单租户自部署场景下应用层加密无实际收益：HTTPS 已加密传输；`apiKey` 由前端塞进 payload 必然要让 Worker 见到；攻击者拿 Worker URL 也榨不出 `apiKey` / 推不动别人的订阅。
- 移除加密后 Worker bundle 体积下降，部署门槛降低（不再需要 `masterKey` env），不再依赖 `amsg-server` 的 `/get-user-key` endpoint。
- 多租户 SaaS 场景请继续使用 `amsg-server` 的 `schedule-message` 加密路径。

**Migration**

- 配合 `@rei-standard/amsg-client@2.2.0+`，构造时传 `instantEncryption: false`。Worker 端把 `options.masterKey` 改成 `options.clientToken`（或都不配，裸跑）。

## 0.1.0 — 2026-05-16

Initial release.

### Added

- `createInstantHandler(options)` — stateless one-shot instant push handler. Lifecycle = single HTTP function call: decrypt → call LLM → split sentences → deliver Web Push → 200 OK. No DB, no cron, no tenant init.
- Adapters for Cloudflare Workers, Node/Express, Netlify Functions, and Vercel Functions (Edge & Node runtimes).
- `deriveUserEncryptionKey`, `decryptPayload`, `splitMessageIntoSentences`, `processInstantMessage`, `validateInstantPayload`, `isValidUUIDv4` exported for advanced users.
- Optional `tokenSigningKey` for HMAC-signed bearer authorization. When omitted, requests are accepted without auth (use this if you delegate auth to platform middleware like Cloudflare Access).
- Push payload field shape is byte-identical to `@rei-standard/amsg-server`'s scheduled/instant path — same SW build (`@rei-standard/amsg-sw`) handles both via the `source: 'instant' | 'scheduled'` discriminator.

### Compatibility

- Requires Node.js ≥ 20 (or Cloudflare Workers with `nodejs_compat` flag for the `crypto` import).
- `masterKey` must be 64-char hex (32 bytes of entropy). When used alongside `@rei-standard/amsg-server`, set this to the same value used by the corresponding amsg-server tenant so the `userKey` derived by `@rei-standard/amsg-client` works on both endpoints.
- Only `messageType: 'instant'` is supported. Sending `firstSendTime` or `recurrenceType` returns `INVALID_PAYLOAD_FORMAT`.
