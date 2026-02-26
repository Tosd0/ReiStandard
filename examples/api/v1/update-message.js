/**
 * PUT /api/v1/update-message?id={uuid}
 * 功能：更新已存在的定时任务（CommonJS，兼容 Vercel 与 Netlify）
 * ReiStandard v2.0.0-pre1
 */

const { deriveUserEncryptionKey, decryptPayload, encryptForStorage } = require('../../lib/encryption');
const { isValidISO8601, isValidUUIDv4 } = require('../../lib/validation');
const { resolveTenantFromRequest } = require('../../lib/tenant-context');
// const { sql } = require('@vercel/postgres');

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

async function core(url, headers, body) {
  const tenantResult = await resolveTenantFromRequest(headers, url);
  if (!tenantResult.ok) {
    return tenantResult.response;
  }

  const masterKey = tenantResult.tenant.masterKey;
  const h = normalizeHeaders(headers);
  const u = new URL(url, 'https://dummy');
  const taskUuid = u.searchParams.get('id');

  if (!taskUuid) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'TASK_ID_REQUIRED',
          message: '缺少任务ID'
        }
      }
    };
  }

  const userId = h['x-user-id'];

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

  // 解析请求体（可以是加密或非加密）
  const parsedBody = typeof body === 'string' ? JSON.parse(body) : body;
  let updates;

  // 如果是加密请求，先解密
  if (parsedBody.iv && parsedBody.authTag && parsedBody.encryptedData) {
    const userKey = deriveUserEncryptionKey(userId, masterKey);
    try {
      updates = decryptPayload(parsedBody, userKey);
    } catch (error) {
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
  } else {
    updates = parsedBody;
  }

  // 验证更新字段
  if (updates.nextSendAt && !isValidISO8601(updates.nextSendAt)) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'INVALID_UPDATE_DATA',
          message: '更新数据格式错误',
          details: { invalidFields: ['nextSendAt'] }
        }
      }
    };
  }
  
  if (updates.recurrenceType && !['none', 'daily', 'weekly'].includes(updates.recurrenceType)) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'INVALID_UPDATE_DATA',
          message: '更新数据格式错误',
          details: { invalidFields: ['recurrenceType'] }
        }
      }
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(updates, 'maxTokens') &&
    updates.maxTokens !== null &&
    (!Number.isInteger(updates.maxTokens) || updates.maxTokens <= 0)
  ) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'INVALID_UPDATE_DATA',
          message: '更新数据格式错误',
          details: { invalidFields: ['maxTokens'] }
        }
      }
    };
  }

  // 查询现有任务并解密（全字段加密版本）
  /*
  const existingTask = await sql`
    SELECT id, encrypted_payload, message_type, next_send_at, status
    FROM scheduled_messages
    WHERE uuid = ${taskUuid}
      AND user_id = ${userId}
      AND status = 'pending'
    LIMIT 1
  `;
  
  if (existingTask.length === 0) {
    // 检查任务是否存在
    const existing = await sql`
      SELECT status FROM scheduled_messages
      WHERE uuid = ${taskUuid} AND user_id = ${userId}
    `;

    if (existing.count === 0) {
      return {
        status: 404,
        body: {
          success: false,
          error: {
            code: 'TASK_NOT_FOUND',
            message: '指定的任务不存在或已被删除'
          }
        }
      };
    }

    // 任务存在但不是 pending 状态
    return {
      status: 409,
      body: {
        success: false,
        error: {
          code: 'TASK_ALREADY_COMPLETED',
          message: '任务已完成或已失败，无法更新'
        }
      }
    };
  }
  */
  
  // 模拟从数据库获取的任务（实际应从数据库查询）
  const existingTask = null; // 实际从数据库获取
  
  if (!existingTask) {
    // 模拟场景：任务不存在时的处理
    console.log('[update-message] Simulated: task not found or not pending');
  }

  // 解密现有payload并合并更新
  const userKey = deriveUserEncryptionKey(userId, masterKey);
  
  // 模拟解密现有数据（实际从existingTask.encrypted_payload解密）
  // const existingData = JSON.parse(decryptFromStorage(existingTask.encrypted_payload, userKey));
  
  // 模拟现有数据结构
  const existingData = {
    contactName: 'Example Contact',
    avatarUrl: null,
    messageType: 'fixed',
    messageSubtype: 'chat',
    userMessage: 'Example message',
    firstSendTime: '2024-01-01T00:00:00Z',
    recurrenceType: 'none',
    apiUrl: null,
    apiKey: null,
    primaryModel: null,
    completePrompt: null,
    maxTokens: null,
    pushSubscription: {},
    metadata: {}
  };

  // 合并更新
  const updatedData = {
    ...existingData,
    ...(updates.completePrompt && { completePrompt: updates.completePrompt }),
    ...(updates.userMessage && { userMessage: updates.userMessage }),
    ...(updates.recurrenceType && { recurrenceType: updates.recurrenceType }),
    ...(updates.avatarUrl && { avatarUrl: updates.avatarUrl }),
    ...(updates.metadata && { metadata: updates.metadata }),
    ...(Object.prototype.hasOwnProperty.call(updates, 'maxTokens') && { maxTokens: updates.maxTokens ?? null })
  };
  
  // 重新加密整个payload
  const encryptedPayload = encryptForStorage(JSON.stringify(updatedData), userKey);
  
  // 构建数据库更新字段
  const updateFields = {
    encrypted_payload: encryptedPayload,
    ...(updates.nextSendAt && { next_send_at: updates.nextSendAt })
  };

  // 更新数据库（全字段加密版本）
  /*
  const result = await sql`
    UPDATE scheduled_messages
    SET encrypted_payload = ${updateFields.encrypted_payload},
        ${updateFields.next_send_at ? sql`next_send_at = ${updateFields.next_send_at},` : sql``}
        updated_at = NOW()
    WHERE uuid = ${taskUuid}
      AND user_id = ${userId}
      AND status = 'pending'
    RETURNING uuid, updated_at
  `;
  */

  console.log('[update-message] Task updated:', {
    taskUuid,
    updatedFields: Object.keys(updateFields)
  });

  // 模拟成功响应
  return {
    status: 200,
    body: {
      success: true,
      data: {
        uuid: taskUuid,
        updatedFields: Object.keys(updateFields),
        updatedAt: new Date().toISOString()
      }
    }
  };
}

// Node.js handler (Vercel)
module.exports = async function(req, res) {
  try {
    if (req.method !== 'PUT') return sendNodeJson(res, 405, { error: 'Method not allowed' });

    let body = '';
    for await (const chunk of req) {
      body += chunk.toString();
    }

    const result = await core(req.url, req.headers, body);
    return sendNodeJson(res, result.status, result.body);
  } catch (error) {
    console.error('[update-message] Error:', error);

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
    if (event.httpMethod !== 'PUT') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }

    const url = event.rawUrl || `https://dummy${event.path}${event.rawQuery ? '?' + event.rawQuery : ''}`;
    const result = await core(url, event.headers || {}, event.body);
    return {
      statusCode: result.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(result.body)
    };
  } catch (error) {
    console.error('[update-message] Error:', error);
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
