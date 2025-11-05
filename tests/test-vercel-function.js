/**
 * Vercel Function 版本的主动消息 API 测试
 *
 * 部署方式：
 * 1. 将此文件放到 /api/test-active-messaging.js
 * 2. 在 Vercel Dashboard 配置环境变量
 * 3. 访问 https://your-domain.vercel.app/api/test-active-messaging
 *
 * 或者本地运行：
 * vercel dev
 * curl http://localhost:3000/api/test-active-messaging
 */

const crypto = require('crypto');

// ============ 配置 ============
function getEnv(key, defaultValue = null) {
  return process.env[key] || defaultValue;
}

// ============ 加密工具 ============
function deriveUserEncryptionKey(userId, masterKey) {
  return crypto
    .createHash('sha256')
    .update(masterKey + userId)
    .digest('hex')
    .slice(0, 64);
}

function encryptPayload(plainPayload, encryptionKey) {
  const plaintext = JSON.stringify(plainPayload);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(encryptionKey, 'hex'),
    iv
  );
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    encryptedData: encrypted.toString('base64')
  };
}

// ============ HTTP 请求 ============
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
      error: error.message
    };
  }
}

// ============ 测试函数 ============
async function runTests(baseUrl, config) {
  const results = [];
  const createdTasks = [];

  // 派生用户密钥
  const userKey = deriveUserEncryptionKey(config.userId, config.encryptionKey);

  // 测试 1: 获取主密钥
  try {
    const res = await makeRequest('GET', `${baseUrl}/api/v1/get-master-key`, {
      headers: { 'X-User-Id': config.userId }
    });
    results.push({
      test: 'GET /api/v1/get-master-key',
      passed: res.ok && res.data.success,
      status: res.status,
      message: res.ok ? '成功' : res.data.error?.message || '失败'
    });
  } catch (error) {
    results.push({
      test: 'GET /api/v1/get-master-key',
      passed: false,
      error: error.message
    });
  }

  // 测试 2: 创建 fixed 消息
  try {
    const payload = {
      contactName: 'ReiTest',
      messageType: 'fixed',
      userMessage: '测试消息',
      firstSendTime: new Date(Date.now() + 60000).toISOString(),
      recurrenceType: 'none',
      pushSubscription: {
        endpoint: 'https://fcm.googleapis.com/test',
        keys: { p256dh: 'test', auth: 'test' }
      }
    };

    const encrypted = encryptPayload(payload, userKey);
    const res = await makeRequest('POST', `${baseUrl}/api/v1/schedule-message`, {
      headers: {
        'X-Payload-Encrypted': 'true',
        'X-Encryption-Version': '1',
        'X-User-Id': config.userId
      },
      body: encrypted
    });

    if (res.ok && res.data.success) {
      createdTasks.push(res.data.data.uuid);
    }

    results.push({
      test: 'POST /api/v1/schedule-message (fixed)',
      passed: res.ok && res.data.success,
      status: res.status,
      taskId: res.data.data?.id,
      message: res.ok ? '成功' : res.data.error?.message || '失败'
    });
  } catch (error) {
    results.push({
      test: 'POST /api/v1/schedule-message (fixed)',
      passed: false,
      error: error.message
    });
  }

  // 测试 3: 创建 prompted 消息（使用占位符 API key）
  try {
    const payload = {
      contactName: 'ReiTest',
      messageType: 'prompted',
      firstSendTime: new Date(Date.now() + 120000).toISOString(),
      recurrenceType: 'none',
      pushSubscription: {
        endpoint: 'https://fcm.googleapis.com/test',
        keys: { p256dh: 'test', auth: 'test' }
      },
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk-test-placeholder',
      primaryModel: 'gpt-5',
      completePrompt: '测试 prompt'
    };

    const encrypted = encryptPayload(payload, userKey);
    const res = await makeRequest('POST', `${baseUrl}/api/v1/schedule-message`, {
      headers: {
        'X-Payload-Encrypted': 'true',
        'X-Encryption-Version': '1',
        'X-User-Id': config.userId
      },
      body: encrypted
    });

    if (res.ok && res.data.success) {
      createdTasks.push(res.data.data.uuid);
    }

    results.push({
      test: 'POST /api/v1/schedule-message (prompted)',
      passed: res.ok && res.data.success,
      status: res.status,
      taskId: res.data.data?.id,
      message: res.ok ? '成功' : res.data.error?.message || '失败'
    });
  } catch (error) {
    results.push({
      test: 'POST /api/v1/schedule-message (prompted)',
      passed: false,
      error: error.message
    });
  }

  // 测试 3.5: 创建 instant 固定消息
  try {
    const payload = {
      contactName: 'InstantRei',
      messageType: 'instant',
      userMessage: '即时测试消息',
      firstSendTime: new Date().toISOString(),
      recurrenceType: 'none',
      pushSubscription: {
        endpoint: 'https://fcm.googleapis.com/test',
        keys: { p256dh: 'test', auth: 'test' }
      }
    };

    const encrypted = encryptPayload(payload, userKey);
    const res = await makeRequest('POST', `${baseUrl}/api/v1/schedule-message`, {
      headers: {
        'X-Payload-Encrypted': 'true',
        'X-Encryption-Version': '1',
        'X-User-Id': config.userId
      },
      body: encrypted
    });

    results.push({
      test: 'POST /api/v1/schedule-message (instant fixed)',
      passed: res.ok && res.data.success,
      status: res.status,
      messagesSent: res.data.data?.messagesSent,
      message: res.ok ? `发送 ${res.data.data?.messagesSent || 0} 条消息` : res.data.error?.message || '失败'
    });
  } catch (error) {
    results.push({
      test: 'POST /api/v1/schedule-message (instant fixed)',
      passed: false,
      error: error.message
    });
  }

  // 测试 3.6: 创建 instant AI 消息
  try {
    const payload = {
      contactName: 'InstantRei',
      messageType: 'instant',
      firstSendTime: new Date().toISOString(),
      recurrenceType: 'none',
      pushSubscription: {
        endpoint: 'https://fcm.googleapis.com/test',
        keys: { p256dh: 'test', auth: 'test' }
      },
      apiUrl: 'https://api.openai.com/v1/chat/completions',
      apiKey: 'sk-test-placeholder',
      primaryModel: 'gpt-5',
      completePrompt: '立即发送一条简短测试消息'
    };

    const encrypted = encryptPayload(payload, userKey);
    const res = await makeRequest('POST', `${baseUrl}/api/v1/schedule-message`, {
      headers: {
        'X-Payload-Encrypted': 'true',
        'X-Encryption-Version': '1',
        'X-User-Id': config.userId
      },
      body: encrypted
    });

    results.push({
      test: 'POST /api/v1/schedule-message (instant AI)',
      passed: res.ok && res.data.success,
      status: res.status,
      messagesSent: res.data.data?.messagesSent,
      message: res.ok ? `发送 ${res.data.data?.messagesSent || 0} 条消息` : res.data.error?.message || '失败'
    });
  } catch (error) {
    results.push({
      test: 'POST /api/v1/schedule-message (instant AI)',
      passed: false,
      error: error.message
    });
  }

  // 测试 4: 查询任务列表
  try {
    const res = await makeRequest('GET', `${baseUrl}/api/v1/messages?status=pending&limit=100`, {
      headers: { 'X-User-Id': config.userId }
    });

    results.push({
      test: 'GET /api/v1/messages',
      passed: res.ok && res.data.success,
      status: res.status,
      taskCount: res.data.data?.tasks?.length || 0,
      message: res.ok ? `查询到 ${res.data.data?.tasks?.length || 0} 个任务` : '失败'
    });
  } catch (error) {
    results.push({
      test: 'GET /api/v1/messages',
      passed: false,
      error: error.message
    });
  }

  // 测试 5: 更新任务
  if (createdTasks.length > 0) {
    try {
      const updatePayload = {
        nextSendAt: new Date(Date.now() + 300000).toISOString()
      };

      const encrypted = encryptPayload(updatePayload, userKey);
      const res = await makeRequest('PUT', `${baseUrl}/api/v1/update-message?id=${createdTasks[0]}`, {
        headers: {
          'X-Payload-Encrypted': 'true',
          'X-Encryption-Version': '1',
          'X-User-Id': config.userId
        },
        body: encrypted
      });

      results.push({
        test: 'PUT /api/v1/update-message/:id',
        passed: res.ok && res.data.success,
        status: res.status,
        message: res.ok ? '成功' : res.data.error?.message || '失败'
      });
    } catch (error) {
      results.push({
        test: 'PUT /api/v1/update-message/:id',
        passed: false,
        error: error.message
      });
    }
  }

  // 测试 6: 触发通知（仅测试认证，不实际执行）
  try {
    const headers = {
      'Authorization': `Bearer ${config.cronSecret}`
    };
    if (config.vercelBypassKey) {
      headers['x-vercel-protection-bypass'] = config.vercelBypassKey;
    }

    const res = await makeRequest('POST', `${baseUrl}/api/v1/send-notifications`, {
      headers
    });

    results.push({
      test: 'POST /api/v1/send-notifications',
      passed: res.ok && res.data.success,
      status: res.status,
      message: res.ok
        ? `处理了 ${res.data.data?.totalTasks || 0} 个任务`
        : res.data.error?.message || '失败',
      errorCode: res.data.error?.code,
      errorDetails: res.data.error?.details
    });
  } catch (error) {
    results.push({
      test: 'POST /api/v1/send-notifications',
      passed: false,
      error: error.message
    });
  }

  // 清理: 删除创建的任务
  const cleanupResults = [];
  for (const taskUuid of createdTasks) {
    try {
      const res = await makeRequest('DELETE', `${baseUrl}/api/v1/cancel-message?id=${taskUuid}`, {
        headers: { 'X-User-Id': config.userId }
      });
      cleanupResults.push({
        uuid: taskUuid,
        success: res.ok && res.data.success
      });
    } catch (error) {
      cleanupResults.push({
        uuid: taskUuid,
        success: false,
        error: error.message
      });
    }
  }

  // 统计结果
  const passedCount = results.filter(r => r.passed).length;
  const totalCount = results.length;

  return {
    summary: {
      total: totalCount,
      passed: passedCount,
      failed: totalCount - passedCount,
      successRate: ((passedCount / totalCount) * 100).toFixed(1) + '%'
    },
    results,
    cleanup: {
      attempted: createdTasks.length,
      successful: cleanupResults.filter(r => r.success).length,
      details: cleanupResults
    },
    timestamp: new Date().toISOString()
  };
}

