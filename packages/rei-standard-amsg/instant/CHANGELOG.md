# Changelog — @rei-standard/amsg-instant

## 0.8.2 — readReasoningContent fallback

- **Enhancement**: `readReasoningContent` 添加 fallback 支持。当原生 `reasoning_content` 字段缺失时，会 fallback 检查 `message.content` 是否包含 `<think>...</think>`、`<thinking>...</thinking>` 或 `<thought>...</thought>` 并提取，提供对更多模型（例如 DeepSeek-R1-Distill）的原生兼容。

## 0.8.1 — segmentTextWithProtectedBlocks utility

- **New**: 增加包级独立 utility `segmentTextWithProtectedBlocks`。该工具用于帮助 caller 将带有“不可拆片段”（如 Markdown 代码块、特定标记）的文本切分为 `PushTextSegment` 数组。纯正则匹配保护机制，不引入业务耦合，并支持自定义 preview 与 metadata，帮助更安全、方便地构建 hook 的 `pushPayloads` 返回值。
- **Fix**: hook 返回的 `pushPayloads` 现在会在发送前浅拷贝再自动补齐 `messageId` / `messageIndex` / `totalMessages`，避免原地修改 caller 对象，并支持 `Object.freeze(...)` 这类不可变 payload。

## 0.8.0 — waitUntil lifecycle support

- 稳定版发布：`0.8.0-next.*` 能力毕业到 latest，依赖收敛到 `@rei-standard/amsg-shared@0.1.0`。
- `waitUntil` 注册的是后台生命周期保护 promise；主流程失败仍由 handler 转成原有 HTTP 错误响应，同时通过 `wait_until_rejected` 事件记录，不额外制造 rejected background promise。
- Cloudflare Workers：`createCloudflareWorker.fetch` 现在接收第三个 `ExecutionContext` 参数，并把主回复链路（LLM 生成、构造/切段 push payloads、逐条 Web Push）交给 `ctx.waitUntil` 保护。直接把 `createInstantHandler(...)` 挂成 Worker module `fetch` 时，也会识别 Cloudflare 传入的 `(request, env, ctx)`。
- 其他运行时：`createInstantHandler` 新增通用 `waitUntil` 生命周期入口；Netlify / Vercel Edge adapters 会透传第二个 context 参数；Node adapter 新增可选 `toNodeHandler(fetchHandler, { waitUntil | runtime | getRuntime })`，方便宿主有生命周期钩子时统一保护主回复链路。

## 0.8.0-next.7 — Dependency bump (pre-release)

- 依赖更新：升级 `@rei-standard/amsg-shared` 到 `0.1.0-next.4` 以获取最新的 `notification.show` 和 `multipart` 相关工具。删除了项目内的 `base64` / `concat` 工具函数，迁移使用 `amsg-shared` 导出的底层工具，提升代码可维护性。

## 0.8.0-next.6 — BREAKING: generic multipart transport (pre-release)

next 阶段把 oversized push 的 transport 收敛成一套通用 multipart 协议。旧 reasoning 专用 `chunkIndex` / `totalChunks` wire format 已移除；`reasoning`、`tool_request`、`content`、`error`、`emotion_update` 或任何自定义 `messageKind`，只要是 JSON-safe payload，都可以被 `_multipart` 包装。

### New

- **`buildMultipartPushPayloads(payload, { maxChunkBytes?, id?, ttlMs? })`** — 构造 generic `_multipart` Web Push payloads。原始 JSON 先 UTF-8 编码，再按 byte 切片并 base64url 编码，避免 Unicode 边界问题。
- **`multipart` handler option** — 默认开启。配置项：`enabled`、`maxChunkBytes`、`ttlMs`、`maxChunks`、`maxTotalBytes`。
- **`multipart_built` / `multipart_sent` events** — 发送端可观测 multipart fallback 何时触发、原始 `messageKind` 是什么、共拆了几片。

### Changed

