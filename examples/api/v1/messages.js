/**
 * GET /api/v1/messages
 * 功能：查询用户的定时任务列表
 * ReiStandard v1.2.1
 */

// const { sql } = require('@vercel/postgres');
const { deriveUserEncryptionKey, decryptFromStorage } = require('../../lib/encryption');
const { getMasterKeyFromDb } = require('../../lib/master-key-store');
const { isValidUUIDv4 } = require('../../lib/validation');

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

async function core(url, headers) {
  const h = normalizeHeaders(headers);
  const userId = h['x-user-id'];

  if (!userId) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'USER_ID_REQUIRED',
          message: '必须提供 X-User-Id 请求头'
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

  const masterKey = await getMasterKeyFromDb();
  if (!masterKey) {
    return {
      status: 503,
      body: {
        success: false,
        error: {
          code: 'MASTER_KEY_NOT_INITIALIZED',
          message: '系统密钥尚未初始化，请先调用 /api/v1/init-master-key'
        }
      }
    };
  }

  // 解析查询参数
  const u = new URL(url, 'https://dummy');
  const status = u.searchParams.get('status') || 'all';
  const contactName = u.searchParams.get('contactName');
  const messageSubtype = u.searchParams.get('messageSubtype');
  const limit = Math.min(parseInt(u.searchParams.get('limit') || '20'), 100);
  const offset = parseInt(u.searchParams.get('offset') || '0');

  // 构建查询条件（仅使用索引字段，敏感字段已全部加密）
  const conditions = ['user_id = $1'];
  const params = [userId];
  let paramIndex = 2;

  if (status !== 'all') {
    conditions.push(`status = $${paramIndex}`);
    params.push(status);
    paramIndex++;
  }
  // 注意：contactName 和 messageSubtype 已加密，需要在解密后内存过滤
  // 由于性能考虑，这里不支持加密字段的数据库层过滤

  /*
  // 查询任务列表（全字段加密版本：只查询索引字段 + encrypted_payload）
  const tasks = await sql`
    SELECT
      id, user_id, uuid, encrypted_payload,
      message_type, next_send_at, status, retry_count,
      created_at, updated_at
    FROM scheduled_messages
    WHERE ${sql.raw(conditions.join(' AND '))}
    ORDER BY next_send_at ASC
    LIMIT ${limit}
    OFFSET ${offset}
  `;

  // 查询总数
  const totalResult = await sql`
    SELECT COUNT(*) as count
    FROM scheduled_messages
    WHERE ${sql.raw(conditions.join(' AND '))}
  `;

  const total = parseInt(totalResult.rows[0].count);
  */

  // 模拟数据（实际项目替换为上述数据库查询）
  const tasks = [];
  const total = 0;
  
  const userKey = deriveUserEncryptionKey(userId, masterKey);
  const decryptedTasks = tasks.map(task => {
    const decrypted = JSON.parse(decryptFromStorage(task.encrypted_payload, userKey));
    return {
      id: task.id,
      uuid: task.uuid,
      contactName: decrypted.contactName,
      messageType: task.message_type,          // 索引字段（明文）
      messageSubtype: decrypted.messageSubtype, // 解密字段
      nextSendAt: task.next_send_at,           // 索引字段（明文）
      recurrenceType: decrypted.recurrenceType, // 解密字段
      status: task.status,                     // 索引字段（明文）
      retryCount: task.retry_count,            // 索引字段（明文）
      createdAt: task.created_at,
      updatedAt: task.updated_at
    };
  });

  console.log('[messages] Query tasks:', {
    userId,
    status,
    limit,
    offset,
    total
  });

  // 解密任务并过滤（如果有加密字段过滤需求）
  // 注意：实际项目中使用 decryptedTasks 替换 tasks
  let tasksToReturn = tasks;
  
  // 如果需要按加密字段过滤（内存过滤，性能开销较大）
  /*
  if (contactName || messageSubtype) {
    const userKey = deriveUserEncryptionKey(userId);
    tasksToReturn = tasks.filter(task => {
      const decrypted = JSON.parse(decryptFromStorage(task.encrypted_payload, userKey));
      if (contactName && decrypted.contactName !== contactName) return false;
      if (messageSubtype && decrypted.messageSubtype !== messageSubtype) return false;
      return true;
    });
  }
  */
  
  return {
    status: 200,
    body: {
      success: true,
      data: {
        tasks: tasksToReturn.map(task => {
          // 解密 encrypted_payload 并返回解密后的字段（复用上方已派生的 userKey）
          const decrypted = JSON.parse(decryptFromStorage(task.encrypted_payload, userKey));

          return {
            id: task.id,
            uuid: task.uuid,
            contactName: decrypted.contactName,              // 从解密数据获取
            messageSubtype: decrypted.messageSubtype,        // 从解密数据获取
            recurrenceType: decrypted.recurrenceType,        // 从解密数据获取
            messageType: task.message_type,                  // 索引字段（明文）
            nextSendAt: task.next_send_at,                   // 索引字段（明文）
            status: task.status,                             // 索引字段（明文）
            retryCount: task.retry_count,                    // 索引字段（明文）
            createdAt: task.created_at,
            updatedAt: task.updated_at
          };
        }),
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total
        }
      }
    }
  };
}

module.exports = async function(req, res) {
  try {
    if (req.method !== 'GET') return sendNodeJson(res, 405, { error: 'Method not allowed' });
    const result = await core(req.url, req.headers);
    return sendNodeJson(res, result.status, result.body);
  } catch (error) {
    console.error('[messages] Error:', error);
    if (error.code === 'DATABASE_URL_MISSING') {
      return sendNodeJson(res, 500, { success: false, error: { code: 'DATABASE_URL_MISSING', message: '缺少 DATABASE_URL 环境变量' } });
    }
    return sendNodeJson(res, 500, { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误，请稍后重试' } });
  }
};

exports.handler = async function(event) {
  try {
    if (event.httpMethod !== 'GET') return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
    const url = event.rawUrl || `https://dummy${event.path}${event.rawQuery ? '?' + event.rawQuery : ''}`;
    const result = await core(url, event.headers || {});
    return { statusCode: result.status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(result.body) };
  } catch (error) {
    console.error('[messages] Error:', error);
    if (error.code === 'DATABASE_URL_MISSING') {
      return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, error: { code: 'DATABASE_URL_MISSING', message: '缺少 DATABASE_URL 环境变量' } }) };
    }
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误，请稍后重试' } }) };
  }
};
