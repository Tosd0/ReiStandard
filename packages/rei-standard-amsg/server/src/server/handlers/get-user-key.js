/**
 * Handler: get-user-key
 * ReiStandard SDK v1.1.0
 *
 * @param {Object} ctx - Server context.
 * @returns {{ GET: function }}
 */

import { deriveUserEncryptionKey } from '../lib/encryption.js';
import { isValidUUIDv4 } from '../lib/validation.js';

export function createGetUserKeyHandler(ctx) {
  async function GET(headers) {
    const userId = headers['x-user-id'];

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

    const masterKey = await ctx.db.getMasterKey();
    if (!masterKey) {
      return {
        status: 503,
        body: { success: false, error: { code: 'MASTER_KEY_NOT_INITIALIZED', message: '主密钥尚未初始化，请先调用 /api/v1/init-master-key' } }
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
