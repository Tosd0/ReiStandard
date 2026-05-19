/**
 * Custom BlobStoreAdapter — Postgres / Neon.
 *
 * The package ships D1 / KV / Memory adapters; this is the template
 * you copy when you want any other backend. Implement the two
 * methods and you're done:
 *
 *   put(key, body, ttlSeconds)  — durable until expiry
 *   read(key)                   — non-destructive; returns null when
 *                                 expired/missing
 *
 * `read` MUST stay non-destructive (do not delete on read): push
 * redelivery can land on the SW after a previous handler already
 * consumed the body, and the SW relies on multi-read to dedup
 * *after* fetching.
 *
 * Schema (caller-owned, **package will not create it for you**):
 *
 *   CREATE TABLE IF NOT EXISTS amsg_transient_blobs (
 *     key TEXT PRIMARY KEY,
 *     body TEXT NOT NULL,
 *     expires_at BIGINT NOT NULL    -- ms epoch
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_amsg_blobs_expires
 *     ON amsg_transient_blobs(expires_at);
 *
 * Schedule a cron sweeper — `read` never deletes, so without one the
 * table grows unboundedly:
 *
 *   DELETE FROM amsg_transient_blobs WHERE expires_at < extract(epoch from now()) * 1000;
 *
 * Wire it into the handler:
 *
 *   import { createInstantHandler } from '@rei-standard/amsg-instant';
 *   import { createPostgresBlobStore } from './postgres-adapter.js';
 *   import { Pool } from 'pg';
 *
 *   const pool = new Pool({ connectionString: env.DATABASE_URL });
 *
 *   export default {
 *     fetch: createInstantHandler({
 *       vapid: { ... },
 *       blobStore: { adapter: createPostgresBlobStore(pool) },
 *       onLLMOutput: myHook,
 *     }),
 *   };
 */

/**
 * @param {import('pg').Pool} pool
 * @returns {import('@rei-standard/amsg-instant').BlobStoreAdapter}
 */
export function createPostgresBlobStore(pool) {
  return {
    async put(key, body, ttlSeconds) {
      await pool.query(
        'INSERT INTO amsg_transient_blobs(key, body, expires_at) VALUES ($1, $2, $3)',
        [key, body, Date.now() + ttlSeconds * 1000],
      );
    },
    async read(key) {
      const { rows } = await pool.query(
        'SELECT body FROM amsg_transient_blobs WHERE key = $1 AND expires_at > $2',
        [key, Date.now()],
      );
      return rows[0]?.body ?? null;
    },
  };
}
