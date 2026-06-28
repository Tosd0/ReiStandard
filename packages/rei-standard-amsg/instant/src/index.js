/**
 * @rei-standard/amsg-instant
 *
 * Stateless one-shot instant push handler. The entire lifecycle of an
 * instant request lives inside a single function invocation:
 *   parse → call LLM → build push payloads → deliver Web Push → 200 OK.
 * No DB, no cron, no tenant init. Zero runtime dependencies. Pure Web
 * Crypto under the hood, so the same handler runs unchanged on Cloudflare
 * Workers (no `nodejs_compat` flag), Vercel Edge, Netlify Edge, Deno,
 * Bun, and Node.
 *
 * Usage:
 *   import { createInstantHandler } from '@rei-standard/amsg-instant';
 *
 *   export default {
 *     fetch: createInstantHandler({
 *       vapid: { email, publicKey, privateKey },
 *       clientToken: env.AMSG_CLIENT_TOKEN,   // optional
 *     })
 *   };
 */

import { validateInstantPayload, validateContinuePayload } from './validation.js';
import { processInstantMessage, sendPushWithMaybeBlob, ensureStableMessageId } from './message-processor.js';
import { MESSAGE_TYPE, PUSH_SOURCE, buildErrorPush } from '@rei-standard/amsg-shared';
import { HookError, PayloadTooLargeError, LlmCallError } from './errors.js';
import {
  utf8,
  utf8Decode,
  base64UrlToBytes,
  hmacSha256,
  timingSafeEqualBytes,
  randomUUID,
} from './utils.js';
import {
  DEFAULT_MULTIPART_CHUNK_BYTES,
  DEFAULT_MULTIPART_MAX_CHUNKS,
  DEFAULT_MULTIPART_MAX_TOTAL_BYTES,
  DEFAULT_MULTIPART_TTL_MS,
} from './multipart.js';

const BLOB_KEY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Hot-path SSE encoding helpers. `TextEncoder` is stateless under the
// hood, and the keepalive comment is fixed bytes — encoding either on
// every request / every 15s is pure overhead. Hoist once at module
// load.
const SSE_ENCODER = new TextEncoder();
const SSE_KEEPALIVE_BYTES = SSE_ENCODER.encode(': keepalive\n\n');
const SSE_DONE_BYTES = SSE_ENCODER.encode('event: done\ndata: {}\n\n');
const DEFAULT_SSE_KEEPALIVE_MS = 1000;
const MIN_SSE_KEEPALIVE_MS = 250;

/**
 * True when the caller asked exclusively for JSON. Any Accept value
 * that lists another media type (including `*\/*`) keeps the default
 * SSE transport — that's the legacy `consumeInstantStream` path which
 * does not set an Accept header at all.
 *
 * Strict `headers.get('accept') === 'application/json'` is too narrow:
 * `application/json; charset=utf-8` or `application/json, *\/*` would
 * silently fall through to SSE and break `await res.json()` callers.
 */
function acceptsJsonOnly(acceptHeader) {
  if (typeof acceptHeader !== 'string' || acceptHeader.length === 0) return false;
  const ranges = acceptHeader.split(',').map((r) => r.split(';')[0].trim().toLowerCase()).filter(Boolean);
  return ranges.length > 0 && ranges.every((r) => r === 'application/json');
}

/**
 * @typedef {Object} VapidConfig
 * @property {string} email
 * @property {string} publicKey   - base64url, 65 B uncompressed P-256 point.
 * @property {string} privateKey  - base64url, 32 B scalar.
 */

/**
 * @typedef {Object} CorsConfig
 * @property {string} [allowOrigin='*']   - Value for `Access-Control-Allow-Origin`. Set to a specific origin (e.g. `https://app.example.com`) to enable credentialed requests / lock down which sites can call the Worker. `*` is fine for public instant endpoints — pushes are gated by the VAPID subscription key, not by origin.
 */

