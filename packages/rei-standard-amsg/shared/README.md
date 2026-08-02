# @rei-standard/amsg-shared

Lowest layer of the ReiStandard Active Messaging stack. Defines
the **push schema** that `amsg-instant`, `amsg-server`,
`amsg-sw`, and `amsg-client` all conform to.

Zero runtime deps. Does **not** depend on any other amsg package —
every other amsg sub-package depends on this one, never the reverse.

---

## Push schema

A single push is described by three independent dimensions:

| Axis           | Field             | Values                                                | Defined by         |
|----------------|-------------------|-------------------------------------------------------|--------------------|
| Dispatch       | `messageType`     | `instant` / `fixed` / `prompted` / `auto`             | Package (fixed)    |
| Business       | `messageSubtype`  | Any string                                            | Caller (free-form) |
| Content        | `messageKind`     | `content` / `reasoning` / `tool_request` / `error`    | Package (fixed)    |

`messageType` answers **how this push was produced** (one-shot
`instant` worker, scheduled `fixed` ping, AI-`prompted` reply, fully
`auto`-generated cadence). `messageKind` answers **what it carries**.
The two are intentionally independent: any `messageType` can carry any
`messageKind`.

There is also `source: 'instant' | 'scheduled'` — the **routing
origin** (`'instant'` for `amsg-instant`, `'scheduled'` for any
`amsg-server` output). `messageType: 'instant'` always pairs with
`source: 'instant'`; the other three `messageType`s always pair with
`source: 'scheduled'`.

---

## Common fields (every push)

| Field            | Type              | Notes                                                                       |
|------------------|-------------------|-----------------------------------------------------------------------------|
| `messageKind`    | `MessageKind`     | Discriminator. Literal type — TS narrows on it.                             |
| `messageType`    | `MessageType`     | Dispatch axis.                                                              |
| `source`         | `'instant' \| 'scheduled'` | Routing origin.                                                    |
| `messageId`      | `string`          | Unique per push. Format owned by the producer.                              |
| `sessionId`      | `string`          | **Shared across all pushes from the same LLM round** (reasoning + content), and across all iterations of a single agentic-loop request. Opaque — do not parse it for task identity, read the scheduling fields below. |
| `timestamp`      | `string` (ISO 8601) | Producer-side wall clock.                                                 |
| `messageSubtype` | `string?`         | Caller's business namespace. Defaults to `'chat'` at producers.             |
| `metadata`       | `object?`         | **Caller passthrough.** Packages MUST NOT write here.                       |
| `taskId`         | `number \| string \| null?` | Scheduled task row id.                                          |
| `taskUuid`       | `string \| null?` | Scheduled task uuid (the id the scheduling side chose).                    |
| `recurrenceType` | `'none' \| 'daily' \| 'weekly'?` | Whether that task fires again.                            |
| `occurrenceMs`   | `number \| null?` | Nominal fire time of this occurrence (epoch ms).                           |

### Scheduling identity

`taskId` / `taskUuid` / `recurrenceType` / `occurrenceMs` are stamped by
`@rei-standard/amsg-server` on every push that came out of a scheduled task
row. They tell the client which task this is, whether the task will come
back, and which nominal fire time produced this burst — so a task the client
never created (one the character scheduled for itself at fire time) still
arrives fully identified. Pushes with no task behind them (`amsg-instant`)
omit all four.

---

## Notification directive

`ContentPush` and `ToolRequestPush` can carry an optional
`notification` object. It is a producer-side hint consumed by
`@rei-standard/amsg-sw` before rendering a system notification.

| Field                | Type                                      | Notes |
|----------------------|-------------------------------------------|-------|
| `show`               | `'auto' \| 'always' \| 'when-hidden' \| false` | Display policy. `auto` follows SW defaults. |
| `title`              | `string?`                                | Notification title override. |
| `body`               | `string?`                                | Notification body override. |
| `icon`               | `string?`                                | Notification icon URL. |
| `badge`              | `string?`                                | Notification badge URL. |
| `tag`                | `string?`                                | Notification grouping tag. |
| `renotify`           | `boolean?`                               | Re-alert when a matching `tag` replaces an existing notification. |
| `requireInteraction` | `boolean?`                               | Keep the notification visible until the user dismisses it. |
| `silent`             | `boolean?`                               | Suppress notification sound and vibration. |
| `data`               | `Record<string, unknown>?`               | Custom data passed to the notification. |

