/**
 * v2.0.0-pre1 master key helper（来源：tenant context / blob）
 * 不再从数据库 system_config 读取或写入。
 */

const { createHash } = require('crypto');

function isValidMasterKey(masterKey) {
  return typeof masterKey === 'string' && /^[0-9a-f]{64}$/i.test(masterKey);
}

function getMasterKeyFromTenantContext(tenantContext) {
  const masterKey = tenantContext && typeof tenantContext === 'object'
    ? tenantContext.masterKey
    : null;

  if (!isValidMasterKey(masterKey)) {
    const error = new Error('TENANT_MASTER_KEY_MISSING');
    error.code = 'TENANT_MASTER_KEY_MISSING';
    error.status = 500;
    throw error;
  }

  return masterKey;
}

function isMasterKeyInitialized(tenantContext) {
  try {
    return Boolean(getMasterKeyFromTenantContext(tenantContext));
  } catch {
    return false;
  }
}

function makeFingerprint(masterKey) {
  if (!isValidMasterKey(masterKey)) {
    return '';
  }
  return createHash('sha256').update(masterKey).digest('hex').slice(0, 16);
}

module.exports = {
  getMasterKeyFromTenantContext,
  isMasterKeyInitialized,
  isValidMasterKey,
  makeFingerprint
};
