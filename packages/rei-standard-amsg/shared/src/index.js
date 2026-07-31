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

// Runtime-neutral 编码 / crypto 帮手（toUint8、base64url、hex、HMAC、
// 常量时间比较等），instant 的 utils 与 server 的 webcrypto-utils 模块
// 从这里 re-export 而不再各自拷贝。
// 实现在独立模块 — shared 内部按主题拆文件，index 只负责聚合导出。
export {
  toUint8,
  concatBytes,
  utf8,
  utf8Decode,
  bytesToBase64,
  bytesToBase64Url,
  base64UrlToBytes,
  jsonToBase64Url,
  bytesToHex,
  hexToBytes,
  hmacSha256,
  timingSafeEqualBytes,
  randomBytes,
  randomUUID,
} from './webcrypto-utils.js';

// ─── Validation & normalization helpers ─────────────────────────────────
// Shared by amsg-server / amsg-instant / amsg-client so the same rules live
// in exactly one place. All pure (no side effects).

// OpenAI-style messages 数组形状校验（结构化错误码），instant 的
// `validateMessagesArray` 与 server 的 `validateLlmMessagesArray` 共用。
// 实现在独立模块 — shared 内部按主题拆文件，index 只负责聚合导出。
export { LLM_MESSAGES_ERROR, validateLlmMessagesShape } from './llm-messages.js';

// OpenAI-compatible LLM HTTP 调用核心（构造请求体 + fetch + 超时 + 解析
// 响应 + trim），instant 的 callLlmRaw 与 server 的 callLlm 共用这一份，
// 两侧差异（stream 字段 / tools 转发 / timeoutMs）走 options 参数化。
// 实现在独立模块 — shared 内部按主题拆文件，index 只负责聚合导出。
export {
  callLlm,
  buildLlmRequestBody,
  normalizeAiApiUrl,
} from './llm-call.js';

// Web Push 加密栈（RFC 8030 传输 / RFC 8291 aes128gcm / RFC 8292 VAPID），
// 纯 WebCrypto 实现，instant 与 server 的 webpush 模块共用这一份。
// 它依赖的编码 / crypto 帮手在 webcrypto-utils.js（上方已聚合导出）。
// 实现在独立模块 — shared 内部按主题拆文件，index 只负责聚合导出。
export {
  sendWebPush,
  buildVapidJwt,
  verifyVapidJwt,
} from './webpush.js';

// 线协议常量单一来源：multipart transport 的 kind / encoding / version 与
// 默认限额（instant 发送端、sw 重组端共用），以及 SW ↔ 页面 postMessage
// 信封常量（页面侧从这里 import，避免 import sw 包执行其模块顶层状态）。
// 实现在独立模块 — shared 内部按主题拆文件，index 只负责聚合导出。
export {
  MULTIPART_MESSAGE_KIND,
  MULTIPART_ENCODING,
  MULTIPART_VERSION,
  DEFAULT_MULTIPART_TTL_MS,
  DEFAULT_MULTIPART_MAX_CHUNKS,
  DEFAULT_MULTIPART_MAX_TOTAL_BYTES,
  REI_AMSG_POSTMESSAGE_TYPE,
  REI_SW_EVENT,
  REI_SW_MESSAGE_TYPE,
  REI_AMSG_DELIVER_MESSAGE_TYPE,
} from './protocol.js';

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

// ─── Agentic-loop hook contract ──────────────────────────────────────────────
// Shared by @rei-standard/amsg-instant (client-executed tools via /continue)
// and @rei-standard/amsg-server (server-executed tools at fire time). Single
// source of truth so the two packages' onLLMOutput contracts cannot drift.

/**
 * @typedef {Object} ChatMessage
 * @property {'system' | 'user' | 'assistant' | 'tool'} role
 * @property {string | unknown[] | null} [content]
 * @property {Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>} [tool_calls]
 * @property {string} [tool_call_id]
 * @property {string} [name]
 */

