/**
 * Web Push — RFC 8030 (transport) + RFC 8291 (aes128gcm payload encryption)
 *           + RFC 8292 (VAPID).
 *
 * Pure-WebCrypto implementation. Zero runtime dependencies. Runs natively on
 * Cloudflare Workers, Vercel Edge, Netlify Edge, Deno, Bun, and Node ≥ 19.
 * Node 18 deployments must go through the `adapters/node` entry which
 * polyfills `globalThis.crypto` from `node:crypto.webcrypto`.
 *
 * The wire format produced here is byte-identical to the `web-push` npm
 * package and to the Push API in any modern browser, so amsg-sw and any
 * existing Web Push subscriptions keep working untouched.
 */

import {
  utf8,
  toUint8,
  concatBytes,
  bytesToBase64Url,
  base64UrlToBytes,
  jsonToBase64Url,
  hmacSha256,
  randomBytes,
} from './webcrypto-utils.js';
import { normalizeVapidSubject } from '@rei-standard/amsg-shared';

// RFC 8291 fixed labels (each followed by a NUL byte per HKDF "info" framing).
const KEY_INFO_PREFIX = utf8('WebPush: info\0');
const CEK_INFO = utf8('Content-Encoding: aes128gcm\0');
const NONCE_INFO = utf8('Content-Encoding: nonce\0');

const VAPID_DEFAULT_TTL = 60;          // seconds — short, matches single-shot instant.
const VAPID_TOKEN_LIFETIME = 12 * 3600; // 12h — comfortably under the 24h RFC 8292 cap.
const RECORD_SIZE = 4096;               // arbitrary — must be ≥ ciphertext length.

/**
 * Send a single Web Push notification.
 *
 * @param {Object}   args
 * @param {Object}   args.subscription  - Standard PushSubscription JSON.
 * @param {string}   args.subscription.endpoint
 * @param {Object}   args.subscription.keys
 * @param {string}   args.subscription.keys.p256dh - base64url, 65 B uncompressed P-256 point.
 * @param {string}   args.subscription.keys.auth   - base64url, 16 B auth secret.
 * @param {string}   args.payload       - Already-stringified JSON to deliver.
 * @param {Object}   args.vapid
 * @param {string}   args.vapid.email      - VAPID `sub` (mailto: auto-prepended if missing).
 * @param {string}   args.vapid.publicKey  - base64url, 65 B uncompressed P-256 point.
 * @param {string}   args.vapid.privateKey - base64url, 32 B scalar.
 * @param {number}  [args.ttl=60]       - Push service TTL header, seconds.
 * @param {typeof fetch} [args.fetch]   - Override fetch impl (testing / proxy).
 * @returns {Promise<{ statusCode: number, body: string, headers: Headers }>}
 * @throws  {Error}  err.code = 'PUSH_SEND_FAILED' on push-service error.
 */
export async function sendWebPush({ subscription, payload, vapid, ttl, fetch: fetchImpl }) {
  if (!subscription || typeof subscription.endpoint !== 'string') {
    throw new Error('sendWebPush: invalid subscription');
  }
  if (typeof payload !== 'string') {
    throw new Error('sendWebPush: payload must be a string');
  }
  if (!vapid || !vapid.email || !vapid.publicKey || !vapid.privateKey) {
    throw new Error('VAPID_CONFIG_MISSING');
  }

  const subscriptionKeys = subscription.keys || {};
  if (typeof subscriptionKeys.p256dh !== 'string' || typeof subscriptionKeys.auth !== 'string') {
    throw new Error('sendWebPush: subscription.keys.p256dh and .auth are required');
  }

  const encryptedBody = await encryptPushPayload({
    plaintext: utf8(payload),
    uaPublicKey: base64UrlToBytes(subscriptionKeys.p256dh),
    authSecret: base64UrlToBytes(subscriptionKeys.auth),
  });

  const jwt = await buildVapidJwt({
    audience: originOf(subscription.endpoint),
    subject: normalizeVapidSubject(vapid.email),
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
  });

  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('sendWebPush: no fetch implementation available');
  }

  const res = await fetchFn(subscription.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': String(Number.isFinite(ttl) ? ttl : VAPID_DEFAULT_TTL),
      'Authorization': `vapid t=${jwt}, k=${vapid.publicKey}`,
    },
    body: encryptedBody,
  });

  // Push services return 201 (RFC 8030) or 200/202 depending on implementation.
  if (!res.ok) {
    const text = await safeReadText(res);
    const err = new Error(
      `Web Push delivery failed: ${res.status} ${res.statusText || ''}${text ? ` — ${text}` : ''}`
    );
    err.code = 'PUSH_SEND_FAILED';
    err.statusCode = res.status;
    throw err;
  }

  return {
    statusCode: res.status,
    body: await safeReadText(res),
    headers: res.headers,
  };
}

