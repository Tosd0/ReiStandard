/**
 * Request payload utilities.
 * Keeps body parsing and shape validation consistent across handlers.
 */

import { isValidUUIDv4 } from './validation.js';

export const REQUEST_ERRORS = {
  INVALID_JSON: { code: 'INVALID_JSON', message: '请求体不是有效的 JSON' },
  INVALID_REQUEST_BODY: { code: 'INVALID_REQUEST_BODY', message: '请求体格式无效' },
  INVALID_ENCRYPTED_PAYLOAD: { code: 'INVALID_ENCRYPTED_PAYLOAD', message: '加密数据格式错误' }
};

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
