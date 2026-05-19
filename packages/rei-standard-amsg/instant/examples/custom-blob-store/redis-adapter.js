/**
 * Custom BlobStoreAdapter — Redis / Upstash.
 *
 * Redis has native TTL via `SET EX`, so the cron sweeper isn't
 * needed — keys expire automatically. `read` is plain `GET` (does
 * NOT delete), preserving the package's non-destructive multi-read
 * contract.
 *
 * Wire it into the handler:
 *
 *   import { createInstantHandler } from '@rei-standard/amsg-instant';
 *   import { createRedisBlobStore } from './redis-adapter.js';
 *   import { Redis } from '@upstash/redis';
 *
 *   const redis = new Redis({ url: env.UPSTASH_URL, token: env.UPSTASH_TOKEN });
 *
 *   export default {
 *     fetch: createInstantHandler({
 *       vapid: { ... },
 *       blobStore: { adapter: createRedisBlobStore(redis) },
 *       onLLMOutput: myHook,
 *     }),
 *   };
 */

/**
 * @param {{
 *   set: (key: string, value: string, opts?: { EX?: number, ex?: number }) => Promise<unknown>,
 *   get: (key: string) => Promise<string | null>,
 * }} redis
 * @returns {import('@rei-standard/amsg-instant').BlobStoreAdapter}
 */
export function createRedisBlobStore(redis) {
  return {
    async put(key, body, ttlSeconds) {
      // Both node-redis v4+ and Upstash accept `EX`/`ex` — pick
      // whichever your client speaks.
      await redis.set(`amsg:${key}`, body, { EX: ttlSeconds });
    },
    async read(key) {
      const body = await redis.get(`amsg:${key}`);
      return typeof body === 'string' ? body : null;
    },
  };
}
