/**
 * Named Error classes for amsg-instant v0.7.
 *
 * Three-tier naming stays consistent across layers so log search /
 * Sentry grouping needs no mental translation:
 *
 *   event taxonomy       hook_threw          (snake_case)
 *   push payload code    HOOK_THREW          (UPPER_SNAKE)
 *   Error class + code   HookError / 'HOOK_THREW'
 *   HTTP response body   { error: 'hook_threw' }
 *
 * Callers can dispatch on `err instanceof HookError` instead of
 * string-comparing `.code`, but `.code` is always present too.
 */

/**
 * Thrown when `onLLMOutput` throws OR returns a value that is not a
 * valid `LLMOutputDecision`. The original cause is preserved via
 * `Error.cause` so stack traces don't lose the inner failure.
 */
export class HookError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(message, opts) {
    super(message, opts);
    this.name = 'HookError';
    this.code = 'HOOK_THREW';
  }
}

/**
 * Thrown when a push payload exceeds `maxInlineBytes` and cannot be
 * delivered through BlobStore or generic multipart (for example,
 * multipart is disabled, its limits are exceeded, or BlobStore `put`
 * failed). Tells the caller exactly how big the payload was vs the cap,
 * so they can decide whether to shorten the body or wire up storage.
 */
export class PayloadTooLargeError extends Error {
  /**
   * @param {number} byteLength  - UTF-8 byte length of the serialized payload.
   * @param {number} maxInlineBytes
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(byteLength, maxInlineBytes, opts) {
    super(`pushPayload UTF-8 byte length ${byteLength} exceeds maxInlineBytes ${maxInlineBytes}`, opts);
    this.name = 'PayloadTooLargeError';
    this.code = 'PAYLOAD_TOO_LARGE';
    this.byteLength = byteLength;
    this.maxInlineBytes = maxInlineBytes;
  }
}

/**
 * Thrown when the LLM call itself fails (network error, non-2xx
 * response, malformed JSON, missing `choices[0].message`). Wraps the
 * underlying cause; caller maps to HTTP 502.
 */
export class LlmCallError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [opts]
   */
  constructor(message, opts) {
    super(message, opts);
    this.name = 'LlmCallError';
    this.code = 'LLM_CALL_FAILED';
  }
}

/**
 * 请求体字节上限（gzip 压缩前、解压后各自计；Node 适配器的原始 body 同样计）。
 * gzip 能用几 KB 展开成几 GB，不设上限等于把内存交给调用方决定。数值与
 * amsg-server 的 DEFAULT_MAX_REQUEST_BODY_BYTES 一致。
 */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Thrown while reading the request body once it exceeds
 * `MAX_REQUEST_BODY_BYTES`. Reading stops at the limit; the handler
 * maps it to HTTP 413.
 */
export class RequestBodyTooLargeError extends Error {
  /**
   * @param {number} maxBytes
   */
  constructor(maxBytes) {
    super(`请求体超过 ${maxBytes} 字节上限`);
    this.name = 'RequestBodyTooLargeError';
    this.code = 'REQUEST_BODY_TOO_LARGE';
    this.maxBytes = maxBytes;
  }
}

/**
 * Thrown by the in-memory blob adapter when `maxEntries` is reached.
 * Fail-fast over silent LRU eviction — silently dropping a key would
 * let a previously-pushed envelope's `/blob/:key` fetch land on a 404
 * and confuse the SW.
 */
export class MemoryStoreFullError extends Error {
  /**
   * @param {number} maxEntries
   */
  constructor(maxEntries) {
    super(`MemoryBlobStore is full (maxEntries=${maxEntries})`);
    this.name = 'MemoryStoreFullError';
    this.code = 'MEMORY_STORE_FULL';
    this.maxEntries = maxEntries;
  }
}
