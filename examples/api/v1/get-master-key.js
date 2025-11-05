/**
 * GET /api/v1/get-master-key
 * 功能：分发主密钥（客户端首次登录时使用）
 * ReiStandard v1.1.0
 */

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

  // 直接返回主密钥（客户端自己派生用户专属密钥）
  return {
    status: 200,
    body: {
      success: true,
      data: {
        masterKey: process.env.ENCRYPTION_KEY,
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
    console.error('[get-master-key] Error:', error);
    return sendNodeJson(res, 500, { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误，请稍后重试' } });
  }
};

exports.handler = async function(event) {
  try {
    if (event.httpMethod !== 'GET') return { statusCode: 405, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Method not allowed' }) };
    const result = await core(event.headers || {});
    return { statusCode: result.status, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(result.body) };
  } catch (error) {
    console.error('[get-master-key] Error:', error);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: '服务器内部错误，请稍后重试' } }) };
  }
};
