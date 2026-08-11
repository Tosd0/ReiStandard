/**
 * Multipart transport — 发送端的切片构造。
 *
 * 一条 Web Push 的明文有硬上限（推送服务限的是加密后 body 4096 字节，
 * 换算下来明文约 3993 字节），装不下的 payload 切成若干条 `_multipart`
 * 分片发出去，sw 那边收齐后还原成原样的 JSON 再走正常的 messageKind 派发。
 *
 * amsg-instant 与 amsg-server 两个发送端共用这一份；线协议常量（kind /
 * encoding / version / 默认限额）在 ./protocol.js，sw 的重组端认同一份。
 * 实现在独立模块 — shared 内部按主题拆文件，index 只负责聚合导出。
 */

import {
  MULTIPART_MESSAGE_KIND,
  MULTIPART_ENCODING,
  MULTIPART_VERSION,
  DEFAULT_MULTIPART_TTL_MS,
} from './protocol.js';
import { bytesToBase64Url, randomUUID, utf8 } from './webcrypto-utils.js';

/**
 * 每片装多少字节原文（切之前的 UTF-8 字节数，不是 base64 后的长度）。
 * 1800 字节编成 base64url 是 2400 字符，加上分片信封仍稳在单条 push 的
 * 明文上限之内。接收端不感知这个值——它只按 `total` 收齐。
 */
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
