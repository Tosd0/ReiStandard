/**
 * Handler: get-user-key
 * ReiStandard SDK v2.0.0-pre1
 *
 * @param {Object} ctx - Server context.
 * @returns {{ GET: function }}
 */

import { deriveUserEncryptionKey } from '../lib/encryption.js';
import { getHeader } from '../lib/request.js';
import { isValidUUIDv4 } from '../lib/validation.js';

export function createGetUserKeyHandler(ctx) {
  async function GET(url, headers) {
    const effectiveHeaders = headers || url || {};
    const tenantResult = await ctx.tenantManager.resolveTenant(effectiveHeaders);
    if (!tenantResult.ok) {
      return tenantResult.error;
    }

    const { masterKey } = tenantResult.context;
    const userId = getHeader(effectiveHeaders, 'x-user-id');

    if (!userId) {
      return {
        status: 400,
        body: { success: false, error: { code: 'USER_ID_REQUIRED', message: '缺少用户标识符' } }
      };
    }

    if (!isValidUUIDv4(userId)) {
      return {
        status: 400,
        body: { success: false, error: { code: 'INVALID_USER_ID_FORMAT', message: 'X-User-Id 必须是 UUID v4 格式' } }
      };
    }

    return {
      status: 200,
      body: {
        success: true,
        data: {
          userKey: deriveUserEncryptionKey(userId, masterKey),
          version: 1
        }
      }
    };
  }

  return { GET };
}
