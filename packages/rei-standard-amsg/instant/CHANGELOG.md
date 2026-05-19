# Changelog — @rei-standard/amsg-instant

## Unreleased

**Fix**

- **`/continue` 无 `onLLMOutput` 时给出清晰的 400 `CONTINUE_NOT_AVAILABLE`**：之前往一个没配 hook 的 handler POST `/continue` 会过 validation、进 `runAgenticLoop`、然后在 `ctx.onLLMOutput(...)` 上炸 TypeError、最终被当成 `HOOK_THREW` 报给客户端 + 推一条诊断 envelope。问题是「没钩子」是部署配置问题，不是钩子抛错，HOOK_THREW 把锅甩到了不存在的钩子上。现在在 handler 入口处直接拒，错误码明确指向缺 `onLLMOutput`。

## 0.7.0 — 2026-05-19 — Agentic Loop Framework

**New**

- **`onLLMOutput` hook**: caller controls per-turn decision. Hook returns one of `{ decision: 'finish' | 'tool-request' | 'continue' | 'skip-push' }`. When the hook is provided, the handler switches to a per-turn agentic loop; when omitted, the handler runs the legacy v0.6 one-shot path **byte-for-byte unchanged**. The two paths are independent and do not share schema.
- **`/continue` endpoint** (hardcoded path) for tool-call resumption. Reuses `/instant`'s full auth chain (Bearer JWT + clientToken, in the same order). Worker stays stateless; the caller persists session state on its end.
- **Custom push payload schema** via the hook's return value. `buildInstantPushPayload` is now exported as a public helper for callers who want the v0.6 13-field shape inside their own hook.
- **Optional `blobStore` config** with a `BlobStoreAdapter` interface (`put` + non-destructive `read`). Six built-in adapters covering the major serverless / Node deployment targets, picked by the platform's native storage so callers don't need a custom adapter for typical setups:
  - **Cloudflare**: `.../blob/d1`, `.../blob/kv`
  - **Vercel / any serverless** (Upstash Redis, also covers Vercel KV which is Upstash under the hood): `.../blob/upstash`
  - **Netlify** (Netlify Blobs; no native TTL, adapter wraps body with embedded `expiresAt`): `.../blob/netlify`
  - **Postgres** (Neon / Supabase / Vercel Postgres / self-hosted via `pg`-compatible client): `.../blob/postgres`
  - **Memory** (long-lived Node only — Memory adapter is unsafe on isolate-based serverless): `.../blob/memory`
  - Arbitrary backends (DynamoDB / Cassandra / …) still plug in with a ~30-line custom adapter implementing the same two methods — templates in `examples/custom-blob-store/`.
- **`/blob/:key` GET endpoint** (hardcoded path; UUID-v4 protected; non-destructive multi-read within TTL; no auth header required so SW can fetch). Response carries `Access-Control-Allow-Origin: *` so cross-origin SW fetches can read the body. Envelope carries an absolute `url` field derived from the inbound `request.url`, so SW doesn't need a separate endpoint config.
- **`maxLoopIterations` guardrail** (default 10). Guards in-loop runaway within a single worker invocation. On overflow: emits `loop_exceeded`, pushes a diagnostic envelope, returns HTTP **200** with `{ status: 'loop_exceeded', ... }` (not 5xx — the worker has fulfilled its "deliver a diagnostic" contract).
- **New event taxonomy** — single-level type-named discriminator (no `error+code` nesting). Three semantic tiers:
  - **progress**: `llm_start`, `llm_done`, `final_pushed`, `tool_request_pushed`, `continue_received`, `blob_written`
  - **soft failure**: `blob_put_failed`, `blob_orphaned`, `diagnostic_push_failed`, `payload_too_large`
  - **hard error**: `hook_threw`, `loop_exceeded`, `llm_call_failed`
- **Named Error classes**: `HookError` (`.code='HOOK_THREW'`), `PayloadTooLargeError` (`.code='PAYLOAD_TOO_LARGE'`), `LlmCallError` (`.code='LLM_CALL_FAILED'`), `MemoryStoreFullError` (`.code='MEMORY_STORE_FULL'`). Callers can `instanceof`-dispatch instead of string-comparing `.code`. Three-tier naming is consistent: `hook_threw` (event) ↔ `HOOK_THREW` (push code / `.code`) ↔ `HookError` (class) ↔ `{ error: 'hook_threw' }` (HTTP body), so log search / Sentry grouping needs no mental translation.

**Changed**

- `processInstantMessage` now **branches at entry**: no `onLLMOutput` → legacy v0.6 path (byte-identical to v0.6); with `onLLMOutput` → multi-turn agentic loop. The two paths are independent.
- Default `maxInlineBytes` for the blob envelope detour is **2600 B**. Comparison uses **UTF-8 byte length** (via `TextEncoder`), not JS string `.length` — CJK content would otherwise bypass the limit and trip push-service 413. The 2600 default leaves ~220 B margin under `web-push-php`'s cross-service compatibility default of 2820 B.
- Hook path appends `choices[0].message` whole object to history (preserves `tool_calls` / `reasoning_content` / `refusal`). Legacy path unchanged.
- `validateInstantPayload` now takes an optional `{ hookPath, maxLoopIterations }` second argument. When `hookPath: true` it rejects `completePrompt` with `400 COMPLETE_PROMPT_NOT_SUPPORTED_ON_HOOK_PATH`.
- `splitPattern` config remains effective on the legacy path; on the hook path it is **silently ignored** and the handler emits a one-shot `console.warn` at construction time.

