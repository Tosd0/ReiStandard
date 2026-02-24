/**
 * Handler: init-tenant
 * ReiStandard SDK v2.0.0
 *
 * @param {Object} ctx - Server context.
 * @returns {{ POST: function }}
 */

import { isValidUUIDv4 } from '../lib/validation.js';
import { getHeader, parseJsonBody } from '../lib/request.js';

export function createInitTenantHandler(ctx) {
  async function POST(headers, body) {
    const initSecret = getHeader(headers, 'x-init-secret');

    // If initSecret is configured, require a matching X-Init-Secret.
    if (ctx.tenant.initSecret && initSecret !== ctx.tenant.initSecret) {
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

    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      return {
        status: 400,
        body: {
          success: false,
          error: parsed.error
        }
      };
    }

    const payload = parsed.data;
    const tenantId = payload.tenantId || undefined;
    const driver = payload.driver;
    const databaseUrl = payload.databaseUrl || payload.connectionString;

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

    if (!databaseUrl || !driver) {
      return {
        status: 400,
        body: {
          success: false,
          error: {
            code: 'INVALID_PARAMETERS',
            message: '缺少 driver 或 databaseUrl 参数'
          }
        }
      };
    }

    try {
      const result = await ctx.tenantManager.initializeTenant({
        tenantId,
        driver,
        connectionString: databaseUrl
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

  return { POST };
}
