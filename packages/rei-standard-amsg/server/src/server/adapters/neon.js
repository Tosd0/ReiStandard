/**
 * Neon Serverless Database Adapter
 *
 * @implements {import('./interface.js').DbAdapter}
 */

import { neon } from '@neondatabase/serverless';
import {
  TABLE_SQL,
  INDEXES,
  MIGRATIONS,
  PUSH_SUBSCRIPTION_TABLE_SQL,
  VERIFY_TABLE_SQL,
  COLUMNS_SQL,
  UPDATABLE_COLUMNS
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
    await sql.query(PUSH_SUBSCRIPTION_TABLE_SQL);
    for (const migration of MIGRATIONS) {
      await sql.query(migration.sql);
    }
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
    await sql.query('DROP TABLE IF EXISTS push_subscriptions CASCADE');
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
      `SELECT id, user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count, created_at, updated_at
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
      if (!UPDATABLE_COLUMNS.has(key)) {
        throw new Error(`[amsg-server neon] rejected unknown update column: ${key}`);
      }
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
        if (!UPDATABLE_COLUMNS.has(key)) {
          throw new Error(`[amsg-server neon] rejected unknown update column: ${key}`);
        }
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
         AND (lease_until IS NULL OR lease_until <= NOW())
         AND (retry_after IS NULL OR retry_after <= NOW())
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
   * 带 serializeGroup 时多一道分组门：同一分组里已经有别的行拿着未到期的租
   * 约，这条就领不走（同一分组同时只跑一条）。判定和写租约在同一条 UPDATE
   * 里完成，「先查再占」的空档天然不存在。分组门只看租约，不看
   * `retry_after`：等着重试的任务其实闲着，不该把同分组的其他任务一起堵住。
   *
   * @param {number} taskId
   * @param {string|Date} expectedNextSendAt - 读这行时拿到的 next_send_at 原值
   * @param {string|Date} leaseUntil - 租期末尾
   * @param {string|null} [serializeGroup] - 串行分组标识；空表示不参与分组串行
   * @returns {Promise<boolean>} true = 领到了；false = 别人正拿着租约、同分组
   *   有任务正在跑、排期被改过、或行已不是 pending
   */
  async claimTask(taskId, expectedNextSendAt, leaseUntil, serializeGroup = null) {
    const sql = this._getSql();
    const grouped = typeof serializeGroup === 'string' && serializeGroup.length > 0;
    const params = [leaseUntil, taskId, expectedNextSendAt];
    let setClause = 'lease_until = $1, updated_at = NOW()';
    let groupGuard = '';
    if (grouped) {
      params.push(serializeGroup); // $4
      setClause = 'lease_until = $1, serialize_group = $4, updated_at = NOW()';
      groupGuard = `
          AND NOT EXISTS (
            SELECT 1 FROM scheduled_messages busy
             WHERE busy.serialize_group = $4 AND busy.id <> $2
               AND busy.status = 'pending' AND busy.lease_until > NOW()
          )`;
    }
    const rows = await sql.query(
      `UPDATE scheduled_messages
          SET ${setClause}
        WHERE id = $2 AND status = 'pending'
          AND date_trunc('milliseconds', next_send_at)
            = date_trunc('milliseconds', $3::timestamptz)
          AND (lease_until IS NULL OR lease_until <= NOW())${groupGuard}
       RETURNING id`,
      params
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

  // ── push_subscriptions (user-level Web Push subscription) ──────────────

  /**
   * 这个用户当前登记的推送订阅（密文原样返回，解密在上层）。
   *
   * @param {string} userId
   * @returns {Promise<{ subscription: string, updated_at: number }|null>}
   */
  async getPushSubscription(userId) {
    const sql = this._getSql();
    const rows = await sql.query(
      'SELECT subscription, updated_at FROM push_subscriptions WHERE user_id = $1 LIMIT 1',
      [userId]
    );
    if (rows.length === 0) return null;
    // BIGINT 在 pg 驱动里读出来是字符串，统一成 number 再往上给。
    return { subscription: rows[0].subscription, updated_at: Number(rows[0].updated_at) };
  }

  /**
   * 覆盖写这个用户的订阅。一个用户一行，没有 last-write-wins 之类的比较——
   * 客户端拿到的新订阅永远比旧的有效，旧的那份只会 410。
   *
   * @param {string} userId
   * @param {string} encryptedSubscription
   * @param {number} updatedAt - epoch 毫秒
   * @returns {Promise<boolean>}
   */
  async upsertPushSubscription(userId, encryptedSubscription, updatedAt) {
    const sql = this._getSql();
    const rows = await sql.query(
      `INSERT INTO push_subscriptions (user_id, subscription, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET
         subscription = EXCLUDED.subscription,
         updated_at = EXCLUDED.updated_at
       RETURNING user_id`,
      [userId, encryptedSubscription, updatedAt]
    );
    return rows.length > 0;
  }

  /**
   * 删掉这个用户的订阅（设置页「停止接收推送」）。
   *
   * @param {string} userId
   * @returns {Promise<boolean>} true = 确实删掉了一行
   */
  async deletePushSubscription(userId) {
    const sql = this._getSql();
    const rows = await sql.query(
      'DELETE FROM push_subscriptions WHERE user_id = $1 RETURNING user_id',
      [userId]
    );
    return rows.length > 0;
  }
}