Unknown fields are preserved for forward compatibility, but the known
fields above are validated by the builders when present.

---

## Per-kind fields

### `ContentPush` — final user-facing content

| Field            | Type        | Notes                                                          |
|------------------|-------------|----------------------------------------------------------------|
| `messageKind`    | `'content'` | Discriminator.                                                 |
| `message`        | `string`    | The sentence/segment to display.                               |
| `messageIndex`   | `number?`   | 1-based segment index within an N-split burst. Omit for singletons. |
| `totalMessages`  | `number?`   | Total segments in the burst. Omit for singletons.              |
| `title`          | `string?`   | Notification title.                                            |
| `contactName`    | `string?`   | Sender display name.                                           |
| `avatarUrl`      | `string \| null?` | Sender avatar URL (`https:` only — `data:` is rejected upstream). |

### `ReasoningPush` — LLM meta-thinking

| Field              | Type           | Notes                                                       |
|--------------------|----------------|-------------------------------------------------------------|
| `messageKind`      | `'reasoning'`  | Discriminator.                                              |
| `reasoningContent` | `string`       | Lifted from `choices[0].message.reasoning_content`.         |
| `title`            | `string?`      |                                                             |
| `contactName`      | `string?`      |                                                             |
| `avatarUrl`        | `string \| null?` |                                                          |
| `messageIndex`     | `number?`      | 1-based part index when a producer sentence-splits reasoning into a burst. Omit for singletons. |
| `totalMessages`    | `number?`      | Total parts of that split. Omit for singletons.             |
| `chunkIndex`       | `number?`      | Transport-only slice index when a single segment exceeds the Web Push payload limit (see `chunkReasoningByUtf8Bytes`). |
| `totalChunks`      | `number?`      | Total transport slices. Omit when not sliced.               |

Both multi-part axes are **omitted from the wire when the part count
is 1**, so single-shot reasoning stays byte-for-byte identical to
older payloads. Current producers emit one `ReasoningPush` per LLM
round and set neither — oversized reasoning rides the generic
multipart transport instead. The two axes can coexist when a
sentence-split segment is itself oversized.

Emitted **before** the matching `ContentPush` burst when the LLM
response carried a non-empty `reasoning_content`.

### `ToolRequestPush` — tool invocation request

| Field         | Type             | Notes                                                       |
|---------------|------------------|-------------------------------------------------------------|
| `messageKind` | `'tool_request'` | Discriminator.                                              |
| `toolCalls`   | `Array<object>`  | OpenAI `choices[0].message.tool_calls` shape, passthrough.  |
| `title`       | `string?`        |                                                             |
| `contactName` | `string?`        |                                                             |
| `message`     | `string?`        | Optional human-readable tag for the request.                |

Emitted by an agentic-loop hook returning
`{ decision: 'tool-request', pushPayloads }`. In the default
(amsg-instant) flavor the client executes the tools and resumes via
`/continue`; amsg-server's fire-time loop runs the tools in-process
instead and may carry a `toolCalls` array directly — see
`assertValidDecision` below.

### `ErrorPush` — producer-level error

| Field         | Type      | Notes                                                                  |
|---------------|-----------|------------------------------------------------------------------------|
| `messageKind` | `'error'` | Discriminator.                                                         |
| `code`        | `string`  | Stable producer-defined code, e.g. `HOOK_THREW`, `LOOP_EXCEEDED`.      |
| `message`     | `string`  | Human-readable description.                                            |
| `iteration`   | `number?` | Agentic-loop iteration when relevant.                                  |

Replaces the legacy 0.7.0 `{ type: 'error', code: '...' }` envelope.
The legacy `type` field is **gone** — do not look for it on
`ErrorPush`.

---

## Usage

### TypeScript / typed JavaScript