/**
 * @typedef {Object} InstantHandlerOptions
 * @property {VapidConfig} vapid              - VAPID keys for Web Push.
 *
 * Note on splitting:
 *
 *   0.8.0 removes the public `splitPattern` / `reasoningSplitPattern`
 *   / `errorSplitPattern` request fields. Hook callers own semantic
 *   splitting now: implement any custom split function inside
 *   `onLLMOutput`, then return the exact `pushPayloads` array to send.
 *
 *   The legacy non-hook path still keeps its v0.6-compatible internal
 *   sentence splitter (`/([。！？!?]+)/`) so old completePrompt-style
 *   callers retain the same burst behaviour. There is no handler-level
 *   `splitFn` option.
 * @property {string} [clientToken]           - Optional shared secret. When set, requests must send a matching `X-Client-Token` header. Weak by design: the token is visible in any frontend bundle that uses it. Use `tokenSigningKey` for real auth.
 * @property {string} [tokenSigningKey]       - Optional HMAC key. When set, `Authorization: Bearer <token>` is verified.
 * @property {CorsConfig} [cors]              - CORS configuration. Defaults to `{ allowOrigin: '*' }`. Every response (including the 204 preflight short-circuit) carries the matching `Access-Control-Allow-*` headers.
 * @property {Object} [webpush]               - **Deprecated since 0.3.0.** Ignored. amsg-instant now implements RFC 8291 + RFC 8292 natively on Web Crypto. Tests should intercept the push HTTP request via `options.fetch` instead.
 * @property {typeof fetch} [fetch]           - Optional fetch override (testing / custom proxy). Used for BOTH the LLM call and the outgoing Web Push POST.
 * @property {(work: Promise<unknown>) => void} [waitUntil]
 *           - Optional lifecycle extender for runtimes with a background
 *             completion hook. Prefer passing it per request when the
 *             platform provides a request-scoped context (for example
 *             Cloudflare Workers' `ctx.waitUntil`).
 * @property {(e: { type: string }) => void} [onEvent]
 * @property {(ctx: import('./session-context.js').SessionContext) => Promise<object> | object} [onLLMOutput]
 *           - **v0.7 hook.** When provided, the handler switches from
 *             the legacy one-shot path to a per-turn agentic loop.
 *             The hook returns one of:
 *               `{ decision: 'finish',       pushPayloads }`
 *               `{ decision: 'tool-request', pushPayloads }`
 *               `{ decision: 'continue',     nextHistory }`
 *               `{ decision: 'skip-push' }`
 *             See README §Agentic Loop.
 * @property {(ctx: { requestBody: unknown, sessionId: string, metadata: Record<string, unknown> }) => unknown | Promise<unknown>} [onBeforeLoop]
 *           - **v0.9 hook.** Run before the LLM loop starts. Use to launch parallel tasks.
 * @property {(ctx: { deliver: (payload: unknown) => Promise<void>, sessionId: string, metadata: Record<string, unknown>, requestBody: unknown, pending: unknown }) => Promise<void>} [onAfterLoop]
 *           - **v0.9 hook.** Run after the LLM loop ends. Use to await parallel tasks and append payloads.
 * @property {import('./blob-store/interface.js').BlobStoreConfig} [blobStore]
 *           - Optional. When a push payload's
 *             UTF-8 byte length exceeds `maxInlineBytes` (default
 *             2600), the body is written to the adapter and the SW
 *             receives a small `{ _blob, key, url, messageKind?, type? }`
 *             envelope instead. Without `blobStore`, the default
 *             generic multipart transport handles JSON-safe oversized
 *             payloads unless disabled or over its limits.
 * @property {number} [maxLoopIterations=10]  - Hard ceiling on in-loop `decision:'continue'` rounds within a single worker invocation. Cross-invocation `/continue` floods are the deployer's auth/rate-limit concern.
 * @property {boolean} [autoEmitReasoning=true]
 *           - **v0.8 hook-path config.** When `true` (default), the
 *             framework auto-emits a `ReasoningPush` before invoking
 *             `onLLMOutput` whenever the LLM response carries a
 *             non-empty `choices[0].message.reasoning_content`. The
 *             hook can still `skip-push` its own content/tool push —
 *             the reasoning push has already shipped. Set to `false`
 *             when the hook author wants total control over every
 *             push that leaves the worker; in that mode the hook can
 *             read `ctx.llmResponse.choices[0].message.reasoning_content`
 *             and produce its own `buildReasoningPush(...)` envelope.
 *             Legacy (non-hook) path always auto-emits regardless.
 * @property {Object} [multipart]
 *           - **0.8.0 transport knob.** Generic multipart fallback for
 *             oversized JSON-safe push payloads when no BlobStore is
 *             configured. Applies to every `messageKind` (including
 *             reasoning, tool_request, content, error, and custom
 *             kinds). Defaults to enabled.
 * @property {boolean} [multipart.enabled=true]
 * @property {number} [multipart.maxChunkBytes=1800]
 * @property {number} [multipart.ttlMs=60000]
 * @property {number} [multipart.maxChunks=128]
 * @property {number} [multipart.maxTotalBytes=256000]
 * @property {number | null} [reasoningChunkBytes]
 *           - Deprecated alias for `multipart.maxChunkBytes`.
 *             `null` disables generic multipart only when `multipart`
 *             is not explicitly configured. It no longer produces
 *             reasoning-only `chunkIndex` / `totalChunks` wire fields.
 * @property {Object} [sse]
 * @property {'on'} [sse.backupPush='on']
 *           - SSE always sends a Web Push backup after every successful
 *             enqueue. `off` / `delayed` are intentionally rejected so
 *             production cannot opt into known-lossy delivery modes.
 * @property {number} [sse.keepaliveMs=1000]
 * @property {boolean} [sse.immediateKeepalive=true]
 */

