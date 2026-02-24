/**
 * Vercel Function 版本的主动消息 API v2.0.0-pre1 测试
 */

const crypto = require('crypto');

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

async function makeRequest(method, url, options = {}) {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

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

async function runTests(baseUrl, config) {
  const results = [];

  const initHeaders = {};
  if (config.initSecret) {
    initHeaders['X-Init-Secret'] = config.initSecret;
  }

  const initRes = await makeRequest('POST', `${baseUrl}/api/v1/init-tenant`, {
    headers: initHeaders,
    body: {
      driver: 'neon',
      databaseUrl: config.tenantDatabaseUrl
    }
  });

  const initPassed = initRes.ok && initRes.data.success;
  results.push({
    test: 'POST /api/v1/init-tenant',
    passed: initPassed,
    status: initRes.status,
    message: initPassed ? '成功' : (initRes.data.error && initRes.data.error.message) || initRes.error || '失败'
  });

  if (!initPassed) {
    return {
      summary: {
        total: results.length,
        passed: 0,
        failed: results.length,
        successRate: '0.0%'
      },
      results,
      timestamp: new Date().toISOString()
    };
  }

  const tenantToken = initRes.data.data.tenantToken;
  const cronToken = initRes.data.data.cronToken;

  const userKeyRes = await makeRequest('GET', `${baseUrl}/api/v1/get-user-key`, {
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      'X-User-Id': config.userId
    }
  });

  const keyPassed = userKeyRes.ok && userKeyRes.data.success;
  results.push({
    test: 'GET /api/v1/get-user-key',
    passed: keyPassed,
    status: userKeyRes.status,
    message: keyPassed ? '成功' : (userKeyRes.data.error && userKeyRes.data.error.message) || userKeyRes.error || '失败'
  });

  if (!keyPassed) {
    return {
      summary: {
        total: results.length,
        passed: results.filter(r => r.passed).length,
        failed: results.filter(r => !r.passed).length,
        successRate: `${((results.filter(r => r.passed).length / results.length) * 100).toFixed(1)}%`
      },
      results,
      timestamp: new Date().toISOString()
    };
  }

  const payload = {
    contactName: 'ReiTest',
    messageType: 'fixed',
    userMessage: '测试消息',
    firstSendTime: new Date(Date.now() + 60 * 1000).toISOString(),
    recurrenceType: 'none',
    pushSubscription: {
      endpoint: 'https://fcm.googleapis.com/test',
      keys: { p256dh: 'test', auth: 'test' }
    }
  };

  const encrypted = encryptPayload(payload, userKeyRes.data.data.userKey);
  const scheduleRes = await makeRequest('POST', `${baseUrl}/api/v1/schedule-message`, {
    headers: {
      Authorization: `Bearer ${tenantToken}`,
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1',
      'X-User-Id': config.userId
    },
    body: encrypted
  });

  results.push({
    test: 'POST /api/v1/schedule-message',
    passed: scheduleRes.ok && scheduleRes.data.success,
    status: scheduleRes.status,
    message: scheduleRes.ok ? '成功' : (scheduleRes.data.error && scheduleRes.data.error.message) || scheduleRes.error || '失败'
  });

  const sendRes = await makeRequest('POST', `${baseUrl}/api/v1/send-notifications`, {
    headers: {
      Authorization: `Bearer ${cronToken}`
    }
  });

  results.push({
    test: 'POST /api/v1/send-notifications',
    passed: sendRes.ok && sendRes.data.success,
    status: sendRes.status,
    message: sendRes.ok ? '成功' : (sendRes.data.error && sendRes.data.error.message) || sendRes.error || '失败'
  });

  const passed = results.filter(r => r.passed).length;
  const total = results.length;

  return {
    summary: {
      total,
      passed,
      failed: total - passed,
      successRate: `${((passed / total) * 100).toFixed(1)}%`
    },
    results,
    timestamp: new Date().toISOString()
  };
}

module.exports = async function handler(req, res) {
  const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
  const config = {
    initSecret: process.env.INIT_SECRET || '',
    tenantDatabaseUrl: process.env.TENANT_DATABASE_URL,
    userId: process.env.TEST_USER_ID || crypto.randomUUID()
  };

  const result = await runTests(baseUrl, config);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(result, null, 2));
};
