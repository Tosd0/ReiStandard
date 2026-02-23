/**
 * 系统密钥存储工具
 * ReiStandard v1.2.0
 */

const { createHash, randomBytes } = require('crypto');
const { neon } = require('@neondatabase/serverless');

const MASTER_KEY_CONFIG_KEY = 'master_key';
const MASTER_KEY_CACHE_TTL_MS = 60 * 1000;

let cachedMasterKey = null;
let cachedAt = 0;

function createError(code, message, status = 500) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function getSqlClient() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw createError('DATABASE_URL_MISSING', '缺少 DATABASE_URL 环境变量', 500);
  }
  return neon(databaseUrl);
}

function isValidMasterKey(masterKey) {
  return typeof masterKey === 'string' && /^[0-9a-f]{64}$/i.test(masterKey);
}

async function ensureSystemConfigTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS system_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `;
}

function setMasterKeyCache(masterKey) {
  cachedMasterKey = masterKey;
  cachedAt = Date.now();
}

function clearMasterKeyCache() {
  cachedMasterKey = null;
  cachedAt = 0;
}

async function getMasterKeyFromDb(options = {}) {
  const bypassCache = options.bypassCache === true;
  const now = Date.now();

  if (!bypassCache && cachedMasterKey && now - cachedAt < MASTER_KEY_CACHE_TTL_MS) {
    return cachedMasterKey;
  }

  const sql = getSqlClient();
  await ensureSystemConfigTable(sql);

  const rows = await sql`
    SELECT value
    FROM system_config
    WHERE key = ${MASTER_KEY_CONFIG_KEY}
    LIMIT 1
  `;

  if (rows.length === 0) {
    clearMasterKeyCache();
    return null;
  }

  const masterKey = rows[0].value;
  if (!isValidMasterKey(masterKey)) {
    throw createError('INVALID_MASTER_KEY_FORMAT', '数据库中的系统密钥格式无效', 500);
  }

  setMasterKeyCache(masterKey);
  return masterKey;
}

async function isMasterKeyInitialized() {
  const masterKey = await getMasterKeyFromDb({ bypassCache: true });
  return Boolean(masterKey);
}

async function setMasterKeyOnce(masterKey) {
  if (!isValidMasterKey(masterKey)) {
    throw createError('INVALID_MASTER_KEY_FORMAT', '系统密钥格式错误，必须是 64 位十六进制字符串', 400);
  }

  const sql = getSqlClient();
  await ensureSystemConfigTable(sql);

  const inserted = await sql`
    INSERT INTO system_config (key, value, created_at, updated_at)
    VALUES (${MASTER_KEY_CONFIG_KEY}, ${masterKey}, NOW(), NOW())
    ON CONFLICT (key) DO NOTHING
    RETURNING key
  `;

  if (inserted.length === 0) {
    throw createError('MASTER_KEY_ALREADY_INITIALIZED', '系统密钥已初始化，无法再次获取', 409);
  }

  setMasterKeyCache(masterKey);
}

function generateMasterKey() {
  return randomBytes(32).toString('hex');
}

function makeFingerprint(masterKey) {
  return createHash('sha256').update(masterKey).digest('hex').slice(0, 16);
}

module.exports = {
  clearMasterKeyCache,
  generateMasterKey,
  getMasterKeyFromDb,
  isMasterKeyInitialized,
  isValidMasterKey,
  makeFingerprint,
  setMasterKeyOnce
};
