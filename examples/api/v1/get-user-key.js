/**
 * GET /api/v1/get-user-key
 * 功能：根据用户 ID 派生用户专属密钥
 * ReiStandard v1.2.0
 */

const { deriveUserEncryptionKey } = require('../../lib/encryption');
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

async function core(headers) {
  const h = normalizeHeaders(headers);
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

  const userKey = deriveUserEncryptionKey(userId, masterKey);
  return {
    status: 200,
    body: {
      success: true,
      data: {
        userKey,
        version: 1
      }
    }
  };
}

module.exports = async function(req, res) {
  try {
    if (req.method !== 'GET') return sendNodeJson(res, 405, { error: 'Method not allowed' });
    const result = await core(req.headers);
    return sendNodeJson(res, result.status, result.body);
  } catch (error) {
    console.error('[get-user-key] Error:', error);
    if (error.code === 'DATABASE_URL_MISSING') {
      return sendNodeJson(res, 500, {
        success: false,
        error: {
          code: 'DATABASE_URL_MISSING',
          message: '缺少 DATABASE_URL 环境变量'
        }
      });
    }

    return sendNodeJson(res, 500, {
      success: false,
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: '服务器内部错误，请稍后重试'
      }
    });
  }
};

exports.handler = async function(event) {
  try {
    if (event.httpMethod !== 'GET') {
      return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
    }
    const result = await core(event.headers || {});
    return {
      statusCode: result.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(result.body)
    };
  } catch (error) {
    console.error('[get-user-key] Error:', error);
    if (error.code === 'DATABASE_URL_MISSING') {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          success: false,
          error: {
            code: 'DATABASE_URL_MISSING',
            message: '缺少 DATABASE_URL 环境变量'
          }
        })
      };
    }

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