- `sendPushWithMaybeBlob` 发送优先级现在是：
  1. 小 payload：直接 Web Push。
  2. oversized + 有 BlobStore：仍优先走 BlobStore envelope。
  3. oversized + 无 BlobStore + multipart enabled：走 generic `_multipart`。
  4. oversized + 无 BlobStore + multipart disabled / 超 multipart 上限：抛 `PayloadTooLargeError`。
- legacy content push、HOOK_THREW diagnostic、LOOP_EXCEEDED diagnostic 现在也走同一个 `sendPushWithMaybeBlob` 路径，因此 oversized payload 策略一致。
- `reasoningChunkBytes` 保留为 deprecated alias：设置数字时等价于 `multipart.maxChunkBytes`；设置 `null` 且未显式配置 `multipart` 时禁用 generic multipart。它不再产生旧 reasoning chunk fields。

### Removed

- Removed old reasoning-only `chunkIndex` / `totalChunks` wire format from producer output.
- Removed `reasoning_chunked` as the transport signal for oversized reasoning. 迁移到 `multipart_built` / `multipart_sent`。

### Migration

- 应用级 SW 不应再依赖 `chunkIndex` / `totalChunks` 拼 reasoning。请升级 `@rei-standard/amsg-sw` 到支持 generic multipart 的 next 版本，让 SW 透明还原完整 payload。
- 如果生产环境不想依赖 multipart fallback，继续配置 BlobStore；BlobStore 仍然优先于 multipart。

## 0.8.0-next.5 — `validateMessagesArray` 放宽 OpenAI tool-call 形态 (pre-release)

非破坏性修复。`validateMessagesArray` 此前过严，会拒绝合法的 OpenAI 工具调用消息：

- **`role: 'assistant'` + 非空 `tool_calls`**:`content` 现在允许为 `''` / `null` / 缺省 — 符合 OpenAI Chat Completions 协议（assistant 只发工具调用、没有 narration 是合法的）。同时对 `tool_calls` 数组做轻量形状校验（每条要 `{ id, type:'function', function:{ name, arguments } }`），形状非法时给出明确报错。
- **`role: 'tool'`**:`content` 允许为空串（工具返空结果合法，如 search 无命中）；`tool_call_id` 现在强校验为必填字符串 — 这是 OpenAI 协议的硬约束，库之前漏校。
- `system` / `user` / 不带 `tool_calls` 的 `assistant`：维持原校验，行为不变。

### 类型

`ChatMessage` typedef 同步更新：`role` 收窄为字面量联合；`content` 类型加入 `null`；`tool_calls` 改为结构化签名（`{ id, type:'function', function:{ name, arguments } }[]`）；`tool_call_id` 文档说明其在 tool 消息上必填。dist `*.d.ts` / `*.d.cts` 由 tsup 从源码 JSDoc 自动生成。

### 影响

任何之前因 `content: ''` 而 400 的 agentic-loop hook（典型场景：assistant 这一轮只回了 tool_calls 没有 narration，下一轮需要把 hook 内部历史回放给 `/continue`）现在可以直接通过。无需调整既有 hook 代码。

## 0.8.0-next.4 — BREAKING: pushPayloads-only hook decision API (pre-release)

Install with `npm install @rei-standard/amsg-instant@next`. Pre-release — breaking on purpose. 见 [`docs/migration-0.8.0-next.4.md`](./docs/migration-0.8.0-next.4.md) 完整迁移指南.

### Removed

