# Changelog — @rei-standard/amsg-client

## 2.4.0 — `consumeInstantStream()` SSE consumer

配套 `@rei-standard/amsg-instant@0.9.0` 的 SSE 默认模式；同时移除 client 默认请求体大小上限，避免本地误拦长上下文请求。

### New

- 新增 `consumeInstantStream(payload, endpointPath?, options)`，按 SSE frame 解析 `event: payload` / `event: error` / `event: done`，并分发到 `options.onPayload`。
- 新增构造器选项 `maxPayloadBytes?: number | null`。默认 `null`，不再由 client 对请求体大小做本地限制；显式配置后，超限请求仍抛 `PAYLOAD_TOO_LARGE_LOCAL`。
- `@rei-standard/amsg-shared` 精确依赖升级到 `0.2.0`，同步 `notification.silent` 类型/校验能力。

### Changed

- 移除默认请求体大小上限。Web Push 单条回复超限仍由 `amsg-instant` 的 BlobStore / multipart 输出链路处理；client 只保留 `avatarUrl` 软清空，避免 data URI 头像把最终 push 撑爆。

### Docs

- `consumeInstantStream` 章节校正：原文写 "SSE 写失败 / 断开才 fallback push"，但 `amsg-instant 0.9.0` 起 Web Push backup 是 **always-on**——SSE 成功 enqueue 也照样发一份同 `messageId` 的 backup，由 SW / client dedupe 收敛。README 改成 "SSE 直送 + Web Push always-on backup + dedupe" 的双路语义；"fallback" 在文档里收窄回它本来该指代的含义（stream 不可用 / enqueue 抛错时的兜底）。仅文档，行为不变。

## 2.4.0-next.0 — `consumeInstantStream()` SSE consumer (pre-release)

发布在 `next` dist-tag。配套 `@rei-standard/amsg-instant@0.9.0-next.0+` 的 SSE 默认模式；老的 `sendInstant()` 字节级不变。

### 新增 `consumeInstantStream(payload, endpointPath?, options)`

POST 到 amsg-instant 的 `/instant` 或 `/continue` 端点，按 SSE frame 解析 `event: payload` / `event: error` / `event: done`，分发到 `options.onPayload` 回调；可被 `options.signal` 中止。

```js
await client.consumeInstantStream(payload, '/instant', {
  onPayload: async (p) => routeToIDB(p),     // 必填
  onError:   (err) => log(err),              // 可选；通知用，不抑制 throw
  onDone:    () => stopSpinner(),            // 可选
  signal:    abortController.signal,         // 可选
});
```

错误语义：网络 / 协议 / abort / `onPayload` 抛错都会让返回的 Promise reject。`onError` 是**通知性 side-channel**（fire 后照常 throw），不是 try/catch 替代——总是 `await` + 外层 `try/catch` 处理。

加密 / 明文两种 transport 共享构造器配置（`instantEncryption` / `instantClientToken`），用法和 `sendInstant` 一致。请求体跟 `sendInstant` 完全一样——包括必须的 `pushSubscription`（SSE 写失败时框架会用它做 fallback push）。

### Spec 细节

- 多行 `data:` 按 SSE 规范用 `\n` 拼接（不是后写覆盖）
- 非 2xx / 非 `text/event-stream` 响应立即 throw，不进 parser
- 出错时 `reader.cancel(err)` 关闭底层连接，避免 fetch stream 残留至 GC
- AbortError 与其他错误一视同仁走 reject——caller 用 `signal` 主动取消时也能拿到 rejection

## 2.3.0 — Dependency bump

- 依赖更新：同步升级 `@rei-standard/amsg-shared` 至稳定版 `0.1.0`。

## 2.3.0-next.1 — avatarUrl 本地软清空 (pre-release)

Cherry-pick stable `2.2.4` 的本地 `avatarUrl` 软清空到 next 预发布线。`scheduleMessage` / `sendInstant` / `updateMessage` 不合法的 `avatarUrl`（`data:` URI / 长度 > 2048 / 非字符串）改为 `console.warn` + 在 payload 上置 `null`（`updateMessage` 路径走 `delete` 以保留服务端原头像），请求继续发送。`Error.code === 'INVALID_AVATAR_URL_LOCAL'` 已移除；当时版本的本地请求体体积预检保留不变，稳定版 2.4.0 已改为可选 `maxPayloadBytes` 且默认不限制。详见 `2.2.4` stable 条目；与 `@rei-standard/amsg-server` 2.4.0-next.1 / `@rei-standard/amsg-instant` 0.8.0-next.1 / `@rei-standard/amsg-sw` 2.1.0-next.1（SW 标题 fallback 至 `来自 {contactName}`）同步。

`next.0` → `next.1` 行为变化只此一项；shared push types re-exports 部分**完全不动**。

## 2.3.0-next.0 — Shared push types re-exports (pre-release)

Published under the `next` dist-tag (repo convention for prereleases). Coordinated with the other amsg sub-packages' `*-next.0` releases. Install with `npm install @rei-standard/amsg-client@next`. Schema is locked; the next-tag window is for downstream integrators to validate end-to-end before this graduates to `latest`.

