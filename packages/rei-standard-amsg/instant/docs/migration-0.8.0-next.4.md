# Migration guide — 0.8.0-next.3 → 0.8.0-next.4

`0.8.0-next.*` is a pre-release line. next.4 is intentionally breaking because we're consolidating two overlapping mechanisms (lib-side `splitPattern` auto-split + hook-side singular `pushPayload`) into one: **the hook returns the exact N pushes it wants sent, and the lib does zero splitting.**

This guide expands on the CHANGELOG. If you only want a one-pager, [`CHANGELOG.md`](../CHANGELOG.md) has the cheat sheet.

## Why

next.2/next.3 had the hook return a single `pushPayload`. The lib then ran an internal `splitHookPushPayload` that:

- Used a `splitPattern` regex to chop the `message` field into N parts.
- Cloned the whole pushPayload N times, replacing only the `message` field per clone.
- Sent each clone as its own Web Push.

Two problems made this leak abstractions:

### Problem 1: regex-driven splitting can't express what real callers need

A single-pass regex can't:

- Cut on `\n` AND on the boundary between two CJK characters in the same call.
- Pull `[[SEND_EMOJI: xxx]]` inline tags out as their own segment between sentences.
- Drop empty segments after the cut and then merge / re-split by business rules.

Callers wanted real JS functions to do the split, not regex sources. The framework's "give us a regex" API was strictly less expressive.

### Problem 2: per-chunk fields had to differ

`splitHookPushPayload` cloned every field besides `message`. But real callers needed per-chunk variation in:

- `notification.body` — OS banner shows sanitized text; `message` keeps raw text for client app post-processing. Banner text and bubble text disagree.
- `metadata.directives` — side-effect markers must appear on exactly one of N pushes (else client replays N times).
- `metadata.iteration` — agentic-loop state per chunk.
- `messageId` — must be unique per push (SW IDB keyPath; duplicates overwrite).

`splitHookPushPayload`'s clone model couldn't express any of this.

next.4's solution is the simplest possible: hook returns `pushPayloads: PushPayload[]`, the lib delivers each element in order with 1500ms spacing. No more clone-and-replace.

## API contract

```ts
type HookDecision =
  | { decision: 'finish';        pushPayloads: PushPayload[] }
  | { decision: 'tool-request';  pushPayloads: PushPayload[] }
  | { decision: 'continue';      nextHistory: ChatMessage[] }
  | { decision: 'skip-push' };
```

**No singular `pushPayload` field.** One push: `[push]`. Three pushes: `[a, b, c]`.

The lib auto-fills these three "mechanical" fields per push:

| Field           | When                                         | Value                                |
|-----------------|----------------------------------------------|--------------------------------------|
| `messageId`     | Hook didn't set one (`messageId === undefined`) | `msg_<uuid>_chunk_<i>` (auto)        |
| `messageIndex`  | Always overwritten                            | 1-based array index (`i + 1`)        |
| `totalMessages` | Always overwritten                            | `pushPayloads.length`                |

Every other field on each push (`messageKind`, `notification`, `metadata`, kind-specific fields like `toolCalls` / `reasoningContent`) is per-push, fully under caller control.

## What gets rejected

Six things now trip a contract error (HOOK_THREW + HTTP 500 for hook-side, 400 INVALID_PAYLOAD_FORMAT for request-body):

1. **`decision.pushPayload` (singular)** → `HookError`: "pushPayload (singular) is removed in next.4, use pushPayloads: [yourPayload]"
2. **Both `pushPayload` and `pushPayloads` set** → `HookError`: "use pushPayloads"
3. **`pushPayloads: []`** → `HookError`: "use decision: skip-push to skip notification entirely"
4. **`pushPayloads[i].splitPattern`** → `HookError`: "splitPattern is removed in next.4"
5. **Request body `splitPattern` / `reasoningSplitPattern` / `errorSplitPattern`** → 400 INVALID_PAYLOAD_FORMAT: "<field> is removed in next.4; caller is responsible for splitting"
6. **`pushPayloads[i]` not a plain object** → `HookError`: "pushPayloads[i] must be a plain object"

