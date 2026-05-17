# Changelog — @rei-standard/amsg-server

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
