# Changelog — @rei-standard/amsg-shared

## 0.4.0-next.3

### Minor Changes

- d6bea67: hook 契约补齐任务身份与状态读写口；push 自带任务的调度身份

  - **config 级 hook 拿到状态读写口。** `onAfterSend` / `onStaleSkip` 的载荷里现在有 `readState(ns)` / `writeState(ns, entries)`，语义与 fire 级那套一致（单用户模式下作用于当前用户的命名空间）。此前只有 fire 级 ctx 上有，宿主要在这两个 hook 里写 `client_state` 只能自己缓存一份写口：isolate 冷启动后、本次 tick 里还没有任何 fire 跑过时缓存是空的（服务停摆恢复后那一波过期跳过一条痕迹都留不下，而那正是 `onStaleSkip` 存在的意义），缓存下来的闭包还握着上一次 invocation 的数据库绑定。
  - **`onAfterSend` 收到本次 fire 的 `scratch`。** 与 `onBeforeFire` / `onLLMOutput` 是同一个对象引用，所以「这次生成了哪几段正文」这类上下文直接从 `info.scratch` 读，不用再按任务行 id 自建登记表（连带 TTL 清扫和并发隔离）。完整载荷：`{ task, sentCount, total, error, scratch, readState, writeState }`。
  - **`onLLMOutput` / `executeToolCalls` 的 ctx 直接带任务身份**：`taskId`（任务行 id）、`taskUuid`、`occurrenceMs`（本次触发的名义时刻，epoch 毫秒）。`sessionId` 是给日志和去重用的不透明字符串（当前格式 `sess_task_<id>@<occurrenceMs>`），拿它切字符串取任务身份是切不稳的。
  - **每条 push 顶层带 `taskId` / `taskUuid` / `recurrenceType` / `occurrenceMs`**（冻结 prompt 路径和 fire-time hook 路径都算）。客户端据此认领任务、判断它还会不会再来——角色在 fire 里给自己排的任务客户端从没见过，此前只能靠宿主往 `metadata` 里逐个抄。调用方在 `pushPayloads` 里自己写了这几个字段会被库覆盖：它们描述的是任务行的事实，不是内容。`@rei-standard/amsg-shared` 的 `AmsgPushCommon` 类型随之收录这四个字段（`taskId` 从 `ContentPush` 上移到公共层）。
  - **新增导出 `PUSH_ENVELOPE_RESERVED_BYTES`（384 字节）**，以及 `measurePushPayload(payload, { reserveEnvelope: true })` 这个口径。hook 把 payload 交还给库之后，库还会补 `messageId` / `sessionId` / `timestamp` / `messageIndex` / `totalMessages` / `taskId` / `taskUuid` / `recurrenceType` / `occurrenceMs`，hook 手里量到的从来不是最终 payload；不留这一截的话，卡在边界上的消息会「量出来装得下、补完字段就超了」，既没走旁路存储也发不出去。返回值多一个 `envelopeReservedBytes`。
  - **`GET /capabilities` 的 features 追加** `hook-state-accessors` / `after-send-scratch` / `fire-task-identity` / `push-task-identity` / `push-envelope-reserved-bytes`。

## 0.4.0-next.2

### Minor Changes

