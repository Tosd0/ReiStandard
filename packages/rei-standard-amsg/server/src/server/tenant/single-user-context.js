/**
 * Single-user tenant context manager.
 *
 * Interface-compatible with createTenantContextManager (resolveTenant /
 * initializeTenant), so the existing business handlers reuse it unchanged.
 * No blob registry, no tenant token — db and masterKey come from the caller
 * (the Worker resolves them from env + D1 binding per request).
 */

import { constantTimeEqual } from '../lib/constant-time.js';
import { getHeader } from '../lib/request.js';

export function createSingleUserContextManager({ db, masterKey, serverToken } = {}) {
  if (!db) throw new Error('[amsg-server single-user] db (adapter) is required');
  if (!masterKey) throw new Error('[amsg-server single-user] masterKey is required');
  const token = String(serverToken || '').trim();

  async function isAuthorized(headers) {
    if (!token) return true; // open when no shared secret configured
    const provided = getHeader(headers, 'x-client-token');
    if (!provided) return false;
    return constantTimeEqual(provided, token);
  }

  async function resolveTenant(headers) {
    if (!(await isAuthorized(headers))) {
      return {
        ok: false,
        error: {
          status: 401,
          body: { success: false, error: { code: 'INVALID_CLIENT_TOKEN', message: '共享密钥无效或缺失' } }
        }
      };
    }
    return {
      ok: true,
      context: { tenantId: 'single', tokenType: 'tenant', db, masterKey }
    };
  }

  async function initializeTenant() {
    const schema = await db.initSchema();
    return { tenantId: 'single', schema };
  }

  return { resolveTenant, initializeTenant };
}
