/**
 * Runtime-neutral crypto + encoding helpers.
 *
 * Everything in here is implemented on top of WHATWG-standard primitives
 * (`globalThis.crypto.subtle`, `TextEncoder`, `Uint8Array`) so the package
 * runs on Cloudflare Workers, Vercel Edge, Netlify Edge, Deno, Bun, and
 * Node ≥ 19 with zero polyfills. The Node adapter polyfills
 * `globalThis.crypto` for Node 18 deployments before any of these are
 * touched.
 *
 * 大部分帮手的实现已上移 @rei-standard/amsg-shared（随 Web Push 加密栈
 * 一起），这里 re-export；只有 instant 专属的少数几个留在本模块。
 */

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

import {
  toUint8,
  concatBytes,
  base64UrlToBytes,
  utf8,
  bytesToBase64Url,
  jsonToBase64Url,
  hmacSha256,
  randomBytes,
} from '@rei-standard/amsg-shared';
export {
  toUint8,
  concatBytes,
  base64UrlToBytes,
  utf8,
  bytesToBase64Url,
  jsonToBase64Url,
  hmacSha256,
  randomBytes,
};

/** UTF-8 decode a Uint8Array / ArrayBuffer into a string. */
export function utf8Decode(buf) {
  return TEXT_DECODER.decode(toUint8(buf));
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

/** `crypto.randomUUID()`. The Node adapter polyfills `globalThis.crypto`. */
export function randomUUID() {
  return globalThis.crypto.randomUUID();
}
