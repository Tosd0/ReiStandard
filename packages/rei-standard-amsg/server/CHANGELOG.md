# Changelog — @rei-standard/amsg-server

## Unreleased

### Changed

- `validateScheduleMessagePayload` no longer enforces a fixed `chat | forum | moment` enum for `messageSubtype`. The field is now validated as an optional string only; the taxonomy is the consumer's call (forwarded as-is to the SW push payload). This is purely a relaxation — any payload that was accepted before is still accepted; payloads with custom subtype strings (e.g. `'sms'`) now pass instead of being rejected with `INVALID_PARAMETERS`.

### Deprecated (soft)

- `messageType: 'instant'` on the `/schedule-message` endpoint. Functionality is preserved and behavior is **unchanged**; no runtime warnings, no breaking changes — purely a documentation-level recommendation. New code should prefer the new [`@rei-standard/amsg-instant`](../instant/README.md) package for a stateless, no-DB instant path.

  Source-level signal: the two `if (payload.messageType === 'instant')` branches in `src/server/handlers/schedule-message.js` now carry a JSDoc `@deprecated` block pointing to amsg-instant. The runtime path is otherwise byte-identical to v2.0.1.

## 2.0.1

(See git history.)