- 3dae842: LLM 调用器收敛到 shared：新模块 `shared/src/llm-call.js` 承载「构造请求体 + fetch + 超时 + 解析响应 + trim」的公共核心，从包根导出 `callLlm` / `buildLlmRequestBody` / `normalizeAiApiUrl`

  此前 instant（`message-processor.js` 的 `callLlmRaw`）与 server（`lib/llm.js` 的 `callLlm`）各写一份 LLM HTTP 调用，已出现漂移（stream 字段、messages 模式探测、超时可配性、trim 位置）。现在单一来源在 shared，两侧差异走 options 参数化（`stream` / `forwardTools` / `timeoutMs` / `fetch` / `requireContent`），instant 与 server 的调用点改薄，各自的导出名（instant 的 `normalizeAiApiUrl`、server 的 `callLlm` / `buildAiRequestBody` / `normalizeAiApiUrl`）与错误码包装不变。`llm.js` 里「两包各自拷贝以避免架构依赖」的过期注释一并删除——两包都已依赖 shared，该理由不再成立。

  行为变化（均为边缘修正）：

  - instant：messages 模式探测统一为 `Array.isArray(payload.messages) && payload.messages.length > 0`（server 语义）。`messages: []` 从「把空数组原样发给上游 LLM」改为「回退 completePrompt 模式」——这是修正错误行为。经公开 handler 不可触达（校验层已拒绝空 messages），仅影响直接调用 `processInstantMessage` 的调用方。
  - instant：`maxTokens` 非法时的错误文案统一为 server 措辞（`Invalid maxTokens: maxTokens must be a positive integer when provided.`）。handler 校验在前，正常路径不可触达。
  - server：`normalizeAiApiUrl` 对非字符串输入统一为 instant 的宽松语义（先 `String()` 强转再解析；此前直接抛「apiUrl is required」）。字符串输入两侧行为本就一致，不受影响。
  - server：`callLlm` 现接受额外 options（`fetch` / `stream` / `forwardTools`），默认值即原 server 语义，既有调用不受影响。

- 8ca959c: 线协议常量收敛到 shared：新模块 `shared/src/protocol.js` 承载 multipart transport 与 SW ↔ 页面 postMessage 的全部线协议常量，从包根导出

  此前 multipart 的 kind / encoding / 默认限额在 instant（`src/multipart.js`，导出）与 sw（`src/index.js`，本地重写、未导出）各写一份，`version: 1` 字面量也两侧各写；SW ↔ 页面 postMessage 常量只定义在 sw 包里，README 教页面侧硬编码字符串。现在单一来源在 shared：

  - multipart：`MULTIPART_MESSAGE_KIND` / `MULTIPART_ENCODING` / `MULTIPART_VERSION`（新增，替代两侧的 `version: 1` 字面量）/ `DEFAULT_MULTIPART_TTL_MS` / `DEFAULT_MULTIPART_MAX_CHUNKS` / `DEFAULT_MULTIPART_MAX_TOTAL_BYTES`
  - postMessage 信封：`REI_AMSG_POSTMESSAGE_TYPE` / `REI_SW_EVENT` / `REI_SW_MESSAGE_TYPE` / `REI_AMSG_DELIVER_MESSAGE_TYPE`

  instant 的 `src/multipart.js` 与 sw 的 `src/index.js` 改为 import shared 并按原导出名 re-export，两个包的公开导出面与 wire format 不变（`DEFAULT_MULTIPART_CHUNK_BYTES` 是发送端独有的切片默认值，留在 instant）。页面侧代码现在可以从 `@rei-standard/amsg-shared` import 这些常量，不必硬编码字符串，也不必从 sw 包 import（那会执行 SW 模块的顶层状态）；client / sw 的 README 示例已相应更新。

- ef2f2d1: messages 数组形状校验统一到 amsg-shared，修复 amsg-server 误拒 agentic 会话的 bug。

  - amsg-shared 新增 `validateLlmMessagesShape(messages)` 与 `LLM_MESSAGES_ERROR` 错误码常量（新模块 `src/llm-messages.js`）：返回结构化错误（稳定 code + 定位索引），支持 assistant 带 `tool_calls` 时 content 可空、`role:'tool'` 要求 `tool_call_id` 的 OpenAI 协议形状。
  - amsg-instant 的 `validateMessagesArray` 改为调用 shared 实现的薄封装，导出名、错误文案与返回形状不变。
  - amsg-server 的 `validateLlmMessagesArray` 同样改为调用 shared 实现。修复：此前该函数缺少 tool_calls / tool 消息分支，注释却声称与 amsg-instant lockstep，导致 agentic 会话（assistant tool_calls + tool 结果）回放到 `scheduleMessage` / `updateMessage` 会被 400 拒绝；现在与 amsg-instant 接受完全相同的形状。畸形 tool 消息新增对应英文错误文案（`tool_calls[j] is malformed` / `tool_call_id is required` 等）。

