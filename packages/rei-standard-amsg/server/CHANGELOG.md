# Changelog — @rei-standard/amsg-server

## 2.5.3

### Patch Changes

- 5c0e047: VAPID subject 规范化支持 `https:` 形式：RFC 8292 允许 subject 使用 `https:`，规范化时按原样保留，不另加 `mailto:` 前缀。reasoning 私有思考过滤、`avatarUrl` 校验、VAPID subject 规范化统一改用 `@rei-standard/amsg-shared` 的实现。
- Updated dependencies [5c0e047]
  - @rei-standard/amsg-shared@0.3.0

## 2.5.2 — in-server instant 路径恢复为一等公民

- **文档**：移除 `schedule-message` 中 `messageType: 'instant'` 两处 JSDoc 的 `@deprecated Soft-deprecated` 标记；该路径（create task → process by UUID → delete task）现以正式支持路径身份记录，不再携带弃用暗示。
- **注释**：`message-processor` 模块头及行内注释中的 "legacy in-server instant" 措辞统一改为 "in-server instant path"（中性术语）。
- **选型说明**：JSDoc 与 README 补充两条 instant 路径各自的适用场景——本端点的 DB 路径任务落库后投递不绑连接生命周期，适合长时间生成 / 零丢失；`@rei-standard/amsg-instant` 无状态、纯 SSE + Web Push，适合能在断连宽限期内（Deno Deploy 实测 ≈20-30s）跑完的短任务。不再有"新代码请改用"的导流建议。
- 运行时行为不变，无 breaking change。

## 2.5.1 — `<think>` 不再泄进 ContentPush

- **Fix**: `readReasoningContent` 走 `<think>` / `<thinking>` / `<thought>` fallback 抽出 reasoning 后，`splitMessageIntoSentences` 拿到的还是原始字符串，私有 chain-of-thought 被同步当成 ContentPush 推送给用户。新增 `stripReasoningTags()` 并把 reasoning 抽取重排到 sentence-split 之前——命中 fallback 时把同一段从 `messageContent` 里剥掉再切句，与 `@rei-standard/amsg-instant` 0.9.1 保持镜像同步。

## 2.5.0 — Dependency bump

- 依赖更新：同步升级 `@rei-standard/amsg-shared` 至稳定版 `0.2.0`，让正式发版环境不解析出混版本 shared graph。
- 运行时行为不变；本包只是随 shared 的 `notification.silent` 类型/校验补齐做协调发版。

## 2.4.1 — readReasoningContent fallback

- **Enhancement**: `readReasoningContent` 添加 fallback 支持。当原生 `reasoning_content` 字段缺失时，会 fallback 检查 `message.content` 是否包含 `<think>...</think>`、`<thinking>...</thinking>` 或 `<thought>...</thought>` 并提取，提供对更多模型（例如 DeepSeek-R1-Distill）的原生兼容。

## 2.4.0 — Dependency bump

- 依赖更新：同步升级 `@rei-standard/amsg-shared` 至稳定版 `0.1.0`。

## 2.4.0-next.1 — avatarUrl 软清空 (pre-release)

Cherry-pick stable `2.3.3` 的 `avatarUrl` 软清空策略到 next 预发布线。把 2.3.1 引入的"严格 400"放宽为"`console.warn` + 把 `avatarUrl` 置空 + 继续"：`schedule-message` 不合法的 `avatarUrl` 在 payload 上置 `null`，`update-message` 把不合法字段从 patch 里 `delete`（旧头像保持不变）。`INVALID_PARAMETERS` / `INVALID_UPDATE_DATA` 不再为 `avatarUrl` 触发，其它字段错误码不变。详见 `2.3.3` stable 条目；与 `@rei-standard/amsg-instant` 0.8.0-next.1 / `@rei-standard/amsg-client` 2.3.0-next.1 / `@rei-standard/amsg-sw` 2.1.0-next.1（SW 标题 fallback 至 `来自 {contactName}`）同步。

`next.0` → `next.1` 行为变化只此一项；三轴 push schema 部分**完全不动**。

## 2.4.0-next.0 — Three-axis push schema + ReasoningPush (pre-release)

