/**
 * Instant message processor.
 * ReiStandard amsg-instant
 *
 * Lifecycle of a single instant request:
 *   call LLM (OpenAI-compatible) →
 *     [if reasoning_content present] emit a ReasoningPush →
 *     split into sentences → send each sentence as its own ContentPush
 *     (1500ms spacing) → return success.
 *
 * Push wire shape comes from `@rei-standard/amsg-shared`'s discriminated
 * union (`AmsgPush`). The same `messageKind` switch is consumed by
 * `@rei-standard/amsg-sw` regardless of whether the push originated
 * here (`source: 'instant'`) or in `@rei-standard/amsg-server`
 * (`source: 'scheduled'`).
 */

import {
  buildContentPush,
  buildReasoningPush,
  buildErrorPush,
  chunkReasoningByUtf8Bytes,
} from '@rei-standard/amsg-shared';

import { sendWebPush } from './webpush.js';
import { randomUUID } from './utils.js';
import { HookError, LlmCallError, PayloadTooLargeError } from './errors.js';
import { buildSessionContext, extractAssistantMessage } from './session-context.js';
import { validateSplitPattern } from './validation.js';

const SLEEP_BETWEEN_MESSAGES_MS = 1500;
// Sub-chunk spacing within a single Layer-1 segment. Byte-chunking is
// a transport-level workaround (Web Push payload limit), NOT a
// typing-bubble UX axis, so the inter-chunk gap is much smaller than
// the inter-sentence gap. 100 ms is enough to avoid pummelling the
// push gateway in a tight loop while keeping perceived latency low.
const SLEEP_BETWEEN_REASONING_CHUNKS_MS = 100;
// Mirrors `DEFAULT_REASONING_CHUNK_BYTES` in `index.js` — kept in sync
// so `processInstantMessage` callers that bypass `createInstantHandler`
// (tests, direct programmatic use) still get the same default.
const DEFAULT_REASONING_CHUNK_BYTES = 2000;

const DEFAULT_MAX_LOOP_ITERATIONS = 10;
const DEFAULT_MAX_INLINE_BYTES = 2600;
const DEFAULT_BLOB_TTL_SECONDS = 60;
const VALID_DECISIONS = new Set(['finish', 'tool-request', 'continue', 'skip-push']);
const PUSH_PAYLOAD_BYTE_ENCODER = new TextEncoder();

const DEFAULT_SPLIT_REGEX = /([。！？!?]+)/;

function splitOnceByRegex(chunk, regex) {
  const out = chunk
    .split(regex)
    .reduce((acc, part, i, arr) => {
      if (i % 2 === 0 && part.trim()) {
        const punctuation = arr[i + 1] || '';
        acc.push(part.trim() + punctuation);
      }
      return acc;
    }, [])
    .filter(s => s.length > 0);
  // No-match fallback: pass the chunk through untouched so a later regex in
  // a cascade can still take a swing at it.
  return out.length > 0 ? out : [chunk];
}

/**
 * Split a message into individual sentences for sequential delivery.
 * Mirrors amsg-server message-processor.js (do not drift).
 *
 * `splitPattern` is an optional caller-provided override:
 *   - `string`              → single regex source, used in place of the default
 *   - `string[]`            → applied as a cascade: split by patterns[0], then
 *                             split each resulting chunk by patterns[1], etc.
 *   - omitted / null / [] / undefined → default /([。！？!?]+)/
 *
 * Capture-group convention: if you want the delimiter re-attached to the
 * preceding chunk (matches default behavior), wrap your delimiter in `(...)`
 * — e.g. `"([\\n]+)"` not `"[\\n]+"`. We don't auto-wrap; that would require
 * parsing escaped/character-class/non-capturing groups.
 *
 * Validation (length cap, regex compilability, array size) is enforced by
 * `validateSplitPattern` upstream — this function trusts its inputs.
 *
 * @param {string} messageContent
 * @param {string | string[] | null} [splitPattern=null]
 * @returns {string[]}
 */
function splitMessageIntoSentences(messageContent, splitPattern = null) {
  const sources =
    splitPattern == null ? null :
    Array.isArray(splitPattern) ? splitPattern :
    [splitPattern];

  const regexes = (sources && sources.length > 0)
    ? sources.map(s => new RegExp(s))
    : [DEFAULT_SPLIT_REGEX];

  let chunks = [messageContent];
  for (const regex of regexes) {
    chunks = chunks.flatMap(c => splitOnceByRegex(c, regex));
  }

  return chunks.length > 0 ? chunks : [messageContent];
}

/**
 * Pick the right split-pattern field + disable semantics for a given
 * `messageKind`. The three kinds split with different defaults:
 *
 *   | messageKind    | field on payload          | default when field is absent |
 *   |----------------|---------------------------|------------------------------|
 *   | `content`      | `splitPattern`            | sentence regex (split on)    |
 *   | `tool_request` | `splitPattern`            | sentence regex (split on)    |
 *   | `reasoning`    | `reasoningSplitPattern`   | **no split**                 |
 *   | `error`        | `errorSplitPattern`       | **no split**                 |
 *
 * Disable semantics in all four cases: an explicit `null` or `[]`
 * disables splitting. The asymmetry is in `undefined` (i.e. caller
 * omitted the field): for `content` / `tool_request` that means "use
 * default sentence regex" (preserves 0.6 UX); for `reasoning` /
 * `error` it means "do not split" (the kinds that didn't have a UX
 * for splitting historically).
 *
 * Per-push override (0.8.0-next.3+): when the hook returns a
 * `pushPayload` that owns a `splitPattern` field, the resolved
 * `pushPattern` argument carries that value and takes precedence over
 * the kind-specific request field above. The override is kind-
 * agnostic (just `splitPattern` — the kind is already pinned by
 * `pushPayload.messageKind`), so disable semantics collapse to the
 * shared `null` / `[]` rule and never fall back to default-on. Callers
 * pass `pushOverridePresent = false` when the field is absent so the
 * request-level fallback kicks in.
 *
 * @param {Record<string, unknown>} payload
 * @param {unknown} kind
 * @param {unknown} pushPattern        - The hook-returned override (only consulted when `pushOverridePresent`).
 * @param {boolean} pushOverridePresent - True iff `pushPayload` owned `splitPattern` (even when `null`).
 * @returns {{ textField: 'message' | 'reasoningContent', pattern: unknown, disabled: boolean } | null}
 *   `null` when the kind is not splittable (unknown / free-form kinds
 *   with no override). An override on a free-form kind still applies
 *   when there's a usable text field — see `splitHookPushPayload`.
 */