```ts
import {
  type AmsgPush,
  type ContentPush,
  type ReasoningPush,
  isContentPush,
} from '@rei-standard/amsg-shared';

function dispatch(push: AmsgPush) {
  switch (push.messageKind) {
    case 'content':
      // push narrowed to ContentPush — push.message is `string`
      console.log(push.message);
      break;
    case 'reasoning':
      // push narrowed to ReasoningPush — push.reasoningContent is `string`
      console.log(push.reasoningContent);
      break;
    case 'tool_request':
      // push.toolCalls is `Array<object>`
      break;
    case 'error':
      console.error(push.code, push.message);
      break;
  }
}
```

### Builders

```js
import {
  buildContentPush,
  buildReasoningPush,
  buildToolRequestPush,
  buildErrorPush,
} from '@rei-standard/amsg-shared';

// One sentence in an N-split burst
const content = buildContentPush({
  messageType: 'instant',
  source: 'instant',
  messageId: `msg_${crypto.randomUUID()}_0`,
  sessionId: 'sess_abc',
  message: 'Hello!',
  contactName: 'Rei',
  messageIndex: 1,
  totalMessages: 2,
});

// Reasoning emitted before the content burst
const reasoning = buildReasoningPush({
  messageType: 'instant',
  source: 'instant',
  messageId: `msg_${crypto.randomUUID()}_reasoning`,
  sessionId: 'sess_abc', // SAME sessionId as the content above
  reasoningContent: 'User greeted me; I should reply warmly.',
});

// Agentic-loop tool request
const toolReq = buildToolRequestPush({
  messageType: 'instant',
  source: 'instant',
  messageId: `msg_${crypto.randomUUID()}_tool`,
  sessionId: 'sess_abc',
  toolCalls: [{ id: 'call_0', type: 'function', function: { name: 'get_weather', arguments: '{}' } }],
});

// Producer-level error
const error = buildErrorPush({
  messageType: 'instant',
  source: 'instant',
  messageId: `msg_${crypto.randomUUID()}_err`,
  sessionId: 'sess_abc',
  code: 'HOOK_THREW',
  message: 'onLLMOutput threw: ...',
  iteration: 2,
});
```

### Type guards

```js
import { isContentPush, isReasoningPush, isToolRequestPush, isErrorPush } from '@rei-standard/amsg-shared';

if (isContentPush(push)) {
  // push.message is `string`
}
```

---

## Constants

```js
import { MESSAGE_KIND, MESSAGE_TYPE, PUSH_SOURCE } from '@rei-standard/amsg-shared';

MESSAGE_KIND.CONTENT;       // 'content'
MESSAGE_KIND.REASONING;     // 'reasoning'
MESSAGE_KIND.TOOL_REQUEST;  // 'tool_request'
MESSAGE_KIND.ERROR;         // 'error'

MESSAGE_TYPE.INSTANT;       // 'instant'
MESSAGE_TYPE.FIXED;         // 'fixed'
MESSAGE_TYPE.PROMPTED;      // 'prompted'
MESSAGE_TYPE.AUTO;          // 'auto'

PUSH_SOURCE.INSTANT;        // 'instant'
PUSH_SOURCE.SCHEDULED;      // 'scheduled'
```

---

## Shared building blocks

Besides the push schema, this package is the single source of truth
for helpers that `amsg-instant`, `amsg-server`, and `amsg-sw` used to
each keep a copy of. All are exported from the package root; the
one-liners below are just a map — see the JSDoc on each export for
the full contract.

### Bytes / encoding / crypto

`toUint8` · `concatBytes` · `utf8` · `utf8Decode` · `bytesToBase64` ·
`bytesToBase64Url` · `base64UrlToBytes` · `jsonToBase64Url` ·
`bytesToHex` · `hexToBytes` · `randomBytes` · `hmacSha256` ·
`timingSafeEqualBytes` — WebCrypto-friendly byte/encoding helpers for
base64url, hex, HMAC, and constant-time comparison.

### LLM call

