import { createHmac } from 'crypto';
// base64url / UTF-8 / 常量时间比较统一用 shared 的实现（编码逐字节一致）。
// HMAC 仍走 node:crypto 的 createHmac：shared 的 hmacSha256 基于
// SubtleCrypto、必然 async，而 createTenantToken / verifyTenantToken
// 是对外导出的同步 API，不能因此改成 Promise。
import {
  utf8,
  utf8Decode,
  bytesToBase64Url,
  base64UrlToBytes,
  timingSafeEqualBytes,
} from '../lib/webcrypto-utils.js';

function sign(input, secret) {
  return bytesToBase64Url(createHmac('sha256', secret).update(input).digest());
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
  const encodedHeader = bytesToBase64Url(utf8(JSON.stringify(header)));
  const encodedPayload = bytesToBase64Url(utf8(JSON.stringify(payload)));
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

  // Compare raw HMAC bytes (decoded from base64url) rather than the
  // encoded character bytes — semantically clearer and avoids the
  // implicit-UTF-8 default of Buffer.from(string).
  let receivedBytes;
  let expectedBytes;
  try {
    receivedBytes = base64UrlToBytes(receivedSignature);
    expectedBytes = base64UrlToBytes(expectedSignature);
  } catch {
    throw new Error('INVALID_TENANT_AUTH');
  }
  if (!timingSafeEqualBytes(receivedBytes, expectedBytes)) {
    throw new Error('INVALID_TENANT_AUTH');
  }

  let payload;
  try {
    payload = JSON.parse(utf8Decode(base64UrlToBytes(encodedPayload)));
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
