import { bytesToBase64Url, randomUUID, utf8 } from './utils.js';

export const MULTIPART_MESSAGE_KIND = '_multipart';
export const MULTIPART_ENCODING = 'json-utf8-base64url';

export const DEFAULT_MULTIPART_CHUNK_BYTES = 1800;
export const DEFAULT_MULTIPART_TTL_MS = 60_000;
export const DEFAULT_MULTIPART_MAX_CHUNKS = 128;
export const DEFAULT_MULTIPART_MAX_TOTAL_BYTES = 256_000;

/**
 * Build generic multipart Web Push payloads for a JSON-safe business payload.
 * The original payload is stringified once, encoded as UTF-8 bytes, split by
 * byte count, then each byte slice is base64url encoded. The receiver restores
 * the exact original JSON bytes before running normal `messageKind` dispatch.
 *
 * @param {unknown} payload
 * @param {Object} [options]
 * @param {number} [options.maxChunkBytes]
 * @param {string} [options.id]
 * @param {number} [options.ttlMs]
 * @param {string} [options.serializedPayload] - Already JSON-stringified payload.
 * @returns {Array<Record<string, unknown>>}
 */
export function buildMultipartPushPayloads(payload, options = {}) {
  const maxChunkBytes = resolvePositiveInteger(
    options.maxChunkBytes,
    DEFAULT_MULTIPART_CHUNK_BYTES,
    'maxChunkBytes'
  );
  const ttlMs = resolvePositiveInteger(options.ttlMs, DEFAULT_MULTIPART_TTL_MS, 'ttlMs');
  const id = typeof options.id === 'string' && options.id.trim()
    ? options.id.trim()
    : `mp_${randomUUID()}`;

  let serialized = typeof options.serializedPayload === 'string'
    ? options.serializedPayload
    : undefined;
  if (serialized === undefined) {
    try {
      serialized = JSON.stringify(payload);
    } catch (error) {
      throw new TypeError(`buildMultipartPushPayloads: payload is not JSON-serializable: ${error?.message ?? error}`);
    }
  }
  if (typeof serialized !== 'string') {
    throw new TypeError('buildMultipartPushPayloads: payload serialized to a non-string');
  }

  const bytes = utf8(serialized);
  const total = Math.max(1, Math.ceil(bytes.byteLength / maxChunkBytes));
  const createdAt = Date.now();
  const originalMessageKind = payload && typeof payload === 'object'
    ? /** @type {{ messageKind?: unknown }} */ (payload).messageKind
    : undefined;

  /** @type {Array<Record<string, unknown>>} */
  const parts = [];
  for (let i = 0; i < total; i++) {
    const start = i * maxChunkBytes;
    const end = Math.min(start + maxChunkBytes, bytes.byteLength);
    const chunkBytes = bytes.subarray(start, end);
    parts.push({
      messageKind: MULTIPART_MESSAGE_KIND,
      multipart: {
        version: 1,
        id,
        index: i + 1,
        total,
        encoding: MULTIPART_ENCODING,
        originalMessageKind: typeof originalMessageKind === 'string'
          ? originalMessageKind
          : null,
        createdAt,
        ttlMs,
      },
      chunk: bytesToBase64Url(chunkBytes),
    });
  }
  return parts;
}

function resolvePositiveInteger(value, fallback, fieldName) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`buildMultipartPushPayloads: ${fieldName} must be a positive integer`);
  }
  return value;
}