function pickSplitConfig(payload, kind, pushPattern, pushOverridePresent) {
  // Resolve text-field by kind. Per-push override flips disable
  // semantics to "explicit null/[] = off; anything else = use it".
  const resolveDisabled = (pattern) =>
    pattern === null || (Array.isArray(pattern) && pattern.length === 0);

  if (kind === 'content' || kind === 'tool_request') {
    if (pushOverridePresent) {
      return { textField: 'message', pattern: pushPattern, disabled: resolveDisabled(pushPattern) };
    }
    const pattern = payload.splitPattern;
    const disabled = pattern === null
      || (Array.isArray(pattern) && pattern.length === 0);
    return { textField: 'message', pattern, disabled };
  }
  if (kind === 'reasoning') {
    if (pushOverridePresent) {
      // Per-push override skips the request-level "default-off"
      // asymmetry: if the hook went out of its way to set the field
      // on the push, treat any non-null/non-[] value as "split with
      // this pattern" — same rule as content/tool_request override.
      return { textField: 'reasoningContent', pattern: pushPattern, disabled: resolveDisabled(pushPattern) };
    }
    const pattern = payload.reasoningSplitPattern;
    // Default-off: undefined / null / [] all mean "do not split".
    const disabled = pattern === undefined
      || pattern === null
      || (Array.isArray(pattern) && pattern.length === 0);
    return { textField: 'reasoningContent', pattern, disabled };
  }
  if (kind === 'error') {
    if (pushOverridePresent) {
      return { textField: 'message', pattern: pushPattern, disabled: resolveDisabled(pushPattern) };
    }
    const pattern = payload.errorSplitPattern;
    // Default-off, same as reasoning.
    const disabled = pattern === undefined
      || pattern === null
      || (Array.isArray(pattern) && pattern.length === 0);
    return { textField: 'message', pattern, disabled };
  }
  return null;
}

/**
 * Per-kind splitter. Given a `pushPayload` and the request `payload`
 * (which carries the kind-specific split-pattern fields), apply the
 * right pattern to the kind's text field and return an array of
 * one-per-push payloads ready for sequential delivery.
 *
 * Routing per `messageKind`:
 *   - `'content'`      → reads `payload.splitPattern`, splits `message`
 *   - `'reasoning'`    → reads `payload.reasoningSplitPattern`, splits
 *                        `reasoningContent` (default-off)
 *   - `'tool_request'` → reads `payload.splitPattern`, splits
 *                        `message`; `toolCalls` binds to the LAST
 *                        prefix chunk (emitted as `tool_request`).
 *                        Chunks 0..N-2 are demoted to `messageKind:
 *                        'content'` (without `toolCalls`) so the
 *                        narration finishes BEFORE the client starts
 *                        executing tools.
 *   - `'error'`        → reads `payload.errorSplitPattern`, splits
 *                        `message` (default-off)
 *   - anything else    → passthrough; the framework can't guess which
 *                        field of a free-form hook payload to split.
 *
 * Per-push override (0.8.0-next.3+): when the hook-returned
 * `pushPayload` owns a `splitPattern` field, it takes precedence over
 * the kind-specific request field — including disabling the default
 * split with `splitPattern: null` on a `content` push. The field is
 * shape-validated (same caps as request-level via
 * `validateSplitPattern`); malformed override throws `HookError`. The
 * directive is stripped before delivery so it never appears on the
 * wire, regardless of whether the split actually fired.
 *
 * The original payload's `toolCalls`, `metadata`, and all push
 * metadata fields (`messageType` / `source` / `sessionId` / `timestamp`
 * / `messageKind` / `messageSubtype` / `taskId`) are preserved
 * verbatim per chunk. Only `messageId` is regenerated per chunk
 * (independent IDs, shared sessionId) and `messageIndex` /
 * `totalMessages` are populated 1-based.
 *
 * @param {unknown} pushPayload
 * @param {Record<string, unknown>} payload    - The validated request payload.
 * @returns {Array<unknown>}  - Length ≥ 1. Single-element when not
 *                              splittable or when the split produces
 *                              one chunk (so callers always loop).
 */
function splitHookPushPayload(pushPayload, payload) {
  if (!pushPayload || typeof pushPayload !== 'object' || Array.isArray(pushPayload)) {
    return [pushPayload];
  }
  const pushObj = /** @type {Record<string, unknown>} */ (pushPayload);
  const kind = pushObj.messageKind;

  // Extract + validate the per-push override (if any) and produce a
  // clean copy of pushObj that never carries `splitPattern` downstream
  // — both single-chunk passthrough returns and N-chunk maps below
  // use `cleanPushObj` so the directive can't leak onto the wire.
  //
  // `undefined` is treated as **absent** (same convention as
  // request-level fields and as plain JS "value not really set"), so
  // `pushPayload.splitPattern: undefined` falls back to the request-
  // level field rather than being interpreted as a degenerate
  // override. Only a non-`undefined` value (including `null` / `[]`)
  // counts as an override. `JSON.stringify` already drops `undefined`
  // properties at the wire layer, so the `undefined` case needs no
  // explicit strip.
  const pushPattern = pushObj.splitPattern;
  const pushOverridePresent = pushPattern !== undefined;
  let cleanPushObj = pushObj;
  if (pushOverridePresent) {
    const validationErr = validateSplitPattern(pushPattern);
    if (validationErr) {
      // Same severity as other pushPayload-shape contract violations
      // (see `sendPushWithMaybeBlob`): surface as HookError so the
      // caller's hook author sees a loud failure instead of a silent
      // unsplit push. `validateSplitPattern` labels its errors with
      // the literal "splitPattern" prefix (shared with the request-
      // level validator) — strip it so the HookError doesn't read
      // "pushPayload.splitPattern invalid: splitPattern ...".
      const cleanedErr = validationErr.replace(
        /^splitPattern(\[\d+\])?\s*/,
        (_m, idx) => idx ? `${idx} ` : '',
      );
      throw new HookError(`pushPayload.splitPattern invalid: ${cleanedErr}`);
    }
    const { splitPattern: _strip, ...rest } = pushObj;
    cleanPushObj = rest;
  }

  const cfg = pickSplitConfig(payload || {}, kind, pushPattern, pushOverridePresent);
  if (!cfg || cfg.disabled) return [cleanPushObj];

  const text = cleanPushObj[cfg.textField];
  if (typeof text !== 'string' || text.length === 0) return [cleanPushObj];

  const segments = splitMessageIntoSentences(text, cfg.pattern);
  if (segments.length <= 1) return [cleanPushObj];

  const total = segments.length;
  return segments.map((segment, i) => {
    const isLast = i === total - 1;
    const chunkMessageId = `msg_${randomUUID()}_chunk_${i}`;

    if (kind === 'tool_request' && !isLast) {
      // Demote prefix chunks to ContentPush — drop `toolCalls` so the
      // client UI doesn't try to execute the tool N times. The last
      // chunk (below) keeps the original kind + toolCalls intact.
      const { toolCalls: _drop, ...rest } = cleanPushObj;
      return {
        ...rest,
        messageKind: 'content',
        messageId: chunkMessageId,
        message: segment,
        messageIndex: i + 1,
        totalMessages: total,
      };
    }

    return {
      ...cleanPushObj,
      messageId: chunkMessageId,
      [cfg.textField]: segment,
      messageIndex: i + 1,
      totalMessages: total,
    };
  });
}

