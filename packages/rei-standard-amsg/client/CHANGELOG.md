# Changelog — @rei-standard/amsg-client

## 2.6.0 — `deliver()` 新增 `onRawRead` 原始读遥测钩子

给 `deliver()` 加一个**可选**的 `onRawRead` 钩子，专供排查 SSE 链路用。SSE transport 每次 `reader.read()` 后回调，把原始字节信息交给调用方，便于回答「连接静默期里到底有没有字节真的到达客户端」这类问题。

不传 = 行为完全不变；SSE 解析逻辑（含 `:` 注释行的处理）一字未动。

### New

- 新增 `deliver()` 选项 `onRawRead(meta)`：SSE transport 每次 `reader.read()` 之后触发，`meta` 含 `ts` / `byteLength` / `done` / `textPreview`（本次数据解码后的前 120 字符，**保留 `:` 注释行**，能看到平时被解析层跳过的 keepalive 帧）；首帧额外带 `status` / `contentEncoding` / `contentType` 三个响应元信息。
- 钩子抛错被吞，不影响送达主流程；`textPreview` 用独立 decoder 取样，不干扰流式解析。

## 2.5.0 — `deliver()` 平台无关送达 primitive

把"发出去"和"业务上是否真送达"在 API 层显式分开。新增 `client.deliver()` 作为新代码的首选入口；老的 `sendInstant()` / `consumeInstantStream()` 仍可用但降级为低级 transport，配 opt-in dev warning 引导迁移。SSE 与 JSON 两条 transport 一并升级到统一的送达协调层，调用方无需感知。

`2.5.0-next.0` 先发在 `next` dist-tag 跑了一轮 SullyOS 等接入方的端到端验证（iOS PWA / SW 双通道实战），无回归后 graduate 到 `latest`。

### New

- 新增 `client.deliver(payload, opts)`：单一入口，根据响应 `Content-Type` 自动选 SSE 或 JSON transport，与 caller 提供的「观察通道 `Promise<ObservedDeliveryReceipt>`」做 race + grace，返回 `DeliveryResult` 含五值 `outcome`（`delivered` / `cancelled` / `timeout` / `send-failed` / `completed-unconfirmed`）。
- 观察通道是 **平台无关 Promise**：库不绑 Service Worker / IndexedDB / Web Push / 任何具体后端，调用方自己把 SW 广播、IPC、原生桥、轮询、自定义通道包成 Promise 即可。
- `delivery` 用 discriminated union 显式声明 `mode: 'observed' | 'transport-only'`，不允许「传永不 resolve 的 Promise 假装在 observed 模式」的写法。
- `outcome:'delivered'` 仅 observed 模式可达，且必须 receipt identity 校验通过（receipt 至少含 `messageId` 或 `sessionId` 之一的非空字符串）；invalid receipt 视为「观察从未触发」继续 race，杜绝并发串单。
- `outcome:'cancelled'` 独立于 `timeout` / `send-failed`：caller `signal.abort()` 触发；但若 grace 内仍观察到 receipt，会改报 `delivered` + `detail.cancelledByCaller: true`（iOS 切回前台后 push 仍接力的实战场景）。
- `outcome:'timeout'` 在 observed 模式 + transport 干净结束 + observation 未接力 时，额外带 `detail.observationChannelStalled: true`——观察通道挂了不等于发送失败。
- `outcome:'send-failed'` 仅在 transport 有 captured error **且** 观察通道也没接力时触发。
- `outcome:'completed-unconfirmed'` 仅 transport-only 模式专用，明确标注「best-effort 乐观，无真相信号」。
- Pre-flight `signal.aborted` 检查：进入时若已 aborted，直接返回 `cancelled`，不下发 fetch。
- `postTransportGraceMs` 默认 = `min(remainingBudget, max(5000, timeoutMs * 0.1))`：5s 下限 + 10% 比例，跨 30s / 300s / 多分钟 timeout 都有合理 grace。
- `onChunk`（可选 SSE 每帧 UI 钩子）抛错被捕获进 `detail.chunkHandlerError`，**不**升级 outcome 到 `send-failed`——UI 钩子失败是 caller-bug-shaped。

### Soft-deprecated（仍可用，文档与 warning 引导迁移）

