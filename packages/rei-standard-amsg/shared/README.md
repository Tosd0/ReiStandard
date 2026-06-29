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
| `sessionId`      | `string`          | **Shared across all pushes from the same LLM round** (reasoning + content), and across all iterations of a single agentic-loop request. |
| `timestamp`      | `string` (ISO 8601) | Producer-side wall clock.                                                 |
| `messageSubtype` | `string?`         | Caller's business namespace. Defaults to `'chat'` at producers.             |
| `metadata`       | `object?`         | **Caller passthrough.** Packages MUST NOT write here.                       |

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
| `taskId`         | `string \| null?` | Scheduled task ID (server only).                          |

### `ReasoningPush` — LLM meta-thinking

| Field              | Type           | Notes                                                       |
|--------------------|----------------|-------------------------------------------------------------|
| `messageKind`      | `'reasoning'`  | Discriminator.                                              |
| `reasoningContent` | `string`       | Lifted from `choices[0].message.reasoning_content`.         |
| `title`            | `string?`      |                                                             |
| `contactName`      | `string?`      |                                                             |
| `avatarUrl`        | `string \| null?` |                                                          |

**No `messageIndex` / `totalMessages`.** Reasoning is one push per
LLM round, never a split-burst. Those fields are absent at the type
level on purpose — making them optional would leave callers
wondering when they're set.

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
`{ decision: 'tool-request', pushPayload }`. The client is expected
to execute the tool and resume via `/continue`.

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
import { isContentPush, isReasoningPush, isErrorPush } from '@rei-standard/amsg-shared';

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

## Invariants

1. **`messageKind` is a literal-type discriminator.** Producers must
   set it via a builder (or to one of the literal values directly).
   Never `string`-typed.
2. **`sessionId` is stable across a single LLM round.** A
   `ReasoningPush` and the `ContentPush`(es) it precedes share the
   same `sessionId`. Agentic-loop multi-iteration runs reuse the
   same `sessionId` across iterations.
3. **`ReasoningPush` carries no `messageIndex` / `totalMessages`.**
   Those fields belong to the content N-split burst.
4. **`metadata` is caller-owned.** Packages must add protocol-level
   data as top-level fields, never inside `metadata`.
5. **`source` is the routing origin, not the dispatch type.**
   `'instant'` ⇄ `amsg-instant`; `'scheduled'` ⇄ `amsg-server`.

See [§6 of `standards/active-messaging-api.md`](../../../standards/active-messaging-api.md)
for the wire-level contract.

---

## License

MIT
