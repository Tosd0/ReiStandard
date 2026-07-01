/**
 * Handler: send-notifications
 * ReiStandard SDK v2.0.1
 *
 * @param {Object} ctx - Server context.
 * @returns {{ POST: function }}
 */

import { runScheduledTick } from '../lib/run-tick.js';

export function createSendNotificationsHandler(ctx) {
  async function POST(urlOrHeaders, maybeHeaders) {
    const url = typeof urlOrHeaders === 'string' ? urlOrHeaders : '';
    const headers = maybeHeaders || (typeof urlOrHeaders === 'object' ? urlOrHeaders : {});

    const tenantResult = await ctx.tenantManager.resolveTenant(headers, {
      allowCronToken: true,
      url
    });
    if (!tenantResult.ok) {
      return tenantResult.error;
    }

    const tenantCtx = tenantResult.context;
    const db = tenantCtx.db;
    const masterKey = tenantCtx.masterKey;

    if (!ctx.vapid.email || !ctx.vapid.publicKey || !ctx.vapid.privateKey) {
      return {
        status: 500,
        body: {
          success: false,
          error: {
            code: 'VAPID_CONFIG_ERROR',
            message: 'VAPID 配置缺失，无法发送推送通知',
            details: {
              missingKeys: [
                !ctx.vapid.email && 'VAPID_EMAIL',
                !ctx.vapid.publicKey && 'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
                !ctx.vapid.privateKey && 'VAPID_PRIVATE_KEY'
              ].filter(Boolean)
            }
          }
        }
      };
    }

    const data = await runScheduledTick({ ...ctx, db, masterKey });
    return { status: 200, body: { success: true, data } };
  }

  return { POST };
}
