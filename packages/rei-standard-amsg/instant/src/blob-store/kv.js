/**
 * Cloudflare KV BlobStoreAdapter.
 *
 * KV's native `expirationTtl` handles row cleanup automatically — no
 * sweeper needed. But write quota on the free tier is **very** small
 * (1000 writes/day), so KV is only practical for low-traffic or
 * paid-tier deployments. Prefer D1 when available.
 *
 * Keys are stored under the `amsg-blob:` prefix to avoid colliding
 * with other tenants of the same KV namespace.
 */

/**
 * @typedef {Object} KVNamespace
 * @property {(key: string, value: string, opts?: { expirationTtl?: number }) => Promise<void>} put
 * @property {(key: string) => Promise<string | null>} get
 */

const KEY_PREFIX = 'amsg-blob:';

/**
 * @param {KVNamespace} kv
 * @returns {import('./interface.js').BlobStoreAdapter}
 */
export function createKVBlobStore(kv) {
  if (!kv || typeof kv.put !== 'function' || typeof kv.get !== 'function') {
    throw new TypeError('createKVBlobStore: kv must be a KVNamespace binding');
  }
  return {
    async put(key, body, ttlSeconds) {
      // KV requires expirationTtl ≥ 60. The default blob TTL is 60s so
      // the floor is harmless; clamp anyway for callers who pass less.
      const ttl = Math.max(60, Math.floor(ttlSeconds));
      await kv.put(KEY_PREFIX + key, body, { expirationTtl: ttl });
    },
    async read(key) {
      return kv.get(KEY_PREFIX + key);
    },
  };
}