/**
 * Create a Fetch-API-compatible handler: `async (request) => Response`.
 *
 * The handler is the same shape used by Cloudflare Workers, Deno Deploy,
 * Vercel Edge, and Bun. Wrap it with one of the platform adapters if you
 * are on Node/Express, Netlify Functions, or Vercel Serverless Functions.
 * When used directly as a Cloudflare Workers module `fetch`, the extra
 * `(env, ctx)` arguments are accepted: SSE mode drives LLM and every
 * push to completion inside the stream's `start()`, so the runtime
 * never reclaims the isolate while work is in flight; pure-push mode
 * (`Accept: application/json`) registers the LLM → split → push chain
 * with `ctx.waitUntil`.
 *
 * @param {InstantHandlerOptions} options
 * @returns {(request: Request, envOrRuntime?: unknown, runtime?: unknown) => Promise<Response>}
 */
export function createInstantHandler(options) {
  if (!options) throw new Error('[amsg-instant] options is required');
  if (!options.vapid) throw new Error('[amsg-instant] options.vapid is required');

  if (options.webpush !== undefined) {
    // Loud-but-survivable deprecation: keep accepting the option so 0.2.x
    // callers don't crash, but make it obvious in any non-silent runtime.
    const warn = globalThis.console && globalThis.console.warn;
    if (typeof warn === 'function') {
      warn('[amsg-instant] options.webpush is deprecated and ignored since 0.3.0. Intercept push delivery via options.fetch in tests.');
    }
  }

  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const tokenSigningKey = options.tokenSigningKey ? String(options.tokenSigningKey) : '';
  const clientToken = options.clientToken ? String(options.clientToken) : '';
  const expectedClientTokenBytes = clientToken ? utf8(clientToken) : null;
  const corsHeaders = buildCorsHeaders(options.cors);
  const onLLMOutput = typeof options.onLLMOutput === 'function' ? options.onLLMOutput : null;
  const onBeforeLoop = typeof options.onBeforeLoop === 'function' ? options.onBeforeLoop : null;
  const onAfterLoop = typeof options.onAfterLoop === 'function' ? options.onAfterLoop : null;
  const blobStore = options.blobStore || null;
  const maxLoopIterations = Number.isInteger(options.maxLoopIterations) && options.maxLoopIterations > 0
    ? options.maxLoopIterations
    : 10;
  // Default true: reasoning emission "just works" out of the box for
  // most hook callers. The legacy path ignores this setting and
  // always auto-emits.
  const autoEmitReasoning = options.autoEmitReasoning !== false;
  // Eager validation keeps transport misconfiguration in startup logs /
  // unit tests instead of surprising the first oversized push.
  const multipart = resolveMultipartOptions(options);
  const sse = resolveSseOptions(options.sse);

  // Validate VAPID shape eagerly so misconfiguration surfaces on the very
  // first request rather than the first Web Push attempt.
  const vapidValid = isVapidConfigValid(options.vapid);

  const respond = (status, body) => jsonResponse(status, body, corsHeaders);

  return async function handler(request, envOrRuntime, runtime) {
    onEvent({ type: 'request' });

    // CORS preflight short-circuit. Browsers fire OPTIONS before any
    // cross-origin POST that carries `Authorization` / `Content-Type:
    // application/json` / a custom `X-Client-Token` header — so this path
    // hits before we ever try to parse the JSON body.
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(request.url);
    } catch {
      parsedUrl = null;
    }
    const pathname = parsedUrl ? parsedUrl.pathname : '';

    // `GET /blob/:key` — public envelope read. Hard-coded path. No
    // auth (SW can't easily attach the caller's Bearer/clientToken);
    // protection is UUID v4 + TTL. CORS opens it for cross-origin SW
    // fetches.
    if (pathname.startsWith('/blob/') && request.method === 'GET') {
      return handleBlobRead(request, pathname, blobStore, corsHeaders);
    }

    if (request.method !== 'POST') {
      return respond(405, {
        success: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST is supported' }
      });
    }

    if (tokenSigningKey) {
      const tokenError = await verifyBearerToken(request, tokenSigningKey, respond);
      if (tokenError) return tokenError;
    }

    if (expectedClientTokenBytes) {
      const tokenError = verifyClientToken(request, expectedClientTokenBytes, respond);
      if (tokenError) return tokenError;
    }

    let rawBody;
    try {
      rawBody = await readRequestBodyText(request);
    } catch (err) {
      return respond(400, {
        success: false,
        error: {
          code: 'INVALID_PAYLOAD_FORMAT',
          message: err && err.unsupportedEncoding
            ? '运行时不支持解压 gzip 请求体（X-Amsg-Request-Encoding: gzip）'
            : '无法读取请求体',
        }
      });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return respond(400, {
        success: false,
        error: { code: 'INVALID_PAYLOAD_FORMAT', message: '请求体不是合法 JSON' }
      });
    }

    const isContinue = pathname === '/continue';

    // `/continue` is a v0.7-only endpoint that exists solely to resume an
    // agentic-loop turn. A handler created without `onLLMOutput` has no
    // loop to resume — without this guard the request would pass
    // validation, enter `runAgenticLoop`, and crash on `ctx.onLLMOutput(
    // ...)` with `TypeError: ctx.onLLMOutput is not a function`, which
    // then routes through the HOOK_THREW pipeline and ships the operator
    // a misleading "hook threw" diagnostic for what is really a deploy
    // misconfiguration. Reject up-front with a clear 400 so the SW (or
    // the operator reading logs) knows exactly which knob to turn.
    if (isContinue && !onLLMOutput) {
      return respond(400, {
        success: false,
        error: {
          code: 'CONTINUE_NOT_AVAILABLE',
          message: '/continue 仅在 createInstantHandler 配置了 onLLMOutput 时可用',
        },
      });
    }

    // Validator selection — `/continue` uses its own schema, `/instant`
    // (and any other POST path) goes through `validateInstantPayload`
    // with a `hookPath` flag so it can reject `completePrompt` when
    // the agentic loop is configured. Backwards compat preserved when
    // pathname is anything else (e.g. `/`, `/foo`): legacy v0.6
    // behaviour was to accept any POST regardless of path.
    let validation;
    if (isContinue) {
      validation = validateContinuePayload(payload, { maxLoopIterations });
    } else {
      validation = validateInstantPayload(payload, {
        hookPath: !!onLLMOutput,
        maxLoopIterations,
      });
    }

    if (!validation.valid) {
      return respond(400, {
        success: false,
        error: {
          code: validation.errorCode,
          message: validation.errorMessage,
          details: validation.details
        }
      });
    }

    if (!vapidValid) {
      return respond(500, {
        success: false,
        error: { code: 'VAPID_CONFIG_ERROR', message: 'VAPID 配置缺失或无效' }
      });
    }

    try {
      const isPurePush = acceptsJsonOnly(request.headers.get('accept'));
      const sessionId = typeof payload.sessionId === 'string' && payload.sessionId ? payload.sessionId : `sess_${randomUUID()}`;

      const processorCtx = {
        vapid: options.vapid,
        fetch: options.fetch || globalThis.fetch,
        onEvent,
        onLLMOutput,
        blobStore,
        maxLoopIterations,
        autoEmitReasoning,
        multipart,
        requestUrl: request.url,
        isResume: isContinue,
      };

      // Resolve metadata once. `|| {}` would mint two distinct empty
      // objects for the two hook calls, so any reference-based
      // book-keeping done by onBeforeLoop wouldn't survive into
      // onAfterLoop. Sharing one ref also matches caller intuition.
      const hookMetadata = payload.metadata || {};

      // Single lifecycle helper used by both transport modes — keeps
      // hook ordering identical regardless of how `deliver` is wired.
      const runWithLifecycleHooks = async () => {
        let pending;
        if (onBeforeLoop) {
          pending = await onBeforeLoop({ requestBody: payload, sessionId, metadata: hookMetadata });
        }
        const result = await processInstantMessage({ ...payload, sessionId }, processorCtx);
        if (onAfterLoop) {
          await onAfterLoop({
            deliver: processorCtx.deliver,
            sessionId,
            metadata: hookMetadata,
            requestBody: payload,
            pending,
          });
        }
        return result;
      };

      if (isPurePush) {
        processorCtx.deliver = async (pushPayload) => {
          await sendPushWithMaybeBlob(ensureStableMessageId(pushPayload), payload, processorCtx, sessionId);
        };
        const work = runWithLifecycleHooks();
        registerWaitUntil(work, resolveWaitUntil(envOrRuntime, runtime, options), onEvent);
        const result = await work;
        return respond(200, { success: true, data: result });
      }

      // SSE Mode — pacing is irrelevant since chunks pipe straight to
      // the consumer (no push-gateway rate limit to smooth over).
      processorCtx.spacingMs = 0;

      // Stream lifecycle. The runtime treats the Response body as
      // "still in production" while `start()` is awaiting — no
      // wall-clock limit applies. We use that window to drive LLM +
      // every push to completion, then close last:
      //   - `streamUsable=false` on enqueue failure / abort makes
      //     subsequent payloads ship via Web Push fallback without
      //     returning early from `start()`.
      //   - `controller.close()` is called in `finally`, after
      //     `Promise.allSettled(backupWork)`, so push HTTP calls
      //     never race the runtime tearing down the isolate.
      // `registerWaitUntil(startDone)` is a thin insurance for the
      // window between `start()` finishing and the runtime releasing
      // the isolate; it's resolved at the tail of `finally`, so under
      // normal conditions there's nothing left for waitUntil to wait
      // on. The LLM body never rides on it.
      let resolveStartDone;
      const startDone = new Promise((resolve) => { resolveStartDone = resolve; });
      registerWaitUntil(startDone, resolveWaitUntil(envOrRuntime, runtime, options), onEvent);

      const backupWork = new Set();
      let streamUsable = true;
      let keepaliveTimer = null;
      let activeController = null;

      const stopKeepalive = () => {
        if (keepaliveTimer) {
          clearInterval(keepaliveTimer);
          keepaliveTimer = null;
        }
      };
      const trackBackupWork = (work) => {
        backupWork.add(work);
        work.finally(() => {
          backupWork.delete(work);
        });
      };
      const messageIdOf = (body) => (
        body && typeof body === 'object' && typeof body.messageId === 'string'
          ? body.messageId
          : undefined
      );
      const scheduleBackupPush = (body) => {
        const messageId = messageIdOf(body);
        onEvent({ type: 'backup_push_scheduled', sessionId, messageId });
        const work = (async () => {
          try {
            await sendPushWithMaybeBlob(body, payload, processorCtx, sessionId);
            onEvent({ type: 'backup_push_sent', sessionId, messageId });
          } catch (pushErr) {
            onEvent({ type: 'backup_push_failed', sessionId, messageId, cause: pushErr });
          }
        })();
        trackBackupWork(work);
      };
      const enqueueKeepalive = () => {
        if (!streamUsable || request.signal.aborted || !activeController) return;
        try {
          activeController.enqueue(SSE_KEEPALIVE_BYTES);
        } catch {
          streamUsable = false;
          stopKeepalive();
        }
      };
      const startKeepalive = () => {
        if (!streamUsable || request.signal.aborted) return;
        if (sse.immediateKeepalive) enqueueKeepalive();
        if (!streamUsable || request.signal.aborted) return;
        keepaliveTimer = setInterval(enqueueKeepalive, sse.keepaliveMs);
      };
      const safeClose = () => {
        // `controller.close()` throws TypeError if the stream is
        // already errored (e.g. previous enqueue failed). We're
        // exiting anyway — swallow.
        try { activeController && activeController.close(); } catch { /* already closed/errored */ }
      };

      return new Response(
        new ReadableStream({
          async start(controller) {
            activeController = controller;
            const onAbort = () => {
              if (!streamUsable) return;
              streamUsable = false;
              stopKeepalive();
              onEvent({ type: 'sse_stream_aborted', sessionId });
            };
            request.signal.addEventListener('abort', onAbort);
            if (request.signal.aborted) onAbort();

            const cleanup = () => {
              stopKeepalive();
              request.signal.removeEventListener('abort', onAbort);
            };

            // Dual transport boundary. Two cases, NOT one:
            //   (1) Always-on backup: when SSE enqueue succeeds we ALSO
            //       call `scheduleBackupPush(stableBody)` so the same
            //       `messageId` ships on both SSE and Web Push. The SW
            //       / client dedupe gate collapses them back to a single
            //       business delivery (and at most one notification).
            //   (2) True fallback: when the stream is unusable (gone /
            //       aborted) or `controller.enqueue` throws, we skip SSE
            //       entirely and ship the payload via Web Push only.
            // Used for both normal `event: payload` and `event: error`.
            const safeEnqueue = async (eventName, body, onFallbackFail) => {
              const stableBody = ensureStableMessageId(body);
              const messageId = messageIdOf(stableBody);
              const fallback = async () => {
                try {
                  await sendPushWithMaybeBlob(stableBody, payload, processorCtx, sessionId);
                  onEvent({ type: 'fallback_push_sent', sessionId, messageId, eventName });
                } catch (pushErr) {
                  onEvent({ type: 'fallback_push_failed', sessionId, messageId, eventName, cause: pushErr });
                  if (onFallbackFail) onFallbackFail(pushErr);
                }
              };
              if (!streamUsable || request.signal.aborted) {
                streamUsable = false;
                stopKeepalive();
                await fallback();
                return;
              }
              try {
                controller.enqueue(SSE_ENCODER.encode(`event: ${eventName}\ndata: ${JSON.stringify(stableBody)}\n\n`));
                onEvent({ type: 'sse_payload_enqueued', sessionId, messageId, eventName });
                scheduleBackupPush(stableBody);
              } catch (err) {
                streamUsable = false;
                stopKeepalive();
                onEvent({ type: 'sse_payload_enqueue_failed', sessionId, messageId, eventName, cause: err });
                await fallback();
              }
            };

            processorCtx.deliver = async (pushPayload) => {
              await safeEnqueue('payload', pushPayload);
            };
            startKeepalive();

            try {
              await runWithLifecycleHooks();

              if (streamUsable) {
                try { controller.enqueue(SSE_DONE_BYTES); } catch { /* race with abort */ }
              }
            } catch (err) {
              // HookError carries an in-loop ErrorPush that already
              // shipped via `deliver` (as event: payload) before the
              // throw — don't echo a second `event: error` for the
              // same logical failure. Other errors (LlmCallError,
              // unexpected) had no in-loop diagnostic and DO need one.
              if (!(err instanceof HookError)) {
                const diag = buildErrorPush({
                  messageType: MESSAGE_TYPE.INSTANT,
                  source: PUSH_SOURCE.INSTANT,
                  messageId: `msg_${randomUUID()}_error`,
                  sessionId,
                  code: err?.code || 'INTERNAL_ERROR',
                  message: err?.message || '内部错误',
                  timestamp: new Date().toISOString(),
                });
                await safeEnqueue('error', diag, (pushErr) => {
                  onEvent({ type: 'sse_error_fallback_failed', sessionId, cause: pushErr });
                });
              }
            } finally {
              cleanup();
              // Close last: while `start()` is awaiting backupWork the
              // runtime keeps the isolate alive without wall-clock
              // pressure. Closing earlier would flip the request into
              // invocation-end state and budget the remaining push
              // HTTP fetches against the runtime's waitUntil ceiling.
              await Promise.allSettled(Array.from(backupWork));
              safeClose();
              resolveStartDone();
            }
          },
          cancel(reason) {
            streamUsable = false;
            stopKeepalive();
            onEvent({ type: 'sse_stream_canceled', sessionId, reason });
          }
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          }
        }
      );

    } catch (err) {
      onEvent({ type: 'error', code: err?.code, message: err?.message });
      const code = err?.code || 'INTERNAL_ERROR';
      const status = mapErrorStatus(err, code);
      return respond(status, {
        success: false,
        error: { code, message: err?.message || '内部错误' },
      });
    }
  };
}