// ============ Vercel Function Handler ============
export default async function handler(req, res) {
  // CORS 处理
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method not allowed',
      message: '只支持 GET 请求'
    });
  }

  // 读取配置
  const config = {
    userId: getEnv('TEST_USER_ID', `test_user_${Date.now()}`),
    encryptionKey: getEnv('ENCRYPTION_KEY'),
    cronSecret: getEnv('CRON_SECRET'),
    vercelBypassKey: getEnv('VERCEL_PROTECTION_BYPASS', '')
  };

  // 验证必需配置
  if (!config.encryptionKey) {
    return res.status(500).json({
      error: 'Configuration error',
      message: '缺少 ENCRYPTION_KEY 环境变量'
    });
  }

  if (!config.cronSecret) {
    return res.status(500).json({
      error: 'Configuration error',
      message: '缺少 CRON_SECRET 环境变量'
    });
  }

  // 获取 API 基础 URL
  const baseUrl = getEnv('API_BASE_URL') || `https://${req.headers.host}`;

  try {
    const testResults = await runTests(baseUrl, config);
    return res.status(200).json(testResults);
  } catch (error) {
    return res.status(500).json({
      error: 'Test execution failed',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}

// ============ 本地运行支持 ============
if (require.main === module) {
  // 本地运行测试
  const config = {
    userId: getEnv('TEST_USER_ID', `test_user_${Date.now()}`),
    encryptionKey: getEnv('ENCRYPTION_KEY'),
    cronSecret: getEnv('CRON_SECRET'),
    vercelBypassKey: getEnv('VERCEL_PROTECTION_BYPASS', '')
  };

  if (!config.encryptionKey || !config.cronSecret) {
    console.error('❌ 错误: 缺少必需的环境变量');
    console.error('请设置: ENCRYPTION_KEY, CRON_SECRET, API_BASE_URL');
    process.exit(1);
  }

  const baseUrl = getEnv('API_BASE_URL', 'http://localhost:3000');

  console.log('============================');
  console.log('主动消息 API 测试');
  console.log('============================');
  console.log(`API 地址: ${baseUrl}`);
  console.log(`测试用户: ${config.userId}`);
  console.log('');

  runTests(baseUrl, config)
    .then(results => {
      console.log(JSON.stringify(results, null, 2));
      process.exit(results.summary.failed === 0 ? 0 : 1);
    })
    .catch(error => {
      console.error('测试失败:', error);
      process.exit(1);
    });
}