Pre-release strictness: no warnings, no silent fallback. You change the call sites, OR your turn 500s on the first hook invocation.

## Migration recipes

### Recipe 1: one-shot finish (no split, no fancy)

Before:
```js
return {
  decision: 'finish',
  pushPayload: {
    messageKind: 'content',
    sessionId: ctx.sessionId,
    message: 'Hello',
    notification: { title: 'Sully', body: 'Hello' },
  },
};
```

After (wrap in array):
```js
return {
  decision: 'finish',
  pushPayloads: [{
    messageKind: 'content',
    sessionId: ctx.sessionId,
    message: 'Hello',
    notification: { title: 'Sully', body: 'Hello' },
  }],
};
```

### Recipe 2: `splitPattern` → caller-side split

Before (request body `splitPattern`):
```js
// Worker config or per-request body field:
{ ..., splitPattern: '([。！？!?]+)' }

// Hook:
return {
  decision: 'finish',
  pushPayload: {
    messageKind: 'content',
    message: 'A。B。C。',
  },
};
```

After (caller implements split, returns N pushes):
```js
// In hook, after computing the LLM output text:
const segments = text
  .split(/([。！？!?]+)/g)
  .reduce((acc, part, i, arr) => {
    if (i % 2 === 0 && part.trim()) acc.push(part.trim() + (arr[i + 1] || ''));
    return acc;
  }, [])
  .filter((s) => s.length > 0);

return {
  decision: 'finish',
  pushPayloads: segments.map((message) => ({
    messageKind: 'content',
    sessionId: ctx.sessionId,
    message,
    notification: { title: `来自 ${ctx.contactName}`, body: message },
  })),
};
```

This pattern is verbose by design — caller now sees exactly what the lib was doing internally, and can replace `String.prototype.split(/.../)` with a richer tokenizer if needed.

### Recipe 3: per-chunk `notification.body` (THE feature this unlocks)

Use case: client-app `message` text contains tags / emoji codes / inline markup. OS banner must show sanitized text.

```js
return {
  decision: 'finish',
  pushPayloads: [
    {
      messageKind: 'content',
      sessionId: ctx.sessionId,
      message: '你看',
      notification: { title: '来自 Sully', body: '你看' },
    },
    {
      messageKind: 'content',
      sessionId: ctx.sessionId,
      message: '[[SEND_EMOJI: 笑]]',                       // raw, client renders as emoji
      notification: { title: '来自 Sully', body: '[表情：笑]' },  // sanitized for OS banner
    },
    {
      messageKind: 'content',
      sessionId: ctx.sessionId,
      message: '我没事的',
      notification: { title: '来自 Sully', body: '我没事的' },
    },
  ],
};
```

Pre-next.4, this required either dropping inline tags from `message` (losing client semantics) or skipping `notification` entirely (no banner). With per-push `notification`, both audiences get what they want.

### Recipe 4: tool-request with mixed kinds

Use case: hook wants narration to ship first, then a tool call to execute.

```js
return {
  decision: 'tool-request',
  pushPayloads: [
    {
      messageKind: 'content',
      sessionId: ctx.sessionId,
      message: '让我同时查日记和天气',
      notification: { title: '来自 Sully', body: '让我同时查日记和天气' },
    },
    {
      messageKind: 'tool_request',
      sessionId: ctx.sessionId,
      message: '',
      toolCalls: [
        { id: 'rd_1', type: 'function', function: { name: 'notion_read_diary', arguments: '{"date":"2024-05-21"}' } },
        { id: 'ws_1', type: 'function', function: { name: 'web_search',        arguments: '{"query":"北京天气"}' } },
      ],
      // No notification — client doesn't show a banner for the tool call itself.
    },
  ],
};
```

decision tag and per-push `messageKind` are now decoupled: a `decision: 'tool-request'` decision can contain content pushes (and probably should — `tool_request` kind pushes typically have empty `message`). The lib doesn't policy-check the mix.

### Recipe 5: `reasoningSplitPattern` → manual reasoning splitting