- 6ead0c4: crypto / 编码 utils 收敛到 shared：新模块 `shared/src/webcrypto-utils.js` 承载全生态唯一一份 runtime-neutral 帮手（`toUint8` / `concatBytes` / `utf8` / `utf8Decode` / `bytesToBase64` / `bytesToBase64Url` / `base64UrlToBytes` / `jsonToBase64Url` / `bytesToHex` / `hexToBytes` / `hmacSha256` / `timingSafeEqualBytes` / `randomBytes` / `randomUUID`），index 聚合导出（`utf8Decode` / `bytesToBase64` / `bytesToHex` / `hexToBytes` / `timingSafeEqualBytes` / `randomUUID` 为 shared 新增导出）。instant 的 `src/utils.js` 与 server 的 `lib/webcrypto-utils.js` 改为纯 re-export（文件与导出名不变，包内引用不受影响）；server 的 tenant token 模块也换用 shared 的 base64url / 常量时间比较实现（编码逐字节一致，HMAC 因同步 API 约束仍走 node:crypto）。
- b146fde: Web Push 加密栈上移 amsg-shared，instant / server 共用同一份实现

  此前 amsg-instant 的 `src/webpush.js` 与 amsg-server 的 `lib/webpush-webcrypto.js` 是逐字相同的两份拷贝（RFC 8030 传输 / RFC 8291 aes128gcm / RFC 8292 VAPID，纯 WebCrypto）。现在实现只有一份，放在 amsg-shared 的独立模块 `src/webpush.js`，从包根导出：

  - `sendWebPush` / `buildVapidJwt` / `verifyVapidJwt`
  - 顺带上移它依赖的 runtime-neutral 帮手：`utf8`、`bytesToBase64Url`、`jsonToBase64Url`、`hmacSha256`、`randomBytes`

  instant 与 server 的对应模块变薄，re-export shared 实现；两个包的公开导出面与 wire format 不变。server 独有的部分原样保留在自己包里：payload 大小护栏（`measurePushPayload` / `MAX_PUSH_PAYLOAD_BYTES` 等，`sendWebPush` 超限仍抛 `PUSH_PAYLOAD_TOO_LARGE`）、scheduled 默认 4 周 TTL 与 `createWebCryptoWebPush`。

### Patch Changes

- 9d1f89f: 补齐许可证文件：每个包根目录加入 MIT LICENSE 文本（此前 package.json 声明 MIT 但 tarball 里没有许可证文件）。仓库层面确立双许可——代码 MIT、`standards/` 规范文本 CC BY-NC-SA 4.0，根 README 的许可一节与 npm 元数据不再互相矛盾。

## 0.4.0-next.1

### Minor Changes

- f13f2f1: fire 级 scratch：hook 之间传上下文不再自己维护 Map

  单次 fire 开始时库创建一个空对象，`onBeforeFire` 的 fireCtx 和同一次 fire 里每轮 `onLLMOutput` / `executeToolCalls` 的 sessionCtx 都拿到同一个 `scratch` 引用；fire 结束（finish / skip-push / 抛错 / 轮数超限）后随之丢弃。不落库、不进日志、不跨 fire 共享。amsg-shared 的 `buildSessionContext` 新增可选 `scratch` 参数（不传则字段缺席，amsg-instant 行为不变）。

## 0.4.0-next.0

### Minor Changes

- 914ddcf: amsg-shared 新增 agentic 循环契约工具：`buildSessionContext`、`extractAssistantMessage`、`assertValidDecision`（新增 `inlineToolCalls` 选项，允许 `tool-request` 直接携带 `toolCalls`，供服务端就地执行工具的场景用）、`extractToolCallsFromDecision`。amsg-instant 的 SessionContext 构建与 decision 校验改为从 amsg-shared 复用同一实现，对外行为与错误信息不变。

## 0.3.0

### Minor Changes

- 5c0e047: 新增三组共享纯函数，让 server / instant / client 复用同一份规则，不再各自维护副本：

  - `validateAvatarUrl`（含 `isValidUrl` 与 `AVATAR_URL_MAX_LENGTH`）—— 头像 URL 校验
  - `normalizeVapidSubject` —— VAPID subject 规范化（`mailto:` / `https:` 均保留，裸邮箱补 `mailto:`）
  - `readReasoningContent` / `stripReasoningTags` —— 读取推理内容与剥离私有 `<think>` 链式思考

## 0.2.0 — Notification silent support

### New

