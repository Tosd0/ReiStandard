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
 * @property {NotificationDirective} [notification] - SW notification strategy.
 */

// ─── Per-kind interfaces ────────────────────────────────────────────────

/**
 * SW-rendering directive. Mirrors the fields that `amsg-sw`'s
 * `createNotificationFromPayload` consumes (`notification.{show,title,body,icon,badge,tag,renotify,requireInteraction,silent,data}`)
 * so producers get builder validation for the fields the SW actually reads.
 *
 * Routing in SW:
 *   - By default (`show: "auto"` or omitted), `messageKind: 'content'` (and legacy un-kinded payloads)
 *     will display a system notification. `reasoning` / `tool_request` / `error` will dispatch silently.
 *   - `show: "always"`, `"when-hidden"`, or `false` overrides this default.
 *   - When rendering, `notification.*` is consulted first, with per-field
 *     fallback to the matching top-level payload fields (`title`,
 *     `body`/`message`, `icon`/`avatarUrl`, `badge`, `tag`/`messageId`,
 *     `renotify`, `requireInteraction`, `silent`, `data`), and finally to
 *     the SW's `defaultIcon` / `defaultBadge` options (boolean knobs
 *     default to `false` at the SW). Prefer setting overrides under
 *     `notification` for explicitness; top-level fallback exists so that
 *     legacy un-namespaced payloads keep working byte-for-byte.
 *
 * @typedef {Object} NotificationDirective
 * @property {"auto" | "always" | "when-hidden" | false} [show] - Rendering strategy. Defaults to "auto" (render only if messageKind is content).
 * @property {string}  [title]              - Notification title override (falls back to top-level `title`, then `来自 {contactName}`).
 * @property {string}  [body]               - Notification body override (falls back to top-level `body`, then `message`).
 * @property {string}  [icon]               - Icon URL override (falls back to top-level `icon`/`avatarUrl`, then SW `defaultIcon`).
 * @property {string}  [badge]              - Badge URL override (falls back to top-level `badge`, then SW `defaultBadge`).
 * @property {string}  [tag]                - Notification grouping tag; matching tag replaces the prior notification (falls back to top-level `tag`, then `messageId`, then a generated unique tag).
 * @property {boolean} [renotify]           - When tag matches, still vibrate/sound (falls back to top-level `renotify`, default false at SW).
 * @property {boolean} [requireInteraction] - Notification stays until user dismisses (falls back to top-level `requireInteraction`, default false at SW).
 * @property {boolean} [silent]             - Suppress sound and vibration (falls back to top-level `silent`, default false at SW).
 * @property {Record<string, unknown>} [data] - Custom payload data to attach to the notification (falls back to top-level `data`).
 */

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
 * Reasoning carries two optional "multi-part" axes, both *omitted* when
 * the part count is 1 so the wire stays byte-for-byte compatible with
 * single-shot callers. The type reserves them for forward compatibility;
 * current producers emit a single ReasoningPush and set neither — oversized
 * reasoning rides the generic multipart transport, not a reasoning-only
 * chunk format.
 *
 *   - `messageIndex` / `totalMessages` — a 1-based part index when a producer
 *     splits reasoning into multiple sentences for typing-bubble UX.
 *
 *   - `chunkIndex` / `totalChunks` — transport-only slicing when a single
 *     segment exceeds the Web Push payload limit; SW would reassemble the
 *     original `reasoningContent` by sorting on `chunkIndex` within a
 *     `(sessionId, messageIndex)` bucket. See `chunkReasoningByUtf8Bytes`
 *     for the safe-edge splitter helper.
 *
 * Both axes can coexist on the same push when a sentence-split segment is
 * itself oversized.
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
 * @param {NotificationDirective} [args.notification]
 *                       - SW-side `showNotification` overrides for content
 *                         (and for ToolRequestPush prefix chunks that get
 *                         demoted to `content` during sentence-split). All
 *                         fields optional; see {@link NotificationDirective}
 *                         for the SW fallback chain.
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
  validateNotificationArg('ContentPush', args.notification);

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
  if (args.notification !== undefined) push.notification = args.notification;
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
  validateNotificationArg('ReasoningPush', args.notification);

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
  if (args.notification !== undefined) push.notification = args.notification;
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
 * @param {NotificationDirective} [args.notification]
 *                       - SW notification overrides. Used after the
 *                         splitter demotes prefix chunks to `content`
 *                         (where `messageKind: 'content'` triggers
 *                         `showNotification`). On the un-demoted last
 *                         chunk (`messageKind: 'tool_request'`) the
 *                         SW dispatches silently and the field is
 *                         ignored — typed here purely so the demoted
 *                         chunks inherit it via the splitter's spread.
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
  validateNotificationArg('ToolRequestPush', args.notification);

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
  if (args.notification !== undefined) push.notification = args.notification;
  return push;
}

