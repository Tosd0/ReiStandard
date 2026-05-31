/**
 * Shared test helpers: real VAPID + subscription key generation,
 * a fetch dispatcher that routes LLM vs Web Push by URL, and an
 * RFC 8291 decryptor so tests can verify the push payload shape
 * without going through the real `web-push` library.
 */

import {
  bytesToBase64Url,
  base64UrlToBytes,
  concatBytes,
  utf8,
  randomBytes,
} from '../src/utils.js';

const KEY_INFO_PREFIX = utf8('WebPush: info\0');
const CEK_INFO = utf8('Content-Encoding: aes128gcm\0');
const NONCE_INFO = utf8('Content-Encoding: nonce\0');

/** Generate a real VAPID key pair for ECDSA P-256 signing. */
export async function generateTestVapid({ email = 'mailto:vapid@example.com' } = {}) {
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const pubRaw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', kp.privateKey);
  return {
    email,
    publicKey: bytesToBase64Url(pubRaw),
    privateKey: jwk.d,
    // The raw bytes are also handy for direct verification in tests.
    _publicKeyBytes: pubRaw,
    _publicCryptoKey: kp.publicKey,
  };
}

/**
 * Generate a fake Web Push subscription with real ECDH keys, so tests can
 * decrypt the captured push body and assert on the shape.
 */
export async function generateTestSubscription({
  endpoint = 'https://push.example.com/sub/test-token',
} = {}) {
  const kp = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const pubRaw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = randomBytes(16);
  return {
    subscription: {
      endpoint,
      keys: { p256dh: bytesToBase64Url(pubRaw), auth: bytesToBase64Url(auth) },
    },
    // Test-only handle to the private key + raw materials needed for decryption.
    _uaPrivateKey: kp.privateKey,
    _uaPublicBytes: pubRaw,
    _authBytes: auth,
  };
}

/**
 * Decrypt a captured push request body (RFC 8291 aes128gcm) back to its
 * original UTF-8 JSON string.
 *
 * @param {Uint8Array} body  - The bytes posted to subscription.endpoint.
 * @param {ReturnType<typeof generateTestSubscription>} subKit
 * @returns {Promise<string>}
 */
export async function decryptCapturedPushBody(body, subKit) {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);

  // Parse aes128gcm content-encoding header (RFC 8188 §2.1).
  const salt = bytes.subarray(0, 16);
  // rs (4 bytes BE) at offset 16 is not needed for single-record decode.
  const idlen = bytes[20];
  const keyid = bytes.subarray(21, 21 + idlen);
  const ciphertext = bytes.subarray(21 + idlen);

  // ECDH(ua_private, as_public) — as_public is the keyid for Web Push.
  const asPublicCryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    keyid,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const ecdhSecret = new Uint8Array(
    await globalThis.crypto.subtle.deriveBits(
      { name: 'ECDH', public: asPublicCryptoKey },
      subKit._uaPrivateKey,
      256
    )
  );

  const keyInfo = concatBytes(KEY_INFO_PREFIX, subKit._uaPublicBytes, keyid);
  const ikm = await hkdf(subKit._authBytes, ecdhSecret, keyInfo, 32);

  const cekBytes = await hkdf(salt, ikm, CEK_INFO, 16);
  const nonce = await hkdf(salt, ikm, NONCE_INFO, 12);

  const cek = await globalThis.crypto.subtle.importKey(
    'raw',
    cekBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const plain = new Uint8Array(
    await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, cek, ciphertext)
  );

  // Strip RFC 8188 padding: trailing 0x00* preceded by 0x02 (final record).
  let end = plain.length;
  while (end > 0 && plain[end - 1] === 0x00) end--;
  if (end === 0 || plain[end - 1] !== 0x02) {
    throw new Error('decrypt: missing final-record padding delimiter');
  }
  return new TextDecoder().decode(plain.subarray(0, end - 1));
}

async function hkdf(salt, ikm, info, length) {
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    ikm,
    { name: 'HKDF' },
    false,
    ['deriveBits']
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    baseKey,
    length * 8
  );
  return new Uint8Array(bits);
}