---

Coordinated minor across the whole amsg ecosystem (shared 0.1.0 / instant 0.7.0 / server 2.3.2 / sw 2.x). The client itself does not send or receive pushes — it only talks to amsg-server / amsg-instant over HTTP — but caller apps that build the client and also handle pushes (typically in a Service Worker) used to need a second dependency on `@rei-standard/amsg-shared` to get the canonical kind/type/source constants, builders, and type guards. 2.3.0 collapses that into a single import surface.

### New

- Re-exports from `@rei-standard/amsg-shared` 0.1.0:
  - **Runtime constants**: `MESSAGE_KIND` (`CONTENT` / `REASONING` / `TOOL_REQUEST` / `ERROR`), `MESSAGE_TYPE` (`INSTANT` / `FIXED` / `PROMPTED` / `AUTO`), `PUSH_SOURCE` (`INSTANT` / `SCHEDULED`).
  - **Builders**: `buildContentPush`, `buildReasoningPush`, `buildToolRequestPush`, `buildErrorPush`.
  - **Type guards**: `isContentPush`, `isReasoningPush`, `isToolRequestPush`, `isErrorPush`.
  - **JSDoc type aliases**: `MessageKind`, `MessageType`, `PushSource`, `AmsgPush`, `ContentPush`, `ReasoningPush`, `ToolRequestPush`, `ErrorPush`.

One import surface — caller apps that consume `ReiClient` and also handle pushes (e.g. in a Service Worker) no longer need a separate dep on `@rei-standard/amsg-shared`. Everything is reachable from `@rei-standard/amsg-client`.

### Compatibility

- Zero runtime behavior change. `ReiClient` API is byte-for-byte unchanged — no method signatures, request shapes, or error codes were touched.
- The re-exports are tree-shake-friendly (shared package is `sideEffects: false`). Bundlers that ship `ReiClient` only will not pull in the builders.

### Dependencies

- Adds `@rei-standard/amsg-shared` at exact `0.1.0` (no caret). Part of the coordinated minor; pinned so a future shared minor cannot silently slip in via `npm install` without a matching client release.

### Migration

- No caller-side action needed. Strictly additive.
- Apps that already depend on `@rei-standard/amsg-shared` directly can keep that dep or drop it in favor of importing from `@rei-standard/amsg-client` — both routes resolve to the same module instance because npm dedupes the exact-pinned `0.1.0`.

## 2.2.3 — 2026-05-18

### Fix

- **本地预校验 `avatarUrl` + payload 体积**（配合 [`@rei-standard/amsg-instant` 0.6.1](../instant/CHANGELOG.md#061--2026-05-18) / [`@rei-standard/amsg-server` 2.3.1](../server/CHANGELOG.md#231--2026-05-18)）：之前 `scheduleMessage` / `sendInstant` / `updateMessage` 是纯 payload-agnostic 透传，业务把 `data:image/...;base64,xxx` 当 `avatarUrl` 传进来，client 会先 AES-GCM 加密、再 POST 出去，绕一圈才在远端拿到 `413` 或 Web Push 4KB 上限报错。当时三个方法在发请求之前做两项本地预检；稳定版 2.4.0 已把请求体体积预检改为可选 `maxPayloadBytes`，默认不限制：
  - **avatarUrl**：拒 `data:` URI、拒长度 > 2048 字符、必须是字符串。违规 → 抛 `Error` with `.code === 'INVALID_AVATAR_URL_LOCAL'`。
  - **payload 体积**：超过当时内置本地阈值会抛 `Error` with `.code === 'PAYLOAD_TOO_LARGE_LOCAL'`，附 `.details = { actualBytes, limitBytes, method }`。此固定阈值在 2.4.0 起不再默认启用。
- 两个 code 都带 `LOCAL` 后缀，方便业务和远端返回的 `INVALID_PARAMETERS` / `INVALID_PAYLOAD_FORMAT` 区分（一个不耗远端配额，一个耗）。
- 错误 message 只写「是什么 + 怎么改」（如「头像不支持传入 data: URI，请改为公网可访问的 https:// 图片 URL」），不写「为什么」—— 触发原因写在本 CHANGELOG / README，避免错误对话框塞一整段背景说明。

### Compatibility

- 业务**几乎零修改**：除非之前真的在传 `data:` URI 当 avatarUrl，或命中了当时版本的固定本地体积预检，否则升级无感。
- 加密格式、headers、endpoint、响应 schema 全部不动。
- `scheduleMessage` / `sendInstant` / `updateMessage` 的返回类型不变；新增的两类错误**只在抛出时**才出现。

## 2.2.2 — 2026-05-18

### Docs

- README 加 `splitPattern` 字段说明，配合 `@rei-standard/amsg-instant@0.6.0+` / `@rei-standard/amsg-server@2.3.0+` 自定义分句正则。client 是 payload-agnostic 透传（`JSON.stringify(payload)`），所以**无代码改动**——业务直接把 `splitPattern: string | string[]` 放进 `sendInstant` / `scheduleMessage` 的 payload，Worker / Server 端会自己校验和应用。

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