/**
 * Validate the optional `notification` argument.
 * Plain object required (`null` / arrays / primitives rejected); field-level shape is
 * checked best-effort — `title` / `body` / `icon` / `badge` / `tag`
 * must be strings when present, `renotify` / `requireInteraction` / `silent`
 * must be booleans. Unknown keys are tolerated so the SW's
 * forward-compatibility (it just won't read them) is preserved.
 *
 * @param {string} kind
 * @param {unknown} value
 */
function validateNotificationArg(kind, value) {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`[amsg-shared] ${kind}: 'notification' must be a plain object`);
  }
  const n = /** @type {Record<string, unknown>} */ (value);
  if (n.show !== undefined && !['auto', 'always', 'when-hidden', false].includes(n.show)) {
    throw new Error(`[amsg-shared] ${kind}: 'notification.show' must be "auto", "always", "when-hidden", or false`);
  }
  for (const f of ['title', 'body', 'icon', 'badge', 'tag']) {
    if (n[f] !== undefined && typeof n[f] !== 'string') {
      throw new Error(`[amsg-shared] ${kind}: 'notification.${f}' must be a string when present`);
    }
  }
  for (const f of ['renotify', 'requireInteraction', 'silent']) {
    if (n[f] !== undefined && typeof n[f] !== 'boolean') {
      throw new Error(`[amsg-shared] ${kind}: 'notification.${f}' must be a boolean when present`);
    }
  }
  if (n.data !== undefined && (n.data === null || typeof n.data !== 'object' || Array.isArray(n.data))) {
    throw new Error(`[amsg-shared] ${kind}: 'notification.data' must be a plain object when present`);
  }
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
 * @param {NotificationDirective} [args.notification]
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
  validateNotificationArg('ErrorPush', args.notification);

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
  if (args.notification !== undefined) push.notification = args.notification;
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
 * char). This is a generic byte-safe string helper retained for
 * callers that need deterministic UTF-8 chunking around small Web Push
 * payload budgets; current amsg-instant oversized payload delivery uses
 * BlobStore / generic multipart instead of reasoning-only wire fields.
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

// ─── Shared Utilities ───────────────────────────────────────────────────

/**
 * Coerce ArrayBuffer | Uint8Array | view → Uint8Array (no copy when possible).
 */
export function toUint8(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  throw new TypeError('Expected ArrayBuffer / Uint8Array');
}

/**
 * Decode base64url (with or without padding) → Uint8Array.
 * @param {string} input
 * @returns {Uint8Array}
 */
export function base64UrlToBytes(input) {
  const s = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (s.length % 4)) % 4;
  const padded = s + '='.repeat(pad);
  const bin = (typeof atob === 'function')
    ? atob(padded)
    : Buffer.from(padded, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Concatenate Uint8Arrays into a single Uint8Array.
 * @param {...(Uint8Array | ArrayBuffer | ArrayBufferView)} chunks
 * @returns {Uint8Array}
 */
export function concatBytes(...chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c instanceof Uint8Array ? c : new Uint8Array(c.buffer || c), offset);
    offset += c.byteLength;
  }
  return out;
}