/**
 * Deliver `pushPayloads` sequentially via `sendPushWithMaybeBlob`,
 * spacing `SLEEP_BETWEEN_MESSAGES_MS` (1500 ms) between consecutive
 * pushes. Each push goes through `sendPushWithMaybeBlob` so the blob
 * detour still applies per-push.
 *
 * Per-push auto-fill (mutates the push object in place — the hook
 * returned a plain literal, we own it from this point):
 *   - `messageId`     — only when the hook didn't set one (auto-fill
 *                       with `msg_<uuid>_chunk_<i>` so deduplication
 *                       on the SW side works across retries).
 *   - `messageIndex`  — always overwritten (1-based) with the array index.
 *   - `totalMessages` — always overwritten with `pushPayloads.length`.
 *
 * Throws on the first failed push; subsequent pushes are not attempted.
 * Callers decide whether to surface the throw or treat the partial
 * delivery as best-effort.
 *
 * @param {Array<Record<string, unknown>>} pushPayloads
 * @param {Record<string, unknown>} payload
 * @param {Object} ctx
 * @param {string} sessionId
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<number>}
 */
async function sendPushesSequentially(pushPayloads, payload, ctx, sessionId, sleep) {
  const total = pushPayloads.length;
  for (let i = 0; i < total; i++) {
    const push = pushPayloads[i];
    if (push.messageId === undefined) {
      push.messageId = `msg_${randomUUID()}_chunk_${i}`;
    }
    push.messageIndex = i + 1;
    push.totalMessages = total;
    await sendPushWithMaybeBlob(push, payload, ctx, sessionId);
    if (i < total - 1) {
      await sleep(SLEEP_BETWEEN_MESSAGES_MS);
    }
  }
  return total;
}

// ─── Reasoning two-layer cascade ────────────────────────────────────────

/**
 * Expand a single `ReasoningPush` into the flat leaf array of pushes
 * the framework will actually deliver, applying the two-layer cascade:
 *
 *   Layer 1 — semantic split via `payload.reasoningSplitPattern`
 *             (delegates to `splitHookPushPayload`). Default-off;
 *             when set, produces M segments carrying
 *             `messageIndex` / `totalMessages`.
 *
 *   Layer 2 — UTF-8 byte chunking via `reasoningChunkBytes` ctx
 *             knob. Default-on (threshold 2000 B); when a Layer-1
 *             segment exceeds the threshold, the segment is sliced at
 *             codepoint boundaries (via `chunkReasoningByUtf8Bytes`)
 *             into N sub-pushes carrying `chunkIndex` / `totalChunks`.
 *             `null` disables Layer 2 entirely — oversized segments
 *             then fall through to `sendPushWithMaybeBlob` and either
 *             hit BlobStore (if configured) or throw
 *             `PayloadTooLargeError`.
 *
 * Layer 1 fields (messageIndex / totalMessages) come straight from
 * `splitHookPushPayload`. Layer 2 fields (chunkIndex / totalChunks)
 * are added per-leaf when N > 1; otherwise the leaf wire-matches the
 * pre-byte-chunking shape byte-for-byte.
 *
 * `messageId` is regenerated per leaf so each push has a unique id:
 *   `msg_<uuid>_iter_<iteration>_reasoning_chunk_<chunkIndex>`
 *
 * @param {Object} reasoningPush
 * @param {Object} payload
 * @param {number | null | undefined} reasoningChunkBytes
 * @param {number | undefined} iteration   - 0 for legacy path, the agentic-loop iteration otherwise.
 * @returns {Array<Object>}
 */
function expandReasoningPushChunks(reasoningPush, payload, reasoningChunkBytes, iteration) {
  // Layer 1: defer to the shared splitter. Returns 1 element when
  // `reasoningSplitPattern` is unset/disabled; ≥2 when sentence split
  // produces multiple segments.
  const layer1 = splitHookPushPayload(reasoningPush, payload);

  // Resolve the byte threshold:
  //   - `null`     → Layer 2 explicitly disabled
  //   - `undefined`→ ctx didn't carry the resolved option (callers that
  //                  invoke `processInstantMessage` directly, e.g. tests).
  //                  Fall back to the same default as `createInstantHandler`.
  //   - positive integer → use as threshold
  if (reasoningChunkBytes === null) return layer1;
  const threshold = (Number.isInteger(reasoningChunkBytes) && reasoningChunkBytes >= 4)
    ? reasoningChunkBytes
    : DEFAULT_REASONING_CHUNK_BYTES;

  /** @type {Array<Object>} */
  const out = [];
  for (const segment of layer1) {
    const text = segment && typeof segment === 'object'
      ? /** @type {{reasoningContent?: unknown}} */ (segment).reasoningContent
      : undefined;
    if (typeof text !== 'string' || text.length === 0) {
      out.push(segment);
      continue;
    }
    const byteLen = PUSH_PAYLOAD_BYTE_ENCODER.encode(text).byteLength;
    if (byteLen <= threshold) {
      out.push(segment);
      continue;
    }
    const pieces = chunkReasoningByUtf8Bytes(text, threshold);
    const totalChunks = pieces.length;
    const iterTag = Number.isInteger(iteration) ? iteration : 0;
    for (let i = 0; i < totalChunks; i++) {
      out.push({
        ...segment,
        messageId: `msg_${randomUUID()}_iter_${iterTag}_reasoning_chunk_${i + 1}`,
        reasoningContent: pieces[i],
        chunkIndex: i + 1,
        totalChunks,
      });
    }
  }
  return out;
}

