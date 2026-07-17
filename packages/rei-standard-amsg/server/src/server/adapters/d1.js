/**
 * Cloudflare D1 (SQLite) Database Adapter.
 *
 * @implements {import('./interface.js').DbAdapter}
 *
 * Timestamps are stored as ISO8601 UTC TEXT. Every timestamp is normalized
 * with new Date(v).toISOString() before store/compare so lexical ordering
 * equals chronological ordering (mixed offsets like +08:00 vs Z are unified).
 */

import { SQLITE_TABLE_SQL, SQLITE_INDEXES, CLIENT_STATE_TABLE_SQL } from './schema.sqlite.js';

// Update methods build a dynamic SET clause from object keys. Callers pass only
// hardcoded column names today, but enforcing a whitelist keeps a future caller
// from ever turning a caller-supplied key into interpolated SQL.
const UPDATABLE_COLUMNS = new Set([
  'user_id', 'uuid', 'encrypted_payload', 'message_type',
  'next_send_at', 'status', 'retry_count', 'created_at', 'updated_at'
]);

export class D1Adapter {
  /** @param {{ prepare: (sql: string) => any }} db - Cloudflare D1 binding */
  constructor(db) {
    /** @private */
    this._db = db;
  }

  /** @private */
  _now() {
    return new Date().toISOString();
  }