/**
 * Build a fetch-style dispatcher that routes by URL.
 *
 * @param {Object} routes
 * @param {(url: string, init: RequestInit) => Promise<Response | { ok: boolean, status?: number, statusText?: string, json?: () => Promise<any>, text?: () => Promise<string> }>} [routes.llm]
 * @param {string} routes.pushEndpoint           - Subscription endpoint to intercept.
 * @param {(url: string, init: RequestInit, captured: { body: Uint8Array, headers: Record<string, string> }) => any} [routes.onPush]
 * @param {(captured: { url: string, body: Uint8Array, headers: Record<string, string>, callIndex: number }) => any} [routes.pushHandler]
 *   Per-call response override for the push endpoint. Called with a
 *   captured object that includes `callIndex` (1-based) so the handler
 *   can inject mid-array failures. Return a Response-like object (with
 *   `ok`/`status`/`statusText`/`text()`) to override the default 201;
 *   return falsy to fall through to the default. Takes precedence over
 *   `onPush` when both are supplied.
 * @returns {{ fetch: Function, pushCalls: Array<{ url: string, body: Uint8Array, headers: Record<string, string> }> }}
 */
export function createFetchRouter(routes) {
  const pushCalls = [];
  const fetchImpl = async (url, init = {}) => {
    if (url === routes.pushEndpoint) {
      const bodyBytes = init.body instanceof Uint8Array
        ? init.body
        : new Uint8Array(await new Response(init.body).arrayBuffer());
      const headers = Object.fromEntries(
        Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
      );
      const captured = { url, body: bodyBytes, headers };
      pushCalls.push(captured);
      if (typeof routes.pushHandler === 'function') {
        const r = await routes.pushHandler({ ...captured, callIndex: pushCalls.length });
        if (r) return r;
      }
      if (typeof routes.onPush === 'function') {
        const r = await routes.onPush(url, init, captured);
        if (r) return r;
      }
      return new Response(null, { status: 201 });
    }
    if (routes.llm) {
      return routes.llm(url, init);
    }
    throw new Error(`createFetchRouter: unexpected URL ${url}`);
  };
  return { fetch: fetchImpl, pushCalls };
}

export async function waitForPushCalls(router, count, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (router.pushCalls.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (router.pushCalls.length !== count) {
    throw new Error(`expected ${count} push call(s), got ${router.pushCalls.length}`);
  }
}

/**
 * Convenience: build a fake LLM response with the given content. Any
 * `extra` keys are merged onto `choices[0].message`, so callers can
 * inject `reasoning_content` / `tool_calls` / `refusal` without
 * needing a second helper.
 */
export function makeLlmResponse(content, extra = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    async json() {
      return { choices: [{ message: { content, ...extra } }] };
    },
  };
}

/**
 * Build a Fetch `Request` for handler tests. `mode` controls the
 * `Accept` header: `'pure-push'` (default) stamps `application/json`
 * so the handler takes the opt-out path; `'sse'` leaves Accept absent
 * so the handler takes the default SSE path. Centralised here so test
 * files don't each re-implement the same builder.
 *
 * @param {{
 *   url?: string,
 *   method?: string,
 *   body?: unknown,
 *   headers?: Record<string, string>,
 *   mode?: 'pure-push' | 'sse',
 * }} [opts]
 * @returns {Request}
 */
export function buildHandlerRequest({
  url = 'http://localhost/instant',
  method = 'POST',
  body,
  headers = {},
  mode = 'pure-push',
} = {}) {
  const merged = { 'content-type': 'application/json', ...headers };
  if (mode === 'pure-push' && merged.accept === undefined) {
    merged.accept = 'application/json';
  }
  return new Request(url, {
    method,
    headers: merged,
    body: body === undefined
      ? undefined
      : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

/**
 * Drain an SSE response and return the parsed events. Used by handler
 * tests that exercise the default (SSE) transport path.
 *
 * Returns `{ payloads, errors, doneReceived }`:
 *   - `payloads`: every `event: payload` (JSON-parsed) in arrival order
 *   - `errors`: every `event: error` (JSON-parsed) in arrival order
 *   - `doneReceived`: whether `event: done` arrived before stream EOF
 *
 * Keepalive comment lines (`:`-prefixed) are skipped silently.
 *
 * @param {Response} res
 * @returns {Promise<{ payloads: Array<any>, errors: Array<any>, doneReceived: boolean }>}
 */
export async function consumeSse(res) {
  const payloads = [];
  const errors = [];
  let doneReceived = false;
  if (!res.body) return { payloads, errors, doneReceived };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        if (!frame.trim()) continue;
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            // SSE spec: multi-line `data:` concatenates with `\n`.
            const piece = line.slice(5).trim();
            data = data ? `${data}\n${piece}` : piece;
          }
        }
        if (event === 'done') {
          doneReceived = true;
          return { payloads, errors, doneReceived };
        }
        if (event === 'error' && data) {
          try { errors.push(JSON.parse(data)); } catch { /* ignore */ }
          continue;
        }
        if (event === 'payload' && data) {
          try { payloads.push(JSON.parse(data)); } catch { /* ignore */ }
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
  return { payloads, errors, doneReceived };
}

export { bytesToBase64Url, base64UrlToBytes };