/**
 * Ship a `ReasoningPush` through the two-layer cascade. Serial
 * delivery with `SLEEP_BETWEEN_REASONING_CHUNKS_MS` (100 ms) between
 * Layer-2 chunks of the same Layer-1 segment, and
 * `SLEEP_BETWEEN_MESSAGES_MS` (1500 ms) between Layer-1 segments —
 * the larger gap preserves typing-bubble UX between sentences while
 * the smaller gap keeps byte-chunking latency low.
 *
 * Fires a single `reasoning_chunked` event when Layer 2 actually
 * produces > 1 chunk (independent of Layer 1 count) so operators see
 * the byte-chunking trigger without per-chunk event noise.
 *
 * @param {Object} reasoningPush
 * @param {Object} payload
 * @param {Object} ctx
 * @param {string} sessionId
 * @param {(ms: number) => Promise<void>} sleep
 * @param {number | undefined} iteration
 * @returns {Promise<number>}  Total leaves shipped.
 */
async function emitReasoning(reasoningPush, payload, ctx, sessionId, sleep, iteration) {
  const leaves = expandReasoningPushChunks(reasoningPush, payload, ctx.reasoningChunkBytes, iteration);

  // Detect "byte chunking actually fired" — i.e. at least one leaf
  // carries chunkIndex/totalChunks. We don't fire on Layer-1-only
  // splits (those are user-configured semantic splits, not transport
  // overflow events).
  const byteChunked = leaves.some(
    (l) => l && typeof l === 'object' && /** @type {{totalChunks?: unknown}} */ (l).totalChunks !== undefined
  );
  if (byteChunked) {
    const onEvent = typeof ctx.onEvent === 'function' ? ctx.onEvent : () => {};
    const totalBytes = typeof reasoningPush.reasoningContent === 'string'
      ? PUSH_PAYLOAD_BYTE_ENCODER.encode(reasoningPush.reasoningContent).byteLength
      : 0;
    const evt = { type: 'reasoning_chunked', sessionId, totalChunks: leaves.length, totalBytes };
    if (Number.isInteger(iteration)) evt.iteration = iteration;
    onEvent(evt);
  }

  for (let i = 0; i < leaves.length; i++) {
    await sendPushWithMaybeBlob(leaves[i], payload, ctx, sessionId);
    if (i < leaves.length - 1) {
      // Same Layer-1 segment iff messageIndex matches (or neither has
      // one — Layer 1 was disabled, all leaves are byte chunks of a
      // single segment).
      const cur = leaves[i];
      const next = leaves[i + 1];
      const curIdx = cur && typeof cur === 'object'
        ? /** @type {{messageIndex?: unknown}} */ (cur).messageIndex : undefined;
      const nextIdx = next && typeof next === 'object'
        ? /** @type {{messageIndex?: unknown}} */ (next).messageIndex : undefined;
      const sameSegment = curIdx === nextIdx;
      await sleep(sameSegment ? SLEEP_BETWEEN_REASONING_CHUNKS_MS : SLEEP_BETWEEN_MESSAGES_MS);
    }
  }
  return leaves.length;
}

/**
 * Normalize the AI API URL for OpenAI-compatible chat endpoints.
 *
 * Rules (idempotent — running it twice is the same as running it once):
 *   - Already ends with `/chat/completions`           → leave as-is.
 *   - Bare host (no path or just `/`)                  → append `/v1/chat/completions`.
 *   - Path ends with a version segment like `/v1`,
 *     `/v2`, … (with or without trailing slash)       → append only `/chat/completions`
 *     (never doubles `/v1` for callers who already
 *      include it).
 *   - Anything else (custom path that doesn't match
 *     the OpenAI shape, e.g. `/v1/messages` for
 *     Anthropic-style proxies, or `/openai/api/foo`)   → leave as-is. We don't
 *     guess — the caller knows their own routing.
 *
 * The query string is preserved verbatim.
 *
 * @param {string} apiUrl
 * @returns {string}
 */
export function normalizeAiApiUrl(apiUrl) {
  const trimmed = String(apiUrl || '').trim();
  if (!trimmed) {
    throw new Error(
      'Invalid apiUrl: apiUrl is required. Please provide a chat endpoint URL ' +
      '(for example: https://api.openai.com or https://api.openai.com/v1/chat/completions).'
    );
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `Invalid apiUrl: "${apiUrl}". Please provide a valid absolute URL.`
    );
  }

  let path = parsed.pathname.replace(/\/+$/, '') || '/';

  if (/\/chat\/completions$/.test(path)) {
    // Already a complete OpenAI-style endpoint. Don't double-suffix.
  } else if (path === '/') {
    // Bare host → assume OpenAI shape.
    path = '/v1/chat/completions';
  } else if (/\/v\d+$/.test(path)) {
    // Path ends in a version segment (e.g. `/v1`, `/v2`). User already
    // versioned the URL — just append `/chat/completions`, never re-add `/v1`.
    path = `${path}/chat/completions`;
  }
  // Any other custom path is left untouched on purpose.

  parsed.pathname = path;
  return parsed.toString();
}

