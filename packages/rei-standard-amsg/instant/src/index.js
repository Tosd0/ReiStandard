/**
 * @rei-standard/amsg-instant
 *
 * Stateless one-shot instant push handler. The entire lifecycle of an
 * instant request lives inside a single function invocation:
 *   parse → call LLM → split sentences → deliver Web Push → 200 OK.
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
import { processInstantMessage } from './message-processor.js';
import { HookError, PayloadTooLargeError, LlmCallError } from './errors.js';
import {
  utf8,
  utf8Decode,
  base64UrlToBytes,
  hmacSha256,
  timingSafeEqualBytes,
} from './utils.js';

const BLOB_KEY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
 * @property {string} [clientToken]           - Optional shared secret. When set, requests must send a matching `X-Client-Token` header. Weak by design: the token is visible in any frontend bundle that uses it. Use `tokenSigningKey` for real auth.
 * @property {string} [tokenSigningKey]       - Optional HMAC key. When set, `Authorization: Bearer <token>` is verified.
 * @property {CorsConfig} [cors]              - CORS configuration. Defaults to `{ allowOrigin: '*' }`. Every response (including the 204 preflight short-circuit) carries the matching `Access-Control-Allow-*` headers.
 * @property {Object} [webpush]               - **Deprecated since 0.3.0.** Ignored. amsg-instant now implements RFC 8291 + RFC 8292 natively on Web Crypto. Tests should intercept the push HTTP request via `options.fetch` instead.
 * @property {typeof fetch} [fetch]           - Optional fetch override (testing / custom proxy). Used for BOTH the LLM call and the outgoing Web Push POST.
 * @property {(e: { type: string }) => void} [onEvent]
 * @property {(ctx: import('./session-context.js').SessionContext) => Promise<object> | object} [onLLMOutput]
 *           - **v0.7 hook.** When provided, the handler switches from
 *             the legacy one-shot path to a per-turn agentic loop.
 *             The hook returns one of:
 *               `{ decision: 'finish',       pushPayload }`
 *               `{ decision: 'tool-request', pushPayload }`
 *               `{ decision: 'continue',     nextHistory }`
 *               `{ decision: 'skip-push' }`
 *             See README §Agentic Loop.
 * @property {import('./blob-store/interface.js').BlobStoreConfig} [blobStore]
 *           - Optional. When the hook returns a pushPayload whose
 *             UTF-8 byte length exceeds `maxInlineBytes` (default
 *             2600), the body is written to the adapter and the SW
 *             receives a small `{ _blob, key, url, type? }` envelope
 *             instead. Without `blobStore` the over-sized payload
 *             throws `PayloadTooLargeError`.
 * @property {number} [maxLoopIterations=10]  - Hard ceiling on in-loop `decision:'continue'` rounds within a single worker invocation. Cross-invocation `/continue` floods are the deployer's auth/rate-limit concern.
 */

/**
 * Create a Fetch-API-compatible handler: `async (request) => Response`.
 *
 * The handler is the same shape used by Cloudflare Workers, Deno Deploy,
 * Vercel Edge, and Bun. Wrap it with one of the platform adapters if you
 * are on Node/Express, Netlify Functions, or Vercel Serverless Functions.
 *
 * @param {InstantHandlerOptions} options
 * @returns {(request: Request) => Promise<Response>}
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
  const blobStore = options.blobStore || null;
  const maxLoopIterations = Number.isInteger(options.maxLoopIterations) && options.maxLoopIterations > 0
    ? options.maxLoopIterations
    : 10;

  // One-shot startup warning: a caller who sets both `onLLMOutput`
  // and `splitPattern` almost certainly hasn't realised the hook
  // path doesn't run the sentence splitter. We don't fail (the combo
  // is benign), just nudge them in the console so the dead config
  // doesn't go unnoticed in production logs.
  if (onLLMOutput && options.splitPattern !== undefined) {
    const warn = globalThis.console && globalThis.console.warn;
    if (typeof warn === 'function') {
      warn('[amsg-instant] splitPattern is ignored when onLLMOutput is provided. Move splitting logic into your hook if needed.');
    }
  }

  // Validate VAPID shape eagerly so misconfiguration surfaces on the very
  // first request rather than the first Web Push attempt.
  const vapidValid = isVapidConfigValid(options.vapid);

  const respond = (status, body) => jsonResponse(status, body, corsHeaders);

  return async function handler(request) {
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
      rawBody = await request.text();
    } catch (_err) {
      return respond(400, {
        success: false,
        error: { code: 'INVALID_PAYLOAD_FORMAT', message: '无法读取请求体' }
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
      const result = await processInstantMessage(payload, {
        vapid: options.vapid,
        fetch: options.fetch || globalThis.fetch,
        onEvent,
        onLLMOutput,
        blobStore,
        maxLoopIterations,
        requestUrl: request.url,
        isResume: isContinue,
      });
      return respond(200, { success: true, data: result });
    } catch (err) {
      onEvent({ type: 'error', code: err?.code, message: err?.message });
      const code = err?.code || 'INTERNAL_ERROR';
      const status = mapErrorStatus(err, code);
      // Unified envelope: every error goes through `error: { code, message }`
      // so SDK consumers can always read `body.error.code`. The plan's
      // earlier draft had HOOK_THREW emit a flat `error: 'hook_threw'`
      // string — that diverged from every other v0.6/v0.7 error and made
      // `body.error.code` undefined for hook failures. The push-payload
      // wire format (what the SW receives) stays as `{type:'error',
      // code:'HOOK_THREW',...}` — that's a separate layer.
      return respond(status, {
        success: false,
        error: { code, message: err?.message || '内部错误' },
      });
    }
  };
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Token',
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
  splitMessageIntoSentences,
  processInstantMessage,
  normalizeAiApiUrl,
  buildInstantPushPayload,
  sendPushWithMaybeBlob,
} from './message-processor.js';
export { sendWebPush, buildVapidJwt, verifyVapidJwt } from './webpush.js';
export { HookError, PayloadTooLargeError, LlmCallError, MemoryStoreFullError } from './errors.js';
export { buildSessionContext, extractAssistantMessage } from './session-context.js';
