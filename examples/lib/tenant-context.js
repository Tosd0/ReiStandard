const { createHash, randomBytes, randomUUID } = require('crypto');
const { neon } = require('@neondatabase/serverless');
const { createTenantToken, extractBearerToken, verifyTenantToken } = require('./tenant-token');
const { getTenantConfig, setTenantConfig } = require('./blob-tenant-store');

function makeFingerprint(masterKey) {
  return createHash('sha256').update(masterKey).digest('hex').slice(0, 16);
}

function parseTokenFromUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url, 'https://dummy.local');
    return String(parsed.searchParams.get('token') || '').trim();
  } catch {
    return '';
  }
}

function getTokenSigningKey() {
  const key = String(process.env.TENANT_TOKEN_SIGNING_KEY || '').trim();
  if (!key) {
    throw new Error('TENANT_TOKEN_SIGNING_KEY_MISSING');
  }
  return key;
}

async function initSchema(driver, databaseUrl) {
  const createTableSql = `
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      uuid VARCHAR(36),
      encrypted_payload TEXT NOT NULL,
      message_type VARCHAR(50) NOT NULL CHECK (message_type IN ('fixed', 'prompted', 'auto', 'instant')),
      next_send_at TIMESTAMP WITH TIME ZONE NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
      retry_count INTEGER DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;

  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_pending_tasks_optimized ON scheduled_messages (status, next_send_at, id, retry_count) WHERE status = 'pending'`,
    `CREATE INDEX IF NOT EXISTS idx_cleanup_completed ON scheduled_messages (status, updated_at) WHERE status IN ('sent', 'failed')`,
    `CREATE INDEX IF NOT EXISTS idx_failed_retry ON scheduled_messages (status, retry_count, next_send_at) WHERE status = 'failed' AND retry_count < 3`,
    `CREATE INDEX IF NOT EXISTS idx_user_id ON scheduled_messages (user_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uidx_uuid ON scheduled_messages (uuid) WHERE uuid IS NOT NULL`
  ];

  if (driver === 'neon') {
    const sql = neon(databaseUrl);
    await sql.query(createTableSql);
    for (const indexSql of indexes) {
      await sql.query(indexSql);
    }
    return;
  }

  if (driver === 'pg') {
    let pool;
    try {
      const pgModule = await import('pg');
      const Pool = pgModule.Pool || pgModule.default?.Pool;
      if (!Pool) {
        throw new Error('PG_DRIVER_IMPORT_FAILED');
      }

      pool = new Pool({ connectionString: databaseUrl });
      await pool.query(createTableSql);
      for (const indexSql of indexes) {
        await pool.query(indexSql);
      }
      return;
    } catch (error) {
      if (error.message === 'ERR_MODULE_NOT_FOUND') {
        throw new Error('PG_DRIVER_NOT_INSTALLED');
      }
      throw error;
    } finally {
      if (pool) {
        await pool.end();
      }
    }
  }

  throw new Error('DRIVER_NOT_SUPPORTED_IN_EXAMPLES');
}

async function initializeTenant({ tenantId: inputTenantId, driver, databaseUrl, publicBaseUrl }) {
  const tenantId = String(inputTenantId || randomUUID()).trim();
  const normalizedDriver = String(driver || '').trim();
  const normalizedDatabaseUrl = String(databaseUrl || '').trim();

  if (!normalizedDatabaseUrl) {
    throw new Error('INVALID_DATABASE_URL');
  }

  if (!['neon', 'pg'].includes(normalizedDriver)) {
    throw new Error('INVALID_DRIVER');
  }

  const existing = await getTenantConfig(tenantId);
  if (existing) {
    throw new Error('TENANT_ALREADY_INITIALIZED');
  }

  await initSchema(normalizedDriver, normalizedDatabaseUrl);

  const masterKey = randomBytes(32).toString('hex');
  const now = new Date().toISOString();

  await setTenantConfig({
    tenantId,
    db: {
      driver: normalizedDriver,
      connectionString: normalizedDatabaseUrl
    },
    masterKey,
    createdAt: now,
    updatedAt: now
  });

  const secret = getTokenSigningKey();
  const tenantToken = createTenantToken({ tenantId, type: 'tenant' }, secret);
  const cronToken = createTenantToken({ tenantId, type: 'cron' }, secret);

  return {
    tenantId,
    tenantToken,
    cronToken,
    cronWebhookUrl: publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/api/v1/send-notifications?token=${cronToken}` : '',
    masterKeyFingerprint: makeFingerprint(masterKey)
  };
}

async function resolveTenantFromRequest(headers = {}, url = '', options = {}) {
  const allowCronToken = options.allowCronToken === true;
  const bearer = extractBearerToken(headers);
  const queryToken = allowCronToken ? parseTokenFromUrl(url) : '';
  const token = bearer || queryToken;

  if (!token) {
    return {
      ok: false,
      response: {
        status: 401,
        body: {
          success: false,
          error: {
            code: 'INVALID_TENANT_AUTH',
            message: '缺少租户鉴权信息'
          }
        }
      }
    };
  }

  let payload;
  try {
    payload = verifyTenantToken(token, getTokenSigningKey(), {
      expectedTypes: allowCronToken ? ['cron'] : ['tenant']
    });
  } catch (_error) {
    return {
      ok: false,
      response: {
        status: 401,
        body: {
          success: false,
          error: {
            code: 'INVALID_TENANT_AUTH',
            message: '租户令牌无效或已过期'
          }
        }
      }
    };
  }

  const tenantConfig = await getTenantConfig(payload.tid);
  if (!tenantConfig) {
    return {
      ok: false,
      response: {
        status: 401,
        body: {
          success: false,
          error: {
            code: 'INVALID_TENANT_AUTH',
            message: '租户配置不存在或已失效'
          }
        }
      }
    };
  }

  return {
    ok: true,
    tenant: {
      tenantId: tenantConfig.tenantId,
      tokenType: payload.typ,
      db: tenantConfig.db,
      masterKey: tenantConfig.masterKey
    }
  };
}

module.exports = {
  initializeTenant,
  resolveTenantFromRequest
};
