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
 * 一起），这里 re-export；只有 server 专属的少数几个留在本模块。
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


/** Encode bytes as standard base64 (with padding). */
export function bytesToBase64(buf) {
  const bytes = toUint8(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  // btoa is available in all Web Crypto runtimes (browsers, Workers, Node 16+).
  return (typeof btoa === 'function')
    ? btoa(bin)
    : Buffer.from(bin, 'binary').toString('base64');
}

/** Encode bytes as lowercase hex. */
export function bytesToHex(buf) {
  const bytes = toUint8(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Decode a hex string into a Uint8Array. */
export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}


/** `crypto.randomUUID()`. The Node adapter polyfills `globalThis.crypto`. */
export function randomUUID() {
  return globalThis.crypto.randomUUID();
}