/**
 * @typedef {Object} SessionContext
 * @property {string}                   sessionId
 * @property {string}                   [charId]
 * @property {ChatMessage[]}            messages       - Including the just-appended assistant turn.
 * @property {unknown}                  llmResponse    - Full LLM response (choices, usage, …).
 * @property {string}                   llmOutputText  - May be '' for pure tool-call responses.
 * @property {number}                   iteration      - 0-indexed: the round that just finished.
 * @property {Record<string, unknown>}  metadata
 * @property {string}                   contactName
 * @property {string}                   [avatarUrl]
 * @property {Record<string, unknown>}  [scratch]      - Per-fire host scratch object. Producers that run several hooks within one fire (amsg-server's fire-time loop) pass the same mutable object to every hook of that fire, so hooks can hand context to each other without a module-level Map. The library never reads, writes, logs, or persists it, and never shares it across fires. Absent when the producer does not supply one (amsg-instant).
 */

/**
 * Build the frozen SessionContext handed to an onLLMOutput hook.
 *
 * Credentials (apiKey / apiUrl / pushSubscription / vapid / masterKey) are
 * intentionally NOT part of the shape: a console.log(ctx) from a hook must
 * not leak keys, and a third-party hook must not be able to exfiltrate
 * them. Frozen so a hook cannot mutate the live history — if it chooses
 * `decision:'continue'`, the caller still owns its copy.
 *
 * @param {Object} args
 * @param {string} args.sessionId
 * @param {ChatMessage[]} args.messages
 * @param {unknown} args.llmResponse
 * @param {number} args.iteration
 * @param {string} args.contactName
 * @param {string} [args.avatarUrl]
 * @param {string} [args.charId]
 * @param {Record<string, unknown>} [args.metadata]
 * @param {Record<string, unknown>} [args.scratch]
 * @returns {SessionContext}
 */
export function buildSessionContext({
  sessionId,
  messages,
  llmResponse,
  iteration,
  contactName,
  avatarUrl,
  charId,
  metadata,
  scratch,
}) {
  const llmOutputText = readLlmOutputText(llmResponse);
  const ctx = {
    sessionId,
    charId,
    messages,
    llmResponse,
    llmOutputText,
    iteration,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    contactName,
    avatarUrl: avatarUrl || undefined,
  };
  // The ctx object is frozen, but the scratch object it references stays
  // mutable on purpose — that mutability is the whole point of the field.
  if (scratch !== undefined) ctx.scratch = scratch;
  return Object.freeze(ctx);
}

/**
 * Safely read `choices[0].message.content` as a string. Pure tool-call
 * responses legitimately have empty content, so we return '' rather than
 * throwing.
 *
 * @param {unknown} llmResponse
 * @returns {string}
 */