- `decision.pushPayload` (singular). Replaced by `decision.pushPayloads: PushPayload[]`.
- Request-body fields `splitPattern` / `reasoningSplitPattern` / `errorSplitPattern` — rejected with 400 `INVALID_PAYLOAD_FORMAT` and a migration hint pointing at `pushPayloads`.
- `pushPayload.splitPattern` per-push override (next.3 only) — rejected with `HookError`.
- Public export `splitMessageIntoSentences` — used to be exported from `@rei-standard/amsg-instant` for hook authors who wanted "the same default split as the legacy path". The legacy path still uses it internally; hook authors implement their own split.
- Most internal split helpers (`splitHookPushPayload` / `pickSplitConfig` / `validatePerKindSplitPatterns` / `validateSplitPattern` / `SPLIT_PATTERN_MAX_*`) removed. `splitMessageIntoSentences` / `splitOnceByRegex` / `DEFAULT_SPLIT_REGEX` stay module-internal because `runLegacyInstant` still uses them.
- The two-layer reasoning cascade collapsed to one layer (byte chunking). The Layer-1 sentence split via `reasoningSplitPattern` is gone with the field.

### Changed

- `runAgenticLoop`'s finish / tool-request branch now reads `decision.pushPayloads` and ships each push via `sendPushWithMaybeBlob` with `SLEEP_BETWEEN_MESSAGES_MS` (1500ms) between consecutive pushes. Per-push: `messageId` is auto-filled when absent (`msg_<uuid>_chunk_<i>`); `messageIndex` / `totalMessages` are always overwritten with array-derived values.
- LOOP_EXCEEDED diagnostic is now a single `sendPushWithMaybeBlob` call (no looping needed — the diagnostic is one push).
- Reasoning auto-emit (`autoEmitReasoning: true`, default): now a single transform. Short reasoning → 1 push; oversized → N byte-chunked pushes with `chunkIndex` / `totalChunks` (Layer-2 only).

### Unchanged

- Legacy v0.6 compat path (no `onLLMOutput`) still splits raw LLM text by sentence regex and ships sequential pushes — byte-level identical to v0.6. The public `splitPattern` knob on the request body is gone, but the path's internal behaviour is preserved (default regex `/([。！？!?]+)/`).
- HOOK_THREW handling (single-shot diagnostic, best-effort delivery), blob envelope, `maxLoopIterations`, `autoEmitReasoning`, `reasoningChunkBytes`, all 4 decisions (`finish` / `tool-request` / `continue` / `skip-push`).
- VAPID / push subscription / `apiKey` are still not exposed to the hook.
- HTTP status code mapping unchanged.

### Migration cheat sheet

| next.3                                                                  | next.4                                                                        |
|-------------------------------------------------------------------------|-------------------------------------------------------------------------------|
| `return { decision: 'finish', pushPayload: { ... } }`                   | `return { decision: 'finish', pushPayloads: [{ ... }] }`                      |
| Request body `splitPattern: '([。！？!?]+)'`                            | Implement the split in your hook; return one push per segment                 |
| `pushPayload.splitPattern: null` (per-push disable from next.3)         | Return `pushPayloads: [singleUnsplit]`                                        |
| `reasoningSplitPattern` request field                                   | Set `autoEmitReasoning: false`, build N reasoning pushes yourself with `buildReasoningPush(...)`, include them at the start of `pushPayloads` |

### Why breaking in pre-release

The `0.8.0-next.*` series is pre-1.0 unstable. next.2 + next.3 stacked two overlapping mechanisms (lib-side splitPattern auto-split + hook-side pushPayload singular). next.4 collapses both into one (caller returns the exact pushes it wants sent) before 1.0 freezes the public surface.

## 0.8.0-next.3 — `pushPayload.splitPattern` per-push override (pre-release)

Coordinated with `@rei-standard/amsg-shared@0.1.0-next.3`. Install with `npm install @rei-standard/amsg-instant@next`.

next.2 把 `splitPattern` 定位成纯请求级配置——hook 在自己返回的 `pushPayload` 上写 `splitPattern: null` 会被静默忽略（库不报错、不警告、TS 也不挡，因为 `ContentPush` 等 typedef 没有声明这个字段，spread 加任意 key 就会绕过 excess-property check）。这是 leaky API：用错位置看起来正常通过，但行为完全没生效。next.3 把这个口子收紧。

### Fixed

