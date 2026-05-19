/**
 * Instant message processor.
 * ReiStandard amsg-instant
 *
 * Lifecycle of a single instant request:
 *   call LLM (OpenAI-compatible) → split into sentences →
 *   send each sentence as its own Web Push notification (1500ms spacing) →
 *   return success.
 *
 * Push payload field shape MUST stay identical to
 * `server/src/server/lib/message-processor.js:78-93` so the same SW
 * (`@rei-standard/amsg-sw`) handles both scheduled and instant pushes
 * uniformly via the `source` discriminator.
 */

import { sendWebPush } from './webpush.js';
import { randomUUID } from './utils.js';
import { HookError, LlmCallError, PayloadTooLargeError } from './errors.js';
import { buildSessionContext, extractAssistantMessage } from './session-context.js';

const SLEEP_BETWEEN_MESSAGES_MS = 1500;

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
 * Mirrors amsg-server message-processor.js:59-70 (do not drift).
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
export function splitMessageIntoSentences(messageContent, splitPattern = null) {
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
 * Build the SW-facing JSON payload for a single sentence in an instant
 * burst. Exported so test suites can verify the wire shape without having
 * to decrypt RFC 8291 ciphertext.
 *
 * Field-for-field parity with `amsg-server/src/server/lib/message-processor.js:78-93`
 * is the contract — drift here will break the shared SW.
 *
 * @param {Object} args
 * @param {string} args.message
 * @param {number} args.index           - 0-based.
 * @param {number} args.total
 * @param {string} args.contactName
 * @param {string|null} [args.avatarUrl]
 * @param {string} [args.messageSubtype='chat']
 * @param {Object} [args.metadata={}]
 * @returns {Object}
 */
export function buildInstantPushPayload({
  message,
  index,
  total,
  contactName,
  avatarUrl = null,
  messageSubtype = 'chat',
  metadata = {},
}) {
  return {
    title: `来自 ${contactName}`,
    message,
    contactName,
    messageId: `msg_${randomUUID()}_instant_${index}`,
    messageIndex: index + 1,
    totalMessages: total,
    messageType: 'instant',
    messageSubtype,
    taskId: null,
    timestamp: new Date().toISOString(),
    source: 'instant',
    avatarUrl,
    metadata,
  };
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

async function callLlm(payload, fetchImpl) {
  const { content } = await callLlmRaw(payload, fetchImpl, /*requireContent=*/true);
  return content.trim();
}

/**
 * Raw LLM call shared by the legacy path and the v0.7 hook loop. The
 * legacy path uses {@link callLlm} which trims the content string;
 * the hook loop calls this directly so it can append the full
 * `choices[0].message` object (preserving `tool_calls` /
 * `reasoning_content`) to its rolling history.
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
 * Process one instant request. Dispatches between two **independent**
 * paths based on whether the caller provided an `onLLMOutput` hook:
 *
 *   - No hook + not a `/continue` resume → **legacy v0.6 path**
 *     (`runLegacyInstant`): byte-for-byte equivalent to v0.6
 *     — single LLM call, sentence-split, sequential pushes with
 *     1500 ms spacing. `splitPattern`, `messageSubtype`,
 *     `buildInstantPushPayload`'s 13 fields all preserved.
 *
 *   - Hook provided (or `isResume === true`) → **v0.7 agentic loop**
 *     (`runAgenticLoop`): per-turn LLM call, hand `SessionContext` to
 *     the hook, dispatch on `decision` (finish / tool-request /
 *     continue / skip-push). Blob envelope kicks in when the hook's
 *     pushPayload exceeds `blobStore.maxInlineBytes`.
 *
 * The two paths intentionally do NOT share schema: hooked callers
 * speak in custom pushPayload objects, legacy callers speak in
 * sentence-split bursts of 13-field default payloads. Trying to
 * unify the two would force one of them into the other's contract.
 *
 * @param {Object} payload  - Validated request body. For legacy:
 *   identical to v0.6. For hook path: same plus `sessionId`,
 *   `iteration?`, and `messages` (not `completePrompt`).
 * @param {Object} ctx
 * @param {{ email: string, publicKey: string, privateKey: string }} ctx.vapid
 * @param {Function} [ctx.fetch]      - fetch impl (globalThis.fetch). Both LLM and push share it.
 * @param {Function} [ctx.sleep]      - sleep impl (testability, legacy path only).
 * @param {(e: object) => void} [ctx.onEvent]
 * @param {(c: import('./session-context.js').SessionContext) =>
 *   Promise<object> | object} [ctx.onLLMOutput]
 * @param {import('./blob-store/interface.js').BlobStoreConfig} [ctx.blobStore]
 * @param {number} [ctx.maxLoopIterations]
 * @param {string} [ctx.requestUrl]   - Inbound `request.url`; used to derive blob envelope URLs.
 * @param {boolean} [ctx.isResume]    - True when entered via `/continue`.
 * @returns {Promise<object>}
 */
export async function processInstantMessage(payload, ctx) {
  if (!ctx.onLLMOutput && !ctx.isResume) {
    return runLegacyInstant(payload, ctx);
  }
  return runAgenticLoop(payload, ctx);
}

/**
 * v0.6 legacy path — extracted verbatim so the hook-path branch
 * cannot disturb its semantics. Byte-for-byte identical output to
 * v0.6: sentence split, sequential push with 1500 ms spacing,
 * 13-field default push payload.
 *
 * @param {Object} payload
 * @param {Object} ctx
 * @returns {Promise<{ messagesSent: number, sentAt: string }>}
 */
async function runLegacyInstant(payload, ctx) {
  const fetchImpl = ctx.fetch || globalThis.fetch;
  const sleep = ctx.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const onEvent = typeof ctx.onEvent === 'function' ? ctx.onEvent : () => {};

  let messageContent;
  try {
    messageContent = await callLlm(payload, fetchImpl);
    onEvent({ type: 'llm_done' });
  } catch (err) {
    const error = new Error(err?.message || 'LLM call failed');
    error.code = 'LLM_CALL_FAILED';
    throw error;
  }

  const messages = splitMessageIntoSentences(messageContent, payload.splitPattern ?? null);
  const pushSubscription = payload.pushSubscription;
  const contactName = payload.contactName;
  const avatarUrl = payload.avatarUrl || null;
  const messageSubtype = payload.messageSubtype || 'chat';
  const metadata = payload.metadata || {};

  for (let i = 0; i < messages.length; i++) {
    const notificationPayload = buildInstantPushPayload({
      message: messages[i],
      index: i,
      total: messages.length,
      contactName,
      avatarUrl,
      messageSubtype,
      metadata,
    });

    try {
      await sendWebPush({
        subscription: pushSubscription,
        payload: JSON.stringify(notificationPayload),
        vapid: ctx.vapid,
        fetch: fetchImpl,
      });
      onEvent({ type: 'push_sent', messageIndex: i + 1, totalMessages: messages.length });
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
    sentAt: new Date().toISOString()
  };
}

/**
 * v0.7 agentic-loop path. Repeats:
 *   call LLM → build SessionContext → onLLMOutput(ctx) → dispatch.
 *
 * Hard cap at `maxLoopIterations` (default 10): once exceeded, the
 * worker emits `loop_exceeded`, pushes a diagnostic envelope to the
 * SW, and returns HTTP 200 with `{ status: 'loop_exceeded', ... }`.
 * Loop-exceeded is NOT thrown — the worker has completed its
 * "deliver a diagnostic" contract, and a non-2xx would make clients
 * mis-treat it as retryable.
 *
 * @param {Object} payload
 * @param {Object} ctx
 * @returns {Promise<object>}
 */
async function runAgenticLoop(payload, ctx) {
  const fetchImpl = ctx.fetch || globalThis.fetch;
  const onEvent = typeof ctx.onEvent === 'function' ? ctx.onEvent : () => {};
  const maxLoopIterations = Number.isInteger(ctx.maxLoopIterations) && ctx.maxLoopIterations > 0
    ? ctx.maxLoopIterations
    : DEFAULT_MAX_LOOP_ITERATIONS;
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId
    ? payload.sessionId
    : randomUUID();

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
      // Hook contract violation: emit event, try to push a diagnostic,
      // then throw HookError. The diagnostic push is best-effort —
      // its failure must not eclipse the original hook error.
      onEvent({ type: 'hook_threw', sessionId, iteration, cause: err });
      const diagnostic = {
        type: 'error',
        code: 'HOOK_THREW',
        sessionId,
        iteration,
        message: err?.message ?? 'onLLMOutput hook threw',
      };
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

    // 'finish' or 'tool-request' — both deliver a push.
    await sendPushWithMaybeBlob(decision.pushPayload, payload, ctx, sessionId);
    onEvent({
      type: decision.decision === 'finish' ? 'final_pushed' : 'tool_request_pushed',
      sessionId,
      iteration,
    });
    return { status: decision.decision === 'finish' ? 'finished' : 'tool_requested', sessionId, iteration };
  }

  // Loop budget exhausted: emit, attempt diagnostic push, return 200.
  onEvent({ type: 'loop_exceeded', sessionId, iteration });
  const diagnostic = {
    type: 'error',
    code: 'LOOP_EXCEEDED',
    sessionId,
    iteration,
    message: `Agentic loop exceeded ${maxLoopIterations} iterations`,
  };
  try {
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
  if (tag === 'continue' && !Array.isArray(/** @type {{ nextHistory?: unknown }} */ (decision).nextHistory)) {
    throw new TypeError('decision:"continue" requires a nextHistory array');
  }
  if ((tag === 'finish' || tag === 'tool-request')
      && /** @type {{ pushPayload?: unknown }} */ (decision).pushPayload === undefined) {
    throw new TypeError(`decision:"${tag}" requires a pushPayload`);
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
 * Push the hook-provided `pushPayload`. If its UTF-8 byte length
 * exceeds `maxInlineBytes`:
 *   - With a `blobStore` configured → write body to the store, push
 *     a small envelope `{ _blob:true, key, url, type? }` instead.
 *   - Without → emit `payload_too_large` and throw
 *     `PayloadTooLargeError`.
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

  // Build absolute envelope URL from the inbound request — SW fetches
  // back to the same origin without needing a separate endpoint
  // config. Hard-coded `/blob/...` path: deployers wanting a sub-
  // prefix must strip it in their outer router (see README §Subpath
  // mount).
  const blobUrl = buildBlobUrl(ctx.requestUrl, key);
  const envelope = {
    _blob: true,
    key,
    url: blobUrl,
    type: pushPayload && typeof pushPayload === 'object'
      ? /** @type {{ type?: unknown }} */ (pushPayload).type
      : undefined,
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
 * Derive the absolute `/blob/:key` URL the SW should fetch. Uses the
 * inbound `request.url` so the package never has to know the public
 * hostname. Falls back to a root-anchored path when `requestUrl` is
 * absent (rare — only when the handler is invoked outside the HTTP
 * adapter, e.g. via unit-test harness).
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

export { sendPushWithMaybeBlob };