Before:
```js
// Request body: reasoningSplitPattern: '([。！？!?]+)'
// autoEmitReasoning: true (default)
// Hook returns: { decision: 'finish', pushPayload: { messageKind: 'content', ... } }
// Lib auto-emits reasoning push split into N chunks by Layer-1 sentence regex.
```

After (caller handles reasoning emission):
```js
// In handler setup:
createInstantHandler({
  ...,
  autoEmitReasoning: false,  // we'll build it ourselves
});

// In hook:
import { buildReasoningPush } from '@rei-standard/amsg-instant';

const reasoning = ctx.llmResponse.choices[0].message.reasoning_content;
const reasoningSegments = reasoning
  ? reasoning.split(/([。！？!?]+)/g)
      .reduce((acc, part, i, arr) => {
        if (i % 2 === 0 && part.trim()) acc.push(part.trim() + (arr[i + 1] || ''));
        return acc;
      }, [])
      .filter((s) => s.length > 0)
  : [];

const reasoningPushes = reasoningSegments.map((piece) => buildReasoningPush({
  messageType: 'instant',
  source: 'instant',
  messageId: `msg_${randomUUID()}_iter_${ctx.iteration}_reasoning_${i}`,
  sessionId: ctx.sessionId,
  reasoningContent: piece,
  timestamp: new Date().toISOString(),
}));

const contentPushes = [{
  messageKind: 'content',
  sessionId: ctx.sessionId,
  message: ctx.llmOutputText,
  notification: { title: `来自 ${ctx.contactName}`, body: ctx.llmOutputText },
}];

return {
  decision: 'finish',
  pushPayloads: [...reasoningPushes, ...contentPushes],
};
```

If you only need byte-bound transparent chunking (the common case for DeepSeek-R1 / GLM-4.5 / Qwen3-Thinking heavy-reasoning responses), keep `autoEmitReasoning: true` (default) and skip this whole recipe — the lib still handles Layer-2 byte chunking via `chunkReasoningByUtf8Bytes` and ships it with `chunkIndex` / `totalChunks` per chunk.

## Stable bits — what didn't change

- VAPID config, `pushSubscription`, `apiKey`, `clientToken` / `tokenSigningKey` — same as next.3.
- `BlobStore` and the `_blob` envelope for over-cap payloads — same.
- `maxLoopIterations` (default 10) — same.
- `autoEmitReasoning` (default `true`) and `reasoningChunkBytes` (default 2000, `null` to disable) — same.
- The 4 `decision` values (`finish` / `tool-request` / `continue` / `skip-push`) — same.
- HTTP status codes (200 / 400 / 401 / 500 / 502) — same.
- `onEvent` event taxonomy — same names (`llm_done`, `final_pushed`, `tool_request_pushed`, `reasoning_pushed`, etc.).

## Questions a reviewer should ask

- "Is the per-push `notification` actually being read by the SW?" Yes — the SW reads `notification.{title,body,icon,badge,tag,renotify,requireInteraction}` and shows them. The amsg-shared package's `ContentPush` / `ToolRequestPush` typedefs have included `notification?` since next.3.
- "Does the lib still de-dup pushes if I ship the same `messageId` twice?" No — the SW's IDB keyPath is `messageId`, so duplicates overwrite. The lib auto-fills unique ids only when the hook doesn't supply one. If the hook sets `messageId` manually, the hook is responsible for uniqueness.
- "What if I send 100 pushes in one `pushPayloads`?" The lib will ship all 100 with 1500ms spacing — total wall-clock ~150s. Probably hits the worker's CPU/wall-time budget. The spec doesn't enforce a hard cap; if you need that, validate in your hook.
- "Can I pass an async push (e.g., await an upstream API per push)?" No — `pushPayloads` is a plain array of fully-formed pushes. Build everything in the hook before returning the decision. The lib doesn't iterate a generator.

## Open questions / future work

- Adding a per-push delay knob (some chunks may want instant delivery, others want a longer pause for typing-bubble UX). next.4 keeps the global 1500ms; if downstream apps need fine-grained timing, file an issue with use cases.
- Optional `validatePushPayload(push)` helper exported from `@rei-standard/amsg-shared` — currently the lib just validates shape; field-level schema validation per messageKind would help hook authors catch typos before delivery.
