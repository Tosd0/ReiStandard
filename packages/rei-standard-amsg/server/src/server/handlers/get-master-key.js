/**
 * Handler: get-master-key
 * ReiStandard SDK v1.1.0
 *
 * @param {Object} ctx - Server context.
 * @returns {{ GET: function }}
 */

export function createGetMasterKeyHandler(ctx) {
  async function GET(headers) {
    const userId = headers['x-user-id'];

    if (!userId) {
      return {
        status: 400,
        body: { success: false, error: { code: 'USER_ID_REQUIRED', message: '缺少用户标识符' } }
      };
    }

    return {
      status: 200,
      body: {
        success: true,
        data: {
          masterKey: ctx.encryptionKey,
          version: 1
        }
      }
    };
  }

  return { GET };
}
