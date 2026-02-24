import { createHmac, timingSafeEqual } from 'crypto';

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const normalized = input
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLength), 'base64');
}

function sign(input, secret) {
  return base64UrlEncode(createHmac('sha256', secret).update(input).digest());
}

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * @typedef {'tenant'|'cron'} TokenType
 */

/**
 * @param {{ tenantId: string, type: TokenType, expiresInSeconds?: number }} params
 * @param {string} secret
 */
export function createTenantToken(params, secret) {
  const issuedAt = nowEpochSeconds();
  const expiresInSeconds = Number(params.expiresInSeconds || 60 * 60 * 24 * 30);
  const payload = {
    tid: params.tenantId,
    typ: params.type,
    iat: issuedAt,
    exp: issuedAt + expiresInSeconds,
    v: 1
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(signingInput, secret);
  return `${signingInput}.${signature}`;
}

/**
 * @param {string} token
 * @param {string} secret
 * @param {{ expectedTypes?: TokenType[] }} [options]
 */
export function verifyTenantToken(token, secret, options = {}) {
  if (!token || typeof token !== 'string') {
    throw new Error('INVALID_TENANT_AUTH');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('INVALID_TENANT_AUTH');
  }

  const [encodedHeader, encodedPayload, receivedSignature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = sign(signingInput, secret);

  const receivedBuffer = Buffer.from(receivedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    receivedBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(receivedBuffer, expectedBuffer)
  ) {
    throw new Error('INVALID_TENANT_AUTH');
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
  } catch {
    throw new Error('INVALID_TENANT_AUTH');
  }

  if (!payload || typeof payload !== 'object' || payload.v !== 1) {
    throw new Error('INVALID_TENANT_AUTH');
  }

  if (!payload.tid || !payload.typ || !payload.exp) {
    throw new Error('INVALID_TENANT_AUTH');
  }

  if (payload.exp <= nowEpochSeconds()) {
    throw new Error('INVALID_TENANT_AUTH');
  }

  const expectedTypes = options.expectedTypes || [];
  if (expectedTypes.length > 0 && !expectedTypes.includes(payload.typ)) {
    throw new Error('INVALID_TENANT_AUTH');
  }

  return payload;
}

/**
 * @param {Record<string, any>} headers
 * @returns {string}
 */
export function extractBearerToken(headers = {}) {
  let authorization = '';
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === 'authorization') {
      authorization = String(value || '').trim();
      break;
    }
  }
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return authorization.slice(7).trim();
}
