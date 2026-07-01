/**
 * Runtime-neutral crypto + encoding helpers.
 *
 * Everything in here is implemented on top of WHATWG-standard primitives
 * (`globalThis.crypto.subtle`, `TextEncoder`, `Uint8Array`) so the package
 * runs on Cloudflare Workers, Vercel Edge, Netlify Edge, Deno, Bun, and
 * Node ≥ 19 with zero polyfills. The Node adapter polyfills
 * `globalThis.crypto` for Node 18 deployments before any of these are
 * touched.
 */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

import { toUint8, concatBytes, base64UrlToBytes } from '@rei-standard/amsg-shared';
export { toUint8, concatBytes, base64UrlToBytes };

/** UTF-8 encode a string into a Uint8Array. */
export function utf8(str) {
  return TEXT_ENCODER.encode(String(str));
}

/** UTF-8 decode a Uint8Array / ArrayBuffer into a string. */
export function utf8Decode(buf) {
  return TEXT_DECODER.decode(toUint8(buf));
}


/** Encode bytes as base64url (no padding). */
export function bytesToBase64Url(buf) {
  const bytes = toUint8(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  // btoa is available in all Web Crypto runtimes (browsers, Workers, Node 16+).
  const b64 = (typeof btoa === 'function')
    ? btoa(bin)
    : Buffer.from(bin, 'binary').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}


/** Encode a JSON-serializable value as base64url (UTF-8 JSON). */
export function jsonToBase64Url(value) {
  return bytesToBase64Url(utf8(JSON.stringify(value)));
}

/**
 * Constant-time byte comparison. Returns true iff `a` and `b` are equal-length
 * sequences with the same bytes. Length is intentionally NOT secret — early
 * length-check is fine and matches Node `timingSafeEqual`'s contract.
 */
export function timingSafeEqualBytes(a, b) {
  const x = toUint8(a);
  const y = toUint8(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) {
    diff |= x[i] ^ y[i];
  }
  return diff === 0;
}

/** HMAC-SHA-256 over `data` with `keyBytes`. Returns 32-byte Uint8Array. */
export async function hmacSha256(keyBytes, data) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    toUint8(keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, toUint8(data));
  return new Uint8Array(sig);
}

/** `crypto.randomUUID()`. The Node adapter polyfills `globalThis.crypto`. */
export function randomUUID() {
  return globalThis.crypto.randomUUID();
}

/** Cryptographically random bytes. */
export function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}
