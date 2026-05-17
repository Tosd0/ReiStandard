# Changelog — @rei-standard/amsg-client

## 2.2.1 — 2026-05-17

### Docs

- README 加 `messages` 模式示例，配合 `@rei-standard/amsg-instant@0.5.0+` / `@rei-standard/amsg-server@2.2.0+` 的 OpenAI 格式 messages 数组转发。client 是 payload-agnostic 透传（`JSON.stringify(payload)`），所以**无代码改动**，只更新文档说明。

## 2.2.0 — 2026-05-16

### Added

- 构造选项 `instantEncryption` (boolean, default `true`) 与 `instantClientToken` (string, optional)。
- `instantEncryption: false` 时 `sendInstant()` 直接 POST 明文 JSON，配套 `@rei-standard/amsg-instant@0.2.0`。`init()` 在该模式下变 no-op。
- 明文模式下构造时可省略 `userId`（默认加密模式仍强制要求）。
- 明文模式下若配 `instantClientToken`，请求会带 `X-Client-Token` 头（弱鉴权 —— token 随 bundle 走前端，devtools 一开就能看到，只防 URL 直怼）。

### Unchanged

- 默认 `instantEncryption: true`，行为与 2.1.0 完全一致（兼容 amsg-instant 0.1.x 与 amsg-server `schedule-message` 路径）。
- `scheduleMessage` / `listMessages` / `updateMessage` / `cancelMessage` / `subscribePush` 仍走加密路径，不受新选项影响。
- 加密模式下 `init()` 行为完全不变。

## 2.1.0 — 2026-05-16

### Added

- `client.sendInstant(payload, endpointPath?, opts?)` — sends a one-shot instant message via `@rei-standard/amsg-instant`. Uses the same `userKey` fetched by `init()`, the same AES-256-GCM envelope, and the same `X-User-Id` / `X-Payload-Encrypted` / `X-Encryption-Version` headers as `scheduleMessage`. Accepts an optional `Authorization` header passthrough for deployments that enable amsg-instant's `tokenSigningKey`.
- New constructor option `customBaseUrls` — a per-endpoint base URL override map (key = endpoint name, e.g. `instant`). Falls back to `baseUrl` when an endpoint name is not present. Set this when an endpoint is deployed separately (e.g. `instant` on Cloudflare Workers while the rest run on Netlify). This is a general mechanism — future endpoints can be overridden with the same field instead of adding more `*BaseUrl` constructor options.

### Deprecated (soft)

- `client.scheduleMessage({ messageType: 'instant', ... })` — still works for backward compatibility (it routes through amsg-server's `/schedule-message` endpoint, which creates a task → processes → deletes the task in one round-trip). New code should prefer `sendInstant()` which skips the DB round-trip entirely.

## 2.0.1

(See git history.)