function resolveWaitUntil(envOrRuntime, runtime, options) {
  if (runtime && typeof runtime.waitUntil === 'function') {
    return { waitUntil: runtime.waitUntil, target: runtime };
  }
  if (envOrRuntime && typeof envOrRuntime.waitUntil === 'function') {
    return { waitUntil: envOrRuntime.waitUntil, target: envOrRuntime };
  }
  if (options && typeof options.waitUntil === 'function') {
    return { waitUntil: options.waitUntil, target: undefined };
  }
  return null;
}

function registerWaitUntil(work, lifecycle, onEvent) {
  if (!lifecycle) return;
  const backgroundWork = work.catch((err) => {
    onEvent({ type: 'wait_until_rejected', code: err?.code, message: err?.message });
  });
  try {
    lifecycle.waitUntil.call(lifecycle.target, backgroundWork);
  } catch (err) {
    onEvent({ type: 'wait_until_failed', cause: err });
  }
}

function resolveMultipartOptions(options) {
  const hasMultipart = options.multipart !== undefined;
  const raw = hasMultipart ? options.multipart : {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('[amsg-instant] multipart must be a plain object when set');
  }

  const multipart = /** @type {Record<string, unknown>} */ (raw);
  let enabled = multipart.enabled !== false;
  let maxChunkBytes = multipart.maxChunkBytes;

  if (options.reasoningChunkBytes !== undefined && maxChunkBytes === undefined) {
    if (options.reasoningChunkBytes === null) {
      if (!hasMultipart) enabled = false;
    } else {
      maxChunkBytes = options.reasoningChunkBytes;
    }
  }

  return {
    enabled,
    maxChunkBytes: resolvePositiveInt(maxChunkBytes, DEFAULT_MULTIPART_CHUNK_BYTES, 'multipart.maxChunkBytes'),
    ttlMs: resolvePositiveInt(multipart.ttlMs, DEFAULT_MULTIPART_TTL_MS, 'multipart.ttlMs'),
    maxChunks: resolvePositiveInt(multipart.maxChunks, DEFAULT_MULTIPART_MAX_CHUNKS, 'multipart.maxChunks'),
    maxTotalBytes: resolvePositiveInt(multipart.maxTotalBytes, DEFAULT_MULTIPART_MAX_TOTAL_BYTES, 'multipart.maxTotalBytes'),
  };
}