  /** @private */
  _iso(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`[amsg-server D1] invalid timestamp: ${value}`);
    }
    return d.toISOString();
  }

  async initSchema() {
    await this._db.prepare(SQLITE_TABLE_SQL).run();
    await this._db.prepare(CLIENT_STATE_TABLE_SQL).run();

    const indexResults = [];
    for (const index of SQLITE_INDEXES) {
      try {
        await this._db.prepare(index.sql).run();
        indexResults.push({ name: index.name, status: 'success', description: index.description, critical: !!index.critical });
      } catch (error) {
        indexResults.push({ name: index.name, status: 'failed', description: index.description, critical: !!index.critical, error: error.message });
      }
    }

    const criticalFailures = indexResults.filter((i) => i.critical && i.status === 'failed');
    if (criticalFailures.length > 0) {
      const names = criticalFailures.map((i) => i.name).join(', ');
      throw new Error(
        `Critical index creation failed (${names}). ` +
        'Please remove duplicate UUID rows and run initSchema again.'
      );
    }

    return {
      columnsCreated: 10,
      indexesCreated: indexResults.filter((r) => r.status === 'success').length,
      indexesFailed: indexResults.filter((r) => r.status === 'failed').length,
      columns: [],
      indexes: indexResults
    };
  }

  async dropSchema() {
    await this._db.prepare('DROP TABLE IF EXISTS scheduled_messages').run();
    await this._db.prepare('DROP TABLE IF EXISTS client_state').run();
  }

  async createTask(params) {
    const now = this._now();
    const nextSendAt = this._iso(params.next_send_at);
    const res = await this._db.prepare(
      `INSERT INTO scheduled_messages
        (user_id, uuid, encrypted_payload, next_send_at, message_type, status, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
    ).bind(params.user_id, params.uuid, params.encrypted_payload, nextSendAt, params.message_type, now, now).run();

    const id = res.meta.last_row_id;
    return this._db.prepare(
      `SELECT id, uuid, next_send_at, status, created_at FROM scheduled_messages WHERE id = ?`
    ).bind(id).first();
  }

  async getTaskByUuid(uuid, userId) {
    return this._db.prepare(
      `SELECT id, user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count
       FROM scheduled_messages
       WHERE uuid = ? AND user_id = ? AND status = 'pending'
       LIMIT 1`
    ).bind(uuid, userId).first();
  }

  async getTaskByUuidOnly(uuid) {
    return this._db.prepare(
      `SELECT id, user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count
       FROM scheduled_messages
       WHERE uuid = ? AND status = 'pending'
       LIMIT 1`
    ).bind(uuid).first();
  }

  async updateTaskById(taskId, updates) {
    const sets = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
      if (!UPDATABLE_COLUMNS.has(key)) {
        throw new Error(`[amsg-server D1] rejected unknown update column: ${key}`);
      }
      sets.push(`${key} = ?`);
      values.push(key === 'next_send_at' ? this._iso(value) : value);
    }
    // Callers may pass updated_at explicitly (tests); otherwise stamp now.
    if (!Object.prototype.hasOwnProperty.call(updates, 'updated_at')) {
      sets.push('updated_at = ?');
      values.push(this._now());
    }
    values.push(taskId);

    await this._db.prepare(
      `UPDATE scheduled_messages SET ${sets.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return this._db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').bind(taskId).first();
  }

  async updateTaskByUuid(uuid, userId, encryptedPayload, extraFields) {
    const now = this._now();
    const sets = ['encrypted_payload = ?', 'updated_at = ?'];
    const values = [encryptedPayload, now];
    if (extraFields) {
      for (const [key, value] of Object.entries(extraFields)) {
        if (!UPDATABLE_COLUMNS.has(key)) {
          throw new Error(`[amsg-server D1] rejected unknown update column: ${key}`);
        }
        sets.push(`${key} = ?`);
        values.push(key === 'next_send_at' ? this._iso(value) : value);
      }
    }
    values.push(uuid, userId);

    const res = await this._db.prepare(
      `UPDATE scheduled_messages SET ${sets.join(', ')}
       WHERE uuid = ? AND user_id = ? AND status = 'pending'`
    ).bind(...values).run();

    if (!res.meta.changes) return null;
    return { uuid, updated_at: now };
  }

  async deleteTaskById(taskId) {
    const res = await this._db.prepare('DELETE FROM scheduled_messages WHERE id = ?').bind(taskId).run();
    return res.meta.changes > 0;
  }

  async deleteTaskByUuid(uuid, userId) {
    const res = await this._db.prepare(
      'DELETE FROM scheduled_messages WHERE uuid = ? AND user_id = ?'
    ).bind(uuid, userId).run();
    return res.meta.changes > 0;
  }

  async getPendingTasks(limit = 50) {
    const res = await this._db.prepare(
      `SELECT id, user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count
       FROM scheduled_messages
       WHERE status = 'pending' AND next_send_at <= ?
       ORDER BY next_send_at ASC
       LIMIT ?`
    ).bind(this._now(), limit).all();
    return res.results || [];
  }

  async listTasks(userId, opts = {}) {
    const { status = 'all', limit = 20, offset = 0 } = opts;
    const conditions = ['user_id = ?'];
    const params = [userId];
    if (status !== 'all') {
      conditions.push('status = ?');
      params.push(status);
    }
    const where = conditions.join(' AND ');

    const countRow = await this._db.prepare(
      `SELECT COUNT(*) as count FROM scheduled_messages WHERE ${where}`
    ).bind(...params).first();
    const total = Number(countRow.count) || 0;

    const res = await this._db.prepare(
      `SELECT id, user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count, created_at, updated_at
       FROM scheduled_messages
       WHERE ${where}
       ORDER BY next_send_at ASC
       LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    return { tasks: res.results || [], total };
  }

  async cleanupOldTasks(days = 7) {
    const safeDays = Math.max(1, Math.floor(Number(days)));
    const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
    const res = await this._db.prepare(
      `DELETE FROM scheduled_messages
       WHERE status IN ('sent', 'failed') AND updated_at < ?`
    ).bind(cutoff).run();
    return res.meta.changes || 0;
  }

  async getTaskStatus(uuid, userId) {
    const row = await this._db.prepare(
      'SELECT status FROM scheduled_messages WHERE uuid = ? AND user_id = ? LIMIT 1'
    ).bind(uuid, userId).first();
    return row ? row.status : null;
  }

  // ── client_state (single-user cloud state mirror) ──────────────────────

  /**
   * Batch upsert. Last-write-wins per (namespace, key): an entry older
   * than the stored row (updatedAt strictly lower) is skipped; equal or
   * newer overwrites. Values arrive pre-encrypted (the handler encrypts).
   *
   * Uses D1's batch() — one network round trip for the whole set (implicit
   * transaction). The client calls this endpoint inside its few-seconds
   * background window, so N sequential round trips could eat the whole
   * window. Bindings without batch() (e.g. the sqlite test shim, custom
   * adapters) fall back to a sequential loop.
   *
   * @param {string} userId
   * @param {Array<{ namespace: string, key: string, value: string, updatedAt: number }>} entries
   * @returns {Promise<{ upserted: number, skipped: number }>}
   */
  async upsertClientState(userId, entries) {
    const UPSERT_SQL =
      `INSERT INTO client_state (user_id, namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, namespace, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= client_state.updated_at`;

    let results;
    if (typeof this._db.batch === 'function') {
      const statements = entries.map((entry) =>
        this._db.prepare(UPSERT_SQL).bind(userId, entry.namespace, entry.key, entry.value, entry.updatedAt)
      );
      results = await this._db.batch(statements);
    } else {
      results = [];
      for (const entry of entries) {
        results.push(
          await this._db.prepare(UPSERT_SQL).bind(userId, entry.namespace, entry.key, entry.value, entry.updatedAt).run()
        );
      }
    }

    let upserted = 0;
    let skipped = 0;
    for (const res of results) {
      if (res.meta.changes > 0) upserted++; else skipped++;
    }
    return { upserted, skipped };
  }

  /**
   * All entries of one namespace (values still encrypted).
   *
   * @param {string} userId
   * @param {string} namespace
   * @returns {Promise<Array<{ namespace: string, key: string, value: string, updated_at: number }>>}
   */
  async getClientState(userId, namespace) {
    const res = await this._db.prepare(
      `SELECT namespace, key, value, updated_at
       FROM client_state
       WHERE user_id = ? AND namespace = ?
       ORDER BY key ASC`
    ).bind(userId, namespace).all();
    return res.results || [];
  }

  /**
   * Wipe every entry of this user.
   *
   * @param {string} userId
   * @returns {Promise<number>} rows deleted
   */
  async clearClientState(userId) {
    const res = await this._db.prepare('DELETE FROM client_state WHERE user_id = ?').bind(userId).run();
    return res.meta.changes || 0;
  }
}

/**
 * Create a D1 adapter from a Cloudflare D1 binding (env.DB).
 * @param {{ prepare: (sql: string) => any }} db
 * @returns {import('./interface.js').DbAdapter}
 */
export function createD1Adapter(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('[amsg-server] createD1Adapter requires a D1 database binding (env.DB)');
  }
  return new D1Adapter(db);
}
