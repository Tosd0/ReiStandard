/**
 * Generic Postgres BlobStoreAdapter.
 *
 * Works with any client that exposes `query(sql, params)` returning
 * `{ rows: [...] }`:
 *
 *   - `pg` (node-postgres) — `new Pool({ ... })`
 *   - `@neondatabase/serverless` — Pool / Client both work
 *   - `@vercel/postgres` — use `sql.query(...)` not the tagged template
 *   - Any other compatible driver
 *
 * Schema is **caller-owned** (the package does not run migrations):
 *
 *   CREATE TABLE IF NOT EXISTS amsg_transient_blobs (
 *     key TEXT PRIMARY KEY,
 *     body TEXT NOT NULL,
 *     expires_at BIGINT NOT NULL  -- ms epoch
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_amsg_blobs_expires
 *     ON amsg_transient_blobs(expires_at);
 *
 * Production deployments MUST schedule a cron sweeper — `read`
 * filters expired rows but never deletes, so without one the table
 * grows unboundedly:
 *
 *   DELETE FROM amsg_transient_blobs
 *   WHERE expires_at < (extract(epoch from now()) * 1000)::bigint;
 */

/**
 * @typedef {Object} PgClient
 * @property {(sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>} query
 */

/**
 * @param {PgClient} client
 * @param {Object} [opts]
 * @param {string} [opts.table='amsg_transient_blobs']
 * @returns {import('./interface.js').BlobStoreAdapter}
 */
export function createPostgresBlobStore(client, opts = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('createPostgresBlobStore: client must expose a query(sql, params) method');
  }
  const table = sanitizeTable(opts.table);
  const putSql = `INSERT INTO ${table}(key, body, expires_at) VALUES ($1, $2, $3)`;
  const readSql = `SELECT body FROM ${table} WHERE key = $1 AND expires_at > $2`;

  return {
    async put(key, body, ttlSeconds) {
      await client.query(putSql, [key, body, Date.now() + ttlSeconds * 1000]);
    },
    async read(key) {
      const result = await client.query(readSql, [key, Date.now()]);
      const row = result && result.rows && result.rows[0];
      if (!row) return null;
      const body = row.body;
      return typeof body === 'string' ? body : null;
    },
  };
}

/**
 * Table identifier guardrail. Postgres doesn't allow parameterised
 * table names, so we limit the surface to `[A-Za-z_][A-Za-z0-9_]*` —
 * same convention as the D1 adapter.
 *
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeTable(value) {
  if (value === undefined || value === null || value === '') return 'amsg_transient_blobs';
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new TypeError(
      'createPostgresBlobStore: opts.table must match /^[A-Za-z_][A-Za-z0-9_]*$/'
    );
  }
  return value;
}
