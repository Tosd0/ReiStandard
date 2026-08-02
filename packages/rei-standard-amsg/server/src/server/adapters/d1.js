/**
 * Cloudflare D1 (SQLite) Database Adapter.
 *
 * @implements {import('./interface.js').DbAdapter}
 *
 * Timestamps are stored as ISO8601 UTC TEXT. Every timestamp is normalized
 * with new Date(v).toISOString() before store/compare so lexical ordering
 * equals chronological ordering (mixed offsets like +08:00 vs Z are unified).
 */

import {
  SQLITE_TABLE_SQL,
  SQLITE_INDEXES,
  SQLITE_MIGRATIONS,
  CLIENT_STATE_TABLE_SQL,
  PUSH_SUBSCRIPTION_TABLE_SQL
} from './schema.sqlite.js';

// Update methods build a dynamic SET clause from object keys. Callers pass only
// hardcoded column names today, but enforcing a whitelist keeps a future caller
// from ever turning a caller-supplied key into interpolated SQL.
const UPDATABLE_COLUMNS = new Set([
  'user_id', 'uuid', 'encrypted_payload', 'message_type',
  'next_send_at', 'lease_until', 'status', 'retry_count', 'created_at', 'updated_at'
]);

// LIKE 前缀转义：用户 key 里的 % _ \ 不能变成通配符/转义符。
function escapeLikePrefix(prefix) {
  return prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

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
    await this._db.prepare(PUSH_SUBSCRIPTION_TABLE_SQL).run();

    // SQLite 的 ALTER TABLE 没有 ADD COLUMN IF NOT EXISTS，列已经在了就会
    // 报 duplicate column name。那正是「这一步不用做」的意思，跳过即可；
    // 其他错误照常抛出去。
    for (const migration of SQLITE_MIGRATIONS) {
      try {
        await this._db.prepare(migration.sql).run();
      } catch (error) {
        if (!/duplicate column name/i.test(error.message || '')) throw error;
      }
    }

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
      columnsCreated: 11,
      indexesCreated: indexResults.filter((r) => r.status === 'success').length,
      indexesFailed: indexResults.filter((r) => r.status === 'failed').length,
      columns: [],
      indexes: indexResults
    };
  }

  async dropSchema() {
    await this._db.prepare('DROP TABLE IF EXISTS scheduled_messages').run();
    await this._db.prepare('DROP TABLE IF EXISTS client_state').run();
    await this._db.prepare('DROP TABLE IF EXISTS push_subscriptions').run();
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
    const now = this._now();
    const res = await this._db.prepare(
      `SELECT id, user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count
       FROM scheduled_messages
       WHERE status = 'pending' AND next_send_at <= ?
         AND (lease_until IS NULL OR lease_until <= ?)
       ORDER BY next_send_at ASC
       LIMIT ?`
    ).bind(now, now, limit).all();
    return res.results || [];
  }

  /**
   * 领取一条到点的任务：在 lease_until 上写下「这条归我管到什么时候」，
   * 本次投递期间别的 tick 领不走它。
   *
   * 租约写在自己的列上，next_send_at 全程不动——那一列是用户设的触发时刻，
   * 任务列表要读它、循环任务推进下一次也要拿它当基准。
   *
   * 两个 tick 抢同一行时只有一个能改到行，另一个拿到 changes = 0，据此跳过。
   * WHERE 里的两个条件各管一件事：
   *   - lease_until 为空或已过期：没人正在跑这条。领了任务的 tick 中途没了
   *     也不会把行焊死，租约到期后自然可以被接手。
   *   - next_send_at 等于读这行时看到的值：读出来之后用户又改了排期的话，
   *     这一跳就不该再按旧时刻发。
   *
   * 不加一个 'sending' 状态来表达「正在跑」：建表语句里 status 有
   * CHECK (status IN ('pending','sent','failed'))，加值要重建表。
   *
   * expectedNextSendAt 按读到的原样比对，不做时区归一化——老部署里可能还留
   * 着非归一化写法的行（如 +08:00 结尾），归一化后反而对不上，那条任务会永
   * 远领不到。
   *
   * @param {number} taskId
   * @param {string} expectedNextSendAt - 读这行时拿到的 next_send_at 原值
   * @param {string|Date} leaseUntil - 租期末尾
   * @returns {Promise<boolean>} true = 领到了；false = 别人正拿着租约、排期被改过、或行已不是 pending
   */
  async claimTask(taskId, expectedNextSendAt, leaseUntil) {
    const expected = typeof expectedNextSendAt === 'string'
      ? expectedNextSendAt
      : this._iso(expectedNextSendAt);
    const res = await this._db.prepare(
      `UPDATE scheduled_messages
          SET lease_until = ?, updated_at = ?
        WHERE id = ? AND status = 'pending' AND next_send_at = ?
          AND (lease_until IS NULL OR lease_until <= ?)`
    ).bind(this._iso(leaseUntil), this._now(), taskId, expected, this._now()).run();
    return (res.meta.changes || 0) > 0;
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
   * `cleanups` 是删除项：在同一 batch 里先于 upsert 执行，`updated_at <= ?`
   * 条件保证陈旧批次删不动更新写入的行。两种形态——
   *   - `{ namespace, keyPrefix, updatedAt }` 删 key 前缀下的所有行，用来清掉
   *     大值旧写入留下的切片行（见 lib/state-chunks.js）；
   *   - `{ namespace, key, updatedAt }` 删这一个 key，用来删整条状态（前缀会
   *     连带删掉同前缀的兄弟 key，删单条必须走精确匹配）。
   *
   * 删掉一整条状态就是这两种各来一条（切片行走前缀、根行走精确 key），
   * `entries` 传空数组即可——见 lib/client-state-store.js。
   *
   * Uses D1's batch() — one network round trip for the whole set (implicit
   * transaction). The client calls this endpoint inside its few-seconds
   * background window, so N sequential round trips could eat the whole
   * window. Bindings without batch() (e.g. the sqlite test shim, custom
   * adapters) fall back to a sequential loop.
   *
   * @param {string} userId
   * @param {Array<{ namespace: string, key: string, value: string, updatedAt: number }>} entries
   * @param {Array<{ namespace: string, key?: string, keyPrefix?: string, updatedAt: number }>} [cleanups]
   * @returns {Promise<{ upserted: number, skipped: number, outcomes: boolean[] }>}
   *   `outcomes[i]` 对应 entries[i] 是否真的写入（changes > 0）。
   */
  async upsertClientState(userId, entries, cleanups = []) {
    const UPSERT_SQL =
      `INSERT INTO client_state (user_id, namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, namespace, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= client_state.updated_at`;
    const CLEANUP_PREFIX_SQL =
      `DELETE FROM client_state
       WHERE user_id = ? AND namespace = ? AND key LIKE ? ESCAPE '\\' AND updated_at <= ?`;
    const CLEANUP_KEY_SQL =
      `DELETE FROM client_state
       WHERE user_id = ? AND namespace = ? AND key = ? AND updated_at <= ?`;

    const buildStatements = () => [
      ...cleanups.map((c) => (
        typeof c.key === 'string'
          ? this._db.prepare(CLEANUP_KEY_SQL).bind(userId, c.namespace, c.key, c.updatedAt)
          : this._db.prepare(CLEANUP_PREFIX_SQL).bind(userId, c.namespace, `${escapeLikePrefix(c.keyPrefix)}%`, c.updatedAt)
      )),
      ...entries.map((entry) =>
        this._db.prepare(UPSERT_SQL).bind(userId, entry.namespace, entry.key, entry.value, entry.updatedAt)
      ),
    ];

    let results;
    if (typeof this._db.batch === 'function') {
      results = await this._db.batch(buildStatements());
    } else {
      results = [];
      for (const stmt of buildStatements()) {
        results.push(await stmt.run());
      }
    }

    // cleanup 语句不计数：upserted/skipped/outcomes 只看 entries 对应的语句。
    const outcomes = results.slice(cleanups.length).map((res) => res.meta.changes > 0);
    let upserted = 0;
    let skipped = 0;
    for (const wrote of outcomes) {
      if (wrote) upserted++; else skipped++;
    }
    return { upserted, skipped, outcomes };
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

  // ── push_subscriptions (user-level Web Push subscription) ──────────────

  /**
   * 这个用户当前登记的推送订阅（密文原样返回，解密在上层）。
   *
   * @param {string} userId
   * @returns {Promise<{ subscription: string, updated_at: number }|null>}
   */
  async getPushSubscription(userId) {
    return this._db.prepare(
      'SELECT subscription, updated_at FROM push_subscriptions WHERE user_id = ? LIMIT 1'
    ).bind(userId).first();
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
    const res = await this._db.prepare(
      `INSERT INTO push_subscriptions (user_id, subscription, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         subscription = excluded.subscription,
         updated_at = excluded.updated_at`
    ).bind(userId, encryptedSubscription, updatedAt).run();
    return (res.meta.changes || 0) > 0;
  }

  /**
   * 删掉这个用户的订阅（设置页「停止接收推送」）。
   *
   * @param {string} userId
   * @returns {Promise<boolean>} true = 确实删掉了一行
   */
  async deletePushSubscription(userId) {
    const res = await this._db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').bind(userId).run();
    return (res.meta.changes || 0) > 0;
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
