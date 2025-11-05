#!/usr/bin/env node

/**
 * 主动消息 API 综合测试脚本
 *
 * 功能：
 * 1. 测试所有端点（schedule-message, send-notifications, update-message, cancel-message, messages）
 * 2. 测试加密/解密流程
 * 3. 测试各种消息类型（fixed, prompted, auto, instant）
 * 4. 自动清理测试数据
 *
 * 使用方法：
 *   node test-active-messaging-api.js
 *
 * 环境变量配置（.env 或直接修改下方配置）：
 *   API_BASE_URL - API 基础 URL
 *   CRON_SECRET - Cron Job 密钥
 *   ENCRYPTION_KEY - 加密主密钥
 *   TEST_USER_ID - 测试用户 ID（可选，默认自动生成）
 */

const crypto = require('crypto');

// ============ 工具函数 - 日志输出 ============

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logSuccess(message) {
  log(`✅ ${message}`, colors.green);
}

function logError(message) {
  log(`❌ ${message}`, colors.red);
}

function logInfo(message) {
  log(`ℹ️  ${message}`, colors.blue);
}

function logWarning(message) {
  log(`⚠️  ${message}`, colors.yellow);
}

function logSection(title) {
  log(`\n${'='.repeat(60)}`, colors.cyan);
  log(title, colors.cyan);
  log('='.repeat(60), colors.cyan);
}

// ============ 配置验证 ============
function getRequiredEnv(key, description) {
  const value = process.env[key];
  if (!value) {
    logError(`缺少必需的环境变量: ${key}`);
    logInfo(`说明: ${description}`);
    logInfo(`\n请设置环境变量后重新运行:`);
    logInfo(`  export ${key}="your_value_here"`);
    logInfo(`\n或创建 .env.test 文件并使用:`);
    logInfo(`  export $(cat .env.test | xargs) && node test-active-messaging-api.js`);
    process.exit(1);
  }
  return value;
}

function getOptionalEnv(key, defaultValue = null) {
  return process.env[key] || defaultValue;
}

// ============ 配置区 ============

// 验证加密密钥格式
function validateEncryptionKey(key) {
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    logError('ENCRYPTION_KEY 格式错误');
    logInfo('必须是 64 位十六进制字符串（32 字节）');
    logInfo('使用以下命令生成: openssl rand -hex 32');
    logInfo(`当前值长度: ${key.length} 字符`);
    process.exit(1);
  }
  return key;
}

const CONFIG = {
  // API 配置（必需）
  apiBaseUrl: getRequiredEnv('API_BASE_URL', 'API 服务器地址，例如: https://your-domain.com 或 http://localhost:3000'),
  cronSecret: getRequiredEnv('CRON_SECRET', 'Cron Job 认证密钥，用于触发 /send-notifications 端点'),
  encryptionKey: validateEncryptionKey(getRequiredEnv('ENCRYPTION_KEY', '64位十六进制加密主密钥，使用 openssl rand -hex 32 生成')),

  // 测试用户配置（可选，默认自动生成）
  testUserId: getOptionalEnv('TEST_USER_ID', `test_user_${Date.now()}`),

  // Vercel 配置（可选）
  vercelBypassKey: getOptionalEnv('VERCEL_PROTECTION_BYPASS', ''),

  // 测试用 AI API 配置（可选，但 prompted/auto 测试需要）
  testApiUrl: getOptionalEnv('TEST_API_URL', 'https://api.openai.com/v1/chat/completions'),
  testApiKey: getOptionalEnv('TEST_API_KEY', 'sk-test-key-placeholder'),
  testModel: getOptionalEnv('TEST_MODEL', 'gpt-5'),

  // 测试用推送订阅（模拟数据）
  testPushSubscription: {
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint',
    expirationTime: null,
    keys: {
      p256dh: 'BEl2...test...kR4=',
      auth: 'k8J...test...3Q='
    }
  }
};

// ============ 工具函数 - 加密相关 ============

// 派生用户专属密钥
function deriveUserEncryptionKey(userId, masterKey) {
  return crypto
    .createHash('sha256')
    .update(masterKey + userId)
    .digest('hex')
    .slice(0, 64);
}