function buildAiRequestBody(payload) {
  // messages mode: forward the caller's OpenAI-style array verbatim. No auto
  // role injection, no concatenation back to a single user message — the
  // point of this branch is to let the upstream app preserve system / multi-
  // turn context across the instant-push path.
  const llmMessages = payload.messages
    ? payload.messages
    : [{ role: 'user', content: payload.completePrompt }];

  const body = {
    model: payload.primaryModel,
    messages: llmMessages,
    // Instant path is one-shot, non-streaming by contract.
    stream: false,
  };

  // Default temperature only when caller didn't pick one AND we're in the
  // legacy completePrompt path. In messages mode we forward whatever the
  // upstream app set (or nothing) so behavior matches their main chat path
  // byte-for-byte.
  if (payload.temperature !== undefined && payload.temperature !== null) {
    body.temperature = payload.temperature;
  } else if (!payload.messages) {
    body.temperature = 0.8;
  }

  if (payload.maxTokens === undefined || payload.maxTokens === null) {
    return body;
  }

  if (!Number.isInteger(payload.maxTokens) || payload.maxTokens <= 0) {
    throw new Error('Invalid maxTokens: must be a positive integer when provided.');
  }

  body.max_tokens = payload.maxTokens;
  return body;
}

/**
 * Raw LLM call. Returns the full response object so callers can read
 * `choices[0].message.reasoning_content` and `tool_calls` along with
 * the content string.
 *
 * When `requireContent` is true (legacy path), a missing /
 * empty-string `choices[0].message.content` is a hard error — that
 * mirrors v0.6 behaviour. When false (hook path), an empty content is
 * acceptable: a pure `tool_calls` response legitimately has no text.
 *
 * @param {Object} payload
 * @param {Function} fetchImpl
 * @param {boolean} requireContent
 * @returns {Promise<{ response: unknown, content: string }>}
 */
