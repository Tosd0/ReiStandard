/**
 * @rei-standard/amsg-shared
 *
 * Lowest layer of the ReiStandard Active Messaging ecosystem.
 * Defines the three-axis push contract that `amsg-instant`,
 * `amsg-server`, `amsg-sw`, and `amsg-client` all conform to.
 *
 * Three orthogonal axes:
 *   1. messageType    — how the push was produced (instant / fixed / prompted / auto)
 *   2. messageSubtype — caller's business classification (free-form string)
 *   3. messageKind    — what the push carries (content / reasoning / tool_request / error)
 *
 * Zero runtime dependencies. The package is ESM/CJS dual-published and
 * intentionally has no `dependencies:` entry — every other amsg sub-
 * package depends on it, never the reverse.
 *
 * Types are expressed via JSDoc `@typedef` unions with literal-type
 * discriminators so TS consumers can narrow on `messageKind`:
 *
 *   if (push.messageKind === 'reasoning') {
 *     // TS knows: push is ReasoningPush, push.reasoningContent is string
 *   }
 */

// ─── Discriminator enums ────────────────────────────────────────────────

/**
 * What the push carries. Fixed enum — packages must not add values.
 *
 * @typedef {'content' | 'reasoning' | 'tool_request' | 'error'} MessageKind
 */

/**
 * How the push was produced. Fixed enum — packages must not add values.
 *
 * @typedef {'instant' | 'fixed' | 'prompted' | 'auto'} MessageType
 */

/**
 * Which sub-package routed the push. Fixed enum — `'instant'` for
 * `amsg-instant` (stateless one-shot), `'scheduled'` for any
 * `amsg-server` output regardless of `messageType`. Packages must not
 * add values.
 *
 * @typedef {'instant' | 'scheduled'} PushSource
 */

/**
 * Runtime constant mirroring the {@link MessageKind} type. Useful for
 * switch statements that need to enumerate every kind:
 *
 *   for (const kind of Object.values(MESSAGE_KIND)) { ... }
 */
export const MESSAGE_KIND = Object.freeze({
  CONTENT: 'content',
  REASONING: 'reasoning',
  TOOL_REQUEST: 'tool_request',
  ERROR: 'error',
});

/**
 * Runtime constant mirroring the {@link MessageType} type.
 */
export const MESSAGE_TYPE = Object.freeze({
  INSTANT: 'instant',
  FIXED: 'fixed',
  PROMPTED: 'prompted',
  AUTO: 'auto',
});

/**
 * Runtime constant mirroring the {@link PushSource} type.
 */
export const PUSH_SOURCE = Object.freeze({
  INSTANT: 'instant',
  SCHEDULED: 'scheduled',
});

// ─── Common shape (fields on every kind) ────────────────────────────────

/**
 * Fields present on every push, regardless of kind. Discriminator
 * fields (`messageKind`) and kind-specific fields live on the kind
 * interfaces below.
 *
 * `metadata` is a passthrough namespace owned by the caller. Packages
 * are forbidden from writing their own fields into `metadata` — any
 * protocol-level data goes on top-level fields.
 *
 * @typedef {Object} AmsgPushCommon
 * @property {MessageType} messageType   - How the push was produced.
 * @property {PushSource}  source        - Which sub-package routed it.
 * @property {string}      messageId     - Unique per push. Format owned by the producer.
 * @property {string}      sessionId     - Shared across all pushes from one LLM round (reasoning + content) and across iterations of a single agentic-loop request.
 * @property {string}      timestamp     - ISO 8601 timestamp at producer.
 * @property {string}      [messageSubtype] - Caller-defined business namespace. Defaults to 'chat' at producers.
 * @property {Object}      [metadata]    - Caller passthrough. Packages MUST NOT write here.
 */

// ─── Per-kind interfaces ────────────────────────────────────────────────

/**
 * Final user-facing content. Sentence-split bursts of N use
 * `messageIndex` (1-based) + `totalMessages` so the client can
 * reassemble or animate.
 *
 * @typedef {AmsgPushCommon & {
 *   messageKind: 'content',
 *   message:       string,
 *   title?:        string,
 *   contactName?:  string,
 *   avatarUrl?:    string | null,
 *   messageIndex?: number,
 *   totalMessages?: number,
 *   taskId?:       string | null,
 * }} ContentPush
 */

