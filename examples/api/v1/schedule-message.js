/**
 * POST /api/v1/schedule-message
 * 功能：创建定时消息任务（CommonJS，兼容 Vercel 与 Netlify）
 * ReiStandard v2.0.1
 *
 * ⚠️ OUTDATED — predates messages array support.
 *
 * 这份手动接入示例**不接受** v2.2.0+ 的 `messages` 字段（OpenAI 格式
 * 数组），也不会把它写进加密 payload。新接入请直接用
 * `@rei-standard/amsg-server@2.2.0+` 的 `createReiServer().handlers
 * .scheduleMessage`，那里完整实现了 messages 数组互斥校验、
 * `temperature` 透传与持久化。
 */

const webpush = require('web-push');
const { deriveUserEncryptionKey, decryptPayload, encryptForStorage } = require('../../lib/encryption');
const { validateScheduleMessagePayload, isValidUUIDv4 } = require('../../lib/validation');
const { resolveTenantFromRequest } = require('../../lib/tenant-context');
const { getVapidConfig, getMissingVapidKeys, normalizeVapidSubject } = require('../../lib/runtime-config');
const { randomUUID } = require('crypto');
// const { sql } = require('@vercel/postgres');

// 🔧 初始化 VAPID（instant 消息路径需要）
const vapidConfig = getVapidConfig();
const VAPID_EMAIL = vapidConfig.email;
const VAPID_PUBLIC_KEY = vapidConfig.publicKey;
const VAPID_PRIVATE_KEY = vapidConfig.privateKey;
const vapidMissingKeys = getMissingVapidKeys(vapidConfig);

