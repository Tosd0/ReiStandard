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

import { validateInstantPayload } from './validation.js';
import { processInstantMessage } from './message-processor.js';
import {
  utf8,
  utf8Decode,
  base64UrlToBytes,
  hmacSha256,
  timingSafeEqualBytes,
} from './utils.js';

/**
 * @typedef {Object} VapidConfig
 * @property {string} email
 * @property {string} publicKey   - base64url, 65 B uncompressed P-256 point.
 * @property {string} privateKey  - base64url, 32 B scalar.
 */

/**
 * @typedef {Object} InstantHandlerOptions
 * @property {VapidConfig} vapid              - VAPID keys for Web Push.
 * @property {string} [clientToken]           - Optional shared secret. When set, requests must send a matching `X-Client-Token` header. Weak by design: the token is visible in any frontend bundle that uses it. Use `tokenSigningKey` for real auth.
 * @property {string} [tokenSigningKey]       - Optional HMAC key. When set, `Authorization: Bearer <token>` is verified.
 * @property {Object} [webpush]               - **Deprecated since 0.3.0.** Ignored. amsg-instant now implements RFC 8291 + RFC 8292 natively on Web Crypto. Tests should intercept the push HTTP request via `options.fetch` instead.
 * @property {typeof fetch} [fetch]           - Optional fetch override (testing / custom proxy). Used for BOTH the LLM call and the outgoing Web Push POST.
 * @property {(e: { type: string }) => void} [onEvent]
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

  // Validate VAPID shape eagerly so misconfiguration surfaces on the very
  // first request rather than the first Web Push attempt.
  const vapidValid = isVapidConfigValid(options.vapid);

  return async function handler(request) {
    onEvent({ type: 'request' });

    if (request.method !== 'POST') {
      return jsonResponse(405, {
        success: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST is supported' }
      });
    }

    if (tokenSigningKey) {
      const tokenError = await verifyBearerToken(request, tokenSigningKey);
      if (tokenError) return tokenError;
    }

    if (expectedClientTokenBytes) {
      const tokenError = verifyClientToken(request, expectedClientTokenBytes);
      if (tokenError) return tokenError;
    }

    let rawBody;
    try {
      rawBody = await request.text();
    } catch (_err) {
      return jsonResponse(400, {
        success: false,
        error: { code: 'INVALID_PAYLOAD_FORMAT', message: '无法读取请求体' }
      });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return jsonResponse(400, {
        success: false,
        error: { code: 'INVALID_PAYLOAD_FORMAT', message: '请求体不是合法 JSON' }
      });
    }

    const validation = validateInstantPayload(payload);
    if (!validation.valid) {
      return jsonResponse(400, {
        success: false,
        error: {
          code: validation.errorCode,
          message: validation.errorMessage,
          details: validation.details
        }
      });
    }

    if (!vapidValid) {
      return jsonResponse(500, {
        success: false,
        error: { code: 'VAPID_CONFIG_ERROR', message: 'VAPID 配置缺失或无效' }
      });
    }

    try {
      const result = await processInstantMessage(payload, {
        vapid: options.vapid,
        fetch: options.fetch || globalThis.fetch,
        onEvent
      });
      return jsonResponse(200, { success: true, data: result });
    } catch (err) {
      onEvent({ type: 'error', code: err?.code, message: err?.message });
      const code = err?.code || 'INTERNAL_ERROR';
      const status = code === 'PUSH_SEND_FAILED' || code === 'LLM_CALL_FAILED' ? 502 : 500;
      return jsonResponse(status, {
        success: false,
        error: { code, message: err?.message || '内部错误' }
      });
    }
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function getHeader(request, name) {
  try {
    return String(request.headers.get(name) || '').trim();
  } catch {
    return '';
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function isVapidConfigValid(vapid) {
  if (!vapid || !vapid.email || !vapid.publicKey || !vapid.privateKey) return false;
  // Don't fully parse here — sendWebPush will throw a precise error on bad
  // key shape. Just ensure none of the three fields are blank.
  return true;
}

function verifyClientToken(request, expectedBytes) {
  const received = getHeader(request, 'x-client-token');
  if (!received) {
    return jsonResponse(401, {
      success: false,
      error: { code: 'INVALID_CLIENT_TOKEN', message: '缺少 X-Client-Token' }
    });
  }
  const receivedBytes = utf8(received);
  if (!timingSafeEqualBytes(receivedBytes, expectedBytes)) {
    return jsonResponse(401, {
      success: false,
      error: { code: 'INVALID_CLIENT_TOKEN', message: 'X-Client-Token 无效' }
    });
  }
  return null;
}

async function verifyBearerToken(request, signingKey) {
  const authHeader = getHeader(request, 'authorization');
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return jsonResponse(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: '缺少 Authorization: Bearer <token>' }
    });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return jsonResponse(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: '空 Bearer token' }
    });
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return jsonResponse(401, {
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
    return jsonResponse(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'token 签名格式无效' }
    });
  }
  if (!timingSafeEqualBytes(receivedBytes, expectedSigBytes)) {
    return jsonResponse(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'token 签名无效' }
    });
  }

  let payload;
  try {
    payload = JSON.parse(utf8Decode(base64UrlToBytes(encodedPayload)));
  } catch {
    return jsonResponse(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'token payload 解析失败' }
    });
  }

  if (!payload || payload.v !== 1 || !payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    return jsonResponse(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'token 已过期或无效' }
    });
  }

  return null;
}

// ─── Public re-exports (for advanced users / SSR / tests) ──────────────

export { validateInstantPayload } from './validation.js';
export { splitMessageIntoSentences, processInstantMessage } from './message-processor.js';
export { sendWebPush, buildVapidJwt, verifyVapidJwt } from './webpush.js';
