/**
 * Request payload utilities.
 * Keeps body parsing and shape validation consistent across handlers.
 */

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