- **`pushPayload.splitPattern` 现在被识别为 per-push override**。hook 返回的 `pushPayload` 自身带 `splitPattern` 字段时，对这一个 push 优先级高于请求级的 `splitPattern` / `reasoningSplitPattern` / `errorSplitPattern`。字段名永远是 `splitPattern`（不分 kind，因为 push 的 `messageKind` 已经定了切谁的文本）。`null` / `[]` 关切；string / string[] 走 cascade。
- **`undefined` 跟 `null` 严格区分**：`splitPattern: undefined`（或字段缺省）= 「没意见，回退请求级」；`splitPattern: null` / `[]` = 「这一个 push 显式关切，盖住请求级」。这跟请求级字段的语义、跟 JS 对 `undefined` 的直觉、跟 next.2 之前的请求级行为都保持一致——`undefined` 不会被错读成「override 在场但 disable」。
- **Override 校验沿用 `validateSplitPattern`**——形状错（非 string/array、超 200 字符、超 10 项）或正则不可编译（`new RegExp(...)` throws）→ 抛 `HookError`，message 形如 `pushPayload.splitPattern invalid: <原因>`，明确点位（不会跟请求级混）。validateSplitPattern 原本带的 `splitPattern` / `splitPattern[i]` 前缀会被 strip，避免 `pushPayload.splitPattern invalid: splitPattern 不是...` 这种重复读起来含糊。
- **Wire 不带 `splitPattern`**——库在交付前从所有 chunks（含 N-段切片、单段透传、ToolRequestPush 的 prefix 降级段）上 strip 掉这个字段，SW 永远收不到。`splitHookPushPayload` 每个 push 跑一次，降级 chunks 从已剥离的 parent spread，**不会发生二次切**。

### Unchanged

- 请求级 `splitPattern` / `reasoningSplitPattern` / `errorSplitPattern` 语义和优先级**完全不变**——只是新增了 per-push 覆盖通道。
- 没在 `pushPayload` 上写 `splitPattern` 的 hook 行为跟 next.2 byte-for-byte 一致（auto-emit reasoning、framework 内置的 `LOOP_EXCEEDED` ErrorPush 等都没有这字段，全部回退到请求级）。
- 公共 API（hook 契约、handler options、HTTP wire format）零变化。

### Coordinated

- 跟 `@rei-standard/amsg-shared@0.1.0-next.3` 一起发——shared 这版顺手补齐 `notification` 字段在 `ContentPush` / `ToolRequestPush` typedef 上的 7 字段 typed support + `buildContentPush` / `buildToolRequestPush` 的 `notification?` 入参（解决跟本 next.3 同源的 leaky-API：SW 早就消费 `notification.{title,body,icon,badge,tag,renotify,requireInteraction}`，但 typedef 没声明导致 caller 只能 untyped spread）。详见 shared CHANGELOG `0.1.0-next.3`。
- `amsg-server` / `amsg-sw` / `amsg-client` 不动。SW 行为未变，只是 shared 把它已经支持的字段类型化了。

## 0.8.0-next.2 — splitPattern hook-mode 修复 + reasoning 两层切分 (pre-release)

Coordinated with `@rei-standard/amsg-shared@0.1.0-next.2`. Install with `npm install @rei-standard/amsg-instant@next`.

### Fixed

- **`splitPattern` 在 hook 模式下重新生效**。0.7 引入的「`splitPattern is ignored when onLLMOutput is provided` 启动 warn + 不切分」是设计抽风：`splitPattern` 是「消息文本切气泡」的 UX 配置，跟 hook 决定「本轮发什么」完全正交。next.2 把它在 hook 模式下重新启用，hook 返回 `decision: 'finish'` / `'tool-request'` 后，framework 按 `messageKind` 对 pushPayload 的文本字段应用 `splitPattern`：`content.message` / `tool_request.message`（默认开，句号正则 `/([。！？!?]+)/`）。`ToolRequestPush` 切片时 `toolCalls` 仍是原子数组，绑定到含 LAST prefix 段的 chunk（emit 为 `tool_request`），前 N-1 段降级为 `content`（不带 `toolCalls`）— 保证 narration 全显示完再启动 tool 执行。
- **删除 0.7 加的 `splitPattern is ignored when onLLMOutput is provided` 启动 warn**。