**Backwards compatibility**

- **Zero breaking changes.** All v0.6 callers (no `onLLMOutput` configured) keep their byte-for-byte legacy behaviour — same 13-field default payload, same `1500 ms` sentence spacing, same `splitPattern` semantics, same `onEvent` shape for legacy events.
- New events and the `/continue` + `/blob/:key` endpoints only activate when the relevant options are set. A subpath-mount caveat applies to deployers wanting to mount the handler under e.g. `/amsg/*` — see README §Subpath mount.

## 0.6.1 — 2026-05-18

**Fix**

- **`avatarUrl` 严格校验**：之前 `avatarUrl` 只检 `new URL(...)` 能不能 parse，导致 `data:image/...;base64,xxx` 这种 base64 内嵌头像也算合法 —— 一旦传进来，整个 push payload 会膨胀到几十 KB，触发下游 Web Push 服务的 4KB 硬上限或网关 `413 Payload Too Large`。现在：
  - 拒 `data:` 开头的 URI（不区分大小写）→ `400 INVALID_PAYLOAD_FORMAT`，错误信息明示「头像不支持传入 data: URI（base64 内嵌图片会触发 413 / Web Push 4KB 上限），请改为公网可访问的 https:// 图片 URL」。
  - 拒长度 > 2048 字符的 URL → `400`，错误信息明示实际长度 + 上限 + 建议（CDN 缩略图）。
  - 仍要求 `new URL(...)` 能 parse。
  - `undefined` / `null` 仍然视为「未传」，零行为变化。
- 顶层 export `validateAvatarUrl(value)`：业务可在 SDK 之外做同步预校验，避免一次远端往返。

**Compatibility**

- 0.6.0 调用者**几乎零修改**：除非之前真的在传 `data:` URI 当 avatarUrl（那本来就跑不通推送），否则升级无感。错误码 `INVALID_PAYLOAD_FORMAT` 不变。

## 0.6.0 — 2026-05-18

**New**

- **`splitPattern` 自定义分句正则**：payload 新增可选 `splitPattern` 字段，类型 `string | string[]`。LLM 返回的整段文本将按此正则切成多条 Web Push 推送（默认 `/([。！？!?]+)/`）。
  - `string` → 单个正则 source（不带 flags），用 `new RegExp(splitPattern)` 编译后替代默认正则。
  - `string[]` → **级联**应用：第一个正则切完，每段再用第二个切，以此类推。适合分层切分（先按段落 `(\n\n+)`、再按句号 `([。！？!?]+)`）。需要 "任一匹配就切" 的语义，调用方自己用 `|` 合成一条正则即可。
  - 不传 / `null` / `undefined` / `[]` → 走默认正则，行为字节级不变。
  - **捕获组约定**：想让分隔符回贴到前一段（与默认行为一致），把分隔符放进 `(...)` 捕获组。库不自动包裹。
  - **限制**：每项 ≤ 200 字符，数组 ≤ 10 项，每项必须能 `new RegExp(...)` 通过。违规 → `400 INVALID_PAYLOAD_FORMAT`。
  - 校验失败的错误信息会精确到出错的索引（如 `splitPattern[2] 不是有效正则表达式`）。

**Compatibility**

- 0.5.x 调用者**零修改**继续工作。push payload、subscription、VAPID、错误码全部不动。0.5.x 直接升级即可。

## 0.5.0 — 2026-05-17

**New**

- **`messages` 数组转发**：payload 新增可选 `messages` 字段，与 `completePrompt` 二选一互斥。上游应用直接把标准 OpenAI 格式的 `[{role:'system',...}, {role:'user',...}, {role:'assistant',...}, ...]` 透传过来，handler **原样**转给 LLM —— 不再被强行压成单个 user 消息。让 instant-push 路径和主聊天路径的 LLM 调用完全等价（system role、多轮历史、tool role 全保留）。
  - `content` 支持 `string` 或非空数组（多模态留口子，元素 schema 不深挖）。
  - role 限定 `system | user | assistant | tool`，违规 → `400 INVALID_PAYLOAD_FORMAT`。
  - 两者同时给、两者都不给、`messages` 为空数组、role 非法 → 全部 `400`，错误信息明示 "exactly one of `completePrompt` or `messages` must be provided"。
- **`temperature` 字段**：可选 number，会透传给 LLM。legacy `completePrompt` 路径无 temperature 时仍默认 0.8（保持旧行为）；`messages` 路径无 temperature 时**不发**，跟上游主路径完全一致。
- LLM 请求 body 现在恒含 `stream: false`（instant 路径按契约非流式）。

**Compatibility**

- 旧 `completePrompt` 调用者**零修改**继续工作。push payload、subscription、VAPID key、错误码全部不动。0.4.x 直接升级即可。

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
