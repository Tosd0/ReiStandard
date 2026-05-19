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

export { bytesToBase64Url, base64UrlToBytes };
