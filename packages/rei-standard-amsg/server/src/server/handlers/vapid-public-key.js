/**
 * Handler: vapid-public-key
 *
 * Exposes this worker's own VAPID public key so a browser frontend can build a
 * Web Push subscription (`applicationServerKey`) at runtime. Each self-hosted
 * worker owns its keypair, so the key can't be baked into the frontend — it
 * pulls it from here.
 *
 * Auth funnels through the same resolveTenant as every other endpoint, so with
 * a serverToken configured this route requires `X-Client-Token` too (the
 * all-or-nothing contract). The public key itself is not a secret; gating it
 * just keeps every endpoint consistent.
 *
 * @param {Object} ctx - Server context ({ vapid, tenantManager, ... }).
 * @returns {{ GET: function }}
 */

export function createVapidPublicKeyHandler(ctx) {
  async function GET(url, headers) {
    const effectiveHeaders = headers || url || {};
    const tenantResult = await ctx.tenantManager.resolveTenant(effectiveHeaders);
    if (!tenantResult.ok) {
      return tenantResult.error;
    }

    const publicKey = ctx.vapid && ctx.vapid.publicKey;
    if (!publicKey) {
      return {
        status: 503,
        body: {
          success: false,
          error: {
            code: 'VAPID_NOT_CONFIGURED',
            message: 'VAPID 公钥未配置：请为本 Worker 设置 VAPID_PUBLIC_KEY'
          }
        }
      };
    }

    return {
      status: 200,
      body: { success: true, publicKey }
    };
  }

  return { GET };
}
