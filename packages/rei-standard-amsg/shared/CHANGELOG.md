# @rei-standard/amsg-shared

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
