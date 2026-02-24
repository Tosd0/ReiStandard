import { createHash, randomBytes, randomUUID } from 'crypto';
import { createAdapter } from '../adapters/factory.js';
import { createTenantToken, extractBearerToken, verifyTenantToken } from './token.js';

function fingerprint(masterKey) {
  return createHash('sha256').update(masterKey).digest('hex').slice(0, 16);
}

function sanitizeDbConfig(driver, connectionString) {
  const normalizedDriver = String(driver || '').trim();
  const normalizedConnectionString = String(connectionString || '').trim();

  if (!['neon', 'pg'].includes(normalizedDriver)) {
    throw new Error('INVALID_DRIVER');
  }
  if (!normalizedConnectionString) {
    throw new Error('INVALID_DATABASE_URL');
  }

  return {
    driver: normalizedDriver,
    connectionString: normalizedConnectionString
  };
}

function parseTokenFromUrl(url) {
  if (!url || typeof url !== 'string') {
    return '';
  }

  try {
    const parsed = new URL(url, 'https://dummy.local');
    return String(parsed.searchParams.get('token') || '').trim();
  } catch {
    return '';
  }
}

/**
 * @param {{
 *   tenantStore: ReturnType<import('./blob-store.js').createTenantBlobStore>,
 *   tokenSigningKey: string,
 *   publicBaseUrl?: string
 * }} options
 */
export function createTenantContextManager(options) {
  const tenantStore = options.tenantStore;
  const tokenSigningKey = String(options.tokenSigningKey || '').trim();
  const publicBaseUrl = String(options.publicBaseUrl || '').replace(/\/$/, '');
  const adapterFactory = options.adapterFactory || createAdapter;
  const adapterCache = new Map();

  if (!tokenSigningKey) {
    throw new Error('[rei-standard-amsg-server] tenant.tokenSigningKey is required');
  }

  async function getOrCreateAdapter(dbConfig) {
    const cacheKey = `${dbConfig.driver}:${dbConfig.connectionString}`;
    if (!adapterCache.has(cacheKey)) {
      const adapter = await adapterFactory(dbConfig);
      adapterCache.set(cacheKey, adapter);
    }
    return adapterCache.get(cacheKey);
  }

  async function initializeTenant({ driver, connectionString, tenantId: providedTenantId }) {
    const dbConfig = sanitizeDbConfig(driver, connectionString);
    const tenantId = String(providedTenantId || randomUUID()).trim();

    const existing = await tenantStore.getTenantConfig(tenantId);
    if (existing) {
      throw new Error('TENANT_ALREADY_INITIALIZED');
    }

    const adapter = await getOrCreateAdapter(dbConfig);
    await adapter.initSchema();

    const masterKey = randomBytes(32).toString('hex');
    const now = new Date().toISOString();

    await tenantStore.setTenantConfig({
      tenantId,
      db: dbConfig,
      masterKey,
      createdAt: now,
      updatedAt: now
    });

    const tenantToken = createTenantToken({ tenantId, type: 'tenant' }, tokenSigningKey);
    const cronToken = createTenantToken({ tenantId, type: 'cron' }, tokenSigningKey);

    return {
      tenantId,
      masterKeyFingerprint: fingerprint(masterKey),
      tenantToken,
      cronToken,
      cronWebhookUrl: publicBaseUrl ? `${publicBaseUrl}/api/v1/send-notifications?token=${cronToken}` : ''
    };
  }

  async function resolveTenant(headers, options = {}) {
    const allowCronToken = options.allowCronToken === true;
    const url = options.url || '';

    const bearerToken = extractBearerToken(headers);
    const tokenFromQuery = allowCronToken ? parseTokenFromUrl(url) : '';
    const token = bearerToken || tokenFromQuery;

    if (!token) {
      return {
        ok: false,
        error: {
          status: 401,
          body: { success: false, error: { code: 'INVALID_TENANT_AUTH', message: '缺少租户鉴权信息' } }
        }
      };
    }

    let payload;
    try {
      payload = verifyTenantToken(token, tokenSigningKey, {
        expectedTypes: allowCronToken ? ['cron'] : ['tenant']
      });
    } catch (_error) {
      return {
        ok: false,
        error: {
          status: 401,
          body: { success: false, error: { code: 'INVALID_TENANT_AUTH', message: '租户令牌无效或已过期' } }
        }
      };
    }

    const tenantConfig = await tenantStore.getTenantConfig(payload.tid);
    if (!tenantConfig) {
      return {
        ok: false,
        error: {
          status: 401,
          body: { success: false, error: { code: 'INVALID_TENANT_AUTH', message: '租户配置不存在或已失效' } }
        }
      };
    }

    const adapter = await getOrCreateAdapter(tenantConfig.db);

    return {
      ok: true,
      context: {
        tenantId: tenantConfig.tenantId,
        tokenType: payload.typ,
        db: adapter,
        masterKey: tenantConfig.masterKey
      }
    };
  }

  return {
    initializeTenant,
    resolveTenant
  };
}
