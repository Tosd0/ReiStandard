/**
 * POST /api/v1/init-tenant
 * 功能：一体化初始化租户（建表 + 生成密钥 + 写入 Blob + 发放 token）
 * ReiStandard v2.0.0-pre1
 */

const { isValidUUIDv4 } = require('../../lib/validation');
const { initializeTenant } = require('../../lib/tenant-context');

function sendNodeJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function core(headers, body, url) {
  const initSecret = String(headers['x-init-secret'] || headers['X-Init-Secret'] || '').trim();
  const expectedInitSecret = String(process.env.INIT_SECRET || '').trim();

  if (expectedInitSecret && initSecret !== expectedInitSecret) {
    return {
      status: 401,
      body: {
        success: false,
        error: {
          code: 'INVALID_INIT_AUTH',
          message: '初始化鉴权失败'
        }
      }
    };
  }

  let payload;
  try {
    payload = typeof body === 'string' ? JSON.parse(body || '{}') : (body || {});
  } catch {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'INVALID_JSON',
          message: '请求体不是有效的 JSON'
        }
      }
    };
  }

  const tenantId = payload.tenantId;
  if (tenantId && !isValidUUIDv4(tenantId)) {
    return {
      status: 400,
      body: {
        success: false,
        error: {
          code: 'INVALID_TENANT_ID',
          message: 'tenantId 必须是 UUID v4 格式'
        }
      }
    };
  }

  try {
    const origin = process.env.PUBLIC_BASE_URL || (url ? new URL(url, 'https://dummy').origin : '');
    const result = await initializeTenant({
      tenantId,
      driver: payload.driver,
      databaseUrl: payload.databaseUrl,
      publicBaseUrl: origin
    });

    return {
      status: 201,
      body: {
        success: true,
        data: {
          tenantId: result.tenantId,
          tenantToken: result.tenantToken,
          cronToken: result.cronToken,
          cronWebhookUrl: result.cronWebhookUrl,
          masterKeyFingerprint: result.masterKeyFingerprint
        }
      }
    };
  } catch (error) {
    if (error.message === 'TENANT_TOKEN_SIGNING_KEY_MISSING') {
      return {
        status: 500,
        body: {
          success: false,
          error: {
            code: 'TENANT_TOKEN_SIGNING_KEY_MISSING',
            message: '缺少 TENANT_TOKEN_SIGNING_KEY 环境变量'
          }
        }
      };
    }

    if (error.message === 'TENANT_CONFIG_KEK_MISSING') {
      return {
        status: 500,
        body: {
          success: false,
          error: {
            code: 'TENANT_CONFIG_KEK_MISSING',
            message: '缺少 TENANT_CONFIG_KEK 环境变量'
          }
        }
      };
    }

    if (error.message === 'INVALID_DRIVER') {
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: 'INVALID_DRIVER',
            message: 'driver 必须是 neon 或 pg'
          }
        }
      };
    }

    if (error.message === 'INVALID_DATABASE_URL') {
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: 'INVALID_DATABASE_URL',
            message: 'databaseUrl 不能为空'
          }
        }
      };
    }

    if (error.message === 'DRIVER_NOT_SUPPORTED_IN_EXAMPLES') {
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: 'INVALID_DRIVER',
            message: 'examples 当前仅支持 neon 或 pg 驱动'
          }
        }
      };
    }

    if (error.message === 'PG_DRIVER_NOT_INSTALLED') {
      return {
        status: 500,
        body: {
          success: false,
          error: {
            code: 'PG_DRIVER_NOT_INSTALLED',
            message: 'driver=pg 需要先安装 pg 依赖'
          }
        }
      };
    }

    if (error.message === 'TENANT_ALREADY_INITIALIZED') {
      return {
        status: 409,
        body: {
          success: false,
          error: {
            code: 'TENANT_ALREADY_INITIALIZED',
            message: 'tenantId 已存在，不能重复初始化'
          }
        }
      };
    }

    throw error;
  }
}

module.exports = async function(req, res) {
  try {
    if (req.method !== 'POST') return sendNodeJson(res, 405, { error: 'Method not allowed' });

    let body = '';
    for await (const chunk of req) body += chunk.toString();

    const result = await core(req.headers || {}, body, req.url);
    return sendNodeJson(res, result.status, result.body);
  } catch (error) {
    console.error('[init-tenant] Error:', error);
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

    const url = event.rawUrl || `https://dummy${event.path}${event.rawQuery ? '?' + event.rawQuery : ''}`;
    const result = await core(event.headers || {}, event.body, url);

    return {
      statusCode: result.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(result.body)
    };
  } catch (error) {
    console.error('[init-tenant] Error:', error);
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