// 加密请求体
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

// HTTP 请求封装
async function makeRequest(method, endpoint, options = {}) {
  const url = `${CONFIG.apiBaseUrl}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };

  const requestOptions = {
    method,
    headers,
  };

  if (options.body) {
    requestOptions.body = JSON.stringify(options.body);
  }

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
      error: error.message
    };
  }
}

// ============ 测试函数 ============

// 存储创建的任务ID，用于后续清理
const createdTasks = [];
let userEncryptionKey = null;

// 1. 测试获取主密钥
async function testGetMasterKey() {
  logSection('测试 1: GET /api/v1/get-master-key');

  logInfo('发送请求...');
  const response = await makeRequest('GET', '/api/v1/get-master-key', {
    headers: {
      'X-User-Id': CONFIG.testUserId
    }
  });

  if (response.ok && response.data.success) {
    logSuccess(`成功获取主密钥 (version: ${response.data.data.version})`);

    // 派生用户专属密钥
    userEncryptionKey = deriveUserEncryptionKey(
      CONFIG.testUserId,
      response.data.data.masterKey
    );
    logInfo(`用户专属密钥已派生: ${userEncryptionKey.slice(0, 16)}...`);

    return true;
  } else {
    logError(`获取主密钥失败: ${response.status} - ${JSON.stringify(response.data)}`);
    // 使用配置的密钥作为后备
    userEncryptionKey = deriveUserEncryptionKey(CONFIG.testUserId, CONFIG.encryptionKey);
    logWarning(`使用配置的密钥作为后备`);
    return false;
  }
}

// 2. 测试创建固定消息任务
async function testCreateFixedMessage() {
  logSection('测试 2: POST /api/v1/schedule-message (fixed 类型)');

  const nextSendTime = new Date(Date.now() + 60 * 1000).toISOString(); // 1分钟后

  const plainPayload = {
    contactName: 'ReiTest',
    messageType: 'fixed',
    userMessage: '这是一条测试消息！',
    firstSendTime: nextSendTime,
    recurrenceType: 'none',
    pushSubscription: CONFIG.testPushSubscription,
    avatarUrl: 'https://example.com/avatar.png',
    metadata: { test: true }
  };

  logInfo('加密请求体...');
  const encryptedPayload = encryptPayload(plainPayload, userEncryptionKey);

  logInfo('发送请求...');
  const response = await makeRequest('POST', '/api/v1/schedule-message', {
    headers: {
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1',
      'X-User-Id': CONFIG.testUserId
    },
    body: encryptedPayload
  });

  if (response.ok && response.data.success) {
    logSuccess(`任务创建成功！任务ID: ${response.data.data.id}`);
    logInfo(`UUID: ${response.data.data.uuid}`);
    logInfo(`下次发送时间: ${response.data.data.nextSendAt}`);
    createdTasks.push({ id: response.data.data.id, uuid: response.data.data.uuid });
    return true;
  } else {
    logError(`创建失败: ${response.status} - ${JSON.stringify(response.data)}`);
    return false;
  }
}

// 3. 测试创建 prompted 消息任务
async function testCreatePromptedMessage() {
  logSection('测试 3: POST /api/v1/schedule-message (prompted 类型)');

  const nextSendTime = new Date(Date.now() + 120 * 1000).toISOString(); // 2分钟后

  const plainPayload = {
    contactName: 'ReiTest',
    messageType: 'prompted',
    firstSendTime: nextSendTime,
    recurrenceType: 'none',
    pushSubscription: CONFIG.testPushSubscription,
    apiUrl: CONFIG.testApiUrl,
    apiKey: CONFIG.testApiKey,
    primaryModel: CONFIG.testModel,
    completePrompt: '【角色】你是ReiTest，一个测试机器人。\n【用户提示】发送一条简短的测试消息\n【任务】根据用户提示发送消息',
    avatarUrl: 'https://example.com/avatar.png'
  };

  logInfo('加密请求体...');
  const encryptedPayload = encryptPayload(plainPayload, userEncryptionKey);

  logInfo('发送请求...');
  const response = await makeRequest('POST', '/api/v1/schedule-message', {
    headers: {
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1',
      'X-User-Id': CONFIG.testUserId
    },
    body: encryptedPayload
  });

  if (response.ok && response.data.success) {
    logSuccess(`任务创建成功！任务ID: ${response.data.data.id}`);
    logInfo(`UUID: ${response.data.data.uuid}`);
    createdTasks.push({ id: response.data.data.id, uuid: response.data.data.uuid });
    return true;
  } else {
    logError(`创建失败: ${response.status} - ${JSON.stringify(response.data)}`);
    return false;
  }
}

// 4. 测试创建 auto 消息任务
async function testCreateAutoMessage() {
  logSection('测试 4: POST /api/v1/schedule-message (auto 类型)');

  const nextSendTime = new Date(Date.now() + 180 * 1000).toISOString(); // 3分钟后

  const plainPayload = {
    contactName: 'ReiTest',
    messageType: 'auto',
    firstSendTime: nextSendTime,
    recurrenceType: 'daily',
    pushSubscription: CONFIG.testPushSubscription,
    apiUrl: CONFIG.testApiUrl,
    apiKey: CONFIG.testApiKey,
    primaryModel: CONFIG.testModel,
    completePrompt: '【角色】你是ReiTest，一个测试机器人。\n【历史对话】无\n【当前时间】' + new Date().toISOString() + '\n【任务】根据当前时间自主生成消息',
    messageSubtype: 'chat'
  };

  logInfo('加密请求体...');
  const encryptedPayload = encryptPayload(plainPayload, userEncryptionKey);

  logInfo('发送请求...');
  const response = await makeRequest('POST', '/api/v1/schedule-message', {
    headers: {
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1',
      'X-User-Id': CONFIG.testUserId
    },
    body: encryptedPayload
  });

  if (response.ok && response.data.success) {
    logSuccess(`任务创建成功！任务ID: ${response.data.data.id}`);
    logInfo(`UUID: ${response.data.data.uuid}`);
    createdTasks.push({ id: response.data.data.id, uuid: response.data.data.uuid });
    return true;
  } else {
    logError(`创建失败: ${response.status} - ${JSON.stringify(response.data)}`);
    return false;
  }
}

// 4.5 测试创建 instant 消息（固定内容）
async function testCreateInstantFixedMessage() {
  logSection('测试 4.5: POST /api/v1/schedule-message (instant 固定类型)');

  const plainPayload = {
    contactName: 'InstantRei',
    messageType: 'instant',
    userMessage: '这是一条即时测试消息！',
    firstSendTime: new Date().toISOString(),
    recurrenceType: 'none',
    pushSubscription: CONFIG.testPushSubscription,
    avatarUrl: 'https://example.com/instant-avatar.png',
    metadata: { testType: 'instant-fixed' }
  };

  logInfo('加密请求体...');
  const encryptedPayload = encryptPayload(plainPayload, userEncryptionKey);

  logInfo('发送请求（期望立即发送）...');
  const response = await makeRequest('POST', '/api/v1/schedule-message', {
    headers: {
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1',
      'X-User-Id': CONFIG.testUserId
    },
    body: encryptedPayload
  });

  if (response.ok && response.data.success) {
    logSuccess(`即时消息发送成功！`);
    logInfo(`UUID: ${response.data.data.uuid}`);
    logInfo(`消息数: ${response.data.data.messagesSent}`);
    logInfo(`状态: ${response.data.data.status}`);
    logInfo(`发送时间: ${response.data.data.sentAt}`);
    // instant 消息发送后立即删除，不加入 createdTasks
    return true;
  } else {
    logError(`发送失败: ${response.status} - ${JSON.stringify(response.data)}`);
    return false;
  }
}

// 4.6 测试创建 instant 消息（AI 生成）
async function testCreateInstantAiMessage() {
  logSection('测试 4.6: POST /api/v1/schedule-message (instant AI 类型)');

  const plainPayload = {
    contactName: 'InstantRei',
    messageType: 'instant',
    firstSendTime: new Date().toISOString(),
    recurrenceType: 'none',
    pushSubscription: CONFIG.testPushSubscription,
    apiUrl: CONFIG.testApiUrl,
    apiKey: CONFIG.testApiKey,
    primaryModel: CONFIG.testModel,
    completePrompt: '【角色】你是InstantRei，一个即时响应机器人。\n【任务】立即发送一条简短的测试消息（不超过20字）',
    avatarUrl: 'https://example.com/instant-avatar.png',
    metadata: { testType: 'instant-ai' }
  };

  logInfo('加密请求体...');
  const encryptedPayload = encryptPayload(plainPayload, userEncryptionKey);

  logInfo('发送请求（期望立即调用 AI 并发送）...');
  const response = await makeRequest('POST', '/api/v1/schedule-message', {
    headers: {
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1',
      'X-User-Id': CONFIG.testUserId
    },
    body: encryptedPayload
  });

  if (response.ok && response.data.success) {
    logSuccess(`即时 AI 消息发送成功！`);
    logInfo(`UUID: ${response.data.data.uuid}`);
    logInfo(`消息数: ${response.data.data.messagesSent}`);
    logInfo(`状态: ${response.data.data.status}`);
    logInfo(`发送时间: ${response.data.data.sentAt}`);
    // instant 消息发送后立即删除，不加入 createdTasks
    return true;
  } else {
    logError(`发送失败: ${response.status} - ${JSON.stringify(response.data)}`);
    return false;
  }
}

// 5. 测试查询任务列表
async function testGetMessages() {
  logSection('测试 5: GET /api/v1/messages');

  logInfo('查询所有待处理任务...');
  const response = await makeRequest('GET', '/api/v1/messages?status=pending&limit=100', {
    headers: {
      'X-User-Id': CONFIG.testUserId
    }
  });

  if (response.ok && response.data.success) {
    const taskCount = response.data.data.tasks.length;
    logSuccess(`成功查询到 ${taskCount} 个任务`);

    if (taskCount > 0) {
      logInfo('任务列表:');
      response.data.data.tasks.forEach(task => {
        console.log(`  - ID: ${task.id}, 角色: ${task.contactName}, 类型: ${task.messageType}, 状态: ${task.status}`);
      });
    }

    return true;
  } else {
    logError(`查询失败: ${response.status} - ${JSON.stringify(response.data)}`);
    return false;
  }
}

// 6. 测试更新任务
async function testUpdateMessage() {
  logSection('测试 6: PUT /api/v1/update-message/:id');

  if (createdTasks.length === 0) {
    logWarning('没有可更新的任务，跳过此测试');
    return false;
  }

  const taskToUpdate = createdTasks[0];
  const newSendTime = new Date(Date.now() + 300 * 1000).toISOString(); // 5分钟后

  const plainPayload = {
    nextSendAt: newSendTime,
    userMessage: '更新后的消息内容'
  };

  logInfo(`更新任务 ${taskToUpdate.uuid}...`);
  logInfo('加密请求体...');
  const encryptedPayload = encryptPayload(plainPayload, userEncryptionKey);

  const response = await makeRequest('PUT', `/api/v1/update-message?id=${taskToUpdate.uuid}`, {
    headers: {
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1',
      'X-User-Id': CONFIG.testUserId
    },
    body: encryptedPayload
  });

  if (response.ok && response.data.success) {
    logSuccess(`任务更新成功！`);
    logInfo(`更新的字段: ${response.data.data.updatedFields.join(', ')}`);
    return true;
  } else {
    logError(`更新失败: ${response.status} - ${JSON.stringify(response.data)}`);
    return false;
  }
}

// 7. 测试触发通知发送（Cron）
async function testSendNotifications() {
  logSection('测试 7: POST /api/v1/send-notifications (Cron)');

  logInfo('触发通知发送...');
  const headers = {
    'Authorization': `Bearer ${CONFIG.cronSecret}`
  };

  if (CONFIG.vercelBypassKey) {
    headers['x-vercel-protection-bypass'] = CONFIG.vercelBypassKey;
  }

  const response = await makeRequest('POST', '/api/v1/send-notifications', {
    headers
  });

  if (response.ok && response.data.success) {
    logSuccess('通知发送成功！');
    logInfo(`处理任务数: ${response.data.data.totalTasks}`);
    logInfo(`成功: ${response.data.data.successCount}, 失败: ${response.data.data.failedCount}`);

    if (response.data.data.details) {
      const details = response.data.data.details;
      if (details.deletedOnceOffTasks) {
        logInfo(`删除一次性任务: ${details.deletedOnceOffTasks}`);
      }
      if (details.updatedRecurringTasks) {
        logInfo(`更新循环任务: ${details.updatedRecurringTasks}`);
      }
      if (details.failedTasks && details.failedTasks.length > 0) {
        logWarning(`失败任务详情:`);
        details.failedTasks.forEach(task => {
          console.log(`  - 任务 ${task.taskId}: ${task.reason}`);
        });
      }
    }

    return true;
  } else {
    logError(`发送失败: ${response.status}`);
    logError(`错误码: ${response.data.error?.code || 'UNKNOWN'}`);
    logError(`错误信息: ${response.data.error?.message || '未知错误'}`);

    if (response.data.error?.details) {
      logInfo(`错误详情: ${JSON.stringify(response.data.error.details, null, 2)}`);
    }

    return false;
  }
}

// 8. 测试参数验证（错误场景）
async function testValidationErrors() {
  logSection('测试 8: 参数验证（错误场景）');

  let passedTests = 0;
  let totalTests = 0;

  // 测试 8.1: 缺少加密头部
  totalTests++;
  logInfo('测试 8.1: 缺少加密头部...');
  const response1 = await makeRequest('POST', '/api/v1/schedule-message', {
    headers: {
      'X-User-Id': CONFIG.testUserId
    },
    body: { test: 'data' }
  });

  if (!response1.ok && response1.data.error?.code === 'ENCRYPTION_REQUIRED') {
    logSuccess('✓ 正确返回 ENCRYPTION_REQUIRED 错误');
    passedTests++;
  } else {
    logError('✗ 未正确验证加密要求');
  }

  // 测试 8.2: 缺少 User ID
  totalTests++;
  logInfo('测试 8.2: 缺少 User ID...');
  const response2 = await makeRequest('POST', '/api/v1/schedule-message', {
    headers: {
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1'
    },
    body: encryptPayload({ test: 'data' }, userEncryptionKey)
  });

  if (!response2.ok && response2.data.error?.code === 'USER_ID_REQUIRED') {
    logSuccess('✓ 正确返回 USER_ID_REQUIRED 错误');
    passedTests++;
  } else {
    logError('✗ 未正确验证 User ID');
  }

  // 测试 8.3: 无效的消息类型
  totalTests++;
  logInfo('测试 8.3: 无效的消息类型...');
  const invalidPayload = {
    contactName: 'Test',
    messageType: 'invalid_type',
    firstSendTime: new Date(Date.now() + 60000).toISOString(),
    pushSubscription: CONFIG.testPushSubscription
  };

  const response3 = await makeRequest('POST', '/api/v1/schedule-message', {
    headers: {
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1',
      'X-User-Id': CONFIG.testUserId
    },
    body: encryptPayload(invalidPayload, userEncryptionKey)
  });

  if (!response3.ok && response3.data.error?.code === 'INVALID_MESSAGE_TYPE') {
    logSuccess('✓ 正确返回 INVALID_MESSAGE_TYPE 错误');
    passedTests++;
  } else {
    logError('✗ 未正确验证消息类型');
  }

  // 测试 8.4: 过去的时间
  totalTests++;
  logInfo('测试 8.4: 过去的时间...');
  const pastTimePayload = {
    contactName: 'Test',
    messageType: 'fixed',
    userMessage: 'Test',
    firstSendTime: new Date(Date.now() - 60000).toISOString(), // 1分钟前
    pushSubscription: CONFIG.testPushSubscription
  };

  const response4 = await makeRequest('POST', '/api/v1/schedule-message', {
    headers: {
      'X-Payload-Encrypted': 'true',
      'X-Encryption-Version': '1',
      'X-User-Id': CONFIG.testUserId
    },
    body: encryptPayload(pastTimePayload, userEncryptionKey)
  });

  if (!response4.ok && response4.data.error?.code === 'INVALID_TIMESTAMP') {
    logSuccess('✓ 正确返回 INVALID_TIMESTAMP 错误');
    passedTests++;
  } else {
    logError('✗ 未正确验证时间');
  }

  logInfo(`\n验证测试通过: ${passedTests}/${totalTests}`);
  return passedTests === totalTests;
}

// 9. 清理测试数据
async function cleanupTestData() {
  logSection('测试 9: 清理测试数据');

  if (createdTasks.length === 0) {
    logInfo('没有需要清理的任务');
    return true;
  }

  logInfo(`准备删除 ${createdTasks.length} 个测试任务...`);

  let successCount = 0;

  for (const task of createdTasks) {
    logInfo(`删除任务 ${task.uuid}...`);
    const response = await makeRequest('DELETE', `/api/v1/cancel-message?id=${task.uuid}`, {
      headers: {
        'X-User-Id': CONFIG.testUserId
      }
    });

    if (response.ok && response.data.success) {
      logSuccess(`✓ 任务 ${task.uuid} 已删除`);
      successCount++;
    } else {
      logError(`✗ 删除任务 ${task.uuid} 失败: ${JSON.stringify(response.data)}`);
    }
  }

  logInfo(`清理完成: ${successCount}/${createdTasks.length} 个任务已删除`);
  return successCount === createdTasks.length;
}

// ============ 主测试流程 ============

async function runAllTests() {
  logSection('主动消息 API 综合测试');
  logInfo(`API 地址: ${CONFIG.apiBaseUrl}`);
  logInfo(`测试用户 ID: ${CONFIG.testUserId}`);
  logInfo(`开始时间: ${new Date().toLocaleString()}`);

  const results = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0
  };

  const tests = [
    { name: '获取主密钥', fn: testGetMasterKey, critical: true },
    { name: '创建固定消息', fn: testCreateFixedMessage, critical: false },
    { name: '创建 prompted 消息', fn: testCreatePromptedMessage, critical: false },
    { name: '创建 auto 消息', fn: testCreateAutoMessage, critical: false },
    { name: '创建 instant 固定消息', fn: testCreateInstantFixedMessage, critical: false },
    { name: '创建 instant AI 消息', fn: testCreateInstantAiMessage, critical: false },
    { name: '查询任务列表', fn: testGetMessages, critical: false },
    { name: '更新任务', fn: testUpdateMessage, critical: false },
    { name: '触发通知发送', fn: testSendNotifications, critical: false },
    { name: '参数验证测试', fn: testValidationErrors, critical: false },
  ];

  // 执行测试
  for (const test of tests) {
    results.total++;
    try {
      const passed = await test.fn();
      if (passed) {
        results.passed++;
      } else {
        results.failed++;
        if (test.critical) {
          logError(`关键测试失败，终止后续测试`);
          break;
        }
      }
    } catch (error) {
      logError(`测试执行出错: ${error.message}`);
      results.failed++;
      if (test.critical) {
        logError(`关键测试失败，终止后续测试`);
        break;
      }
    }

    // 等待一下，避免请求过快
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // 清理测试数据
  logInfo('\n等待 2 秒后开始清理...');
  await new Promise(resolve => setTimeout(resolve, 2000));
  await cleanupTestData();

  // 输出测试报告
  logSection('测试报告');
  log(`总计: ${results.total} 个测试`, colors.cyan);
  log(`通过: ${results.passed} 个`, colors.green);
  log(`失败: ${results.failed} 个`, colors.red);
  log(`成功率: ${((results.passed / results.total) * 100).toFixed(1)}%`, colors.cyan);
  log(`\n结束时间: ${new Date().toLocaleString()}`, colors.cyan);

  // 退出码
  process.exit(results.failed === 0 ? 0 : 1);
}

// ============ 入口 ============

// 检查 Node.js 版本（需要 18+ 支持原生 fetch）
const nodeVersion = parseInt(process.version.slice(1).split('.')[0]);
if (nodeVersion < 18) {
  logError('此脚本需要 Node.js 18 或更高版本（支持原生 fetch API）');
  logInfo(`当前版本: ${process.version}`);
  process.exit(1);
}

// 运行测试
runAllTests().catch(error => {
  logError(`测试执行失败: ${error.message}`);
  console.error(error);
  process.exit(1);
});
