/**
 * Neon Serverless Database Adapter
 * ReiStandard SDK v2.0.1
 *
 * @implements {import('./interface.js').DbAdapter}
 */

import { neon } from '@neondatabase/serverless';
import {
  TABLE_SQL,
  INDEXES,
  VERIFY_TABLE_SQL,
  COLUMNS_SQL
} from './schema.js';

export class NeonAdapter {
  /** @param {string} connectionString */
  constructor(connectionString) {
    /** @private */
    this._connectionString = connectionString;
    /** @private */
    this._sql = null;
  }

  /** @private */
  _getSql() {
    if (!this._sql) {
      this._sql = neon(this._connectionString);
    }
    return this._sql;
  }

  async initSchema() {
    const sql = this._getSql();

    await sql.query(TABLE_SQL);
    const indexResults = [];
    for (const index of INDEXES) {
      try {
        await sql.query(index.sql);
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

    const tableCheck = await sql.query(VERIFY_TABLE_SQL);
    if (tableCheck.length === 0) {
      throw new Error('Table creation verification failed');
    }
    const columns = await sql.query(COLUMNS_SQL);
    return {
      columnsCreated: columns.length,
      indexesCreated: indexResults.filter(r => r.status === 'success').length,
      indexesFailed: indexResults.filter(r => r.status === 'failed').length,
      columns: [
        ...columns.map(c => ({ table: 'scheduled_messages', name: c.column_name, type: c.data_type, nullable: c.is_nullable === 'YES' }))
      ],
      indexes: indexResults
    };
  }

  async dropSchema() {
    const sql = this._getSql();
    await sql.query('DROP TABLE IF EXISTS scheduled_messages CASCADE');
  }

  async createTask(params) {
    const sql = this._getSql();
    const rows = await sql.query(
      `INSERT INTO scheduled_messages
        (user_id, uuid, encrypted_payload, next_send_at, message_type, status, retry_count, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', 0, NOW(), NOW())
       RETURNING id, uuid, next_send_at, status, created_at`,
      [params.user_id, params.uuid, params.encrypted_payload, params.next_send_at, params.message_type]
    );
    return rows[0] || null;
  }

  async getTaskByUuid(uuid, userId) {
    const sql = this._getSql();
    const rows = await sql.query(
      `SELECT id, user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count
       FROM scheduled_messages
       WHERE uuid = $1 AND user_id = $2 AND status = 'pending'
       LIMIT 1`,
      [uuid, userId]
    );
    return rows[0] || null;
  }

  async getTaskByUuidOnly(uuid) {
    const sql = this._getSql();
    const rows = await sql.query(
      `SELECT id, user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count
       FROM scheduled_messages
       WHERE uuid = $1 AND status = 'pending'
       LIMIT 1`,
      [uuid]
    );
    return rows[0] || null;
  }

  async updateTaskById(taskId, updates) {
    const sql = this._getSql();
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

    const rows = await sql.query(
      `UPDATE scheduled_messages SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || null;
  }

  async updateTaskByUuid(uuid, userId, encryptedPayload, extraFields) {
    const sql = this._getSql();
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
    const rows = await sql.query(
      `UPDATE scheduled_messages SET ${sets.join(', ')}
       WHERE uuid = $${idx} AND user_id = $${idx + 1} AND status = 'pending'
       RETURNING uuid, updated_at`,
      values
    );
    return rows[0] || null;
  }

  async deleteTaskById(taskId) {
    const sql = this._getSql();
    const rows = await sql.query('DELETE FROM scheduled_messages WHERE id = $1 RETURNING id', [taskId]);
    return rows.length > 0;
  }

  async deleteTaskByUuid(uuid, userId) {
    const sql = this._getSql();
    const rows = await sql.query(
      'DELETE FROM scheduled_messages WHERE uuid = $1 AND user_id = $2 RETURNING id',
      [uuid, userId]
    );
    return rows.length > 0;
  }

  async getPendingTasks(limit = 50) {
    const sql = this._getSql();
    return sql.query(
      `SELECT id, user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count
       FROM scheduled_messages
       WHERE status = 'pending' AND next_send_at <= NOW()
       ORDER BY next_send_at ASC
       LIMIT $1`,
      [limit]
    );
  }

  /**
   * 领取一条到点的任务：把 next_send_at 顶到租期末尾，本次投递期间这一行
   * 对其他 tick 不再是「到点待发」。
   *
   * WHERE 里带上读这行时看到的 next_send_at，两个 tick 抢同一行时只有一个
   * 改得动，另一个拿不到 RETURNING 行，据此跳过。用 next_send_at 做比对值
   * 而不是加一个 'sending' 状态：status 上有 CHECK 约束，加值要改表。
   *
   * 两边都截到毫秒再比：列是 timestamptz（微秒精度），驱动读出来是 JS Date
   * （毫秒精度），原值送回去可能因为亚毫秒差对不上。
   *
   * @param {number} taskId
   * @param {string|Date} expectedNextSendAt - 读这行时拿到的 next_send_at 原值
   * @param {string|Date} leaseUntil - 租期末尾
   * @returns {Promise<boolean>} true = 领到了；false = 已被别人领走或行已不是 pending
   */
  async claimTask(taskId, expectedNextSendAt, leaseUntil) {
    const sql = this._getSql();
    const rows = await sql.query(
      `UPDATE scheduled_messages
          SET next_send_at = $1, updated_at = NOW()
        WHERE id = $2 AND status = 'pending'
          AND date_trunc('milliseconds', next_send_at)
            = date_trunc('milliseconds', $3::timestamptz)
       RETURNING id`,
      [leaseUntil, taskId, expectedNextSendAt]
    );
    return rows.length > 0;
  }

  async listTasks(userId, opts = {}) {
    const sql = this._getSql();
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

    const countRows = await sql.query(
      `SELECT COUNT(*) as count FROM scheduled_messages WHERE ${where}`,
      params
    );
    const total = parseInt(countRows[0].count, 10);

    const taskParams = [...params, limit, offset];
    const tasks = await sql.query(
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
    const sql = this._getSql();
    const safeDays = Math.max(1, Math.floor(Number(days)));
    const rows = await sql.query(
      `DELETE FROM scheduled_messages
       WHERE status IN ('sent', 'failed')
         AND updated_at < NOW() - make_interval(days => $1)
       RETURNING id`,
      [safeDays]
    );
    return rows.length;
  }

  async getTaskStatus(uuid, userId) {
    const sql = this._getSql();
    const rows = await sql.query(
      'SELECT status FROM scheduled_messages WHERE uuid = $1 AND user_id = $2 LIMIT 1',
      [uuid, userId]
    );
    return rows.length > 0 ? rows[0].status : null;
  }
}