### New

- **`reasoningSplitPattern` / `errorSplitPattern` payload 字段** — 按 `messageKind` 独立的句号切配置：

  | `messageKind`  | 字段                      | 默认                |
  |----------------|---------------------------|---------------------|
  | `content`      | `splitPattern`            | `/([。！？!?]+)/` (开) |
  | `tool_request` | `splitPattern`            | `/([。！？!?]+)/` (开) |
  | `reasoning`    | `reasoningSplitPattern`   | **不切**            |
  | `error`        | `errorSplitPattern`       | **不切**            |
  | 自由 payload   | —                         | 不切                |

  四个 kind 共享的「禁用」语义：显式 `null` 或 `[]` 关闭切分。差别在 `undefined`（字段省略）：`content` / `tool_request` 回落默认句号正则；`reasoning` / `error` 保持不切（这俩历史上就没切片 UX，默认 off 才符合预期）。

- **`reasoningChunkBytes` handler option（默认 2000，`null` 禁用）** — `ReasoningPush.reasoningContent` 的 UTF-8 字节上限。reasoning-heavy LLM（DeepSeek-R1 / GLM-4.5 / Qwen3-Thinking）经常输出 3-10 KB reasoning，超 Web Push ~2.6 KB 上限。next.2 内置 transparent 字节切分：超限时按 UTF-8 codepoint 边界切成 N 份，每片带 `chunkIndex` / `totalChunks`，SW 按这两个字段拼回完整字符串。**绝大多数 reasoning-heavy 部署不再需要 BlobStore。** `createInstantHandler` 构造期校验 `reasoningChunkBytes ∈ [500, maxInlineBytes - 600]`（600 B 余量给 push payload 元字段），不合法抛 `TypeError`。

- **两层 cascade（Layer 1 句切 → Layer 2 字节切）** — `reasoningSplitPattern` 先按句切成 M 段，每段单独量字节，超阈值的段再字节切成 N 块。最终 push 同时带两组索引：
  - Layer 1：`messageIndex` 1..M / `totalMessages` M（M=1 时不写）
  - Layer 2：`chunkIndex` 1..N / `totalChunks` N（N=1 时不写）

  SW 拼接：按 `sessionId` 分桶 → 按 `messageIndex` 分子桶 → 按 `chunkIndex` 排序拼字符串。

- **新事件 `reasoning_chunked`** — `{ sessionId, iteration?, totalChunks, totalBytes }`。只在 Layer 2 实际切分时 fire 一次（Layer 1 单独的句切不 fire），避免事件洪水。

- **`chunkReasoningByUtf8Bytes` re-export** — 从 `@rei-standard/amsg-shared` 直接 re-export 出来，hook 作者想自己切（`autoEmitReasoning: false` + 手动 dispatch）也能用。

### 行为兼容

- 不传任何新字段：`reasoning_content` 小于 2000 B 时 wire format 跟 next.1 byte-for-byte 一致。
- 老 SW 拿到单 chunk 单 segment 的 ReasoningPush 完全照常消费（新字段都 optional，单值时不写）。
- HOOK_THREW 诊断仍走 `sendWebPush` 单 shot（特殊路径，跟 byte chunking 解耦）。
- LOOP_EXCEEDED 诊断走 `sendChunkedPush` 仍然遵循 `errorSplitPattern`（默认不切）。

### 投递时序

- Layer 1 段间间隔：`SLEEP_BETWEEN_MESSAGES_MS`（1500 ms，typing-bubble UX）
- Layer 2 同段 chunk 间间隔：`SLEEP_BETWEEN_REASONING_CHUNKS_MS`（100 ms，transport-only，不需要打字感）
- 一律串行，每个 chunk 等前一个 push 返回再发，避免 push gateway 速率限制 + SW 按 `chunkIndex` 重排
- 内部统一通过 `sendPushWithMaybeBlob`，单 chunk 超限仍可走 BlobStore envelope（兜底未变）

