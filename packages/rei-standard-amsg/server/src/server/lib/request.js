/**
 * Request payload utilities.
 * Keeps body parsing and shape validation consistent across handlers.
 *
 * 两层：`readRequestBody` 把 Fetch `Request` 的正文读成字符串（gzip 请求体在
 * 这一步还原），下面的 `parseBodyAsObject` / `parseEncryptedBody` 再把字符串
 * 解析成对象。handler 只跟字符串打交道，不用知道它是怎么传过来的。
 */

import { isValidUUIDv4 } from './validation.js';

export const REQUEST_ERRORS = {
  INVALID_JSON: { code: 'INVALID_JSON', message: '请求体不是有效的 JSON' },
  INVALID_REQUEST_BODY: { code: 'INVALID_REQUEST_BODY', message: '请求体格式无效' },
  INVALID_ENCRYPTED_PAYLOAD: { code: 'INVALID_ENCRYPTED_PAYLOAD', message: '加密数据格式错误' }
};

/**
 * 解压后请求体的字节上限（默认 32MB）。
 *
 * 只管 gzip 那条路：压缩数据能用很小的体积展开成极大的正文（几百 KB 换几个
 * GB），不设上限等于把内存交给调用方决定。不压缩的请求体不受这个数约束，行为
 * 与以前一致——那条路的体积本来就摆在传输量上，平台自己的请求大小限制盖得住。
 */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/** gzip 数据的头两个字节（RFC 1952）。 */
const GZIP_MAGIC_0 = 0x1f;
const GZIP_MAGIC_1 = 0x8b;

/**
 * `Content-Encoding` 头归一化：小写、去空格、丢掉 `identity`。
 * 多个编码叠加（`gzip, br`）原样返回整串，交给调用方按「不支持」处理。
 *
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeContentEncoding(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '';
  const tokens = value.split(',').map((t) => t.trim()).filter((t) => t && t !== 'identity');
  if (tokens.length === 0) return '';
  if (tokens.length === 1) return tokens[0];
  return value;
}

/** 这堆字节看起来是 gzip 吗（魔数判断）。 */
function looksGzipped(bytes) {
  return bytes.length >= 2 && bytes[0] === GZIP_MAGIC_0 && bytes[1] === GZIP_MAGIC_1;
}

/**
 * 解 gzip 并按 UTF-8 解码，边解边数字节——超过上限当场停手，不把整份展开的
 * 数据先读进内存再判断。
 *
 * @param {Uint8Array} bytes
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function inflateGzipToText(bytes, maxBytes) {
  const reader = new Response(bytes).body
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      const error = new Error(`解压后的请求体超过 ${maxBytes} 字节上限`);
      error.code = 'REQUEST_BODY_TOO_LARGE';
      throw error;
    }
    // stream: true —— 一个多字节字符可能被切在两个分片中间，逐片独立解码会
    // 在切点上解出替换字符。
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * 把请求正文读成字符串，`Content-Encoding: gzip` 的在这一步还原。
 *
 * 客户端把大 body（一次 fire_pack、一整批 client_state）压了再传能省下几倍
 * 传输量，代价只有服务端这一次解压。所有带 body 的端点走同一个入口，谁都不用
 * 各自判一遍这个头。
 *
 * 说是 gzip、字节却不是 gzip 开头时按明文处理：有些边缘网关会替你把请求体解
 * 开却留着原来的 `Content-Encoding` 头，再解一次只会解出乱码。魔数判断两种情
 * 况都接得住。
 *
 * 只认 gzip。deflate / br 回 415 而不是猜着解——猜错解出来的是一段乱码，会变
 * 成一句让人找不着北的「请求体不是有效的 JSON」。
 *
 * @param {{ headers?: { get?: (name: string) => string|null }, text: () => Promise<string>, arrayBuffer: () => Promise<ArrayBuffer> }} request
 *   Fetch API 的 Request（或形状相同的对象）。
 * @param {{ maxBytes?: number }} [options] - `maxBytes`：解压后的字节上限，
 *   默认 {@link DEFAULT_MAX_REQUEST_BODY_BYTES}。
 * @returns {Promise<{ ok: true, body: string } | { ok: false, error: { status: number, body: Object } }>}
 *   `error` 就是可以直接回给调用方的那个信封（与 handler 的返回同构）。
 */
