/**
 * Upstash Redis BlobStoreAdapter — also works with Vercel KV.
 *
 * `@upstash/redis` and `@vercel/kv` share the same client surface
 * (Vercel KV is Upstash under the hood), so this single adapter
 * covers both. Use it on Vercel / Netlify Functions / AWS Lambda /
 * any serverless that lacks a native KV — Upstash's REST API works
 * from anywhere with HTTPS egress and the free tier handles ~10k
 * commands/day.
 *
 * Native TTL via `SET EX`, no cron sweeper needed.
 *
 * Keys are namespaced under `amsg-blob:` so the same Redis instance
 * can host unrelated data without collision.
 *
 * NOTE: this is **not** a node-redis (v4+) adapter. node-redis uses
 * `{ EX: ttl }` (uppercase) and a slightly different `set` overload
 * — see `examples/custom-blob-store/redis-adapter.js` for that
 * template.
 */

const KEY_PREFIX = 'amsg-blob:';

/**
 * @typedef {Object} UpstashRedisClient
 * @property {(key: string, value: string, opts?: { ex?: number }) => Promise<unknown>} set
 * @property {(key: string) => Promise<string | null>} get
 */

/**
 * @param {UpstashRedisClient} redis
 * @returns {import('./interface.js').BlobStoreAdapter}
 */
export function createUpstashBlobStore(redis) {
  if (!redis || typeof redis.set !== 'function' || typeof redis.get !== 'function') {
    throw new TypeError('createUpstashBlobStore: redis must expose set/get (e.g. @upstash/redis or @vercel/kv client)');
  }
  return {
    async put(key, body, ttlSeconds) {
      // Upstash rejects ex < 1; clamp defensively for callers who pass 0/negative.
      const ttl = Math.max(1, Math.floor(ttlSeconds));
      await redis.set(KEY_PREFIX + key, body, { ex: ttl });
    },
    async read(key) {
      const body = await redis.get(KEY_PREFIX + key);
      return typeof body === 'string' ? body : null;
    },
  };
}
