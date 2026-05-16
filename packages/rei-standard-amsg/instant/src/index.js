/**
 * @rei-standard/amsg-instant
 *
 * Stateless one-shot instant push handler. The entire lifecycle of an
 * instant request lives inside a single function invocation:
 *   parse → call LLM → split sentences → deliver Web Push → 200 OK.
 * No DB, no cron, no tenant init. Deploy to Cloudflare Workers, Node,
 * Netlify, or Vercel.
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

import { createHmac, timingSafeEqual } from 'crypto';

import { loadWebpush, applyVapid } from './webpush.js';
import { validateInstantPayload } from './validation.js';
import { processInstantMessage } from './message-processor.js';

/**
 * @typedef {Object} VapidConfig
 * @property {string} email
 * @property {string} publicKey
 * @property {string} privateKey
 */

/**
 * @typedef {Object} InstantHandlerOptions
 * @property {VapidConfig} vapid              - VAPID keys for Web Push.
 * @property {string} [clientToken]           - Optional shared secret. When set, requests must send a matching `X-Client-Token` header. Note: this is a *weak* check — the token will be visible in any frontend bundle that uses it, so it stops casual URL-direct abuse, not a determined attacker. Use `tokenSigningKey` for real auth.
 * @property {string} [tokenSigningKey]       - Optional HMAC key. When set, `Authorization: Bearer <token>` is verified.
 * @property {Object} [webpush]               - Optional preloaded web-push module (mainly for tests).
 * @property {typeof fetch} [fetch]           - Optional fetch override (testing / custom proxy).
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

  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const tokenSigningKey = options.tokenSigningKey ? String(options.tokenSigningKey) : '';
  const clientToken = options.clientToken ? String(options.clientToken) : '';
  const expectedClientTokenBytes = clientToken ? Buffer.from(clientToken, 'utf8') : null;

  let vapidApplied = false;
  let cachedWebpush = null;

  async function ensureWebpush() {
    if (cachedWebpush && vapidApplied) return cachedWebpush;
    const mod = await loadWebpush(options.webpush);
    if (!vapidApplied) {
      applyVapid(mod, options.vapid);
      vapidApplied = true;
    }
    cachedWebpush = mod;
    return mod;
  }

  return async function handler(request) {
    onEvent({ type: 'request' });

    if (request.method !== 'POST') {
      return jsonResponse(405, {
        success: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST is supported' }
      });
    }

    if (tokenSigningKey) {
      const tokenError = verifyBearerToken(request, tokenSigningKey);
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

    let webpush;
    try {
      webpush = await ensureWebpush();
    } catch (_err) {
      return jsonResponse(500, {
        success: false,
        error: { code: 'VAPID_CONFIG_ERROR', message: 'VAPID 配置缺失或无效' }
      });
    }

    try {
      const result = await processInstantMessage(payload, {
        webpush,
        fetch: options.fetch || globalThis.fetch,
        onEvent
      });
      return jsonResponse(200, { success: true, data: result });
    } catch (err) {
      onEvent({ type: 'error', code: err?.code, message: err?.message });
      const code = err?.code || 'INTERNAL_ERROR';
      const status = code === 'PUSH_SEND_FAILED' ? 502 : code === 'LLM_CALL_FAILED' ? 502 : 500;
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

function verifyClientToken(request, expectedBytes) {
  const received = getHeader(request, 'x-client-token');
  if (!received) {
    return jsonResponse(401, {
      success: false,
      error: { code: 'INVALID_CLIENT_TOKEN', message: '缺少 X-Client-Token' }
    });
  }
  const receivedBytes = Buffer.from(received, 'utf8');
  if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) {
    return jsonResponse(401, {
      success: false,
      error: { code: 'INVALID_CLIENT_TOKEN', message: 'X-Client-Token 无效' }
    });
  }
  return null;
}

function verifyBearerToken(request, signingKey) {
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
  const expectedSig = base64UrlEncode(
    createHmac('sha256', signingKey).update(signingInput).digest()
  );

  // Compare raw HMAC bytes (32 B after base64url decode) rather than the
  // UTF-8 bytes of the encoded characters — semantically clearer and avoids
  // Buffer.from(string)'s implicit-encoding default. Kept in lockstep with
  // amsg-server's tenant/token.js to preserve the protocol contract.
  let received;
  let expected;
  try {
    received = base64UrlDecode(receivedSig);
    expected = base64UrlDecode(expectedSig);
  } catch {
    return jsonResponse(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'token 签名格式无效' }
    });
  }
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return jsonResponse(401, {
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'token 签名无效' }
    });
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
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

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLength), 'base64');
}

// ─── Public re-exports (for advanced users / SSR / tests) ──────────────

export { validateInstantPayload } from './validation.js';
export { splitMessageIntoSentences, processInstantMessage } from './message-processor.js';