export async function readRequestBody(request, options = {}) {
  const encoding = normalizeContentEncoding(
    request.headers && typeof request.headers.get === 'function'
      ? request.headers.get('content-encoding')
      : ''
  );
  if (!encoding) return { ok: true, body: await request.text() };

  if (encoding !== 'gzip' && encoding !== 'x-gzip') {
    return {
      ok: false,
      error: errorResponse(
        415,
        'UNSUPPORTED_CONTENT_ENCODING',
        `请求体的 Content-Encoding「${encoding}」不支持，这里只认 gzip`,
        { contentEncoding: encoding, supported: ['gzip'] }
      )
    };
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!looksGzipped(bytes)) return { ok: true, body: new TextDecoder('utf-8').decode(bytes) };

  if (typeof DecompressionStream !== 'function') {
    return {
      ok: false,
      error: errorResponse(
        415,
        'UNSUPPORTED_CONTENT_ENCODING',
        '当前运行环境没有 DecompressionStream，收不了 gzip 请求体',
        { contentEncoding: encoding }
      )
    };
  }

  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_REQUEST_BODY_BYTES;
  try {
    return { ok: true, body: await inflateGzipToText(bytes, maxBytes) };
  } catch (error) {
    if (error && error.code === 'REQUEST_BODY_TOO_LARGE') {
      return {
        ok: false,
        error: errorResponse(413, 'REQUEST_BODY_TOO_LARGE', error.message, { maxBytes })
      };
    }
    return {
      ok: false,
      error: errorResponse(
        400,
        'INVALID_CONTENT_ENCODING',
        '请求体声明是 gzip，但解压失败',
        { contentEncoding: encoding }
      )
    };
  }
}

/**
 * @typedef {{ code: string, message: string }} ValidationError
 */

/**
 * @typedef {{
 *   invalidJson?: ValidationError,
 *   invalidType?: ValidationError
 * }} ParseBodyOptions
 */

/**
 * @typedef {{
 *   ok: true,
 *   data: Record<string, any>
 * } | {
 *   ok: false,
 *   error: ValidationError
 * }} ParseBodyResult
 */

/**
 * Parse body into a JSON object.
 *
 * @param {unknown} body
 * @param {ParseBodyOptions} [options]
 * @returns {ParseBodyResult}
 */
export function parseBodyAsObject(body, options = {}) {
  const invalidJson = options.invalidJson || REQUEST_ERRORS.INVALID_JSON;
  const invalidType = options.invalidType || REQUEST_ERRORS.INVALID_REQUEST_BODY;

  let parsed = body;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { ok: false, error: invalidJson };
    }
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, error: invalidType };
  }

  return { ok: true, data: parsed };
}

/**
 * Parse a standard JSON object body.
 *
 * @param {unknown} body
 * @returns {ParseBodyResult}
 */
export function parseJsonBody(body) {
  return parseBodyAsObject(body, {
    invalidJson: REQUEST_ERRORS.INVALID_JSON,
    invalidType: REQUEST_ERRORS.INVALID_REQUEST_BODY
  });
}

/**
 * Check if a value is a plain object (and not null/array).
 *
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check if an object follows the encrypted payload envelope shape.
 *
 * @param {unknown} payload
 * @returns {payload is { iv: string, authTag: string, encryptedData: string }}
 */
export function isEncryptedEnvelope(payload) {
  if (!isPlainObject(payload)) return false;

  return (
    typeof payload.iv === 'string' &&
    typeof payload.authTag === 'string' &&
    typeof payload.encryptedData === 'string'
  );
}

/**
 * Parse and validate an encrypted payload envelope.
 *
 * @param {unknown} body
 * @returns {ParseBodyResult}
 */
export function parseEncryptedBody(body) {
  const parsedBody = parseBodyAsObject(body, {
    invalidJson: REQUEST_ERRORS.INVALID_ENCRYPTED_PAYLOAD,
    invalidType: REQUEST_ERRORS.INVALID_ENCRYPTED_PAYLOAD
  });

  if (!parsedBody.ok) {
    return parsedBody;
  }

  if (!isEncryptedEnvelope(parsedBody.data)) {
    return { ok: false, error: REQUEST_ERRORS.INVALID_ENCRYPTED_PAYLOAD };
  }

  return parsedBody;
}

/**
 * 标准错误信封：{ status, body: { success: false, error: { code, message, details? } } }。
 *
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Object} [details]
 */
export function errorResponse(status, code, message, details) {
  const error = details === undefined ? { code, message } : { code, message, details };
  return { status, body: { success: false, error } };
}

/**
 * X-User-Id 门禁。所有按用户读写的端点共用这一份：规则（必填 + UUID v4）和
 * 文案只此一处，改口径不用挨个 handler 找复制粘贴的副本。
 *
 * @param {Record<string, any>} headers
 * @returns {{ userId: string, error?: undefined } | { error: ReturnType<typeof errorResponse> }}
 */
export function requireUserId(headers) {
  const userId = getHeader(headers, 'x-user-id');
  if (!userId) return { error: errorResponse(400, 'USER_ID_REQUIRED', '缺少用户标识符') };
  if (!isValidUUIDv4(userId)) return { error: errorResponse(400, 'INVALID_USER_ID_FORMAT', 'X-User-Id 必须是 UUID v4 格式') };
  return { userId };
}

/**
 * Read a header value case-insensitively.
 *
 * @param {Record<string, any>} headers
 * @param {string} name
 * @returns {string}
 */
export function getHeader(headers = {}, name) {
  if (!headers || typeof headers !== 'object') {
    return '';
  }

  const lowerName = String(name || '').toLowerCase();
  if (!lowerName) return '';

  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === lowerName) {
      return String(value || '').trim();
    }
  }

  return '';
}