// ─── RFC 8291: aes128gcm payload encryption ────────────────────────────

/**
 * @param {Object} args
 * @param {Uint8Array} args.plaintext
 * @param {Uint8Array} args.uaPublicKey  - recipient p256dh, 65 B uncompressed.
 * @param {Uint8Array} args.authSecret   - recipient auth, 16 B.
 * @returns {Promise<Uint8Array>} encryption header || ciphertext
 */
async function encryptPushPayload({ plaintext, uaPublicKey, authSecret }) {
  // 1. Ephemeral ECDH key pair (as = "application server" per RFC 8291).
  const asKeyPair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const asPublicRaw = new Uint8Array(
    await globalThis.crypto.subtle.exportKey('raw', asKeyPair.publicKey)
  );

  // 2. ECDH shared secret with recipient's p256dh.
  const uaPublicCryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    uaPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const ecdhSecret = new Uint8Array(
    await globalThis.crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaPublicCryptoKey },
      asKeyPair.privateKey,
      256
    )
  );

  // 3. IKM = HKDF-SHA256(salt=auth_secret, ikm=ecdh_secret,
  //                     info="WebPush: info\0" || ua_public || as_public, L=32)
  const keyInfo = concatBytes(KEY_INFO_PREFIX, uaPublicKey, asPublicRaw);
  const ikm = await hkdfSha256(authSecret, ecdhSecret, keyInfo, 32);

  // 4. encryption_salt (random, 16 B). Goes into the header so the recipient
  //    can re-derive CEK / NONCE.
  const salt = randomBytes(16);

  // 5. CEK = HKDF-SHA256(salt, ikm, "Content-Encoding: aes128gcm\0", 16)
  const cekBytes = await hkdfSha256(salt, ikm, CEK_INFO, 16);
  const cek = await globalThis.crypto.subtle.importKey(
    'raw',
    cekBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  // 6. NONCE = HKDF-SHA256(salt, ikm, "Content-Encoding: nonce\0", 12)
  const nonce = await hkdfSha256(salt, ikm, NONCE_INFO, 12);

  // 7. Single-record AES-128-GCM. Padding delimiter 0x02 marks the final
  //    (and only) record per RFC 8188 §2.
  const padded = concatBytes(plaintext, new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cek, padded)
  );

  // 8. aes128gcm content-encoding framing (RFC 8188 §2.1):
  //      salt(16) || rs(4 BE) || idlen(1) || keyid(idlen) || ciphertext
  //    For Web Push, keyid is the application-server public key (65 B).
  const header = new Uint8Array(16 + 4 + 1 + asPublicRaw.byteLength);
  header.set(salt, 0);
  writeUint32BE(header, 16, RECORD_SIZE);
  header[20] = asPublicRaw.byteLength;
  header.set(asPublicRaw, 21);

  return concatBytes(header, ciphertext);
}

/**
 * HKDF-SHA-256 (extract-then-expand) via WebCrypto.
 *
 * @param {Uint8Array} salt
 * @param {Uint8Array} ikm
 * @param {Uint8Array} info
 * @param {number}     length  - desired output length in bytes (≤ 32 in our usage).
 * @returns {Promise<Uint8Array>}
 */
async function hkdfSha256(salt, ikm, info, length) {
  const baseKey = await globalThis.crypto.subtle.importKey(
    'raw',
    toUint8(ikm),
    { name: 'HKDF' },
    false,
    ['deriveBits']
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toUint8(salt),
      info: toUint8(info),
    },
    baseKey,
    length * 8
  );
  return new Uint8Array(bits);
}