function resolveSseOptions(input) {
  const raw = input === undefined ? {} : input;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('[amsg-instant] sse must be a plain object when set');
  }

  const backupPush = raw.backupPush === undefined ? 'on' : String(raw.backupPush);
  if (backupPush !== 'on') {
    throw new TypeError('[amsg-instant] sse.backupPush is always "on" in 0.9.0 stable');
  }
  if (raw.backupDelayMs !== undefined) {
    throw new TypeError('[amsg-instant] sse.backupDelayMs was removed; backup push is immediate');
  }

  const keepaliveMs = Math.max(
    MIN_SSE_KEEPALIVE_MS,
    resolvePositiveInt(raw.keepaliveMs, DEFAULT_SSE_KEEPALIVE_MS, 'sse.keepaliveMs')
  );

  return {
    backupPush,
    keepaliveMs,
    immediateKeepalive: raw.immediateKeepalive !== false,
  };
}

function resolvePositiveInt(value, fallback, fieldName) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`[amsg-instant] ${fieldName} must be a positive integer. Got: ${value}`);
  }
  return value;
}

/**
 * Map an Error to its HTTP status code. `HookError` is in-process
 * caller-supplied code that misbehaved — 500. `LlmCallError` /
 * `PUSH_SEND_FAILED` are upstream — 502. `PayloadTooLargeError` is
 * a config mismatch (no blob store) on a hook-path response — 500
 * is more honest than 413 since the limit isn't the HTTP body, it's
 * the *push payload*.
 *
 * @param {unknown} err
 * @param {string} code
 * @returns {number}
 */
