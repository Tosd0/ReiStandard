/**
 * Cloudflare D1 BlobStoreAdapter.
 *
 * Default table is `amsg_transient_blobs` — the caller must create it
 * (the package does not run migrations on its behalf). Schema:
 *
 *   CREATE TABLE IF NOT EXISTS amsg_transient_blobs (
 *     key TEXT PRIMARY KEY,
 *     body TEXT NOT NULL,
 *     expires_at INTEGER NOT NULL  -- ms epoch
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_amsg_blobs_expires
 *     ON amsg_transient_blobs(expires_at);
 *
 * Production deployments MUST schedule a cron sweeper:
 *
 *   # wrangler.toml
 *   [triggers]
 *   crons = ["* /15 * * * *"]
 *
 *   export default {
 *     async scheduled(_event, env) {
 *       await env.DB.prepare(
 *         'DELETE FROM amsg_transient_blobs WHERE expires_at < ?'
 *       ).bind(Date.now()).run();
 *     },
 *   };
 *
 * Without the sweeper expired rows accumulate forever — `read` filters
 * them out but never deletes.
 */

/**
 * @typedef {Object} D1PreparedStatement
 * @property {(...args: unknown[]) => D1PreparedStatement} bind
 * @property {() => Promise<unknown>} run
 * @property {<T = unknown>() => Promise<T | null>} first
 */

/**
 * @typedef {Object} D1Database
 * @property {(query: string) => D1PreparedStatement} prepare
 */

/**
 * @param {D1Database} db
 * @param {Object} [opts]
 * @param {string} [opts.table='amsg_transient_blobs']
 * @returns {import('./interface.js').BlobStoreAdapter}
 */
export function createD1BlobStore(db, opts = {}) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createD1BlobStore: db must be a D1 Database binding');
  }
  const table = sanitizeTable(opts.table);
  const putSql = `INSERT INTO ${table}(key, body, expires_at) VALUES (?, ?, ?)`;
  const readSql = `SELECT body FROM ${table} WHERE key = ? AND expires_at > ?`;

  return {
    async put(key, body, ttlSeconds) {
      await db.prepare(putSql).bind(key, body, Date.now() + ttlSeconds * 1000).run();
    },
    async read(key) {
      const row = await db.prepare(readSql).bind(key, Date.now()).first();
      if (!row) return null;
      const body = /** @type {{ body?: unknown }} */ (row).body;
      return typeof body === 'string' ? body : null;
    },
  };
}

/**
 * Table identifier guardrail. D1 doesn't allow parameterised table
 * names, so we limit the surface to `[A-Za-z_][A-Za-z0-9_]*` to keep
 * the interpolation safe.
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeTable(value) {
  if (value === undefined || value === null || value === '') return 'amsg_transient_blobs';
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new TypeError(
      'createD1BlobStore: opts.table must match /^[A-Za-z_][A-Za-z0-9_]*$/'
    );
  }
  return value;
}
