/**
 * Handler: init-master-key
 * ReiStandard SDK v1.2.1
 *
 * @param {Object} ctx - Server context.
 * @returns {{ POST: function }}
 */

import { createHash, randomBytes } from 'crypto';

function makeFingerprint(masterKey) {
  return createHash('sha256').update(masterKey).digest('hex').slice(0, 16);
}

export function createInitMasterKeyHandler(ctx) {
  async function POST() {
    const masterKey = randomBytes(32).toString('hex');
    const inserted = await ctx.db.setMasterKeyOnce(masterKey);

    if (!inserted) {
      return {
        status: 409,
        body: {
          success: false,
          error: {
            code: 'MASTER_KEY_ALREADY_INITIALIZED',
            message: '主密钥已初始化，无法再次获取'
          }
        }
      };
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

  return { POST };
}
