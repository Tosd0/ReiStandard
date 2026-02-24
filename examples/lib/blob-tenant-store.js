const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('crypto');

const inMemoryNamespaces = new Map();

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

function getKekBuffer() {
  const kek = String(process.env.TENANT_CONFIG_KEK || '').trim();
  if (!kek) {
    throw new Error('TENANT_CONFIG_KEK_MISSING');
  }
  return createHash('sha256').update(kek).digest();
}

function encryptConfig(config, kekBuffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kekBuffer, iv);
  const plaintext = Buffer.from(JSON.stringify(config), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(authTag)}.${base64UrlEncode(ciphertext)}`;
}

function decryptConfig(encrypted, kekBuffer) {
  const parts = String(encrypted || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('INVALID_TENANT_CONFIG');
  }

  const iv = base64UrlDecode(parts[1]);
  const authTag = base64UrlDecode(parts[2]);
  const ciphertext = base64UrlDecode(parts[3]);

  const decipher = createDecipheriv('aes-256-gcm', kekBuffer, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
}

function createInMemoryStore(namespace) {
  if (!inMemoryNamespaces.has(namespace)) {
    inMemoryNamespaces.set(namespace, new Map());
  }

  const namespaceMap = inMemoryNamespaces.get(namespace);

  return {
    async get(key) {
      return namespaceMap.has(key) ? namespaceMap.get(key) : null;
    },
    async set(key, value) {
      namespaceMap.set(key, value);
    },
    async delete(key) {
      namespaceMap.delete(key);
    }
  };
}

async function resolveBlobStore() {
  if (globalThis.__REI_BLOB_STORE__ && typeof globalThis.__REI_BLOB_STORE__.get === 'function') {
    return globalThis.__REI_BLOB_STORE__;
  }

  const namespace = process.env.TENANT_BLOB_NAMESPACE || 'rei-tenants';

  try {
    const blobModule = await import('@netlify/blobs');
    const getStore = blobModule.getStore || (blobModule.default && blobModule.default.getStore);
    if (typeof getStore === 'function') {
      return getStore({ name: namespace });
    }
  } catch (_error) {
    // Fallback for local development/tests
  }

  return createInMemoryStore(namespace);
}

function tenantKey(tenantId) {
  return `tenant/${tenantId}`;
}

async function getTenantConfig(tenantId) {
  const store = await resolveBlobStore();
  const encrypted = await store.get(tenantKey(tenantId), { type: 'text' });
  if (!encrypted) return null;

  return decryptConfig(encrypted, getKekBuffer());
}

async function setTenantConfig(config) {
  const store = await resolveBlobStore();
  const encrypted = encryptConfig(config, getKekBuffer());
  await store.set(tenantKey(config.tenantId), encrypted);
}

module.exports = {
  getTenantConfig,
  setTenantConfig
};