/**
 * LLM "meta-thinking" — `choices[0].message.reasoning_content` lifted
 * out of the upstream response into its own push. Emitted **before**
 * the matching {@link ContentPush} burst when present and non-empty.
 *
 * Reasoning carries two orthogonal "multi-part" axes, both optional —
 * they are *omitted* when the part count is 1 so the wire stays
 * byte-for-byte compatible with single-shot ReasoningPush callers:
 *
 *   - `messageIndex` / `totalMessages` — set when a semantic
 *     splitter (`reasoningSplitPattern` in amsg-instant) has cut the
 *     reasoning into multiple sentences for typing-bubble UX.
 *
 *   - `chunkIndex` / `totalChunks` — set when a single segment was
 *     too large for the Web Push payload limit and the producer had
 *     to slice it across multiple pushes at UTF-8 byte boundaries.
 *     Transport-only; SW reassembles the original `reasoningContent`
 *     by sorting on `chunkIndex` within a `(sessionId, messageIndex)`
 *     bucket. See `chunkReasoningByUtf8Bytes` for the safe-edge
 *     splitter helper.
 *
 * Both axes can coexist on the same push when a sentence-split
 * segment is itself oversized.
 *
 * @typedef {AmsgPushCommon & {
 *   messageKind: 'reasoning',
 *   reasoningContent: string,
 *   title?:         string,
 *   contactName?:   string,
 *   avatarUrl?:     string | null,
 *   messageIndex?:  number,
 *   totalMessages?: number,
 *   chunkIndex?:    number,
 *   totalChunks?:   number,
 * }} ReasoningPush
 */

/**
 * Tool invocation request emitted by an agentic-loop hook (`decision:
 * 'tool-request'`). The client is expected to execute the tool and
 * resume via the producer's `/continue` endpoint.
 *
 * `toolCalls` mirrors the OpenAI `choices[0].message.tool_calls`
 * shape — left as `any`-equivalent so producers can passthrough
 * whatever OpenAI-compatible upstream returned.
 *
 * @typedef {AmsgPushCommon & {
 *   messageKind: 'tool_request',
 *   toolCalls: Array<Object>,
 *   title?:       string,
 *   contactName?: string,
 *   message?:     string,
 * }} ToolRequestPush
 */

/**
 * Producer-level error. Replaces the legacy
 * `{ type: 'error', code: '...' }` envelope. `code` is a stable
 * string; `iteration` is the agentic-loop iteration number when
 * relevant (0 / absent otherwise).
 *
 * @typedef {AmsgPushCommon & {
 *   messageKind: 'error',
 *   code:    string,
 *   message: string,
 *   iteration?: number,
 * }} ErrorPush
 */

/**
 * Discriminated union of all pushes the SW can receive. TS consumers
 * `switch` on `messageKind` and the compiler narrows automatically.
 *
 * @typedef {ContentPush | ReasoningPush | ToolRequestPush | ErrorPush} AmsgPush
 */

// ─── Builder helpers ────────────────────────────────────────────────────
//
// Each builder takes the kind-specific fields plus the common ones and
// returns a plain object. The package does NOT validate beyond the
// minimum needed to keep the type discriminators stable — callers may
// pass extra fields freely (subject to the SW's tolerance for unknown
// keys).
//
// Use these builders to avoid drift across `amsg-instant` and
// `amsg-server`, but they aren't mandatory: hook callers in
// `amsg-instant` can return any object whose shape matches the union.

/**
 * Throw if a field that must be present is missing. Producers should
 * surface a clear error rather than silently emit a malformed push.
 *
 * @param {string} kind
 * @param {string} field
 * @param {unknown} value
 */
function requireField(kind, field, value) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`[amsg-shared] ${kind}: '${field}' is required`);
  }
}

/**
 * Build a {@link ContentPush}. Use this for legacy sentence-split
 * bursts (set `messageIndex` 1-based + `totalMessages`) or for a
 * single content push (omit both).
 *
 * @param {Object} args
 * @param {MessageType} args.messageType
 * @param {PushSource}  args.source
 * @param {string}      args.messageId
 * @param {string}      args.sessionId
 * @param {string}      args.message
 * @param {string}      [args.timestamp]      - Defaults to `new Date().toISOString()`.
 * @param {string}      [args.title]
 * @param {string}      [args.contactName]
 * @param {string | null} [args.avatarUrl]
 * @param {string}      [args.messageSubtype]
 * @param {number}      [args.messageIndex]
 * @param {number}      [args.totalMessages]
 * @param {string | null} [args.taskId]
 * @param {Object}      [args.metadata]
 * @returns {ContentPush}
 */