Published under the `next` dist-tag (repo convention for prereleases). Coordinated with the other amsg sub-packages' `*-next.0` releases. Install with `npm install @rei-standard/amsg-server@next`. Schema is locked; the next-tag window is for downstream integrators to validate end-to-end before this graduates to `latest`.

---

Coordinated minor across the whole amsg ecosystem. The server's push wire shape now follows `@rei-standard/amsg-shared`'s discriminated union, indexed by `messageKind`. LLM-driven paths (`prompted` / `auto` / the via-server `instant` path) also lift `choices[0].message.reasoning_content` into a first-class `ReasoningPush` ahead of the content burst.

### Breaking

- **Push wire shape now follows `@rei-standard/amsg-shared`'s `AmsgPush` union.** Every push carries `messageKind: 'content' | 'reasoning'` as a literal-type discriminator. `ContentPush` keeps every field the 2.3.x 13-field shape had (`title`, `message`, `contactName`, `messageId`, `messageIndex`, `totalMessages`, `messageType`, `messageSubtype`, `taskId`, `timestamp`, `source`, `avatarUrl`, `metadata`) — plus the new `messageKind: 'content'` discriminator and `sessionId`.
- **`sessionId` is now part of every push.** Server-emitted pushes use `sess_task_<task.id>` for scheduled rows (stable across retries) or `sess_<uuid>` when there is no task id (the legacy in-server instant path). Same `sessionId` is shared across the auto-emitted ReasoningPush and the entire ContentPush burst from one LLM round.

### New

- **Auto-emit `ReasoningPush` before the content burst** when the LLM response carries non-empty `choices[0].message.reasoning_content`. Applies to `prompted`, `auto`, and the legacy in-server `instant` path. `fixed` and explicit-`userMessage` paths produce no LLM response, so the reasoning step is naturally skipped.
- **Server-driven failures continue to flow through DB `status: 'failed'`** — server does NOT push an `ErrorPush` to clients. (This is the schema-unification release, not a behavior-expansion release; the in-band push error envelope is a separate feature shipped only by `@rei-standard/amsg-instant`.)

### Migration from 2.3.x

| 2.3.x                                      | 2.4.0                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| Hand-rolled 13-field `notificationPayload` | `buildContentPush({...})` from `@rei-standard/amsg-shared`                             |
| `messagesSent` reflects sentence count     | Unchanged — still sentence count. ReasoningPush is auxiliary, not counted.             |
| Push payload has no `messageKind`          | Push payload carries `messageKind: 'content'`. SW dispatch on `payload.messageKind`    |
| Push payload has no `sessionId`            | Push payload carries `sessionId`. Same id across ReasoningPush + ContentPush burst     |
| No reasoning push                          | If LLM returns non-empty `reasoning_content`, a separate `ReasoningPush` is sent first |

If you have a SW that hand-sniffs push fields, switch to the `messageKind` discriminator. If you have a client that pairs server-sent sentences (e.g. via `messageId` regex), use `sessionId` instead — it's stable and explicit.

### Dependencies

- Adds `@rei-standard/amsg-shared` at exact version `0.1.0` (no caret). The coordinated minor upgrade is intentionally strict — npm shouldn't resolve a mixed-version graph across the ecosystem.

## 2.3.2 — 2026-05-18

### Docs

- README 不再用 `../../../...` 跳层相对路径（在 npmjs.com 渲染时一律 404）。`standards/active-messaging-api.md`、`examples/vercel.json.example`、sibling `amsg-instant` README 改用绝对 GitHub URL，与原有「## 相关链接（绝对 URL）」小节保持同源。
- 「环境变量」小节展开：每个变量补一句说明（VAPID 邮箱 / 公私钥用途、`TENANT_CONFIG_KEK` 是用于加密 Blob 里租户配置的 KEK、`TENANT_TOKEN_SIGNING_KEY` 是 token HMAC 签名密钥、`INIT_SECRET` / `PUBLIC_BASE_URL` / `VERCEL_PROTECTION_BYPASS` 的触发条件），附 `openssl rand -base64 32` 生成命令和 `.env` 模板。
- 「v2.0.1 变更摘要」末尾加 pointer，指向规范 §6.1（`messages` 数组 / `splitPattern`）/ §6.2（`avatarUrl` 严格校验）—— 这些字段从 2.2.0 起陆续加入，未在该小节展开。

