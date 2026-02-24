#!/usr/bin/env node

/**
 * 主动消息 API v2.0.0-pre1 综合测试脚本（Blob 一体化初始化版）
 */

const crypto = require('crypto');

function getRequiredEnv(key, description) {
  const value = process.env[key];
  if (!value) {
    console.error(`缺少环境变量 ${key}：${description}`);
    process.exit(1);
  }
  return value;
}

function getOptionalEnv(key, defaultValue = null) {
  return process.env[key] || defaultValue;
}

const CONFIG = {
  apiBaseUrl: getRequiredEnv('API_BASE_URL', 'API 地址，例如 https://your-domain.com'),
  initSecret: getOptionalEnv('INIT_SECRET', ''),
  tenantDatabaseUrl: getRequiredEnv('TENANT_DATABASE_URL', '租户独立数据库连接串'),
  testUserId: getOptionalEnv('TEST_USER_ID', crypto.randomUUID()),
  vercelBypassKey: getOptionalEnv('VERCEL_PROTECTION_BYPASS', '')
};

function encryptPayload(plainPayload, encryptionKey) {
  const plaintext = JSON.stringify(plainPayload);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(encryptionKey, 'hex'),
    iv
  );

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    encryptedData: encrypted.toString('base64')
  };
}

async function makeRequest(method, endpoint, options = {}) {
  const url = `${CONFIG.apiBaseUrl}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  if (CONFIG.vercelBypassKey) {
    headers['x-vercel-protection-bypass'] = CONFIG.vercelBypassKey;
  }

  const requestOptions = {
    method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  };

  try {
    const response = await fetch(url, requestOptions);
    const data = await response.json().catch(() => ({}));

    return {
      ok: response.ok,
      status: response.status,
      data
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error.message,
      data: {}
    };
  }
}

async function run() {
  console.log('=== ReiStandard API v2.0.0-pre1 测试开始 ===');

  const initHeaders = {};
  if (CONFIG.initSecret) {
    initHeaders['X-Init-Secret'] = CONFIG.initSecret;
  }

  const initRes = await makeRequest('POST', '/api/v1/init-tenant', {
    headers: initHeaders,
    body: {
      driver: 'neon',
      databaseUrl: CONFIG.tenantDatabaseUrl
    }
  });

  if (!initRes.ok || !initRes.data.success) {
    console.error('init-tenant 失败:', initRes.status, initRes.data || initRes.error);
    process.exit(1);
  }

  const tenantToken = initRes.data.data.tenantToken;
  const cronToken = initRes.data.data.cronToken;

  console.log('init-tenant 成功:', {
    tenantId: initRes.data.data.tenantId,
    masterKeyFingerprint: initRes.data.data.masterKeyFingerprint
  });

  const userKeyRes = await makeRequest('GET', '/api/v1/get-user-key', {
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      'X-User-Id': CONFIG.testUserId
    }
  });

  if (!userKeyRes.ok || !userKeyRes.data.success) {
    console.error('get-user-key 失败:', userKeyRes.status, userKeyRes.data || userKeyRes.error);
    process.exit(1);
  }

  const userKey = userKeyRes.data.data.userKey;
  console.log('get-user-key 成功');

  const schedulePayload = {
    contactName: 'TestContact',
    messageType: 'fixed',
    userMessage: 'hello from v2.0.0-pre1',
    firstSendTime: new Date(Date.now() + 60 * 1000).toISOString(),
    recurrenceType: 'none',
    pushSubscription: {
      endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint',
      expirationTime: null,
      keys: {
        p256dh: 'BEl2...test...kR4=',
        auth: 'k8J...test...3Q='
      }
    }
  };

  const encryptedBody = encryptPayload(schedulePayload, userKey);
  const scheduleRes = await makeRequest('POST', '/api/v1/schedule-message', {
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      'X-User-Id': CONFIG.testUserId,
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1'
    },
    body: encryptedBody
  });

  if (!scheduleRes.ok || !scheduleRes.data.success) {
    console.error('schedule-message 失败:', scheduleRes.status, scheduleRes.data || scheduleRes.error);
    process.exit(1);
  }

  console.log('schedule-message 成功:', scheduleRes.data.data.uuid);

  const listRes = await makeRequest('GET', '/api/v1/messages?status=all&limit=10&offset=0', {
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      'X-User-Id': CONFIG.testUserId
    }
  });

  if (!listRes.ok || !listRes.data.success) {
    console.error('messages 失败:', listRes.status, listRes.data || listRes.error);
    process.exit(1);
  }

  console.log('messages 成功');

  const sendRes = await makeRequest('POST', '/api/v1/send-notifications', {
    headers: {
      Authorization: `Bearer ${cronToken}`
    }
  });

  if (!sendRes.ok || !sendRes.data.success) {
    console.error('send-notifications 失败:', sendRes.status, sendRes.data || sendRes.error);
    process.exit(1);
  }

  console.log('send-notifications 成功');
  console.log('=== ReiStandard API v2.0.0-pre1 测试通过 ===');
}

run().catch((error) => {
  console.error('测试异常:', error);
  process.exit(1);
});