function mapErrorStatus(err, code) {
  if (err instanceof HookError) return 500;
  if (err instanceof LlmCallError) return 502;
  if (err instanceof PayloadTooLargeError) return 500;
  if (code === 'PUSH_SEND_FAILED' || code === 'LLM_CALL_FAILED') return 502;
  return 500;
}

/**
 * `GET /blob/:key` handler. Returns the previously-stored blob body
 * to the SW, with `Access-Control-Allow-Origin: *` so a cross-origin
 * SW fetch can read it. Multiple reads within the TTL return the
 * same body — push-redelivery scenarios rely on this so the SW can
 * dedup *after* fetching.
 *
 * @param {Request} request
 * @param {string} pathname
 * @param {import('./blob-store/interface.js').BlobStoreConfig | null} blobStore
 * @param {Record<string, string>} baseHeaders
 * @returns {Promise<Response>}
 */
async function handleBlobRead(request, pathname, blobStore, baseHeaders) {
  if (!blobStore || !blobStore.adapter) {
    return new Response(JSON.stringify({ error: 'blob_store_not_configured' }), {
      status: 404,
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
  const key = pathname.slice('/blob/'.length);
  if (!BLOB_KEY_REGEX.test(key)) {
    return new Response(JSON.stringify({ error: 'invalid_key' }), {
      status: 400,
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
  let body;
  try {
    body = await blobStore.adapter.read(key);
  } catch {
    return new Response(JSON.stringify({ error: 'blob_read_failed' }), {
      status: 502,
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
  if (typeof body !== 'string') {
    return new Response(JSON.stringify({ error: 'blob_not_found_or_expired' }), {
      status: 404,
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
  return new Response(body, {
    status: 200,
    headers: {
      ...baseHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

function getHeader(request, name) {
  try {
    return String(request.headers.get(name) || '').trim();
  } catch {
    return '';
  }
}

/**
 * Read the request body as text, transparently gunzip-ing it when the
 * client opted into request compression. `@rei-standard/amsg-client`'s
 * `deliver({ compressRequest })` gzips a large request body and marks it
 * with `X-Amsg-Request-Encoding: gzip` — a non-standard header, deliberately
 * not `Content-Encoding`, so CDNs / proxies don't decode it out from under us.
 * No marker ⇒ the body is read verbatim, so uncompressed requests are
 * unaffected.
 *
 * @param {Request} request
 * @returns {Promise<string>}
 */
async function readRequestBodyText(request) {
  if (getHeader(request, 'x-amsg-request-encoding').toLowerCase() !== 'gzip') {
    return request.text();
  }
  if (typeof DecompressionStream === 'undefined') {
    const err = new Error('runtime lacks DecompressionStream for gzip request body');
    err.unsupportedEncoding = true;
    throw err;
  }
  const compressed = await request.arrayBuffer();
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/**
 * Build the `Access-Control-Allow-*` headers applied to every response.
 *
 * `Vary: Origin` is added only when the allowed origin isn't the wildcard
 * — caching layers in front of the Worker need it so they don't serve a
 * permissive ACAO header to the wrong site.
 *
 * @param {{ allowOrigin?: string } | undefined} cors
 * @returns {Record<string, string>}
 */
function buildCorsHeaders(cors) {
  const allowOrigin = (cors && typeof cors.allowOrigin === 'string' && cors.allowOrigin.trim())
    ? cors.allowOrigin.trim()
    : '*';

  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Token, X-Amsg-Request-Encoding',
    'Access-Control-Max-Age': '86400',
  };
  if (allowOrigin !== '*') {
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function jsonResponse(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(extraHeaders || {}),
    },
  });
}

function isVapidConfigValid(vapid) {
  if (!vapid || !vapid.email || !vapid.publicKey || !vapid.privateKey) return false;
  // Don't fully parse here — sendWebPush will throw a precise error on bad
  // key shape. Just ensure none of the three fields are blank.
  return true;
}

function verifyClientToken(request, expectedBytes, respond) {
  const received = getHeader(request, 'x-client-token');
  if (!received) {
    return respond(401, {
      success: false,
      error: { code: 'INVALID_CLIENT_TOKEN', message: '缺少 X-Client-Token' }
    });
  }
  const receivedBytes = utf8(received);
  if (!timingSafeEqualBytes(receivedBytes, expectedBytes)) {
    return respond(401, {
      success: false,
      error: { code: 'INVALID_CLIENT_TOKEN', message: 'X-Client-Token 无效' }
    });
  }
  return null;
}

async function verifyBearerToken(request, signingKey, respond) {
  const authHeader = getHeader(request, 'authorization');
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return respond(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: '缺少 Authorization: Bearer <token>' }
    });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return respond(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: '空 Bearer token' }
    });
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return respond(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'token 格式无效' }
    });
  }

  const [encodedHeader, encodedPayload, receivedSig] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSigBytes = await hmacSha256(utf8(signingKey), utf8(signingInput));

  let receivedBytes;
  try {
    receivedBytes = base64UrlToBytes(receivedSig);
  } catch {
    return respond(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'token 签名格式无效' }
    });
  }
  if (!timingSafeEqualBytes(receivedBytes, expectedSigBytes)) {
    return respond(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'token 签名无效' }
    });
  }

  let payload;
  try {
    payload = JSON.parse(utf8Decode(base64UrlToBytes(encodedPayload)));
  } catch {
    return respond(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'token payload 解析失败' }
    });
  }

  if (!payload || payload.v !== 1 || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    return respond(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'token 已过期或无效' }
    });
  }

  return null;
}