无代码变更，仅 README 重写。规范文档在仓库根的 `standards/active-messaging-api.md`（已同步到 v2.3）。

## 2.3.1 — 2026-05-18

### Fix

- **`avatarUrl` 严格校验**（与 [`@rei-standard/amsg-instant` 0.6.1](../instant/CHANGELOG.md#061--2026-05-18) 同步）：之前 `avatarUrl` 只检 `new URL(...)` 能不能 parse，导致 `data:image/...;base64,xxx` 这种 base64 内嵌头像也算合法 —— 一旦传进来，存进任务再随推送外发会膨胀几十 KB，触发下游 Web Push 服务的 4KB 硬上限或网关 `413 Payload Too Large`。`schedule-message` 与 `update-message` 现在统一：
  - 拒 `data:` 开头的 URI（不区分大小写）→ `400 INVALID_PARAMETERS` / `400 INVALID_UPDATE_DATA`，错误信息明示「头像不支持传入 data: URI（base64 内嵌图片会触发 413 / Web Push 4KB 上限），请改为公网可访问的 https:// 图片 URL」。
  - 拒长度 > 2048 字符的 URL → `400`，错误信息明示实际长度 + 上限 + 建议（CDN 缩略图）。
  - 仍要求 `new URL(...)` 能 parse。
  - `undefined` / `null` 仍然视为「未传」，零行为变化。
- 顶层 export `validateAvatarUrl(value)`：业务可在 SDK 之外做同步预校验，避免一次远端往返。

### Compatibility

- 2.3.0 调用者**几乎零修改**：除非之前真的在传 `data:` URI 当 avatarUrl（那本来就跑不通推送），否则升级无感。错误码 `INVALID_PARAMETERS` / `INVALID_UPDATE_DATA` 不变，加密格式、推送 payload 不动。
- 与 `@rei-standard/amsg-instant` 0.6.1 共享语义；两端独立实现但行为字节级一致。

## 2.3.0 — 2026-05-18

### New

- **`splitPattern` 自定义分句正则**（与 [`@rei-standard/amsg-instant` 0.6.0](../instant/CHANGELOG.md#060--2026-05-18) 同步）：`schedule-message` / `update-message` payload 新增可选 `splitPattern: string | string[]` 字段。
  - `string` → 单个正则 source（不带 flags），用 `new RegExp(splitPattern)` 编译后替代默认 `/([。！？!?]+)/`。
  - `string[]` → **级联**应用：先按数组首项切，每段再按下一项切，以此类推。适合分层切分（先按段落 `(\n\n+)`、再按句号 `([。！？!?]+)`）。
  - 不传 / `null` / `[]` → 走默认正则，行为字节级不变；老库存任务（无此字段）行为不变。
  - **限制**：每项 ≤ 200 字符，数组 ≤ 10 项，每项必须能 `new RegExp(...)` 通过。违规 → `400 INVALID_PARAMETERS`（schedule）/ `400 INVALID_UPDATE_DATA`（update）。
  - **捕获组约定**：想让分隔符回贴到前一段（与默认行为一致），把分隔符放进 `(...)` 捕获组。库不自动包裹。
  - 持久化：随 `fullTaskData` 一起加密落盘；`update-message` 用 `hasOwnProperty` 模式合并，显式传 `splitPattern: null` 可重置回默认。
- 顶层 export `validateSplitPattern(value)`：业务可在 SDK 之外做同步预校验。

### Compatibility

- 2.2.x 调用者**零修改**继续工作。DB schema、加密格式、推送 payload、错误码全部不动。2.2.x 直接升级即可。
- 与 `@rei-standard/amsg-instant` 0.6.0 共享语义；两端独立实现但行为字节级一致。

## 2.2.0 — 2026-05-17

### New

- **`messages` 数组转发**（与 [`@rei-standard/amsg-instant` 0.5.0](../instant/CHANGELOG.md#050--2026-05-17) 同步）：`schedule-message` / `update-message` payload 新增可选 `messages` 字段，与 `completePrompt` **互斥二选一**。`prompted` / `auto` / `instant` 三种 AI 配置消息全部支持。
  - 上游应用直接把标准 OpenAI 格式的 `[{role:'system',...}, {role:'user',...}, {role:'assistant',...}, ...]` 透传过来，`buildAiRequestBody` **原样**转给 LLM —— 不再被强行压成单个 user 消息。让定时消息 / 即时消息 / Worker instant 三条路径的 LLM 调用完全等价（system role、多轮历史、tool role 全保留）。
  - `content` 支持 `string` 或非空数组（多模态留口子，元素 schema 不深挖）。
  - role 限定 `system | user | assistant | tool`，违规 → `400 INVALID_PARAMETERS`。
  - 两者同时给、`messages` 为空数组、role 非法 → 全部 `400`。
  - 持久化层（加密 task data）同时存 `completePrompt` 和 `messages` 字段；`update-message` 切换 prompt source 时自动 null 掉另一个，保证存储一致性。
- **`temperature` 字段**：可选 number，会透传给 LLM。legacy `completePrompt` 路径无 temperature 时仍默认 0.8（保持旧行为）；`messages` 路径无 temperature 时**不发**，跟上游主路径完全一致。
- 顶层 export `validateLlmMessagesArray(messages)`：业务可在 SDK 之外做同步预校验。

### Compatibility

- 旧 `completePrompt` 调用者**零修改**继续工作。DB schema、加密格式、推送 payload 字段全部不动。2.1.x 直接升级即可。
- 与 `@rei-standard/amsg-instant` 0.5.0 共享语义；两端独立实现但行为字节级一致。

## 2.1.1 — 2026-05-17

### Improvements

- **`apiUrl` 智能规范化（幂等）**：`processSingleMessage` 链路里的 `normalizeAiApiUrl` 现在会自动补全 OpenAI 兼容的 chat 路径，**与 [`@rei-standard/amsg-instant`](../instant/CHANGELOG.md#040--2026-05-17) 0.4.0 完全同步**：
  - 裸 host（如 `https://api.openai.com`）→ 补 `/v1/chat/completions`
  - 末尾是 `/v1` / `/v2` 等版本段 → 只补 `/chat/completions`，**不会重复加 v1**
  - 已含 `/chat/completions` → 原样返回
  - Anthropic-shape `/v1/messages` 等自定义路径 → 不动
- 老调用者传完整 `…/v1/chat/completions` 仍然 work；逻辑严格幂等。
- `normalizeAiApiUrl` 现在作为 `src/server/lib/message-processor.js` 顶层 export（之前是私有），方便业务在 SDK 之外做同步预校验。

### Notes

- 协议字段零变更；DB schema、加密格式、推送 payload 字段全部不动。
- 与 amsg-instant 共享逻辑、但各持一份代码（避免 server → worker-pkg 的反向依赖）。任何后续规则变更都需要两边同步。

## 2.1.0 — 2026-05-16

### Changed

- `validateScheduleMessagePayload` no longer enforces a fixed `chat | forum | moment` enum for `messageSubtype`. The field is now validated as an optional string only; the taxonomy is the consumer's call (forwarded as-is to the SW push payload). This is purely a relaxation — any payload that was accepted before is still accepted; payloads with custom subtype strings (e.g. `'sms'`) now pass instead of being rejected with `INVALID_PARAMETERS`.

### Deprecated (soft)

- `messageType: 'instant'` on the `/schedule-message` endpoint. Functionality is preserved and behavior is **unchanged**; no runtime warnings, no breaking changes — purely a documentation-level recommendation. New code should prefer the new [`@rei-standard/amsg-instant`](../instant/README.md) package for a stateless, no-DB instant path.

  Source-level signal: the two `if (payload.messageType === 'instant')` branches in `src/server/handlers/schedule-message.js` now carry a JSDoc `@deprecated` block pointing to amsg-instant. The runtime path is otherwise byte-identical to v2.0.1.

## 2.0.1

(See git history.)
