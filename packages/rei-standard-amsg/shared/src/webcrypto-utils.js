/**
 * Runtime-neutral crypto + encoding helpers.
 *
 * Everything in here is implemented on top of WHATWG-standard primitives
 * (`globalThis.crypto.subtle`, `TextEncoder`, `Uint8Array`) so the code
 * runs on Cloudflare Workers, Vercel Edge, Netlify Edge, Deno, Bun, and
 * Node ≥ 19 with zero polyfills. amsg-instant 的 Node adapter 会在这些
 * 帮手被触达之前为 Node 18 部署 polyfill `globalThis.crypto`。
 *
 * 这是全生态唯一一份实现 — instant 的 `src/utils.js` 与 server 的
 * `lib/webcrypto-utils.js` 都薄薄地 re-export 这里，shared 内部的
 * webpush 模块也从这里 import。实现在独立模块 — shared 内部按主题
 * 拆文件，index 只负责聚合导出。
 */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

/**
 * Coerce ArrayBuffer | Uint8Array | view → Uint8Array (no copy when possible).
 */
export function toUint8(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  throw new TypeError('Expected ArrayBuffer / Uint8Array');
}

/**
 * Concatenate Uint8Arrays into a single Uint8Array.
 * @param {...(Uint8Array | ArrayBuffer | ArrayBufferView)} chunks
 * @returns {Uint8Array}
 */
export function concatBytes(...chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c instanceof Uint8Array ? c : new Uint8Array(c.buffer || c), offset);
    offset += c.byteLength;
  }
  return out;
}

/** UTF-8 encode a string into a Uint8Array. */
export function utf8(str) {
  return TEXT_ENCODER.encode(String(str));
}

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

/** Encode bytes as base64url (no padding). */
export function bytesToBase64Url(buf) {
  return bytesToBase64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Decode base64url (with or without padding) → Uint8Array.
 * @param {string} input
 * @returns {Uint8Array}
 */
export function base64UrlToBytes(input) {
  const s = String(input).replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (s.length % 4)) % 4;
  const padded = s + '='.repeat(pad);
  const bin = (typeof atob === 'function')
    ? atob(padded)
    : Buffer.from(padded, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode a JSON-serializable value as base64url (UTF-8 JSON). */
export function jsonToBase64Url(value) {
  return bytesToBase64Url(utf8(JSON.stringify(value)));
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

/** Cryptographically random bytes. */
export function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/** `crypto.randomUUID()`. The Node adapter polyfills `globalThis.crypto`. */
export function randomUUID() {
  return globalThis.crypto.randomUUID();
}