- **NotificationDirective**：新增并校验 `notification.silent?: boolean`，与 `@rei-standard/amsg-sw@2.2.0` 的无声通知渲染能力对齐。

### Fix

- **NotificationDirective typedef 与 SW 实际行为对齐**：原 typedef 写 `tag` / `renotify` / `requireInteraction` / `silent` 没有 top-level fallback，实际上 `amsg-sw` 一直对这四个字段（以及 `data`）都按 `notification.X` → `payload.X` → 默认值的顺序回退。typedef 改成承认完整 fallback，避免 producer 误以为漏在 payload 顶级的字段不生效。仅 doc / type，wire format 不变。

### Compatibility

- 纯 additive。未传 `notification.silent` 时 wire format 不变。

## 0.1.0 — NotificationDirective 与 Shared utilities

### New

- **Shared Utilities**：新增并导出了底层工具函数 `base64UrlToBytes`, `toUint8`, 和 `concatBytes`，统一了底层依赖。
- **NotificationDirective**：新增了对 `notification.show` (`"auto"` | `"always"` | `"when-hidden"` | `false`) 参数的类型定义与验证逻辑。

## 0.1.0-next.3 — `notification` 字段 typed support (pre-release)

Coordinated with `@rei-standard/amsg-instant@0.8.0-next.3`. Install with `npm install @rei-standard/amsg-shared@next`. Wire format unchanged — additive typedef + new optional builder arg.

`notification` 字段一直被 `amsg-sw` 的 `createNotificationFromPayload` 当作 `showNotification` 渲染指令读取（`title` / `body` / `icon` / `badge` / `tag` / `renotify` / `requireInteraction` 共 7 字段），但 `ContentPush` / `ToolRequestPush` typedef 没声明，hook 作者只能 untyped spread——跟 next.3 amsg-instant 修掉的 `pushPayload.splitPattern` 是同一种 leaky-API。这版补上类型，IDE 给完整的 7 字段补全。

### New

- **`NotificationDirective` typedef** — 显式 7 个 optional 字段（`title` / `body` / `icon` / `badge` / `tag` / `renotify` / `requireInteraction`），跟 `amsg-sw` `createNotificationFromPayload` 实际消费的字段一一对应。typedef 写了 SW 端的 fallback 链（`notification.title` → `payload.title` → `来自 {contactName}` → `'New notification'`），producer 不用再翻 SW 源码。
- **`ContentPush.notification?` + `ToolRequestPush.notification?`** — 两个 push kind 加可选字段。`ToolRequestPush` 上也挂是为了让 amsg-instant 的 sentence-splitter demote 出来的前 N-1 个 ContentPush chunks 继承（demoted 时 spread 整个 cleanPushObj，所以 notification 跟着走）。`ReasoningPush` / `ErrorPush` 不加——SW 这俩 kind 是 silent dispatch，挂上也不会触发渲染。
- **`buildContentPush` / `buildToolRequestPush` 加 `notification?` 入参** — passthrough 不深拷贝（跟 `metadata` 一致的处理）。形状校验：必须是 plain object，`title` / `body` / `icon` / `badge` / `tag` 是 string、`renotify` / `requireInteraction` 是 boolean。未知字段透传（保 SW forward-compat）。

### 为什么 typed 全部 7 个字段（而不只是 `title` / `body`）

SW 实际读取 7 个 notification 字段；只 typed 其中一部分会让剩余字段继续绕过 builder 校验，表现成“代码能过、行为静默不生效”。这版一次性补齐完整字段集，caller 可以直接从手写 spread 迁到 typed arg。

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

| Was (0.7.x)                                    | Now (≥ 0.1.0 of shared, ≥ 0.8.0 of instant)      |
| ---------------------------------------------- | ------------------------------------------------ |
| 13-field instant push                          | `buildContentPush({...})`                        |
| `{ type: 'error', code: 'HOOK_THREW', ...}`    | `buildErrorPush({ code: 'HOOK_THREW', ... })`    |
| `{ type: 'error', code: 'LOOP_EXCEEDED', ...}` | `buildErrorPush({ code: 'LOOP_EXCEEDED', ... })` |
| (no equivalent — reasoning was discarded)      | `buildReasoningPush({ reasoningContent, ... })`  |
