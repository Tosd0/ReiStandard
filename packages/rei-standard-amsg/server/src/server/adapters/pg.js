/**
 * PostgreSQL (pg) Database Adapter
 * ReiStandard SDK v1.1.0
 *
 * Uses the standard 'pg' npm package.
 *
 * @implements {import('./interface.js').DbAdapter}
 */

import { Pool } from 'pg';
import {
  TABLE_SQL,
  SYSTEM_CONFIG_SQL,
  INDEXES,
  VERIFY_TABLE_SQL,
  VERIFY_SYSTEM_CONFIG_SQL,
  COLUMNS_SQL,
  SYSTEM_CONFIG_COLUMNS_SQL
} from './schema.js';

export class PgAdapter {
  /** @param {string} connectionString */
  constructor(connectionString) {
    /** @private */
    this._connectionString = connectionString;
    /** @private */
    this._pool = null;
  }

  /** @private */
  _getPool() {
    if (!this._pool) {
      this._pool = new Pool({ connectionString: this._connectionString });
    }
    return this._pool;
  }

  /** @private */
  async _query(text, params) {
    const pool = this._getPool();
    const result = await pool.query(text, params);
    return result.rows;
  }

  async initSchema() {
    await this._query(TABLE_SQL);
    await this._query(SYSTEM_CONFIG_SQL);

    const indexResults = [];
    for (const index of INDEXES) {
      try {
        await this._query(index.sql);
        indexResults.push({
          name: index.name,
          status: 'success',
          description: index.description,
          critical: !!index.critical
        });
      } catch (error) {
        indexResults.push({
          name: index.name,
          status: 'failed',
          description: index.description,
          critical: !!index.critical,
          error: error.message
        });
      }
    }

    const criticalFailures = indexResults.filter((index) => index.critical && index.status === 'failed');
    if (criticalFailures.length > 0) {
      const failedNames = criticalFailures.map((index) => index.name).join(', ');
      throw new Error(
        `Critical index creation failed (${failedNames}). ` +
        'Please remove duplicate UUID rows and run initSchema again.'
      );
    }

    const tableCheck = await this._query(VERIFY_TABLE_SQL);
    if (tableCheck.length === 0) {
      throw new Error('Table creation verification failed');
    }
    const systemConfigCheck = await this._query(VERIFY_SYSTEM_CONFIG_SQL);
    if (systemConfigCheck.length === 0) {
      throw new Error('system_config table creation verification failed');
    }

    const columns = await this._query(COLUMNS_SQL);
    const systemConfigColumns = await this._query(SYSTEM_CONFIG_COLUMNS_SQL);

    return {
      columnsCreated: columns.length + systemConfigColumns.length,
      indexesCreated: indexResults.filter(r => r.status === 'success').length,
      indexesFailed: indexResults.filter(r => r.status === 'failed').length,
      columns: [
        ...columns.map(c => ({ table: 'scheduled_messages', name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES' })),
        ...systemConfigColumns.map(c => ({ table: 'system_config', name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES' }))
      ],
      indexes: indexResults
    };
  }

  async dropSchema() {
    await this._query('DROP TABLE IF EXISTS scheduled_messages CASCADE');
  }

  async createTask(params) {
    const rows = await this._query(
      `INSERT INTO scheduled_messages
        (user_id, uuid, encrypted_payload, next_send_at, message_type, status, retry_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', 0, NOW(), NOW())
       RETURNING id, uuid, next_send_at, status, created_at`,
      [params.user_id, params.uuid, params.encrypted_payload, params.next_send_at, params.message_type]
    );
    return rows[0] || null;
  }

  async getTaskByUuid(uuid, userId) {
    const rows = await this._query(
      `SELECT id, user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count
       FROM scheduled_messages
       WHERE uuid = $1 AND user_id = $2 AND status = 'pending'
       LIMIT 1`,
      [uuid, userId]
    );
    return rows[0] || null;
  }

  async getTaskByUuidOnly(uuid) {
    const rows = await this._query(
      `SELECT id, user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count
       FROM scheduled_messages
       WHERE uuid = $1 AND status = 'pending'
       LIMIT 1`,
      [uuid]
    );
    return rows[0] || null;
  }

  async updateTaskById(taskId, updates) {
    const sets = [];
    const values = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      sets.push(`${key} = $${idx}`);
      values.push(value);
      idx++;
    }

    sets.push('updated_at = NOW()');
    values.push(taskId);

    const rows = await this._query(
      `UPDATE scheduled_messages SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || null;
  }

  async updateTaskByUuid(uuid, userId, encryptedPayload, extraFields) {
    const sets = ['encrypted_payload = $1', 'updated_at = NOW()'];
    const values = [encryptedPayload];
    let idx = 2;

    if (extraFields) {
      for (const [key, value] of Object.entries(extraFields)) {
        sets.push(`${key} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    values.push(uuid, userId);
    const rows = await this._query(
      `UPDATE scheduled_messages SET ${sets.join(', ')}
       WHERE uuid = $${idx} AND user_id = $${idx + 1} AND status = 'pending'
       RETURNING uuid, updated_at`,
      values
    );
    return rows[0] || null;
  }

  async deleteTaskById(taskId) {
    const rows = await this._query('DELETE FROM scheduled_messages WHERE id = $1 RETURNING id', [taskId]);
    return rows.length > 0;
  }

  async deleteTaskByUuid(uuid, userId) {
    const rows = await this._query(
      'DELETE FROM scheduled_messages WHERE uuid = $1 AND user_id = $2 RETURNING id',
      [uuid, userId]
    );
    return rows.length > 0;
  }

  async getPendingTasks(limit = 50) {
    return this._query(
      `SELECT id, user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count
       FROM scheduled_messages
       WHERE status = 'pending' AND next_send_at <= NOW()
       ORDER BY next_send_at ASC
       LIMIT $1`,
      [limit]
    );
  }

  async listTasks(userId, opts = {}) {
    const { status = 'all', limit = 20, offset = 0 } = opts;

    const conditions = ['user_id = $1'];
    const params = [userId];
    let idx = 2;

    if (status !== 'all') {
      conditions.push(`status = $${idx}`);
      params.push(status);
      idx++;
    }

    const where = conditions.join(' AND ');

    const countRows = await this._query(
      `SELECT COUNT(*) as count FROM scheduled_messages WHERE ${where}`,
      params
    );
    const total = parseInt(countRows[0].count, 10);

    const taskParams = [...params, limit, offset];
    const tasks = await this._query(
      `SELECT id, user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count, created_at, updated_at
       FROM scheduled_messages
       WHERE ${where}
       ORDER BY next_send_at ASC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      taskParams
    );

    return { tasks, total };
  }

  async cleanupOldTasks(days = 7) {
    const safeDays = Math.max(1, Math.floor(Number(days)));
    const rows = await this._query(
      `DELETE FROM scheduled_messages
       WHERE status IN ('sent', 'failed')
         AND updated_at < NOW() - make_interval(days => $1)
       RETURNING id`,
      [safeDays]
    );
    return rows.length;
  }

  async getTaskStatus(uuid, userId) {
    const rows = await this._query(
      'SELECT status FROM scheduled_messages WHERE uuid = $1 AND user_id = $2 LIMIT 1',
      [uuid, userId]
    );
    return rows.length > 0 ? rows[0].status : null;
  }

  async getMasterKey() {
    const rows = await this._query(
      `SELECT value
       FROM system_config
       WHERE key = 'master_key'
       LIMIT 1`
    );
    return rows.length > 0 ? rows[0].value : null;
  }

  async setMasterKeyOnce(masterKey) {
    const rows = await this._query(
      `INSERT INTO system_config (key, value, created_at, updated_at)
       VALUES ('master_key', $1, NOW(), NOW())
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [masterKey]
    );
    return rows.length > 0;
  }
}
