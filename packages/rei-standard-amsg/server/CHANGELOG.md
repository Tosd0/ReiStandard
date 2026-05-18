# Changelog — @rei-standard/amsg-server

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
