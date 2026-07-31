/**
 * PostgreSQL (pg) Database Adapter
 *
 * Uses the standard 'pg' npm package.
 *
 * @implements {import('./interface.js').DbAdapter}
 */

import { Pool } from 'pg';
import {
  TABLE_SQL,
  INDEXES,
  MIGRATIONS,
  VERIFY_TABLE_SQL,
  COLUMNS_SQL,
  UPDATABLE_COLUMNS
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
    for (const migration of MIGRATIONS) {
      await this._query(migration.sql);
    }
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
    const columns = await this._query(COLUMNS_SQL);
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
      if (!UPDATABLE_COLUMNS.has(key)) {
        throw new Error(`[amsg-server pg] rejected unknown update column: ${key}`);
      }
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
        if (!UPDATABLE_COLUMNS.has(key)) {
          throw new Error(`[amsg-server pg] rejected unknown update column: ${key}`);
        }
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
         AND (lease_until IS NULL OR lease_until <= NOW())
       ORDER BY next_send_at ASC
       LIMIT $1`,
      [limit]
    );
  }

  /**
   * 领取一条到点的任务：在 lease_until 上写下「这条归我管到什么时候」，
   * 本次投递期间别的 tick 领不走它。
   *
   * 租约写在自己的列上，next_send_at 全程不动——那一列是用户设的触发时刻，
   * 任务列表要读它、循环任务推进下一次也要拿它当基准。
   *
   * 两个 tick 抢同一行时只有一个改得动，另一个拿不到 RETURNING 行，据此跳
   * 过。WHERE 里的两个条件各管一件事：
   *   - lease_until 为空或已过期：没人正在跑这条。领了任务的 tick 中途没了
   *     也不会把行焊死，租约到期后自然可以被接手。
   *   - next_send_at 等于读这行时看到的值：读出来之后用户又改了排期的话，
   *     这一跳就不该再按旧时刻发。
   *
   * 不加一个 'sending' 状态来表达「正在跑」：status 上有 CHECK 约束，加值
   * 要改表。
   *
   * 比 next_send_at 时两边都截到毫秒：列是 timestamptz（微秒精度），驱动读
   * 出来是 JS Date（毫秒精度），原值送回去可能因为亚毫秒差对不上。
   *
   * @param {number} taskId
   * @param {string|Date} expectedNextSendAt - 读这行时拿到的 next_send_at 原值
   * @param {string|Date} leaseUntil - 租期末尾
   * @returns {Promise<boolean>} true = 领到了；false = 已被别人领走或行已不是 pending
   */
  async claimTask(taskId, expectedNextSendAt, leaseUntil) {
    const rows = await this._query(
      `UPDATE scheduled_messages
          SET lease_until = $1, updated_at = NOW()
        WHERE id = $2 AND status = 'pending'
          AND date_trunc('milliseconds', next_send_at)
            = date_trunc('milliseconds', $3::timestamptz)
          AND (lease_until IS NULL OR lease_until <= NOW())
       RETURNING id`,
      [leaseUntil, taskId, expectedNextSendAt]
    );
    return rows.length > 0;
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
}
