/**
 * Handler: get-user-key
 *
 * @param {Object} ctx - Server context.
 * @returns {{ GET: function }}
 */

import { deriveUserEncryptionKey } from '../lib/encryption.js';
import { requireUserId } from '../lib/request.js';

export function createGetUserKeyHandler(ctx) {
  async function GET(url, headers) {
    const effectiveHeaders = headers || url || {};
    const tenantResult = await ctx.tenantManager.resolveTenant(effectiveHeaders);
    if (!tenantResult.ok) {
      return tenantResult.error;
    }

    const { masterKey } = tenantResult.context;
    const gate = requireUserId(effectiveHeaders);
    if (gate.error) return gate.error;
    const { userId } = gate;

    return {
      status: 200,
      body: {
        success: true,
        data: {
          userKey: await deriveUserEncryptionKey(userId, masterKey),
          version: 1
        }
      }
    };
  }

  return { GET };
}