### Unchanged

- hook API（4-decision 契约）/ agentic loop / `/continue` / `maxLoopIterations` / `autoEmitReasoning` 全部不变
- BlobStore 路径、envelope schema、`maxInlineBytes` 等不变
- 凭据（vapid / apiKey / pushSubscription）继续不暴露给 hook
- 不引入新错误码、不改 HTTP 状态码映射
- `runLegacyInstant`（不传 `onLLMOutput` 的 0.6 兼容路径）也吃 Layer 2 字节切，跟 `runAgenticLoop` 行为一致

## 0.8.0-next.1 — avatarUrl 软清空 (pre-release)

Cherry-pick stable `0.7.1` 的 `avatarUrl` 软清空策略到 next 预发布线。`/instant` 与 `/continue` 路径不合法的 `avatarUrl`（`data:` URI / 长度 > 2048 / 非字符串 / 不是合法 URL）会在 payload 上**置为 `null`** + `console.warn`，整次推送继续；`INVALID_PAYLOAD_FORMAT` 不再为 `avatarUrl` 触发，其它字段错误码不变。详见 `0.7.1` stable 条目；与 `@rei-standard/amsg-server` 2.4.0-next.1 / `@rei-standard/amsg-client` 2.3.0-next.1 / `@rei-standard/amsg-sw` 2.1.0-next.1（SW 标题 fallback 至 `来自 {contactName}`）同步。

`next.0` → `next.1` 行为变化只此一项；三轴 push schema 部分**完全不动**。

## 0.8.0-next.0 — Three-axis push schema + ReasoningPush (pre-release)

Published under the `next` dist-tag (repo convention for prereleases). Coordinated with `@rei-standard/amsg-shared@0.1.0-next.0`, `amsg-server@2.4.0-next.0`, `amsg-sw@2.1.0-next.0`, `amsg-client@2.3.0-next.0`. Install with `npm install @rei-standard/amsg-instant@next`. The schema is locked; the next-tag window is for downstream integrators to validate end-to-end before this graduates to `latest`.

---

Coordinated minor across the whole amsg ecosystem. This release replaces the legacy 13-field push envelope (and the standalone `{ type:'error', code:'...' }` shape) with a discriminated union from the new `@rei-standard/amsg-shared` package, indexed by `messageKind`. It also lifts LLM `reasoning_content` into its own first-class push so clients can render "thinking…" UI ahead of the actual reply.

### Breaking

- **Push wire shape now follows `@rei-standard/amsg-shared`'s `AmsgPush` union.** Every push carries `messageKind: 'content' | 'reasoning' | 'tool_request' | 'error'` as a literal-type discriminator. TS callers `switch (push.messageKind)` and narrow on it.
- **The 0.7.x `{ type: 'error', code: '...' }` diagnostic envelope (used for `HOOK_THREW` and `LOOP_EXCEEDED`) is gone.** Diagnostics are now `ErrorPush` (`messageKind: 'error'` + same `code` / `message` fields). The legacy `type: 'error'` field is **not** present on the new envelope — do not look for it.
- **Public export `buildInstantPushPayload` removed.** Use `buildContentPush` from `@rei-standard/amsg-shared` (re-exported from this package). The new builder takes the three-axis fields (`messageType` / `source` / `messageKind`) + the legacy 13 fields as optionals.

### New