export function buildContentPush(args) {
  requireField('ContentPush', 'messageType', args.messageType);
  requireField('ContentPush', 'source', args.source);
  requireField('ContentPush', 'messageId', args.messageId);
  requireField('ContentPush', 'sessionId', args.sessionId);
  if (typeof args.message !== 'string') {
    throw new Error("[amsg-shared] ContentPush: 'message' must be a string");
  }

  /** @type {ContentPush} */
  const push = {
    messageKind: 'content',
    messageType: args.messageType,
    source: args.source,
    messageId: args.messageId,
    sessionId: args.sessionId,
    timestamp: args.timestamp || new Date().toISOString(),
    message: args.message,
  };
  if (args.title !== undefined) push.title = args.title;
  if (args.contactName !== undefined) push.contactName = args.contactName;
  if (args.avatarUrl !== undefined) push.avatarUrl = args.avatarUrl;
  if (args.messageSubtype !== undefined) push.messageSubtype = args.messageSubtype;
  if (args.messageIndex !== undefined) push.messageIndex = args.messageIndex;
  if (args.totalMessages !== undefined) push.totalMessages = args.totalMessages;
  if (args.taskId !== undefined) push.taskId = args.taskId;
  if (args.metadata !== undefined) push.metadata = args.metadata;
  return push;
}

/**
 * Build a {@link ReasoningPush}. Producers emit this **before** any
 * matching `ContentPush` burst when the LLM response carried a non-
 * empty `reasoning_content`.
 *
 * Two optional multi-part axes (both omitted from wire when the part
 * count is 1, so single-shot reasoning stays byte-for-byte compatible):
 *
 *   - `messageIndex` / `totalMessages` — semantic splitter (sentence
 *     regex) produced multiple segments.
 *   - `chunkIndex` / `totalChunks` — byte splitter (UTF-8 payload-limit
 *     workaround) sliced a single segment across multiple pushes.
 *
 * Both can be set together when a sentence-split segment is itself
 * oversized. See README §"Reasoning chunking".
 *
 * @param {Object} args
 * @param {MessageType} args.messageType
 * @param {PushSource}  args.source
 * @param {string}      args.messageId
 * @param {string}      args.sessionId
 * @param {string}      args.reasoningContent
 * @param {string}      [args.timestamp]
 * @param {string}      [args.title]
 * @param {string}      [args.contactName]
 * @param {string | null} [args.avatarUrl]
 * @param {string}      [args.messageSubtype]
 * @param {number}      [args.messageIndex]
 * @param {number}      [args.totalMessages]
 * @param {number}      [args.chunkIndex]
 * @param {number}      [args.totalChunks]
 * @param {Object}      [args.metadata]
 * @returns {ReasoningPush}
 */
export function buildReasoningPush(args) {
  requireField('ReasoningPush', 'messageType', args.messageType);
  requireField('ReasoningPush', 'source', args.source);
  requireField('ReasoningPush', 'messageId', args.messageId);
  requireField('ReasoningPush', 'sessionId', args.sessionId);
  if (typeof args.reasoningContent !== 'string' || !args.reasoningContent) {
    throw new Error("[amsg-shared] ReasoningPush: 'reasoningContent' must be a non-empty string");
  }

  /** @type {ReasoningPush} */
  const push = {
    messageKind: 'reasoning',
    messageType: args.messageType,
    source: args.source,
    messageId: args.messageId,
    sessionId: args.sessionId,
    timestamp: args.timestamp || new Date().toISOString(),
    reasoningContent: args.reasoningContent,
  };
  if (args.title !== undefined) push.title = args.title;
  if (args.contactName !== undefined) push.contactName = args.contactName;
  if (args.avatarUrl !== undefined) push.avatarUrl = args.avatarUrl;
  if (args.messageSubtype !== undefined) push.messageSubtype = args.messageSubtype;
  if (args.messageIndex !== undefined) push.messageIndex = args.messageIndex;
  if (args.totalMessages !== undefined) push.totalMessages = args.totalMessages;
  if (args.chunkIndex !== undefined) push.chunkIndex = args.chunkIndex;
  if (args.totalChunks !== undefined) push.totalChunks = args.totalChunks;
  if (args.metadata !== undefined) push.metadata = args.metadata;
  return push;
}