// ─── Public re-exports (for advanced users / SSR / tests) ──────────────

export { validateInstantPayload, validateAvatarUrl, validateContinuePayload } from './validation.js';
export {
  processInstantMessage,
  normalizeAiApiUrl,
  sendPushWithMaybeBlob,
  readReasoningContent,
} from './message-processor.js';
export { buildMultipartPushPayloads } from './multipart.js';
export { sendWebPush, buildVapidJwt, verifyVapidJwt } from './webpush.js';
export { HookError, PayloadTooLargeError, LlmCallError, MemoryStoreFullError } from './errors.js';
export { buildSessionContext, extractAssistantMessage } from './session-context.js';

// Re-export the shared push schema so hook authors can import builders
// and types from a single place (instant) rather than having to add a
// second dependency on @rei-standard/amsg-shared.
export {
  MESSAGE_KIND,
  MESSAGE_TYPE,
  PUSH_SOURCE,
  buildContentPush,
  buildReasoningPush,
  buildToolRequestPush,
  buildErrorPush,
  isContentPush,
  isReasoningPush,
  isToolRequestPush,
  isErrorPush,
  chunkReasoningByUtf8Bytes,
} from '@rei-standard/amsg-shared';

export { segmentTextWithProtectedBlocks } from './segmentation.js';
