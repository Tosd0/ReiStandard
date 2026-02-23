/**
 * POST /api/v1/init-master-key
 * 功能：初始化并返回一次性系统密钥（仅首次可见）
 * ReiStandard v1.2.0
 */

const { generateMasterKey, makeFingerprint, setMasterKeyOnce } = require('../../lib/master-key-store');

function sendNodeJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function core() {
  const masterKey = generateMasterKey();

  try {
    await setMasterKeyOnce(masterKey);
  } catch (error) {
    if (error.code === 'MASTER_KEY_ALREADY_INITIALIZED') {
      return {
        status: 409,
        body: {
          success: false,
          error: {
            code: 'MASTER_KEY_ALREADY_INITIALIZED',
            message: '系统密钥已初始化，无法再次获取'
          }
        }
      };
    }

    if (error.code === 'DATABASE_URL_MISSING') {
      return {
        status: 500,
        body: {
          success: false,
          error: {
            code: 'DATABASE_URL_MISSING',
            message: '缺少 DATABASE_URL 环境变量'
          }
        }
      };
    }

    throw error;
  }

  return {
    status: 201,
    body: {
      success: true,
      data: {
        masterKey,
        fingerprint: makeFingerprint(masterKey),
        version: 1
      }
    }
  };
}

module.exports = async function(req, res) {
  try {
    if (req.method !== 'POST') return sendNodeJson(res, 405, { error: 'Method not allowed' });
    const result = await core();
    return sendNodeJson(res, result.status, result.body);
  } catch (error) {
    console.error('[init-master-key] Error:', error);
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
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
    }

    const result = await core();
    return {
      statusCode: result.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(result.body)
    };
  } catch (error) {
    console.error('[init-master-key] Error:', error);
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