// ─── RFC 8292: VAPID JWT ───────────────────────────────────────────────

/**
 * Build a VAPID `Authorization` JWT for a single push.
 *
 * @param {Object} args
 * @param {string} args.audience    - Origin of the push endpoint (e.g. https://fcm.googleapis.com).
 * @param {string} args.subject     - VAPID `sub` claim, typically `mailto:you@example.com`.
 * @param {string} args.publicKey   - base64url, 65 B uncompressed P-256 point.
 * @param {string} args.privateKey  - base64url, 32 B scalar.
 * @returns {Promise<string>} compact JWS (three base64url segments).
 */
export async function buildVapidJwt({ audience, subject, publicKey, privateKey }) {
  const header = jsonToBase64Url({ typ: 'JWT', alg: 'ES256' });
  const payload = jsonToBase64Url({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + VAPID_TOKEN_LIFETIME,
    sub: subject,
  });

  const signingInput = utf8(`${header}.${payload}`);

  const pubBytes = base64UrlToBytes(publicKey);
  const privBytes = base64UrlToBytes(privateKey);
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
    throw new Error('VAPID publicKey must be a 65-byte uncompressed P-256 point (base64url).');
  }
  if (privBytes.length !== 32) {
    throw new Error('VAPID privateKey must be a 32-byte scalar (base64url).');
  }

  // Import as JWK so we can supply both private scalar (d) and public point
  // (x, y) in one step — required by WebCrypto for ECDSA signing.
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: bytesToBase64Url(privBytes),
    x: bytesToBase64Url(pubBytes.subarray(1, 33)),
    y: bytesToBase64Url(pubBytes.subarray(33, 65)),
    ext: true,
  };
  const key = await globalThis.crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  // WebCrypto ECDSA produces a raw 64-byte (r || s) signature — exactly the
  // wire format JOSE/JWS expects, so no DER unwrapping is needed.
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signingInput
  );

  return `${header}.${payload}.${bytesToBase64Url(sig)}`;
}

/**
 * Verify a VAPID JWT signature. Exported for tests / advanced consumers.
 * Returns the decoded payload if the signature and `exp` are valid.
 *
 * @param {string} jwt
 * @param {string} publicKey  - VAPID public key (base64url, 65 B).
 * @returns {Promise<{ aud: string, exp: number, sub: string }>}
 */
export async function verifyVapidJwt(jwt, publicKey) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new Error('VAPID JWT: malformed (expected three segments)');
  const [h, p, s] = parts;

  const pubBytes = base64UrlToBytes(publicKey);
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
    throw new Error('VAPID publicKey must be 65 B uncompressed P-256 (base64url).');
  }
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: bytesToBase64Url(pubBytes.subarray(1, 33)),
    y: bytesToBase64Url(pubBytes.subarray(33, 65)),
    ext: true,
  };
  const key = await globalThis.crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );

  const ok = await globalThis.crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    base64UrlToBytes(s),
    utf8(`${h}.${p}`)
  );
  if (!ok) throw new Error('VAPID JWT: signature mismatch');

  const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(p)));
  if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('VAPID JWT: expired');
  }
  return payload;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function originOf(endpoint) {
  return new URL(endpoint).origin;
}

function writeUint32BE(buf, offset, value) {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

async function safeReadText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// Re-export the HMAC helper so `index.js` can verify Bearer JWTs without a
// separate import path. Keeps the public surface tight.
export { hmacSha256 };

/**
 * web-push-compatible sender backed by the Web Crypto implementation above.
 * message-processor calls `ctx.webpush.sendNotification(subscription, payloadString)`,
 * so we only need that one method. VAPID keys are baked in at construction.
 *
 * @param {{ email: string, publicKey: string, privateKey: string }} vapid
 * @returns {{ sendNotification: (subscription: Object, payload: string) => Promise<any> }}
 */
export function createWebCryptoWebPush(vapid) {
  return {
    async sendNotification(subscription, payload) {
      return sendWebPush({
        subscription,
        payload,
        vapid: {
          email: vapid.email,
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey
        },
        fetch: globalThis.fetch
      });
    }
  };
}