if (vapidMissingKeys.length === 0) {
  webpush.setVapidDetails(
    normalizeVapidSubject(VAPID_EMAIL),
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
  console.log('[schedule-message] VAPID configured for instant messages');
} else {
  console.error('[schedule-message] VAPID configuration error:', {
    hasEmail: !!VAPID_EMAIL,
    hasPublicKey: !!VAPID_PUBLIC_KEY,
    hasPrivateKey: !!VAPID_PRIVATE_KEY
  });
}

function normalizeHeaders(h) {
  const out = {};
  for (const k in h || {}) out[k.toLowerCase()] = h[k];
  return out;
}

function sendNodeJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function core(headers, body) {
  const tenantResult = await resolveTenantFromRequest(headers);
  if (!tenantResult.ok) {
    return tenantResult.response;
  }

  const masterKey = tenantResult.tenant.masterKey;
  const h = normalizeHeaders(headers);

  // 1. 验证加密头部
  const isEncrypted = h['x-payload-encrypted'] === 'true';
  const encryptionVersion = h['x-encryption-version'];
  const userId = h['x-user-id'];

  if (!isEncrypted) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'ENCRYPTION_REQUIRED',
          message: '请求体必须加密'
        }
      }
    };
  }

  if (!userId) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'USER_ID_REQUIRED',
          message: '缺少用户标识符'
        }
      }
    };
  }

  if (!isValidUUIDv4(userId)) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'INVALID_USER_ID_FORMAT',
          message: 'X-User-Id 必须是 UUID v4 格式'
        }
      }
    };
  }

  if (encryptionVersion !== '1') {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'UNSUPPORTED_ENCRYPTION_VERSION',
          message: '加密版本不支持'
        }
      }
    };
  }

  // 2. 解密请求体
  let payload;
  try {
    const encryptedBody = typeof body === 'string' ? JSON.parse(body) : body;

    // 验证加密数据格式
    if (!encryptedBody.iv || !encryptedBody.authTag || !encryptedBody.encryptedData) {
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: 'INVALID_ENCRYPTED_PAYLOAD',
            message: '加密数据格式错误'
          }
        }
      };
    }

    // 派生用户专属密钥并解密
    const userKey = deriveUserEncryptionKey(userId, masterKey);
    payload = decryptPayload(encryptedBody, userKey);

  } catch (error) {
    if (error.message.includes('auth') || error.message.includes('Unsupported state')) {
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: 'DECRYPTION_FAILED',
            message: '请求体解密失败'
          }
        }
      };
    }

    if (error instanceof SyntaxError) {
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: 'INVALID_PAYLOAD_FORMAT',
            message: '解密后的数据不是有效 JSON'
          }
        }
      };
    }

    throw error;
  }

  // 4. 验证业务参数
  const validationResult = validateScheduleMessagePayload(payload);
  if (!validationResult.valid) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: validationResult.errorCode,
          message: validationResult.errorMessage,
          details: validationResult.details
        }
      }
    };
  }

  // 5. 生成 UUID（如果未提供）
  const taskUuid = payload.uuid || randomUUID();
  
  // 6. 加密整个 payload 用于数据库存储（全字段加密）
  const userKey = deriveUserEncryptionKey(userId, masterKey);
  
  // 创建要存储的完整数据对象
  const fullTaskData = {
    contactName: payload.contactName,
    avatarUrl: payload.avatarUrl || null,
    messageType: payload.messageType,
    messageSubtype: payload.messageSubtype || 'chat',
    userMessage: payload.userMessage || null,
    firstSendTime: payload.firstSendTime,
    recurrenceType: payload.recurrenceType || 'none',
    apiUrl: payload.apiUrl || null,
    apiKey: payload.apiKey || null,
    primaryModel: payload.primaryModel || null,
    completePrompt: payload.completePrompt || null,
    maxTokens: payload.maxTokens ?? null,
    pushSubscription: payload.pushSubscription,
    metadata: payload.metadata || {}
  };
  
  // 将整个数据对象加密成一个字符串
  const encryptedPayload = encryptForStorage(JSON.stringify(fullTaskData), userKey);

  // 7. 插入数据库（全字段加密存储）
  /*
  const result = await sql`
    INSERT INTO scheduled_messages (
      user_id,
      uuid,
      encrypted_payload,
      next_send_at,
      message_type,
      status,
      retry_count,
      created_at,
      updated_at
    ) VALUES (
      ${userId},
      ${taskUuid},
      ${encryptedPayload},
      ${payload.firstSendTime},
      ${payload.messageType},
      'pending',
      0,
      NOW(),
      NOW()
    )
    RETURNING id, uuid, next_send_at, status, created_at
  `;
  */

  // 模拟数据库响应（实际项目中替换为真实数据库调用）
  // 注意：实际使用时，从数据库返回的只有加密数据，需要解密后才能显示
  const mockResult = {
    id: 12345,
    uuid: taskUuid,
    next_send_at: payload.firstSendTime,
    status: 'pending',
    created_at: new Date().toISOString()
  };

  console.log('[schedule-message] New task created:', {
    taskId: mockResult.id,
    contactName: payload.contactName,  // 从原始payload获取，因为数据库中已加密
    nextSendAt: mockResult.next_send_at,
    messageType: payload.messageType
  });

  // 8. instant 类型：立即触发 send-notifications 处理
  if (payload.messageType === 'instant') {
    // 验证 VAPID 配置（instant 消息需要立即发送）
    if (vapidMissingKeys.length > 0) {
      return {
        status: 500,
        body: {
          success: false,
          error: {
            code: 'VAPID_CONFIG_ERROR',
            message: 'VAPID 配置缺失，无法发送即时消息',
            details: {
              missingKeys: vapidMissingKeys
            }
          }
        }
      };
    }

    // 导入 message-processor 的核心处理函数（避免循环依赖）
    const { processMessagesByUuid } = require('../../lib/message-processor');

    try {
      // 立即处理这条消息（带重试机制）
      const sendResult = await processMessagesByUuid(taskUuid, 2, masterKey); // 最多重试2次
      
      if (!sendResult.success) {
        // 发送失败，更新数据库任务状态为失败（如果数据库可用）
        /*
        await sql`
          UPDATE scheduled_messages
          SET status = 'failed',
              failure_reason = ${JSON.stringify(sendResult.error)},
              updated_at = NOW()
          WHERE uuid = ${taskUuid}
        `;
        */
        
        console.error('[schedule-message] Instant message failed:', {
          uuid: taskUuid,
          error: sendResult.error,
          retriesAttempted: sendResult.error.retriesAttempted || 0
        });

        return {
          status: 500,
          body: {
            success: false,
            error: {
              code: 'MESSAGE_SEND_FAILED',
              message: '消息发送失败',
              details: sendResult.error
            }
          }
        };
      }

      console.log('[schedule-message] Instant message sent:', {
        uuid: taskUuid,
        contactName: payload.contactName,
        messagesSent: sendResult.messagesSent,
        retriesUsed: sendResult.retriesUsed || 0
      });

      // 返回 instant 类型的成功响应
      return {
        status: 200,
        body: {
          success: true,
          data: {
            uuid: taskUuid,
            contactName: payload.contactName,
            messagesSent: sendResult.messagesSent,
            sentAt: new Date().toISOString(),
            status: 'sent',
            retriesUsed: sendResult.retriesUsed || 0
          }
        }
      };
    } catch (error) {
      console.error('[schedule-message] Instant message error:', error);
      return {
        status: 500,
        body: {
          success: false,
          error: {
            code: 'MESSAGE_SEND_FAILED',
            message: '消息发送失败',
            details: { error: error.message }
          }
        }
      };
    }
  }

  // 9. 返回普通类型的成功响应（敏感信息已加密存储）
  return {
    status: 201,
    body: {
      success: true,
      data: {
        id: mockResult.id,
        uuid: mockResult.uuid,
        contactName: payload.contactName,  // 从原始payload返回，数据库中已加密
        nextSendAt: mockResult.next_send_at,
        status: mockResult.status,
        createdAt: mockResult.created_at
      }
    }
  };
}

// Node.js handler (Vercel)
module.exports = async function(req, res) {
  try {
    if (req.method !== 'POST') return sendNodeJson(res, 405, { error: 'Method not allowed' });

    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }

    const result = await core(req.headers, body);
    return sendNodeJson(res, result.status, result.body);
  } catch (error) {
    console.error('[schedule-message] Error:', error);
    return sendNodeJson(res, 500, {
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '服务器内部错误，请稍后重试'
      }
    });
  }
};

// Netlify handler
exports.handler = async function(event) {
  try {
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }

    const result = await core(event.headers || {}, event.body);
    return {
      statusCode: result.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(result.body)
    };
  } catch (error) {
    console.error('[schedule-message] Error:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: '服务器内部错误，请稍后重试'
        }
      })
    };
  }
};