function readLlmOutputText(llmResponse) {
  if (!llmResponse || typeof llmResponse !== 'object') return '';
  const choices = /** @type {{ choices?: unknown }} */ (llmResponse).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const message = /** @type {{ message?: { content?: unknown } }} */ (choices[0])?.message;
  const content = message?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * Extract the `choices[0].message` whole object — preserving `tool_calls`
 * / `reasoning_content` / `refusal` etc. — for appending to the running
 * history. Falls back to a minimal placeholder when the response is
 * malformed so the hook still gets a chance to react via
 * `llmOutputText === ''`.
 *
 * Critically, we keep the entire message object (not just
 * `{role, content}`): the next round may need to forward a `tool_calls`
 * array to OpenAI alongside the matching tool-result messages, and
 * stripping the field would make the API reject the request.
 *
 * @param {unknown} llmResponse
 * @returns {ChatMessage}
 */
export function extractAssistantMessage(llmResponse) {
  const message =
    llmResponse &&
    typeof llmResponse === 'object' &&
    Array.isArray(/** @type {{ choices?: unknown }} */ (llmResponse).choices) &&
    /** @type {{ choices: Array<{ message?: unknown }> }} */ (llmResponse).choices[0]?.message;
  if (message && typeof message === 'object') {
    return /** @type {ChatMessage} */ (message);
  }
  return { role: 'assistant', content: '' };
}

const VALID_DECISIONS = new Set(['finish', 'tool-request', 'continue', 'skip-push']);

/**
 * Assert that an onLLMOutput hook returned a structurally valid decision.
 * TypeScript discriminated unions don't survive into runtime, and a
 * misbehaving hook can easily return `null` / `{ decision: 'idk' }` /
 * `undefined` — treat any of those as a hook contract violation.
 *
 * Flavors:
 * - default (amsg-instant): 'tool-request' must carry pushPayloads — the
 *   tool_request push goes to the client, which executes the tools and
 *   POSTs /continue.
 * - `{ inlineToolCalls: true }` (amsg-server fire-time loop): the host
 *   executes tools in-process, so 'tool-request' may instead carry a
 *   non-empty `toolCalls` array directly; pushPayloads then become
 *   optional. pushPayloads-shaped tool-requests stay valid so a
 *   classifier written for instant drops in unchanged.
 *
 * @param {unknown} decision
 * @param {{ inlineToolCalls?: boolean }} [options]
 */
export function assertValidDecision(decision, options = {}) {
  const inlineToolCalls = options.inlineToolCalls === true;

  if (!decision || typeof decision !== 'object') {
    throw new TypeError(`onLLMOutput returned invalid decision: ${stringifyDecisionForError(decision)}`);
  }
  const tag = /** @type {{ decision?: unknown }} */ (decision).decision;
  if (typeof tag !== 'string' || !VALID_DECISIONS.has(tag)) {
    throw new TypeError(`onLLMOutput returned invalid decision tag: ${stringifyDecisionForError(tag)}`);
  }

  const hasSingular = Object.prototype.hasOwnProperty.call(decision, 'pushPayload');
  const hasPlural = Object.prototype.hasOwnProperty.call(decision, 'pushPayloads');

  if (hasSingular) {
    throw new TypeError(
      hasPlural
        ? 'pushPayload (singular) is removed in 0.8.0, use pushPayloads'
        : 'pushPayload (singular) is removed in 0.8.0, use pushPayloads: [yourPayload]'
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

  if (tag === 'tool-request' && inlineToolCalls && Object.prototype.hasOwnProperty.call(decision, 'toolCalls')) {
    const toolCalls = /** @type {{ toolCalls?: unknown }} */ (decision).toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      throw new TypeError('decision:"tool-request" toolCalls must be a non-empty array when set');
    }
    for (let i = 0; i < toolCalls.length; i++) {
      const t = toolCalls[i];
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        throw new TypeError(`toolCalls[${i}] must be a plain object, got ${stringifyDecisionForError(t)}`);
      }
    }
    if (!hasPlural) return;
    // pushPayloads also present → validate them below too.
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
      throw new TypeError(`pushPayloads[${i}] must be a plain object, got ${stringifyDecisionForError(p)}`);
    }
    if (Object.prototype.hasOwnProperty.call(p, 'splitPattern')) {
      throw new TypeError(`pushPayloads[${i}].splitPattern is removed in 0.8.0; caller is responsible for splitting`);
    }
    if (Object.prototype.hasOwnProperty.call(p, 'messageId')) {
      const id = /** @type {{ messageId?: unknown }} */ (p).messageId;
      if (typeof id !== 'string' || id === '') {
        throw new TypeError(`pushPayloads[${i}].messageId must be a non-empty string when set, got ${stringifyDecisionForError(id)}`);
      }
    }
  }
}

/**
 * Pull the toolCalls out of a 'tool-request' decision, whichever shape it
 * came in: `decision.toolCalls` directly (server flavor), or embedded in
 * tool_request pushPayloads (instant classifier flavor).
 *
 * @param {unknown} decision
 * @returns {Array<Record<string, unknown>>}
 */
export function extractToolCallsFromDecision(decision) {
  if (!decision || typeof decision !== 'object') return [];
  const direct = /** @type {{ toolCalls?: unknown }} */ (decision).toolCalls;
  if (Array.isArray(direct) && direct.length > 0) {
    return direct;
  }
  const pushPayloads = /** @type {{ pushPayloads?: unknown }} */ (decision).pushPayloads;
  if (!Array.isArray(pushPayloads)) return [];
  const out = [];
  for (const push of pushPayloads) {
    if (push && typeof push === 'object' && Array.isArray(/** @type {{ toolCalls?: unknown }} */ (push).toolCalls)) {
      out.push(.../** @type {{ toolCalls: unknown[] }} */ (push).toolCalls);
    }
  }
  return out;
}

function stringifyDecisionForError(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
