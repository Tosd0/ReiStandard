/**
 * Web Push wrapper.
 *
 * Wraps the `web-push` npm module with VAPID configuration applied
 * once per handler instance. The module is loaded dynamically so that
 * environments that don't need it (e.g. unit tests passing a mock)
 * never have to install it.
 */

let _cachedWebpush = null;

function normalizeVapidSubject(email) {
  const trimmed = String(email || '').trim();
  if (!trimmed) return '';
  return /^mailto:/i.test(trimmed) ? trimmed : `mailto:${trimmed}`;
}

/**
 * Resolve the web-push module (real implementation or a provided mock).
 *
 * @param {Object} [override] - Optional preloaded module (used by tests).
 * @returns {Promise<Object>}
 */
export async function loadWebpush(override) {
  if (override) return override;
  if (_cachedWebpush) return _cachedWebpush;

  let mod;
  try {
    const imported = await import('web-push');
    mod = imported.default || imported;
  } catch (_err) {
    throw new Error(
      '[amsg-instant] web-push is required. Install it with: npm install web-push'
    );
  }
  _cachedWebpush = mod;
  return mod;
}

/**
 * Apply VAPID details to a web-push module instance.
 *
 * @param {Object} webpush
 * @param {{ email: string, publicKey: string, privateKey: string }} vapid
 */
export function applyVapid(webpush, vapid) {
  if (!vapid || !vapid.email || !vapid.publicKey || !vapid.privateKey) {
    throw new Error('VAPID_CONFIG_MISSING');
  }
  webpush.setVapidDetails(
    normalizeVapidSubject(vapid.email),
    vapid.publicKey,
    vapid.privateKey
  );
}
