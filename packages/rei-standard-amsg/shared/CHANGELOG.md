# @rei-standard/amsg-shared

## 0.1.0-next.3 — `notification` 字段 typed support (pre-release)

Coordinated with `@rei-standard/amsg-instant@0.8.0-next.3`. Install with `npm install @rei-standard/amsg-shared@next`. Wire format unchanged — additive typedef + new optional builder arg.

`notification` 字段一直被 `amsg-sw` 的 `createNotificationFromPayload` 当作 `showNotification` 渲染指令读取（`title` / `body` / `icon` / `badge` / `tag` / `renotify` / `requireInteraction` 共 7 字段），但 `ContentPush` / `ToolRequestPush` typedef 没声明，hook 作者只能 untyped spread——跟 next.3 amsg-instant 修掉的 `pushPayload.splitPattern` 是同一种 leaky-API。这版补上类型，IDE 给完整的 7 字段补全。

### New

- **`NotificationDirective` typedef** — 显式 7 个 optional 字段（`title` / `body` / `icon` / `badge` / `tag` / `renotify` / `requireInteraction`），跟 `amsg-sw` `createNotificationFromPayload` 实际消费的字段一一对应。typedef 写了 SW 端的 fallback 链（`notification.title` → `payload.title` → `来自 {contactName}` → `'New notification'`），producer 不用再翻 SW 源码。
- **`ContentPush.notification?` + `ToolRequestPush.notification?`** — 两个 push kind 加可选字段。`ToolRequestPush` 上也挂是为了让 amsg-instant 的 sentence-splitter demote 出来的前 N-1 个 ContentPush chunks 继承（demoted 时 spread 整个 cleanPushObj，所以 notification 跟着走）。`ReasoningPush` / `ErrorPush` 不加——SW 这俩 kind 是 silent dispatch，挂上也不会触发渲染。
- **`buildContentPush` / `buildToolRequestPush` 加 `notification?` 入参** — passthrough 不深拷贝（跟 `metadata` 一致的处理）。形状校验：必须是 plain object，`title` / `body` / `icon` / `badge` / `tag` 是 string、`renotify` / `requireInteraction` 是 boolean。未知字段透传（保 SW forward-compat）。

### 为什么 typed 全部 7 个字段（而不只是 `title` / `body`）

最早的 follow-up 草稿写的是 `{ title?: string; body?: string }`。但 SW 实际读 7 个，只 typed 2 个会让另外 5 个仍然走 untyped spread——recreate next.3 amsg-instant 那个 footgun 的根本原因（typedef 不全 → spread bypass → 行为静默）。一次性 typed 完整集干净。SullyOS 这种 caller 后续 1 行 diff 就能从 untyped spread 迁到 typed arg。

### 行为兼容

- 不传 `notification`：wire format 跟 next.2 byte-for-byte 一致（builder 出口不写这个 key）。
- 老 amsg-sw / amsg-instant 等 caller 不受影响——typedef 是 additive，builder 没改原有签名。
- Wire schema 不动；`AmsgPush` 联合类型不动；type guards 不变。
- 跟 amsg-instant 0.8.0-next.3 的 `pushPayload.splitPattern` per-push override 协调发版。

## 0.1.0-next.2 — ReasoningPush 字节切分 + multi-part 索引字段 (pre-release)

Coordinated with `@rei-standard/amsg-instant@0.8.0-next.2`. Install with `npm install @rei-standard/amsg-shared@next`. Existing single-shot ReasoningPush callers are wire-compatible — the new fields are emitted only when chunking actually fires.

### New

