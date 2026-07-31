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
 * 实现已全部上移 @rei-standard/amsg-shared（shared/src/webcrypto-utils.js），
 * 这里只 re-export，保留原有导出名以免包内引用大改。
 */

export {
  toUint8,
  concatBytes,
  base64UrlToBytes,
  utf8,
  utf8Decode,
  bytesToBase64,
  bytesToBase64Url,
  jsonToBase64Url,
  bytesToHex,
  hexToBytes,
  hmacSha256,
  timingSafeEqualBytes,
  randomBytes,
  randomUUID,
} from '@rei-standard/amsg-shared';