- **Auto-emit `ReasoningPush` before the content burst / hook.** When the LLM response carries a non-empty `choices[0].message.reasoning_content`, the framework now ships a separate `ReasoningPush` first, then the existing content path. Both the legacy sentence-split path AND the agentic-loop hook path do this.
- **`autoEmitReasoning` config (default `true`)** — hook-path opt-out. Set to `false` on `createInstantHandler({...})` when the hook author wants total control over every push that leaves the worker. In that mode, hooks can read `ctx.llmResponse.choices[0].message.reasoning_content` and build their own `buildReasoningPush(...)` envelope. The legacy (non-hook) path always auto-emits regardless — it has no hook control point to honor.
- **`sessionId` is stable across one LLM round.** The auto-emitted ReasoningPush and the content burst that follows it share the same `sessionId`. In the agentic-loop path, all iterations of a single `/instant` request also share one `sessionId`. Legacy path: mints `sess_<uuid>` if the payload didn't carry one. Hook path: reuses `payload.sessionId` or mints a UUID. **The hook is responsible for propagating `ctx.sessionId` into its own `pushPayload`** — the framework does not inject it.
- **Blob envelope now carries `messageKind`.** When a push exceeds `maxInlineBytes`, the `{ _blob, key, url }` envelope now also includes `messageKind` (and the legacy `type` field for hand-rolled hook payloads). The SW can dispatch on the discriminator without having to fetch the blob first.
- **Builder / type guard re-exports.** `buildContentPush`, `buildReasoningPush`, `buildToolRequestPush`, `buildErrorPush`, `isContentPush`, `isReasoningPush`, `isToolRequestPush`, `isErrorPush`, `MESSAGE_KIND`, `MESSAGE_TYPE`, `PUSH_SOURCE` are all re-exported from `@rei-standard/amsg-instant` so hook authors don't need a second dependency on `@rei-standard/amsg-shared`.
- **`readReasoningContent(llmResponse)` helper** exported for hook authors who need to inspect or post-process reasoning content before deciding what to push.
- **New event types**: `reasoning_pushed`, `reasoning_push_failed`. Both carry `sessionId` and (for the hook path) `iteration`.

### Migration from 0.7.x

| 0.7.x                                                                  | 0.8.0                                                                                    |
|------------------------------------------------------------------------|------------------------------------------------------------------------------------------|
| `buildInstantPushPayload({ message, index, total, contactName, ... })` | `buildContentPush({ messageType: 'instant', source: 'instant', messageId, sessionId, message, messageIndex, totalMessages, contactName, ... })` from `@rei-standard/amsg-instant` |
| Hook payload `{ type: 'tool-request', ... }` (free-form)               | Either keep it free-form (still legal — `pushPayload: unknown`) or call `buildToolRequestPush({ ... })` for a typed envelope |
| SW dispatch by ad-hoc field sniffing on push payload                   | SW dispatch by `payload.messageKind` switch (consume the shared `AmsgPush` discriminated union) |
| `{ type: 'error', code: 'HOOK_THREW', message, sessionId, iteration }` | Auto-built — no caller-side change needed; the wire shape now uses `messageKind: 'error'` instead of `type: 'error'` |
| Hook fully owned every push (incl. reasoning, if you built one)        | Framework auto-emits `ReasoningPush` before the hook runs. Set `autoEmitReasoning: false` on `createInstantHandler({...})` to restore total hook control. |
| Hook returned `pushPayload` without a `sessionId` field                | **Set `sessionId: ctx.sessionId`** in your hook's `pushPayload`. The framework does NOT auto-inject it (the `pushPayload: unknown` contract is preserved). Without this the SW can't pair your content push with the auto-emitted ReasoningPush. |
| Legacy path push failure aborted the whole burst                       | Reasoning-push failure is now best-effort (`reasoning_push_failed` event + continue). Content-push failures still abort, same as before. |

If you have a hook that builds its own pushPayload object, **set `sessionId: ctx.sessionId`** in it so the SW can pair your content push with the auto-emitted ReasoningPush.

### Dependencies

- Adds `@rei-standard/amsg-shared` at exact version `0.1.0` (no caret). The coordinated minor upgrade is intentionally strict — npm shouldn't resolve a mixed-version graph across the ecosystem.

## Unreleased (pre-0.8.0)

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
