/**
 * multipart 分片信封的构造——测试这一侧的单一出处。
 *
 * 线协议那几项（version / encoding / index / total / base64url）在这里写一遍
 * 就够。各个测试文件各抄一份的话，改一次 wire 格式要改好几处，漏掉的那处会变
 * 成「测试照样绿，但它测的是 SW 已经不认的格式」。
 */

/**
 * 把任意一段文本切成 `_multipart` 分片。
 *
 * 直接喂文本（而不是对象）是为了造「拼得回来、但解不开」的分片——JSON.parse
 * 失败那条路。
 *
 * @param {string} text
 * @param {{
 *   id?: string,
 *   maxChunkBytes?: number,
 *   ttlMs?: number,
 *   createdAt?: number,
 *   originalMessageKind?: string|null,
 * }} [options]
 * @returns {Array<Object>}
 */
export function buildChunksFromText(text, {
  id = `mp_test_${Math.random().toString(16).slice(2)}`,
  maxChunkBytes = 80,
  ttlMs = 60_000,
  createdAt = Date.now(),
  originalMessageKind = null,
} = {}) {
  const bytes = new TextEncoder().encode(text);
  const total = Math.ceil(bytes.byteLength / maxChunkBytes);
  return Array.from({ length: total }, (_, index) => {
    const start = index * maxChunkBytes;
    const chunk = bytes.subarray(start, Math.min(start + maxChunkBytes, bytes.byteLength));
    return {
      messageKind: '_multipart',
      multipart: {
        version: 1,
        id,
        index: index + 1,
        total,
        encoding: 'json-utf8-base64url',
        originalMessageKind,
        createdAt,
        ttlMs,
      },
      chunk: Buffer.from(chunk).toString('base64url'),
    };
  });
}

/**
 * 把一个 push payload 切成 `_multipart` 分片，`originalMessageKind` 跟着 payload
 * 自己的 messageKind 走（调用方显式传了就以它为准）。
 *
 * @param {Object} payload
 * @param {Parameters<typeof buildChunksFromText>[1]} [options]
 * @returns {Array<Object>}
 */
export function buildMultipartPayloads(payload, options = {}) {
  return buildChunksFromText(JSON.stringify(payload), {
    originalMessageKind: typeof payload.messageKind === 'string' ? payload.messageKind : null,
    ...options,
  });
}