/**
 * Build a {@link ToolRequestPush}. Caller is expected to executed
 * tools client-side and resume via `/continue` (see `amsg-instant`
 * README §Agentic Loop).
 *
 * @param {Object} args
 * @param {MessageType} args.messageType
 * @param {PushSource}  args.source
 * @param {string}      args.messageId
 * @param {string}      args.sessionId
 * @param {Array<Object>} args.toolCalls
 * @param {string}      [args.timestamp]
 * @param {string}      [args.title]
 * @param {string}      [args.contactName]
 * @param {string}      [args.message]
 * @param {string}      [args.messageSubtype]
 * @param {Object}      [args.metadata]
 * @returns {ToolRequestPush}
 */
export function buildToolRequestPush(args) {
  requireField('ToolRequestPush', 'messageType', args.messageType);
  requireField('ToolRequestPush', 'source', args.source);
  requireField('ToolRequestPush', 'messageId', args.messageId);
  requireField('ToolRequestPush', 'sessionId', args.sessionId);
  if (!Array.isArray(args.toolCalls) || args.toolCalls.length === 0) {
    throw new Error("[amsg-shared] ToolRequestPush: 'toolCalls' must be a non-empty array");
  }

  /** @type {ToolRequestPush} */
  const push = {
    messageKind: 'tool_request',
    messageType: args.messageType,
    source: args.source,
    messageId: args.messageId,
    sessionId: args.sessionId,
    timestamp: args.timestamp || new Date().toISOString(),
    toolCalls: args.toolCalls,
  };
  if (args.title !== undefined) push.title = args.title;
  if (args.contactName !== undefined) push.contactName = args.contactName;
  if (args.message !== undefined) push.message = args.message;
  if (args.messageSubtype !== undefined) push.messageSubtype = args.messageSubtype;
  if (args.metadata !== undefined) push.metadata = args.metadata;
  return push;
}

/**
 * Build an {@link ErrorPush}. Replaces the legacy
 * `{ type: 'error', code: '...' }` envelope. The new shape carries
 * the full common-fields set so the SW can route it through the
 * same `messageKind` switch as the other three kinds.
 *
 * @param {Object} args
 * @param {MessageType} args.messageType
 * @param {PushSource}  args.source
 * @param {string}      args.messageId
 * @param {string}      args.sessionId
 * @param {string}      args.code
 * @param {string}      args.message
 * @param {string}      [args.timestamp]
 * @param {number}      [args.iteration]
 * @param {string}      [args.messageSubtype]
 * @param {Object}      [args.metadata]
 * @returns {ErrorPush}
 */
export function buildErrorPush(args) {
  requireField('ErrorPush', 'messageType', args.messageType);
  requireField('ErrorPush', 'source', args.source);
  requireField('ErrorPush', 'messageId', args.messageId);
  requireField('ErrorPush', 'sessionId', args.sessionId);
  requireField('ErrorPush', 'code', args.code);
  if (typeof args.message !== 'string') {
    throw new Error("[amsg-shared] ErrorPush: 'message' must be a string");
  }

  /** @type {ErrorPush} */
  const push = {
    messageKind: 'error',
    messageType: args.messageType,
    source: args.source,
    messageId: args.messageId,
    sessionId: args.sessionId,
    timestamp: args.timestamp || new Date().toISOString(),
    code: args.code,
    message: args.message,
  };
  if (args.iteration !== undefined) push.iteration = args.iteration;
  if (args.messageSubtype !== undefined) push.messageSubtype = args.messageSubtype;
  if (args.metadata !== undefined) push.metadata = args.metadata;
  return push;
}

// ─── Narrowing helpers ──────────────────────────────────────────────────

/**
 * Type guard: returns true if the argument is a {@link ContentPush}.
 *
 * @param {unknown} value
 * @returns {value is ContentPush}
 */
export function isContentPush(value) {
  return !!value && typeof value === 'object'
    && /** @type {{messageKind?: unknown}} */ (value).messageKind === 'content';
}

