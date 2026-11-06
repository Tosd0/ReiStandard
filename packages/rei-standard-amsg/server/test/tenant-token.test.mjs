import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTenantToken, verifyTenantToken } from '../src/server/tenant/token.js';

const SECRET = 'tenant-signing-secret';

function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

// init 签出的租户 / cron token 没有续签路径，默认不能带过期时间。
test('createTenantToken 默认不带 exp，且能通过校验', () => {
  const token = createTenantToken({ tenantId: 't1', type: 'tenant' }, SECRET);
  assert.equal(decodePayload(token).exp, undefined);
  const payload = verifyTenantToken(token, SECRET, { expectedTypes: ['tenant'] });
  assert.equal(payload.tid, 't1');
});

test('createTenantToken 显式传 expiresInSeconds 才带 exp，过期后被拒', () => {
  const token = createTenantToken({ tenantId: 't1', type: 'cron', expiresInSeconds: 3600 }, SECRET);
  const payload = decodePayload(token);
  assert.equal(payload.exp, payload.iat + 3600);
  assert.equal(verifyTenantToken(token, SECRET).typ, 'cron');

  const expired = createTenantToken({ tenantId: 't1', type: 'cron', expiresInSeconds: 1 }, SECRET);
  const originalNow = Date.now;
  Date.now = () => originalNow() + 5000;
  try {
    assert.throws(() => verifyTenantToken(expired, SECRET), /INVALID_TENANT_AUTH/);
  } finally {
    Date.now = originalNow;
  }
});