- `sendInstant()` JSDoc 改标 **Low-level JSON dispatcher**，提示 「HTTP 200 ≠ delivery confirmation」当 backup push 开启时。
- `consumeInstantStream()` JSDoc 改标 **Low-level SSE consumer**，提示 「rejection ≠ delivery failure」当 backup push 开启时。
- 两者新增可选 `opts.expectsBackupPush`：
  - `true` → 实例 + 方法首次调用时 `console.warn` 一次（migration 审计用）
  - `false` → 显式表示「我知道这点」永久静音
  - 不传 → 不警告
- 没有立刻 `@deprecated`，留两个 minor 缓冲到 3.0.0。

### 内部重构（行为字节不变）

- 抽取私有 `_buildInstantRequest` / `_runInstantTransport` / `_consumeSseStream`，`sendInstant` / `consumeInstantStream` / `deliver` 三条路径共用。
- SSE 解析逻辑与 2.4.0 byte-identical（多行 `data:` 用 `\n` 拼接、`event: done` 优先、EOF 视为 done、`event: error` 解 JSON 抛带 `code` 的 Error）。

### Migration

| 旧写法 | 新写法 |
| --- | --- |
| `try { await consumeInstantStream(p, '/instant', { onPayload }) } catch { fail() }` | `const r = await deliver(p, { delivery: { mode: 'observed', observed }, timeoutMs, onChunk: onPayload }); if (r.outcome !== 'delivered') ...` |
| `const r = await sendInstant(p); if (!r.success) fail()` | `const r = await deliver(p, { delivery: { mode: 'observed', observed }, timeoutMs }); if (r.outcome === 'send-failed') ...` |
| `sendInstant(p, '/instant', { authorization: 'Bearer ...' })` | `deliver(p, { delivery, timeoutMs, authorization: 'Bearer ...' })` |

详见 README 的 `deliver()` 标准用法与「为什么需要 `deliver()`」段。

### 发布前 review 期修复（折叠进 2.5.0）

Self-review 时（仿 ultrareview 多角度分派）抓到的 correctness 修复，均不破前面任何 API：

- **SSE 帧分隔**：原 `buffer.split('\n\n')` 在 CRLF 服务端（.NET / IIS / 某些 CDN）下永远拼不到分隔符，全流静默丢。改成先 `\r\n?` → `\n` 整 buffer 归一化再 split，覆盖 `\r\n\r\n` / `\n\n` / `\r\r` 与跨 chunk seam 的混合行尾。
- **SSE EOF flush**：流结束时漏 `decoder.decode()` 收尾 + 漏处理无尾随空行的最后一帧。两处都补上，避免跨 chunk 的 UTF-8 多字节字符丢字节、最后一帧静默丢。
- **本地校验错误不再被埋**：`PAYLOAD_TOO_LARGE_LOCAL` / 加密未初始化等本地错误现在直接从 `deliver()` 抛出，不再被吞进 IIFE 变成 `outcome:'send-failed'` + `detail.transportError`。请求构造提前到 race 启动之前。
- **post-return 写穿防护**：observed 模式赢 race 后，仍在跑的 transport IIFE 不再有机会改 caller 已持有的 `detail`（`finalized` 闸口同步关）。
- **caller signal listener 卸载**：每个终态都会 removeEventListener，长生命周期 `AbortController` 跨 N 次调用不再累积 2N 个 stale 闭包。
- **abort 微任务窗口竞态**：pre-flight 与 listener 注册之间窗口内 abort 触发时，新注册的 listener 不会 fire（DOM spec），现在 addEventListener 后会再查一次 `signal.aborted` 并补触发。
- **transport-only + cancel 不再 linger**：`mode: 'transport-only'` 下 caller abort 之后直接返回，不再死等 grace/2 拿一个永远不会到的 observation。
- **`deliver()` 接受 `opts.authorization`**：从 `sendInstant({authorization})` 迁过来时不会再静默丢 header。
- **结构化 JSON Content-Type**：`application/problem+json` / `application/vnd.api+json` 这类 structured-suffix variant 现在被识别为 JSON。
- **JSDoc 写明 cancel grace `/2`**：`postTransportGraceMs` 注释明确 cancel 路径生效的是 `grace/2`（一半留给清理）。

依赖与外部接口零变更；以上全部在 `client` 包内部完成，并加了 9 条 regression 测试覆盖。