| Export | What it is |
|---|---|
| `callLlm(...)` | Call an OpenAI-compatible chat-completions endpoint with timeout / abort handling (default 300 000 ms, injectable `fetch`). |
| `buildLlmRequestBody(...)` | Build the request body for prompt mode or `messages` mode. |
| `normalizeAiApiUrl(apiUrl)` | Normalize a base URL to its chat-completions endpoint without doubling `/v1`; unrecognized paths pass through unchanged. |
| `validateLlmMessagesShape(...)` | Validate a `messages` array, including assistant `tool_calls` and `role: 'tool'` entries. |
| `LLM_MESSAGES_ERROR` | Stable error codes emitted by that validation. |

### Web Push

| Export | What it is |
|---|---|
| `sendWebPush(...)` | RFC 8291 payload encryption + RFC 8292 VAPID auth + POST to the push service (`err.code = 'PUSH_SEND_FAILED'` on failure). |
| `buildVapidJwt(...)` / `verifyVapidJwt(...)` | Build / verify the ES256 VAPID JWT. |
| `normalizeVapidSubject(...)` | Normalize the VAPID subject (e.g. add the `mailto:` prefix). |

### Wire-protocol constants

| Export | What it is |
|---|---|
| `MULTIPART_MESSAGE_KIND` / `MULTIPART_ENCODING` / `MULTIPART_VERSION` | The generic multipart chunk envelope (`'_multipart'`) produced by `amsg-instant` and reassembled by `amsg-sw`. |
| `DEFAULT_MULTIPART_TTL_MS` / `DEFAULT_MULTIPART_MAX_CHUNKS` / `DEFAULT_MULTIPART_MAX_TOTAL_BYTES` | Multipart reassembly budget defaults. |
| `REI_AMSG_POSTMESSAGE_TYPE` / `REI_SW_EVENT` / `REI_SW_MESSAGE_TYPE` / `REI_AMSG_DELIVER_MESSAGE_TYPE` | The window ⇄ Service Worker `postMessage` protocol strings — import these instead of hard-coding the literals. |

### Agentic-loop contract

| Export | What it is |
|---|---|
| `assertValidDecision(decision, options?)` | Runtime-validate an `onLLMOutput` hook decision (`finish` / `tool-request` / `continue` / `skip-push`); `{ inlineToolCalls: true }` enables the amsg-server flavor. |
| `extractToolCallsFromDecision(...)` | Pull tool calls out of either decision flavor (inline `toolCalls` or tool-request `pushPayloads`). |
| `buildSessionContext(...)` | Build the frozen, credential-free context object handed to agentic hooks. |
| `extractAssistantMessage(...)` | Safely read `choices[0].message` off an LLM response (never throws). |
| `readReasoningContent(...)` | Read `reasoning_content` off an assistant message; empty string means "none". |
| `stripReasoningTags(...)` | Strip reasoning that leaked into `message.content` so it doesn't ship inside the `ContentPush` burst. |
| `chunkReasoningByUtf8Bytes(text, maxBytes)` | Split reasoning text on safe UTF-8 edges for payload-limited transports. |

### Validation misc

`isValidUrl` · `validateAvatarUrl` · `AVATAR_URL_MAX_LENGTH` — the
avatar-URL soft-strip rule shared by client / instant / server
(standards §6.2).

---

## Invariants

1. **`messageKind` is a literal-type discriminator.** Producers must
   set it via a builder (or to one of the literal values directly).
   Never `string`-typed.
2. **`sessionId` is stable across a single LLM round.** A
   `ReasoningPush` and the `ContentPush`(es) it precedes share the
   same `sessionId`. Agentic-loop multi-iteration runs reuse the
   same `sessionId` across iterations.
3. **Multi-part fields are omitted for singletons.** On `ContentPush`
   and `ReasoningPush` alike, `messageIndex` / `totalMessages` (and
   reasoning's `chunkIndex` / `totalChunks`) only appear on genuine
   multi-part bursts — never as a redundant `1 / 1`.
4. **`metadata` is caller-owned.** Packages must add protocol-level
   data as top-level fields, never inside `metadata`.
5. **`source` is the routing origin, not the dispatch type.**
   `'instant'` ⇄ `amsg-instant`; `'scheduled'` ⇄ `amsg-server`.

See [§6 of `standards/active-messaging-api.md`](../../../standards/active-messaging-api.md)
for the wire-level contract.

---

## License

MIT
