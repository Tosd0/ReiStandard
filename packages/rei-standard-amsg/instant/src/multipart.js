import {
  MULTIPART_MESSAGE_KIND,
  MULTIPART_ENCODING,
  MULTIPART_VERSION,
  DEFAULT_MULTIPART_TTL_MS,
  DEFAULT_MULTIPART_MAX_CHUNKS,
  DEFAULT_MULTIPART_MAX_TOTAL_BYTES,
} from '@rei-standard/amsg-shared';
import { bytesToBase64Url, randomUUID, utf8 } from './utils.js';

// 线协议常量（kind / encoding / version 与接收端限额默认值）单一来源在
// @rei-standard/amsg-shared 的 protocol 模块 — sw 的重组端用同一份。
// 这里 re-export 保持本包既有导出名不变。
export {
  MULTIPART_MESSAGE_KIND,
  MULTIPART_ENCODING,
  DEFAULT_MULTIPART_TTL_MS,
  DEFAULT_MULTIPART_MAX_CHUNKS,
  DEFAULT_MULTIPART_MAX_TOTAL_BYTES,
} from '@rei-standard/amsg-shared';

// 发送端独有的切片默认值（sw 接收端不感知），留在本包。
export const DEFAULT_MULTIPART_CHUNK_BYTES = 1800;

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
        version: MULTIPART_VERSION,
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
