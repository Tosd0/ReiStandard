# Changelog — @rei-standard/amsg-server

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