- **`ReasoningPush` 加四个可选字段**：`messageIndex` / `totalMessages`（语义切，由 amsg-instant 的 `reasoningSplitPattern` 触发）+ `chunkIndex` / `totalChunks`（字节切，由 amsg-instant 的 `reasoningChunkBytes` 触发，把单段 reasoning 在 UTF-8 codepoint 边界切成 N 份绕开 Web Push ~2.6 KB 上限）。四个字段都 optional，单 chunk 单 segment 时不写到 wire 上，老 SW 看到的字节流跟 next.1 完全一致。
- **`buildReasoningPush`** 透传四个新可选字段；未传时输出不包含它们。
- **新导出 `chunkReasoningByUtf8Bytes(text, maxBytes)`** — UTF-8 codepoint-safe 字节切分 helper。`TextEncoder` → 字节扫描回退到 lead byte → `TextDecoder` 还原。汉字（3-byte）/ emoji（4-byte）/ ASCII 混排都能保证边界不切坏，`chunks.join('')` 严格等于输入。`maxBytes < 4` 抛 `RangeError`（UTF-8 codepoint 最宽 4 字节，更小没法切）；非字符串 `text` 抛 `TypeError`。
- **SW / 消费方拼接约定**（仅文档，本包不实现）：按 `sessionId` 分桶 → 有 `messageIndex` 再按它分子桶（Layer 1）→ 按 `chunkIndex` 排序拼字符串（Layer 2）。两个轴都到齐再消费。

### Unchanged

- 三轴 push schema、其它三种 push（content / tool_request / error）的 typedef + 字段、type guard、`MESSAGE_KIND` / `MESSAGE_TYPE` / `PUSH_SOURCE` 常量、零运行时依赖、ESM/CJS 双发布 — 全不动。
- 单 chunk 单 segment 的 ReasoningPush wire format 完全不变（新字段默认不写）。

## 0.1.0-next.0 — initial pre-release

Published under the `next` dist-tag (the repo's convention for prereleases — `publish-workspaces.mjs` auto-routes any version with a prerelease suffix). The schema is locked but the package is held back from `latest` until downstream integrators sign off on the wire shape end-to-end. Install with `npm install @rei-standard/amsg-shared@next`.

---

New package. The lowest layer of the ReiStandard Active Messaging
ecosystem: every other amsg sub-package (`amsg-instant`,
`amsg-server`, `amsg-sw`, `amsg-client`) depends on this one, never
the reverse.

### What's in

- `MessageKind` / `MessageType` / `PushSource` type aliases + matching
  runtime constants (`MESSAGE_KIND`, `MESSAGE_TYPE`, `PUSH_SOURCE`).
- Discriminated union `AmsgPush = ContentPush | ReasoningPush |
  ToolRequestPush | ErrorPush`, with `messageKind` as the literal-type
  tag (TS consumers can `switch (push.messageKind)` and narrow).
- Common-fields `@typedef` `AmsgPushCommon` capturing the universal
  shape (`messageType` / `source` / `messageId` / `sessionId` /
  `timestamp` / `messageSubtype?` / `metadata?`).
- Four builder helpers: `buildContentPush`, `buildReasoningPush`,
  `buildToolRequestPush`, `buildErrorPush`. Each does minimum
  required-field validation and returns a plain object.
- Four type guards: `isContentPush`, `isReasoningPush`,
  `isToolRequestPush`, `isErrorPush`.

### Out of scope (deliberate)

- No `messageKind: 'tool_result'`. Tool results flow client → worker
  via the `/continue` body, not as a push.
- No streaming-chunk push type.
- No tool-call schema validation (`toolCalls` is `Array<object>` —
  whatever OpenAI-compatible the upstream returned).
- Builders do not write into `metadata`. `metadata` stays a caller-
  owned namespace.

### Migration from 0.7.x callers

The 0.7.x `amsg-instant` legacy push (13 fields, no `messageKind`)
and the standalone `{ type: 'error', code: '...' }` envelope are both
gone in the upstream packages that consume this. Use:

| Was (0.7.x)                                     | Now (≥ 0.1.0 of shared, ≥ 0.8.0 of instant)     |
|-------------------------------------------------|--------------------------------------------------|
| 13-field instant push                           | `buildContentPush({...})`                        |
| `{ type: 'error', code: 'HOOK_THREW', ...}`     | `buildErrorPush({ code: 'HOOK_THREW', ... })`    |
| `{ type: 'error', code: 'LOOP_EXCEEDED', ...}`  | `buildErrorPush({ code: 'LOOP_EXCEEDED', ... })` |
| (no equivalent — reasoning was discarded)       | `buildReasoningPush({ reasoningContent, ... })`  |
