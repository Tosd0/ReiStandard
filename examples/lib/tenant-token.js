const { createHmac, timingSafeEqual } = require('crypto');

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLength = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLength), 'base64');
}

function sign(input, secret) {
  return base64UrlEncode(createHmac('sha256', secret).update(input).digest());
}

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
}

function createTenantToken({ tenantId, type, expiresInSeconds = 60 * 60 * 24 * 30 }, secret) {
  const issuedAt = nowEpochSeconds();
  const payload = {
    tid: tenantId,
    typ: type,
    iat: issuedAt,
    exp: issuedAt + Number(expiresInSeconds),
    v: 1
  };

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(signingInput, secret);

  return `${signingInput}.${signature}`;
}

function verifyTenantToken(token, secret, options = {}) {
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

  if (!payload || !payload.tid || !payload.typ || !payload.exp || payload.v !== 1) {
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

function extractBearerToken(headers = {}) {
  let auth = '';
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === 'authorization') {
      auth = String(value || '').trim();
      break;
    }
  }
  if (!auth.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return auth.slice(7).trim();
}

module.exports = {
  createTenantToken,
  verifyTenantToken,
  extractBearerToken
};
