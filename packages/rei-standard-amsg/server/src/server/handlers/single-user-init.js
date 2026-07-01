/**
 * Handler: single-user-init
 *
 * Idempotent "just create the tables" endpoint for single-user deployments
 * (the degenerate form of init-tenant). Reuses resolveTenant purely to enforce
 * the optional shared secret, then runs initSchema. Issues no token.
 *
 * @param {Object} ctx - Single-user server context (ctx.tenantManager).
 * @returns {{ POST: function }}
 */
export function createSingleUserInitHandler(ctx) {
  async function POST(headers /* , body */) {
    const auth = await ctx.tenantManager.resolveTenant(headers || {});
    if (!auth.ok) {
      return auth.error;
    }
    try {
      const result = await ctx.tenantManager.initializeTenant();
      return {
        status: 200,
        body: { success: true, data: { tenantId: result.tenantId, schema: result.schema } }
      };
    } catch (error) {
      return {
        status: 500,
        body: { success: false, error: { code: 'INIT_FAILED', message: error.message } }
      };
    }
  }

  return { POST };
}