/**
 * Type guard: returns true if the argument is a {@link ReasoningPush}.
 *
 * @param {unknown} value
 * @returns {value is ReasoningPush}
 */
export function isReasoningPush(value) {
  return !!value && typeof value === 'object'
    && /** @type {{messageKind?: unknown}} */ (value).messageKind === 'reasoning';
}

/**
 * Type guard: returns true if the argument is a {@link ToolRequestPush}.
 *
 * @param {unknown} value
 * @returns {value is ToolRequestPush}
 */
export function isToolRequestPush(value) {
  return !!value && typeof value === 'object'
    && /** @type {{messageKind?: unknown}} */ (value).messageKind === 'tool_request';
}

/**
 * Type guard: returns true if the argument is an {@link ErrorPush}.
 *
 * @param {unknown} value
 * @returns {value is ErrorPush}
 */
export function isErrorPush(value) {
  return !!value && typeof value === 'object'
    && /** @type {{messageKind?: unknown}} */ (value).messageKind === 'error';
}

// ─── Reasoning byte chunker ─────────────────────────────────────────────

const REASONING_CHUNK_ENCODER = new TextEncoder();
const REASONING_CHUNK_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * Slice a string into UTF-8 byte chunks no larger than `maxBytes`,
 * always cutting at codepoint boundaries (never inside a multi-byte
 * char). Designed for the {@link ReasoningPush} byte-chunking path
 * in amsg-instant — producers facing the ~3 KB Web Push payload
 * limit slice oversized reasoning into N pushes with
 * `chunkIndex` / `totalChunks`, the SW reassembles by concat.
 *
 * Algorithm: TextEncoder → Uint8Array → backward scan from each
 * candidate cut index until the byte is a UTF-8 lead byte (any byte
 * where `(b & 0xC0) !== 0x80`; continuation bytes are `0b10xxxxxx`).
 * TextDecoder turns each slice back into a JS string.
 *
 *   chunkReasoningByUtf8Bytes('A寿B', 4) → ['A寿', 'B']  // '寿' = 3 B,
 *                                                       // cut at safe edge
 *
 * Constraints:
 *   - `maxBytes` MUST be ≥ 4 (UTF-8 codepoints can be up to 4 bytes;
 *     any smaller threshold has no valid cut point for a 4-byte char
 *     and is also operationally nonsensical). Throws `RangeError`
 *     otherwise.
 *   - Empty `text` → `[]` (caller can check `.length === 0`).
 *   - `text` whose total UTF-8 byte length ≤ `maxBytes` → `[text]`
 *     (no chunking).
 *   - `text` MUST be a string. Non-string throws `TypeError`.
 *
 * Joining the result `chunks.join('')` is guaranteed to equal the
 * input `text` (no data loss, no extra whitespace).
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string[]}
 */
export function chunkReasoningByUtf8Bytes(text, maxBytes) {
  if (typeof text !== 'string') {
    throw new TypeError('[amsg-shared] chunkReasoningByUtf8Bytes: text must be a string');
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 4) {
    throw new RangeError(
      '[amsg-shared] chunkReasoningByUtf8Bytes: maxBytes must be an integer ≥ 4 (UTF-8 max codepoint width)'
    );
  }
  if (text.length === 0) return [];

  const bytes = REASONING_CHUNK_ENCODER.encode(text);
  if (bytes.byteLength <= maxBytes) return [text];

  /** @type {string[]} */
  const chunks = [];
  let start = 0;
  while (start < bytes.byteLength) {
    let end = Math.min(start + maxBytes, bytes.byteLength);

    if (end < bytes.byteLength) {
      // Walk back to a lead byte. UTF-8 continuation bytes are
      // `0b10xxxxxx` → (b & 0xC0) === 0x80. Any other byte starts a
      // new codepoint, so `end` is a safe boundary as long as the
      // byte AT `end` is NOT a continuation byte.
      while (end > start && (bytes[end] & 0xC0) === 0x80) {
        end--;
      }
      // The precondition `maxBytes ≥ 4` guarantees `end > start`
      // here: a window of ≥4 bytes always contains at least one
      // lead byte (UTF-8 codepoints are ≤ 4 bytes).
    }

    chunks.push(REASONING_CHUNK_DECODER.decode(bytes.subarray(start, end)));
    start = end;
  }
  return chunks;
}