// ─── Validation & normalization helpers ─────────────────────────────────
// Shared by amsg-server / amsg-instant / amsg-client so the same rules live
// in exactly one place. All pure (no side effects).

/**
 * True when `value` parses as an absolute URL.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** Max accepted `avatarUrl` length, in characters. */
export const AVATAR_URL_MAX_LENGTH = 2048;

/**
 * Validate the optional `avatarUrl` field. Rejects `data:` URIs (typically
 * base64-encoded inline images) and anything longer than
 * {@link AVATAR_URL_MAX_LENGTH} chars — both the dominant trigger for
 * downstream 413 / Web Push 4 KB payload errors — plus anything that doesn't
 * parse as a URL. Returns an error message string, or null when valid.
 *
 * Pure: callers decide how to act on a non-null result (amsg-server /
 * amsg-instant / amsg-client soft-strip + console.warn; see standards §6.2).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function validateAvatarUrl(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    return 'avatarUrl 必须是字符串';
  }
  if (/^data:/i.test(value)) {
    return '头像不支持传入 data: URI，请改为公网可访问的 https:// 图片 URL';
  }
  if (value.length > AVATAR_URL_MAX_LENGTH) {
    return `头像 URL 长度 ${value.length} 字符超过 ${AVATAR_URL_MAX_LENGTH} 上限，请改为更短的图片 URL`;
  }
  if (!isValidUrl(value)) {
    return 'avatarUrl 不是合法 URL';
  }
  return null;
}

/**
 * Normalize a VAPID `sub` (subject) claim. Web Push (RFC 8292) accepts a
 * `mailto:` address or an `http(s):` URL; a bare contact like
 * `you@example.com` is prefixed with `mailto:`. An already-prefixed
 * `mailto:` / `http(s):` value is returned untouched. Empty / blank → `''`.
 *
 * @param {unknown} email
 * @returns {string}
 */
export function normalizeVapidSubject(email) {
  const trimmed = String(email || '').trim();
  if (!trimmed) return '';
  return /^mailto:/i.test(trimmed) || /^https?:/i.test(trimmed) ? trimmed : `mailto:${trimmed}`;
}

/**
 * Matches `<think>…</think>` / `<thinking>…</thinking>` / `<thought>…</thought>`
 * spans (case-insensitive, lazy multi-line). The plain form captures the inner
 * text in group 2; the `_G` form is the global stripper.
 */
const REASONING_TAG_RE = /<(think|thinking|thought)>([\s\S]*?)<\/\1>/i;
const REASONING_TAG_RE_G = /<(think|thinking|thought)>[\s\S]*?<\/\1>/gi;

/**
 * Read `choices[0].message.reasoning_content` as a non-empty trimmed string,
 * or null when absent / empty. Falls back to the first `<think>` span inside
 * `message.content` when a provider inlines reasoning there. Many providers
 * return an empty string instead of omitting the field — treated the same as
 * missing so callers don't emit an empty ReasoningPush.
 *
 * @param {unknown} llmResponse
 * @returns {string | null}
 */
export function readReasoningContent(llmResponse) {
  if (!llmResponse || typeof llmResponse !== 'object') return null;
  const choices = /** @type {{ choices?: unknown }} */ (llmResponse).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = /** @type {{ message?: { reasoning_content?: unknown, content?: unknown } }} */ (choices[0])?.message;

  const raw = message?.reasoning_content;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }

  const content = message?.content;
  if (typeof content === 'string') {
    const match = content.match(REASONING_TAG_RE);
    if (match) {
      const trimmed = match[2].trim();
      if (trimmed.length > 0) return trimmed;
    }
  }

  return null;
}

/**
 * Drop any `<think>` / `<thinking>` / `<thought>` spans from a user-facing
 * content string, so private chain-of-thought leaking through `message.content`
 * does not also ship inside the ContentPush burst.
 *
 * @param {string} content
 * @returns {string}
 */
export function stripReasoningTags(content) {
  if (typeof content !== 'string' || !content.includes('<')) return content;
  return content.replace(REASONING_TAG_RE_G, '').trim();
}