### Codex review 后追加的修复（同样折叠进 2.5.0）

走完一轮 9-angle self-review 之后，又请 Codex 独立读了一遍 working tree，抓到 7 个我漏的：

- **transport-only 模式 transport 结束后仍然等 grace**：之前只 fix 了 cancel 路径，post-transport-ended 路径还在白等（`timeoutMs: 60_000` 默认会多卡 ~5s）。observed mode 才有观察通道值得等，transport-only 直接按 transport 结果出 outcome。
- **abort 期间 `_buildInstantRequest` 仍可能发 fetch**：pre-flight 只查了一次，但 build 是 async（加密走 Web Crypto 会 await），signal 在 build 中途 abort 会被吞，仍走 fetch。现在 build 完成后再查一次 `signal.aborted`，aborted 就直接返回 cancelled 不下发请求。
- **post-transport grace 期间 abort 被忽略**：transport 先结束后，late-receipt 等待只 race `validatedObserved` + 自己的 timer，没 race `cancelledP`。caller 在 grace 期间 abort 会被错报成 timeout / send-failed。现在 grace 等待跟 cancel signal 一起 race，abort 赢就报 cancelled。
- **SSE CRLF 跨 chunk seam 仍然破**：第一轮修了 `\r\n\r\n` 的统一归一化，但当真实 CRLF 正好被分到两个 chunk（chunk1 末尾 `\r`、chunk2 开头 `\n`），原 normalize 会把 chunk1 的 trailing `\r` 提前变成 `\n`，再跟下一个 chunk 拼成 `\n\n` 误判帧边界。修：把 trailing `\r` 留到下一 chunk 再统一归一化。
- **`onChunk` 抛错跨 deliver-return mutate detail**：上轮防了 transport IIFE 的 `detail.transportResponse` 写穿，但 `wrappedOnChunk` 的 catch 仍直接写 `detail.chunkHandlerError`，observed 赢 race 返回后 onChunk 延迟 throw 仍能改 caller 持有的 detail。现在 `chunkHandlerError` 写入也 gate 在 `finalized`。
- **Content-Type 用 substring 不是 media-type 解析**：`application/json; note=text/event-stream` 这种参数里带其他媒体类型的会被错认。改成严格 media-type 解析：先用 `;` 切参数、trim、lowercase，再 exact match + structured-suffix 正则。`consumeInstantStream` 的 SSE 检查也一并改成走 `classifyContentType`。
- **`NEVER_SETTLES` 共享 sentinel 累积 Promise reactions**：`Promise.race` 每次都给那个全局永不 settle 的 Promise 挂 reaction，长生命周期页面会持续累积。改成条件式构造 race 数组——transport-only 不参 observed/`validatedObserved`，无 signal 不参 cancelledP，整个 `NEVER_SETTLES` 常量直接删掉。

测试集相应扩到 55 条，覆盖以上每个修复 + transport-only 短路 + 跨 chunk seam 的真 CRLF 场景；之前自己写的 5 条直接动 `globalThis.fetch` 的测试也改成走 `installFetch()` restore 模式，避免污染更大 suite。

### 正式版补丁（折叠进 2.5.0）

- **`sendInstant()` 显式带 `Accept: application/json`**：默认 `Accept: */*` 会落到 amsg-instant 的 SSE 分支，随后的 `res.json()` 在 SSE 字节流上抛 SyntaxError。`sendInstant()` 是声明回 JSON 的入口，header 一并钉死。
- **`expectsBackupPush` 文档与代码对齐**：JSDoc 与 warn 文案此前宣称 "Pass `expectsBackupPush: false` to silence"，实际 `false`、不传都是静默，`true` 才会触发一次性 warn。文案改成 opt-in dev reminder，默认静默，不再误导调用方。
- **去掉 `_urlBase64ToUint8Array`**：与 `@rei-standard/amsg-shared` 的 `base64UrlToBytes` 逐字节重复（已有 `atob` + Node `Buffer` 双兜底），改 import shared 版本。
- **模块级 `TEXT_ENCODER`**：`_encrypt` 与 `_assertPayloadSize` 此前每次都 `new TextEncoder()`。`TextEncoder` 是无状态的，提到 module top 复用，跟 instant / sw 对齐。

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
