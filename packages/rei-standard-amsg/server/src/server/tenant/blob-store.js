import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const inMemoryNamespaces = new Map();

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

function getKekBuffer(kek) {
  const value = String(kek || '').trim();
  if (!value) {
    throw new Error('[rei-standard-amsg-server] tenant.kek is required');
  }
  return createHash('sha256').update(value).digest();
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

async function resolveBlobStore(namespace) {
  if (globalThis.__REI_BLOB_STORE__ && typeof globalThis.__REI_BLOB_STORE__.get === 'function') {
    return globalThis.__REI_BLOB_STORE__;
  }

  try {
    const blobModule = await import('@netlify/blobs');
    const getStore = blobModule.getStore || blobModule.default?.getStore;
    if (typeof getStore === 'function') {
      return getStore({ name: namespace });
    }
  } catch (_error) {
    // Fall back to in-memory store for local tests / non-Netlify runtimes
  }

  return createInMemoryStore(namespace);
}

/**
 * @typedef {{
 *   tenantId: string,
 *   db: { driver: 'neon'|'pg', connectionString: string },
 *   masterKey: string,
 *   createdAt: string,
 *   updatedAt: string
 * }} TenantConfig
 */

/**
 * @param {{ namespace?: string, kek: string }} options
 */
export function createTenantBlobStore(options) {
  const namespace = String(options.namespace || 'rei-tenants').trim() || 'rei-tenants';
  const kekBuffer = getKekBuffer(options.kek);

  function getTenantKey(tenantId) {
    return `tenant/${tenantId}`;
  }

  return {
    async getTenantConfig(tenantId) {
      const store = await resolveBlobStore(namespace);
      const encrypted = await store.get(getTenantKey(tenantId), { type: 'text' });
      if (!encrypted) return null;
      return decryptConfig(encrypted, kekBuffer);
    },

    async setTenantConfig(config) {
      const store = await resolveBlobStore(namespace);
      const encrypted = encryptConfig(config, kekBuffer);
      await store.set(getTenantKey(config.tenantId), encrypted);
    },

    async deleteTenantConfig(tenantId) {
      const store = await resolveBlobStore(namespace);
      await store.delete(getTenantKey(tenantId));
    }
  };
}