async function callLlmRaw(payload, fetchImpl, requireContent) {
  const url = normalizeAiApiUrl(payload.apiUrl);
  const requestBody = buildAiRequestBody(payload);

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${payload.apiKey}`
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(300000)
  });

  if (!res.ok) {
    if (res.status === 405) {
      throw new Error(
        'AI API error: 405 Method Not Allowed. apiUrl must point to a full chat endpoint ' +
        `(for example: /chat/completions). Received: ${url}`
      );
    }
    const statusText = res.statusText || 'Unknown Error';
    throw new Error(`AI API error: ${res.status} ${statusText}. Request URL: ${url}`);
  }

  const data = await res.json();
  const rawContent = data?.choices?.[0]?.message?.content;
  if (requireContent) {
    if (typeof rawContent !== 'string' || !rawContent.trim()) {
      throw new Error('AI API error: response missing choices[0].message.content');
    }
  }
  return {
    response: data,
    content: typeof rawContent === 'string' ? rawContent : '',
  };
}

/**
 * Read `choices[0].message.reasoning_content` as a non-empty trimmed
 * string, or null when absent / empty. Many providers return an
 * empty string instead of omitting the field — treat that the same
 * as missing so we don't emit an empty ReasoningPush.
 *
 * @param {unknown} llmResponse
 * @returns {string | null}
 */
function readReasoningContent(llmResponse) {
  if (!llmResponse || typeof llmResponse !== 'object') return null;
  const choices = /** @type {{ choices?: unknown }} */ (llmResponse).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = /** @type {{ message?: { reasoning_content?: unknown } }} */ (choices[0])?.message;
  const raw = message?.reasoning_content;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Process one instant request. Dispatches between two **independent**
 * paths based on whether the caller provided an `onLLMOutput` hook:
 *
 *   - No hook + not a `/continue` resume → **legacy path**
 *     (`runLegacyInstant`): single LLM call, sentence-split, sequential
 *     pushes with 1500 ms spacing. v0.8 emits an additional
 *     ReasoningPush before the content burst when the LLM response
 *     includes a non-empty `reasoning_content`.
 *
 *   - Hook provided (or `isResume === true`) → **agentic loop**
 *     (`runAgenticLoop`): per-turn LLM call. v0.8 emits a
 *     ReasoningPush BEFORE invoking the hook when the LLM response
 *     includes `reasoning_content` (skippable via
 *     `autoEmitReasoning: false`). The hook then decides via the
 *     same 4-decision contract; the hook's `pushPayload` is what
 *     `sw` will route as the kind-specific content push.
 *
 * @param {Object} payload  - Validated request body.
 * @param {Object} ctx
 * @param {{ email: string, publicKey: string, privateKey: string }} ctx.vapid
 * @param {Function} [ctx.fetch]
 * @param {Function} [ctx.sleep]
 * @param {(e: object) => void} [ctx.onEvent]
 * @param {(c: import('./session-context.js').SessionContext) =>
 *   Promise<object> | object} [ctx.onLLMOutput]
 * @param {import('./blob-store/interface.js').BlobStoreConfig} [ctx.blobStore]
 * @param {number} [ctx.maxLoopIterations]
 * @param {string} [ctx.requestUrl]
 * @param {boolean} [ctx.isResume]
 * @param {boolean} [ctx.autoEmitReasoning=true] - Hook path only. When
 *   `false`, the framework will not auto-emit ReasoningPush before
 *   invoking the hook — callers wanting reasoning emission must build
 *   it themselves with `buildReasoningPush` and push it via their own
 *   `pushPayload`.
 * @returns {Promise<object>}
 */
export async function processInstantMessage(payload, ctx) {
  if (!ctx.onLLMOutput && !ctx.isResume) {
    return runLegacyInstant(payload, ctx);
  }
  return runAgenticLoop(payload, ctx);
}

/**
 * Legacy path — single LLM call, sentence-split, sequential push.
 * v0.8: emits a ReasoningPush before the content burst when
 * `reasoning_content` is present in the LLM response.
 *
 * @param {Object} payload
 * @param {Object} ctx
 * @returns {Promise<{ messagesSent: number, sentAt: string, sessionId: string }>}
 */
async function runLegacyInstant(payload, ctx) {
  const fetchImpl = ctx.fetch || globalThis.fetch;
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const onEvent = typeof ctx.onEvent === 'function' ? ctx.onEvent : () => {};

  // sessionId is shared across all pushes from this legacy invocation:
  // an optional ReasoningPush + N ContentPush sentences. Callers can
  // pass `sessionId` to pin it across retries; otherwise mint one.
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId
    ? payload.sessionId
    : `sess_${randomUUID()}`;

  let llmResponse;
  let messageContent;
  try {
    const { response, content } = await callLlmRaw(payload, fetchImpl, /*requireContent=*/true);
    llmResponse = response;
    messageContent = content.trim();
    onEvent({ type: 'llm_done', sessionId });
  } catch (err) {
    const error = new Error(err?.message || 'LLM call failed');
    error.code = 'LLM_CALL_FAILED';
    throw error;
  }

  const pushSubscription = payload.pushSubscription;
  const contactName = payload.contactName;
  const avatarUrl = payload.avatarUrl || null;
  const messageSubtype = payload.messageSubtype || 'chat';
  const metadata = payload.metadata || {};

  // Step 1: ReasoningPush if reasoning_content present. Emitted before
  // the content burst so clients can render a "thinking…" UI ahead of
  // the actual reply.
  const reasoning = readReasoningContent(llmResponse);
  if (reasoning) {
    const reasoningPush = buildReasoningPush({
      messageType: 'instant',
      source: 'instant',
      messageId: `msg_${randomUUID()}_instant_reasoning`,
      sessionId,
      reasoningContent: reasoning,
      timestamp: new Date().toISOString(),
      title: `来自 ${contactName}`,
      contactName,
      avatarUrl,
      messageSubtype,
      metadata,
    });

    // Best-effort: a failed reasoning push must NOT eclipse the
    // user-facing content burst. Mirrors the hook path's
    // `reasoning_push_failed` event (runAgenticLoop).
    //
    // Two-layer cascade via `emitReasoning`:
    //   Layer 1 — `payload.reasoningSplitPattern` (default off, sentence split)
    //   Layer 2 — `ctx.reasoningChunkBytes`     (default 2000, byte chunking)
    // Single reasoning < threshold + no sentence pattern → wire matches pre-next.2 exactly.
    let reasoningShipped = false;
    try {
      // Legacy path has no "iteration" — pass undefined so messageId
      // template falls back to `iter_0` and the `reasoning_chunked`
      // event omits the field.
      await emitReasoning(reasoningPush, payload, ctx, sessionId, sleep, undefined);
      reasoningShipped = true;
      onEvent({ type: 'reasoning_pushed', sessionId });
    } catch (err) {
      onEvent({ type: 'reasoning_push_failed', sessionId, cause: err });
    }

    // Only space the burst when the reasoning push actually shipped —
    // skipping the sleep when it failed shaves 1.5s off the perceived
    // latency for that case.
    if (reasoningShipped) {
      await sleep(SLEEP_BETWEEN_MESSAGES_MS);
    }
  }

  // Step 2: ContentPush burst.
  const messages = splitMessageIntoSentences(messageContent, payload.splitPattern ?? null);

  for (let i = 0; i < messages.length; i++) {
    const contentPush = buildContentPush({
      messageType: 'instant',
      source: 'instant',
      messageId: `msg_${randomUUID()}_instant_${i}`,
      sessionId,
      message: messages[i],
      timestamp: new Date().toISOString(),
      title: `来自 ${contactName}`,
      contactName,
      avatarUrl,
      messageSubtype,
      messageIndex: i + 1,
      totalMessages: messages.length,
      taskId: null,
      metadata,
    });

    try {
      await sendWebPush({
        subscription: pushSubscription,
        payload: JSON.stringify(contentPush),
        vapid: ctx.vapid,
        fetch: fetchImpl,
      });
      onEvent({ type: 'push_sent', messageIndex: i + 1, totalMessages: messages.length, sessionId });
    } catch (err) {
      const error = new Error(err?.message || 'Web Push delivery failed');
      error.code = 'PUSH_SEND_FAILED';
      error.statusCode = err?.statusCode;
      error.messageIndex = i + 1;
      throw error;
    }

    if (i < messages.length - 1) {
      await sleep(SLEEP_BETWEEN_MESSAGES_MS);
    }
  }

  return {
    messagesSent: messages.length,
    sentAt: new Date().toISOString(),
    sessionId,
  };
}

/**
 * Agentic-loop path. Repeats:
 *   call LLM → [auto-emit ReasoningPush if configured] → buildSessionContext →
 *   onLLMOutput(ctx) → dispatch.
 *
 * Hard cap at `maxLoopIterations` (default 10): once exceeded, the
 * worker emits `loop_exceeded`, pushes an ErrorPush diagnostic, and
 * returns HTTP 200 with `{ status: 'loop_exceeded', ... }`.
 * Loop-exceeded is NOT thrown — the worker has completed its
 * "deliver a diagnostic" contract.
 *
 * @param {Object} payload
 * @param {Object} ctx
 * @returns {Promise<object>}
 */
async function runAgenticLoop(payload, ctx) {
  const fetchImpl = ctx.fetch || globalThis.fetch;
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const onEvent = typeof ctx.onEvent === 'function' ? ctx.onEvent : () => {};
  const maxLoopIterations = Number.isInteger(ctx.maxLoopIterations) && ctx.maxLoopIterations > 0
    ? ctx.maxLoopIterations
    : DEFAULT_MAX_LOOP_ITERATIONS;
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId
    ? payload.sessionId
    : randomUUID();
  // Default true: most hook callers want reasoning emission to "just
  // work". Set false when the hook caller wants total control over
  // every push that leaves the worker.
  const autoEmitReasoning = ctx.autoEmitReasoning !== false;

  if (ctx.isResume) {
    onEvent({ type: 'continue_received', sessionId, iteration: payload.iteration ?? 0 });
  }

  let messages = Array.isArray(payload.messages) ? payload.messages.slice() : [];
  let iteration = Number.isInteger(payload.iteration) ? payload.iteration : 0;

  while (iteration < maxLoopIterations) {
    onEvent({ type: 'llm_start', sessionId, iteration });
    let llmResponse;
    try {
      const { response } = await callLlmRaw({ ...payload, messages }, fetchImpl, /*requireContent=*/false);
      llmResponse = response;
    } catch (err) {
      onEvent({ type: 'llm_call_failed', sessionId, iteration, cause: err });
      throw new LlmCallError(err?.message || 'LLM call failed', { cause: err });
    }
    onEvent({ type: 'llm_done', sessionId, iteration });

    // Append the full assistant message — `tool_calls` /
    // `reasoning_content` / `refusal` survive into the next round.
    const assistantMessage = extractAssistantMessage(llmResponse);
    messages = [...messages, assistantMessage];

    // Auto-emit ReasoningPush BEFORE the hook so the hook can still
    // `skip-push` its own content push without losing the reasoning
    // signal. Best-effort: if the auto-push throws, the loop turns it
    // into a `reasoning_push_failed` event and continues — never let
    // an instrumentation push eclipse the user-facing path.
    if (autoEmitReasoning) {
      const reasoning = readReasoningContent(llmResponse);
      if (reasoning) {
        const reasoningPush = buildReasoningPush({
          messageType: 'instant',
          source: 'instant',
          messageId: `msg_${randomUUID()}_iter_${iteration}_reasoning`,
          sessionId,
          reasoningContent: reasoning,
          timestamp: new Date().toISOString(),
          title: payload.contactName ? `来自 ${payload.contactName}` : undefined,
          contactName: payload.contactName,
          avatarUrl: payload.avatarUrl || null,
          messageSubtype: payload.messageSubtype || 'chat',
          metadata: payload.metadata || {},
        });
        try {
          // Two-layer cascade — Layer 1 (`reasoningSplitPattern`,
          // default off) then Layer 2 (`reasoningChunkBytes`, default
          // 2000 B). Default config: single short reasoning ships as
          // one push (wire-identical to pre-next.2); long reasoning
          // auto-chunks with `chunkIndex`/`totalChunks`.
          await emitReasoning(reasoningPush, payload, ctx, sessionId, sleep, iteration);
          onEvent({ type: 'reasoning_pushed', sessionId, iteration });
        } catch (err) {
          // Don't fail the whole turn for a reasoning instrumentation
          // push — log it and continue. The user-facing content/tool
          // path is still going to run.
          onEvent({ type: 'reasoning_push_failed', sessionId, iteration, cause: err });
        }
      }
    }

    const sessionCtx = buildSessionContext({
      sessionId,
      messages,
      llmResponse,
      iteration,
      contactName: payload.contactName,
      avatarUrl: payload.avatarUrl,
      charId: payload.charId,
      metadata: payload.metadata,
    });

    let decision;
    try {
      decision = await ctx.onLLMOutput(sessionCtx);
      assertValidDecision(decision);
    } catch (err) {
      onEvent({ type: 'hook_threw', sessionId, iteration, cause: err });
      const diagnostic = buildErrorPush({
        messageType: 'instant',
        source: 'instant',
        messageId: `msg_${randomUUID()}_iter_${iteration}_error`,
        sessionId,
        code: 'HOOK_THREW',
        message: err?.message ?? 'onLLMOutput hook threw',
        iteration,
        timestamp: new Date().toISOString(),
      });
      try {
        await sendWebPush({
          subscription: payload.pushSubscription,
          payload: JSON.stringify(diagnostic),
          vapid: ctx.vapid,
          fetch: fetchImpl,
        });
      } catch (pushErr) {
        onEvent({ type: 'diagnostic_push_failed', code: 'HOOK_THREW', sessionId, cause: pushErr });
      }
      throw new HookError(`onLLMOutput threw: ${err?.message ?? err}`, { cause: err });
    }

    if (decision.decision === 'continue') {
      // `nextHistory` REPLACES messages — that's the documented
      // contract, even though most callers will want to do
      // `[...ctx.messages, toolResult]`. README §"continue +
      // nextHistory footgun" warns about this.
      messages = Array.isArray(decision.nextHistory) ? decision.nextHistory.slice() : [];
      iteration++;
      continue;
    }

    if (decision.decision === 'skip-push') {
      return { status: 'skipped', sessionId, iteration };
    }

    // 'finish' or 'tool-request' — deliver pushPayloads sequentially.
    // The lib does no splitting; the hook returned the exact N pushes.
    // Reasoning pushes coming from the hook flow through the same
    // delivery path — `autoEmitReasoning` (default on) handles the
    // framework-emitted ReasoningPush that comes from the LLM's
    // `reasoning_content` field BEFORE the hook fires, and Task 4
    // rewires `emitReasoning` to a single-layer byte-chunker. Hooks
    // wanting custom reasoning chunking now slice themselves and pass
    // the pieces as individual `pushPayloads` entries.
    const messagesSent = await sendPushesSequentially(
      decision.pushPayloads,
      payload,
      ctx,
      sessionId,
      sleep,
    );
    onEvent({
      type: decision.decision === 'finish' ? 'final_pushed' : 'tool_request_pushed',
      sessionId,
      iteration,
      messagesSent,
    });
    return { status: decision.decision === 'finish' ? 'finished' : 'tool_requested', sessionId, iteration };
  }

  // Loop budget exhausted: emit, attempt diagnostic push, return 200.
  onEvent({ type: 'loop_exceeded', sessionId, iteration });
  const diagnostic = buildErrorPush({
    messageType: 'instant',
    source: 'instant',
    messageId: `msg_${randomUUID()}_loop_exceeded`,
    sessionId,
    code: 'LOOP_EXCEEDED',
    message: `Agentic loop exceeded ${maxLoopIterations} iterations`,
    iteration,
    timestamp: new Date().toISOString(),
  });
  try {
    // The diagnostic is a single push by construction (one
    // `buildErrorPush(...)` call above); no looping needed.
    await sendPushWithMaybeBlob(diagnostic, payload, ctx, sessionId);
  } catch (err) {
    onEvent({ type: 'diagnostic_push_failed', code: 'LOOP_EXCEEDED', sessionId, cause: err });
  }
  return { status: 'loop_exceeded', sessionId, iteration };
}

/**
 * Assert that the hook returned a structurally valid decision.
 * TypeScript discriminated unions don't survive into runtime, and a
 * misbehaving hook can easily return `null` / `{ decision: 'idk' }`
 * / `undefined`. Treat any of those as a hook contract violation so
 * we route through the same HOOK_THREW pipeline.
 *
 * @param {unknown} decision
 */
function assertValidDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    throw new TypeError(`onLLMOutput returned invalid decision: ${stringifyForError(decision)}`);
  }
  const tag = /** @type {{ decision?: unknown }} */ (decision).decision;
  if (typeof tag !== 'string' || !VALID_DECISIONS.has(tag)) {
    throw new TypeError(`onLLMOutput returned invalid decision tag: ${stringifyForError(tag)}`);
  }

  const hasSingular = Object.prototype.hasOwnProperty.call(decision, 'pushPayload');
  const hasPlural = Object.prototype.hasOwnProperty.call(decision, 'pushPayloads');

  if (hasSingular) {
    throw new TypeError(
      hasPlural
        ? 'pushPayload (singular) is removed in next.4, use pushPayloads'
        : 'pushPayload (singular) is removed in next.4, use pushPayloads: [yourPayload]'
    );
  }

  if (tag === 'continue') {
    if (!Array.isArray(/** @type {{ nextHistory?: unknown }} */ (decision).nextHistory)) {
      throw new TypeError('decision:"continue" requires a nextHistory array');
    }
    return;
  }

  if (tag === 'skip-push') {
    return;
  }

  // 'finish' / 'tool-request' — both need pushPayloads array
  if (!hasPlural || !Array.isArray(/** @type {{ pushPayloads?: unknown }} */ (decision).pushPayloads)) {
    throw new TypeError(`decision:"${tag}" requires a pushPayloads array`);
  }
  const pushes = /** @type {Array<unknown>} */ (decision.pushPayloads);
  if (pushes.length === 0) {
    throw new TypeError('pushPayloads: [] — use decision: skip-push to skip notification entirely');
  }
  for (let i = 0; i < pushes.length; i++) {
    const p = pushes[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new TypeError(`pushPayloads[${i}] must be a plain object, got ${stringifyForError(p)}`);
    }
    if (Object.prototype.hasOwnProperty.call(p, 'splitPattern')) {
      throw new TypeError(`pushPayloads[${i}].splitPattern is removed in next.4; caller is responsible for splitting`);
    }
  }
}

function stringifyForError(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Push a payload (any of the four `messageKind` types or a free-form
 * hook payload). If its UTF-8 byte length exceeds `maxInlineBytes`:
 *   - With a `blobStore` configured → write body to the store, push
 *     a small envelope `{ _blob:true, key, url, messageKind?, type? }`
 *     instead.
 *   - Without → emit `payload_too_large` and throw
 *     `PayloadTooLargeError`.
 *
 * The envelope's `messageKind` (and legacy `type`) field is lifted
 * from the original payload when present, so the SW can dispatch on
 * the discriminator without having to fetch the blob first.
 *
 * The byte check uses **UTF-8 bytes**, not JS string `.length`.
 * String `.length` counts UTF-16 code units; a Chinese character is
 * `.length === 1` but takes 3 bytes in UTF-8, and using `.length`
 * would let CJK content bypass the cap and trip the push service's
 * 4 KB ciphertext limit.
 *
 * @param {unknown} pushPayload
 * @param {Object} payload   - The validated request payload (carries `pushSubscription`).
 * @param {Object} ctx       - Processor ctx (carries vapid / fetch / blobStore / requestUrl).
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function sendPushWithMaybeBlob(pushPayload, payload, ctx, sessionId) {
  const onEvent = typeof ctx.onEvent === 'function' ? ctx.onEvent : () => {};
  const fetchImpl = ctx.fetch || globalThis.fetch;

  // pushPayload must be JSON-safe. Circular refs / BigInt / function
  // fields throw inside JSON.stringify — that's a hook contract
  // violation, same severity as returning an invalid decision tag,
  // so route through HookError.
  let serialized;
  try {
    serialized = JSON.stringify(pushPayload);
  } catch (err) {
    throw new HookError(`pushPayload is not JSON-serializable: ${err?.message ?? err}`, { cause: err });
  }
  if (typeof serialized !== 'string') {
    throw new HookError('pushPayload serialized to a non-string (likely `undefined`)');
  }

  const byteLen = PUSH_PAYLOAD_BYTE_ENCODER.encode(serialized).byteLength;
  const maxInline = (ctx.blobStore && Number.isInteger(ctx.blobStore.maxInlineBytes) && ctx.blobStore.maxInlineBytes > 0)
    ? ctx.blobStore.maxInlineBytes
    : DEFAULT_MAX_INLINE_BYTES;

  if (byteLen <= maxInline) {
    await sendWebPush({
      subscription: payload.pushSubscription,
      payload: serialized,
      vapid: ctx.vapid,
      fetch: fetchImpl,
    });
    return;
  }

  if (!ctx.blobStore || !ctx.blobStore.adapter) {
    onEvent({ type: 'payload_too_large', byteLen, maxInline, sessionId });
    throw new PayloadTooLargeError(byteLen, maxInline);
  }

  const adapter = ctx.blobStore.adapter;
  const ttl = Number.isInteger(ctx.blobStore.ttlSeconds) && ctx.blobStore.ttlSeconds > 0
    ? ctx.blobStore.ttlSeconds
    : DEFAULT_BLOB_TTL_SECONDS;
  const key = randomUUID();

  try {
    await adapter.put(key, serialized, ttl);
  } catch (err) {
    onEvent({ type: 'blob_put_failed', key, sessionId, cause: err });
    throw new PayloadTooLargeError(byteLen, maxInline, { cause: err });
  }
  onEvent({ type: 'blob_written', key, size: byteLen, sessionId });

  const blobUrl = buildBlobUrl(ctx.requestUrl, key);
  // Lift `messageKind` (and legacy `type`) into the envelope so the
  // SW can dispatch on the discriminator without having to fetch the
  // blob body first.
  const payloadObj = pushPayload && typeof pushPayload === 'object' ? pushPayload : {};
  const envelope = {
    _blob: true,
    key,
    url: blobUrl,
    messageKind: /** @type {{ messageKind?: unknown }} */ (payloadObj).messageKind,
    type: /** @type {{ type?: unknown }} */ (payloadObj).type,
  };

  try {
    await sendWebPush({
      subscription: payload.pushSubscription,
      payload: JSON.stringify(envelope),
      vapid: ctx.vapid,
      fetch: fetchImpl,
    });
  } catch (err) {
    onEvent({ type: 'blob_orphaned', key, size: byteLen, sessionId, cause: err });
    throw err;
  }
}

/**
 * Derive the absolute `/blob/:key` URL the SW should fetch.
 *
 * @param {string | undefined} requestUrl
 * @param {string} key
 * @returns {string}
 */
function buildBlobUrl(requestUrl, key) {
  if (requestUrl) {
    try {
      return new URL(`/blob/${key}`, requestUrl).toString();
    } catch {
      // requestUrl was malformed — fall through.
    }
  }
  return `/blob/${key}`;
}

export { sendPushWithMaybeBlob, readReasoningContent };
