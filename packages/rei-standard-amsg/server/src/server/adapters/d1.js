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
  SQLITE_ALL_INDEXES,
  SQLITE_MIGRATIONS,
  CLIENT_STATE_TABLE_SQL,
  PUSH_SUBSCRIPTION_TABLE_SQL,
  LLM_CREDENTIALS_TABLE_SQL,
  MESSAGE_OUTBOX_TABLE_SQL
} from './schema.sqlite.js';
// 列名不分方言：可写列的白名单、任务行的两套 SELECT 列集，三个适配器共用
// schema.js 里的这一份，加列只改一处。
import { UPDATABLE_COLUMNS, TASK_DELIVERY_COLUMNS, TASK_DETAIL_COLUMNS } from './schema.js';

/**
 * 「key 以 prefix 开头」的字典序上界：`key >= prefix AND key < prefixRangeEnd(prefix)`。
 *
 * 上界的算法是把 prefix 的最后一个码位换成它的下一个码位。SQLite 的默认排序
 * （BINARY）按 UTF-8 字节比大小，而 UTF-8 的字节序与码位序一致，所以这样得到
 * 的正是「所有以 prefix 开头的字符串」之后紧邻的那个位置，不多不少。
 * client_state 的 key 列是普通 TEXT、没有 COLLATE NOCASE（见
 * adapters/schema.sqlite.js 的 CLIENT_STATE_TABLE_SQL），这个前提成立。
 *
 * 两种码位没有「下一个」，退一步改前一个码位：
 *   - U+D7FF：+1 会落进代理区（U+D800-U+DFFF），那不是合法字符，直接跨到 U+E000；
 *   - U+10FFFF：已经是最大码位，没有下一个，改前一个码位（不会多删——以
 *     U+10FFFF 开头的那批本来就排在同前缀那一族的最后面）。
 * 一路退到空串表示这个 prefix 没有上界，范围条件因此一行都匹配不上；宁可少删
 * 留下几行孤儿切片，也不能多删把别的 key 的切片带走。实际用到的 prefix 结尾固
 * 定是 \u001f（见 lib/state-chunks.js 的 SEP），这两条走不到，写全只是为了以后
 * 换分隔符时不出意外。
 *
 * @param {string} prefix
 * @returns {string} 上界；空串表示没有上界
 */
function prefixRangeEnd(prefix) {
  const points = Array.from(prefix); // 按码位切，别把代理对劈成两半
  while (points.length > 0) {
    const cp = points[points.length - 1].codePointAt(0);
    if (cp === 0xd7ff) {
      points[points.length - 1] = String.fromCodePoint(0xe000);
      return points.join('');
    }
    if (cp < 0x10ffff) {
      points[points.length - 1] = String.fromCodePoint(cp + 1);
      return points.join('');
    }
    points.pop();
  }
  return '';
}

// D1 单条语句最多 100 个绑定参数，第 101 个直接报 `too many SQL variables`
// （D1_ERROR 7500），语句根本执行不了。这个数算的是**整条语句**的参数总数，
// 不只是 IN (...) 里那部分。
const D1_MAX_BOUND_PARAMS = 100;

/**
 * 把要塞进 IN (...) 的一串值按 D1 的绑定参数上限切批。
 *
 * 额度按语句实际算、不是写死一批 100 个：每条语句除了 IN 列表还有自己的固定
 * 参数（`user_id = ?`、`SET acked_at = ?` 这些），可用额度是
 * `D1_MAX_BOUND_PARAMS - 固定参数个数`。所以同样 200 个 id，只有 `user_id`
 * 一个固定参数的 DELETE 切成 99+99+2，多一个 SET 的 UPDATE 切成 98+98+4。
 *
 * @param {unknown[]} values - IN 列表里的值
 * @param {number} fixedParams - 同一条语句里除 IN 列表之外的绑定参数个数
 * @returns {unknown[][]} 每批一个数组；values 为空时返回空数组
 */
function chunkForBoundParams(values, fixedParams) {
  const perStatement = D1_MAX_BOUND_PARAMS - fixedParams;
  if (perStatement < 1) {
    throw new Error(
      `[amsg-server D1] 固定参数已占满 ${D1_MAX_BOUND_PARAMS} 个绑定位，IN 列表放不下`
    );
  }
  const batches = [];
  for (let i = 0; i < values.length; i += perStatement) {
    batches.push(values.slice(i, i + perStatement));
  }
  return batches;
}

// 库里除了本库建的表，还有两类内部表：SQLite 自己的（`sqlite_` 开头）和
// Cloudflare 塞进 D1 的（`_cf_` 开头，新建的库自带一张 `_cf_KV`）。它们都不属于
// 本库的 schema，describeSchema() 要跳过。
//
// `_cf_` 这一类还有更硬的理由：对它跑 `PRAGMA table_info` 会被 D1 的 authorizer
// 直接拒掉（`D1_ERROR: not authorized: SQLITE_AUTH`），异常会把整个
// describeSchema() 带崩，schema 自查跟着一起废。新建的库自带 `_cf_KV`、早先建的
// 老库没有，症状因此是「新部署的后端必挂、老部署反而一切正常」。
//
// 判断放在 JS 侧、不写进 SQL 的 WHERE：LIKE 里的 `_` 是「任意单个字符」通配符，
// `NOT LIKE '_cf_%'` 会顺手吃掉 `acfg_notes` 这类正常表名，要写对还得额外挂
// ESCAPE 子句。用 startsWith 就没有这层坑。
const INTERNAL_TABLE_PREFIXES = ['sqlite_', '_cf_'];

function isInternalTableName(name) {
  return INTERNAL_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix));
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

  /**
   * 组一组带 `IN (...)` 的语句：值多到一条塞不下时，按 D1 的绑定参数上限切成
   * 几条（见 chunkForBoundParams）。
   *
   * 只有拿得到事务的绑定才切。没有 batch() 的绑定（测试 shim、自定义适配器，
   * 都不是真实 D1）原样发一条不切的语句：切批是为 D1 那条上限服务的，这类绑
   * 定不受它约束，切了反倒会因为没有事务而多出一个「写一半」的中间态。
   *
   * @private
   * @param {(placeholders: string) => string} buildSql - 拿占位符串（`?, ?, ?`）组 SQL
   * @param {unknown[]} leadingParams - IN 列表之前的固定参数，按出现顺序
   * @param {unknown[]} values - IN 列表里的全部值
   * @returns {any[]} 已经 bind 好的语句
   */
  _prepareInClauseStatements(buildSql, leadingParams, values) {
    const batches = typeof this._db.batch === 'function'
      ? chunkForBoundParams(values, leadingParams.length)
      : [values];
    return batches.map((batch) => this._db
      .prepare(buildSql(batch.map(() => '?').join(', ')))
      .bind(...leadingParams, ...batch));
  }

  /**
   * 带 `IN (...)` 的批量写，切成几条也仍然是一次原子操作。
   *
   * 一条语句本来天然原子，拆开之后这份保证得自己补回来，否则就会多出「只删掉
   * 前 99 个」「只 ack 了前 98 条」这类比原问题更难查的中间态。D1 的 batch()
   * 是隐式事务——其中一条失败，整批回滚——正好接住这件事。
   *
   * 一条就够时照旧单发，跟切批以前走的是同一条路，常见调用（一次三五个 id）
   * 的行为一个字节都没变。
   *
   * @private
   * @param {(placeholders: string) => string} buildSql
   * @param {unknown[]} leadingParams
   * @param {unknown[]} values
   * @returns {Promise<number>} 各批影响行数之和
   */
  async _runInClauseWrite(buildSql, leadingParams, values) {
    const statements = this._prepareInClauseStatements(buildSql, leadingParams, values);
    if (statements.length === 0) return 0;
    if (statements.length === 1) {
      const res = await statements[0].run();
      return res.meta.changes || 0;
    }
    const results = await this._db.batch(statements);
    return results.reduce((n, res) => n + (res.meta.changes || 0), 0);
  }

  async initSchema() {
    await this._db.prepare(SQLITE_TABLE_SQL).run();
    await this._db.prepare(CLIENT_STATE_TABLE_SQL).run();
    await this._db.prepare(PUSH_SUBSCRIPTION_TABLE_SQL).run();
    await this._db.prepare(LLM_CREDENTIALS_TABLE_SQL).run();
    await this._db.prepare(MESSAGE_OUTBOX_TABLE_SQL).run();

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

    // 三张表的索引一起建（scheduled_messages / client_state / message_outbox）。
    // 全是 IF NOT EXISTS，老部署重跑一次 initSchema 就把后加的索引补上了。
    const indexResults = [];
    for (const index of SQLITE_ALL_INDEXES) {
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
      columnsCreated: 13,
      indexesCreated: indexResults.filter((r) => r.status === 'success').length,
      indexesFailed: indexResults.filter((r) => r.status === 'failed').length,
      columns: [],
      indexes: indexResults
    };
  }

  /**
   * 活库里现在实际有哪些表 / 列 / 索引。
   *
   * 只读不写，纯粹如实回报：拿它跟这一版需要的清单对照的活儿在
   * lib/schema-version.js（`getSchemaVersion` / `ensureSchema`）。库升级后表结
   * 构变了而老部署没跑过 initSchema 时，cron 会每分钟静默挂在缺的那一列上，
   * 界面上一切正常——这个方法就是让宿主查得出来。
   *
   * @returns {Promise<{ tables: Record<string, string[]>, indexes: string[] }>}
   */
  async describeSchema() {
    const tableRes = await this._db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'`
    ).all();

    /** @type {Record<string, string[]>} */
    const tables = {};
    for (const row of tableRes.results || []) {
      const name = String(row.name ?? '');
      // SQLite / Cloudflare 的内部表跳过，理由见 INTERNAL_TABLE_PREFIXES。
      if (isInternalTableName(name)) continue;
      // PRAGMA 不接受绑定参数，表名只能拼进去。名字来自 sqlite_master（我们自己
      // 建的表），仍按标识符白名单过一道，拼接里不留任何余地。
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      const columnRes = await this._db.prepare(`PRAGMA table_info(${name})`).all();
      tables[name] = (columnRes.results || []).map((column) => column.name);
    }

    const indexRes = await this._db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name IS NOT NULL`
    ).all();

    return { tables, indexes: (indexRes.results || []).map((row) => row.name) };
  }

  async dropSchema() {
    await this._db.prepare('DROP TABLE IF EXISTS scheduled_messages').run();
    await this._db.prepare('DROP TABLE IF EXISTS client_state').run();
    await this._db.prepare('DROP TABLE IF EXISTS push_subscriptions').run();
    await this._db.prepare('DROP TABLE IF EXISTS llm_credentials').run();
    await this._db.prepare('DROP TABLE IF EXISTS message_outbox').run();
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

  /**
   * 建新任务的同时取消旧的那条（`POST /schedule-message` 的 supersedesUuid）。
   *
   * 两条语句走一次 batch（D1 的隐式事务 + 单次网络往返）：不会出现「旧的删了、
   * 新的没建成」的中间态——INSERT 撞 uuid 唯一索引时整个 batch 回滚，旧行原样
   * 留着，调用方按既有的 409 冲突路径处理。
   *
   * @param {import('./interface.js').InsertTaskParams} params
   * @param {string} supersedesUuid - 要取消的旧任务 uuid（同一 user_id 下）
   * @returns {Promise<Object>} createTask 的返回行 + `superseded`（旧行是否
   *   真的被删掉；false = 旧行本就不存在）
   */
  async createTaskSuperseding(params, supersedesUuid) {
    const now = this._now();
    const nextSendAt = this._iso(params.next_send_at);
    const statements = [
      this._db.prepare(
        'DELETE FROM scheduled_messages WHERE uuid = ? AND user_id = ?'
      ).bind(supersedesUuid, params.user_id),
      this._db.prepare(
        `INSERT INTO scheduled_messages
          (user_id, uuid, encrypted_payload, next_send_at, message_type, status, retry_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`
      ).bind(params.user_id, params.uuid, params.encrypted_payload, nextSendAt, params.message_type, now, now),
    ];

    let results;
    if (typeof this._db.batch === 'function') {
      results = await this._db.batch(statements);
    } else {
      // 没有 batch() 的绑定退回顺序执行——失去原子性，但语义一致。
      results = [];
      for (const stmt of statements) results.push(await stmt.run());
    }

    const superseded = (results[0].meta.changes || 0) > 0;
    const id = results[1].meta.last_row_id;
    const row = await this._db.prepare(
      'SELECT id, uuid, next_send_at, status, created_at FROM scheduled_messages WHERE id = ?'
    ).bind(id).first();
    return { ...row, superseded };
  }

  async getTaskByUuid(uuid, userId) {
    return this._db.prepare(
      `SELECT ${TASK_DETAIL_COLUMNS}
       FROM scheduled_messages
       WHERE uuid = ? AND user_id = ? AND status = 'pending'
       LIMIT 1`
    ).bind(uuid, userId).first();
  }

  async getTaskByUuidOnly(uuid) {
    return this._db.prepare(
      `SELECT ${TASK_DELIVERY_COLUMNS}
       FROM scheduled_messages
       WHERE uuid = ? AND status = 'pending'
       LIMIT 1`
    ).bind(uuid).first();
  }

  /**
   * 这条 uuid 现在是什么状态——不限用户，也不限状态（getTaskByUuidOnly 只看
   * pending 行）。`runTask` 用它把「这条已经跑完了」和「压根没这条」分开回报。
   *
   * @param {string} uuid
   * @returns {Promise<{ status: string }|null>}
   */
  async getTaskStatusByUuidOnly(uuid) {
    const row = await this._db.prepare(
      'SELECT status FROM scheduled_messages WHERE uuid = ? LIMIT 1'
    ).bind(uuid).first();
    return row ? { status: row.status } : null;
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
      `SELECT ${TASK_DELIVERY_COLUMNS}
       FROM scheduled_messages
       WHERE status = 'pending' AND next_send_at <= ?
         AND (lease_until IS NULL OR lease_until <= ?)
         AND (retry_after IS NULL OR retry_after <= ?)
       ORDER BY next_send_at ASC
       LIMIT ?`
    ).bind(now, now, now, limit).all();
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
   * 带 serializeGroup 时多一道分组门：同一分组里已经有别的行拿着未到期的租
   * 约，这条就领不走（同一分组同时只跑一条）。判定和写租约在同一条 UPDATE
   * 里完成，「先查再占」的空档天然不存在——两个 tick 同时来，只有一个改得动
   * 行。分组门只看租约，不看 `retry_after`：等着重试的任务其实闲着，不该把
   * 同分组的其他任务一起堵住。
   *
   * @param {number} taskId
   * @param {string} expectedNextSendAt - 读这行时拿到的 next_send_at 原值
   * @param {string|Date} leaseUntil - 租期末尾
   * @param {string|null} [serializeGroup] - 串行分组标识；空表示不参与分组串行
   * @returns {Promise<boolean>} true = 领到了；false = 别人正拿着租约、同分组
   *   有任务正在跑、排期被改过、或行已不是 pending
   */
  async claimTask(taskId, expectedNextSendAt, leaseUntil, serializeGroup = null) {
    const expected = typeof expectedNextSendAt === 'string'
      ? expectedNextSendAt
      : this._iso(expectedNextSendAt);
    const grouped = typeof serializeGroup === 'string' && serializeGroup.length > 0;
    const now = this._now();

    const sets = ['lease_until = ?'];
    const values = [this._iso(leaseUntil)];
    if (grouped) {
      sets.push('serialize_group = ?');
      values.push(serializeGroup);
    }
    sets.push('updated_at = ?');
    values.push(now);

    let where =
      `id = ? AND status = 'pending' AND next_send_at = ?
          AND (lease_until IS NULL OR lease_until <= ?)`;
    values.push(taskId, expected, now);
    if (grouped) {
      where +=
        `
          AND NOT EXISTS (
            SELECT 1 FROM scheduled_messages busy
             WHERE busy.serialize_group = ? AND busy.id <> ?
               AND busy.status = 'pending' AND busy.lease_until > ?
          )`;
      values.push(serializeGroup, taskId, now);
    }

    const res = await this._db.prepare(
      `UPDATE scheduled_messages SET ${sets.join(', ')} WHERE ${where}`
    ).bind(...values).run();
    return (res.meta.changes || 0) > 0;
  }

  /**
   * 投递期间的租约续期（run-tick 的心跳用）。只在行仍是 pending 且确实持有
   * 租约（lease_until 非空）时生效——收尾把租约放掉之后，迟到的心跳不会把
   * 租约复活。
   *
   * @param {number} taskId
   * @param {string|Date} leaseUntil - 新的租期末尾
   * @returns {Promise<boolean>} true = 续上了
   */
  async renewTaskLease(taskId, leaseUntil) {
    const res = await this._db.prepare(
      `UPDATE scheduled_messages SET lease_until = ?
       WHERE id = ? AND status = 'pending' AND lease_until IS NOT NULL`
    ).bind(this._iso(leaseUntil), taskId).run();
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
      `SELECT ${TASK_DETAIL_COLUMNS}
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

  /**
   * 状态 + 失败摘要（GET /message 用它把「为什么失败」透给已失败的行——那些
   * 行 getTaskByUuid 读不到，payload 里的 lastError 也就够不着了）。
   *
   * @param {string} uuid
   * @param {string} userId
   * @returns {Promise<{ status: string, last_error: string|null }|null>}
   */
  async getTaskStatusInfo(uuid, userId) {
    const row = await this._db.prepare(
      'SELECT status, last_error FROM scheduled_messages WHERE uuid = ? AND user_id = ? LIMIT 1'
    ).bind(uuid, userId).first();
    return row ? { status: row.status, last_error: row.last_error ?? null } : null;
  }

  // ── client_state (single-user cloud state mirror) ──────────────────────

  /**
   * Batch upsert. Last-write-wins per (namespace, key): an entry older
   * than the stored row (updatedAt strictly lower) is skipped; equal or
   * newer overwrites. Values arrive pre-encrypted (the handler encrypts).
   *
   * 例外是「来自未来」的行：`updated_at` 晚于服务端当前时间的行一律放行覆盖。
   * 比较值是客户端自己报的时间戳，设备时钟只要领先过真实时间（用户改过系统
   * 时间、时区或日期误操作），那一刻同步上来的行就带着一个还没到的时刻；之后
   * 这台设备发什么都比它「旧」，条件写全被无声跳过，云端那行要等真实时间追上
   * 去才解得开——客户端删本地数据、重装都碰不到它。合法写入不可能来自未来，
   * 所以这种行按脏数据处理：服务端的钟是可信的那一个，拿它当判据放行。一次
   * 正常写入就把 `updated_at` 拉回现实，之后旧不盖新照常生效。
   *
   * `cleanups` 是删除项：在同一 batch 里先于 upsert 执行，`updated_at <= ?`
   * 条件保证陈旧批次删不动更新写入的行（同样对未来时间戳的行放行，否则删一条
   * 状态时切片行留在库里成孤儿）。两种形态——
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
   * @param {number} [now] - 服务端当前时刻（epoch 毫秒），判定「这行来自未来」用的
   *   就是它。调用方（lib/client-state-store.js）传下来，测试可以钉住一个假时钟；
   *   自定义调用方不传时退回本机时钟。
   * @returns {Promise<{ upserted: number, skipped: number, outcomes: boolean[], cleanupOutcomes?: Array<boolean|null> }>}
   *   `outcomes[i]` 对应 entries[i] 是否真的写入（changes > 0）。
   *   `cleanupOutcomes[i]` 对应 cleanups[i]（传了 cleanups 才有）：精确 key 形态
   *   回 `true` = 这个 key 的行已经不在（删掉了，或本来就没有）、`false` = 行还在
   *   （库里那行更新，删除被条件写拦下）；前缀形态不探测，回 `null`。
   */
  async upsertClientState(userId, entries, cleanups = [], now = Date.now()) {
    // 条件写的第二个分支 `client_state.updated_at > ?`（? = 服务端当前时刻）是
    // 时钟跑偏的解锁口：库里那行标着一个还没到的时刻，它就不是可信的比较基准，
    // 这次写入直接放行。注意这里不去钳制调用方给的时间戳（改写成
    // `min(客户端值, 服务端 now)`）——entry 的 `version` 护栏允许是「毫秒时间戳
    // 或单调递增版本号」两种语义，钳制会把后者压坏；改写调用方给的值也更侵入。
    // 放行脏行已经够解开死锁：一次正常写入就把 updated_at 拉回现实，之后自愈。
    const UPSERT_SQL =
      `INSERT INTO client_state (user_id, namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, namespace, key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= client_state.updated_at
          OR client_state.updated_at > ?`;
    // 前缀匹配走字典序范围（`key >= prefix AND key < 上界`），不用 LIKE：
    //   - D1 把 LIKE pattern 的长度上限压到了 50 字节（SQLite 默认 50000，官方
    //     文档没写这一条）。pattern 是「key + 分隔符 + %」再加上转义字符，key
    //     一到 49 字符就超限，整条语句报 `LIKE or GLOB pattern too complex`。
    //     batch() 是原子的，这一炸同批的 upsert 全部回滚——库自己声明 key 可以
    //     写到 256 字符（lib/client-state-store.js 的 MAX_KEY_CHARS），实际却
    //     只有 48 能落库。范围比较没有任何长度上限。
    //   - 范围条件能直接吃 (user_id, namespace, key) 主键索引，LIKE 和
    //     substr(key, 1, ?) = ? 都得逐行算。
    //   - 前缀里的 % _ \ 不再是通配符，转义那一层跟着一起去掉了。
    // 两条清理同样要给未来时间戳的行开口子，否则跑偏那阵写下的切片行谁也删不
    // 掉，根行覆盖成小值之后留一堆读不出来的孤儿。
    const CLEANUP_PREFIX_SQL =
      `DELETE FROM client_state
       WHERE user_id = ? AND namespace = ? AND key >= ? AND key < ?
         AND (updated_at <= ? OR updated_at > ?)`;
    const CLEANUP_KEY_SQL =
      `DELETE FROM client_state
       WHERE user_id = ? AND namespace = ? AND key = ?
         AND (updated_at <= ? OR updated_at > ?)`;

    // 精确 key 的删除后面紧跟一条探针：这个 key 的行还在不在。DELETE 的 changes
    // 为 0 分不清「本来就没有」和「被条件写拦下」，探针分得清——删完行还在，
    // 就是库里那行更新、这次删除没生效。主键点查，最多读一行。前缀形态（切片
    // 行清理）不探：没人消费它的结果，每条多一条语句白花。
    const PROBE_KEY_SQL =
      `SELECT COUNT(*) AS n FROM client_state
       WHERE user_id = ? AND namespace = ? AND key = ?`;

    // 每行都是一条独立的 prepare（不是把多行拼进一条语句），加上 now 之后单条
    // 最多 6 个绑定参数，离 D1 单条语句 100 个参数的上限很远。
    // 顺序：cleanups（精确 key 的每条后面跟一条探针）→ entries 的 upsert。
    const statements = [];
    /** cleanups[i] 的探针在 results 里的下标；前缀形态没有探针，记 null。 */
    const probeIndexes = [];
    for (const c of cleanups) {
      if (typeof c.key === 'string') {
        statements.push(this._db.prepare(CLEANUP_KEY_SQL).bind(userId, c.namespace, c.key, c.updatedAt, now));
        probeIndexes.push(statements.length);
        statements.push(this._db.prepare(PROBE_KEY_SQL).bind(userId, c.namespace, c.key));
      } else {
        statements.push(
          this._db.prepare(CLEANUP_PREFIX_SQL)
            .bind(userId, c.namespace, c.keyPrefix, prefixRangeEnd(c.keyPrefix), c.updatedAt, now)
        );
        probeIndexes.push(null);
      }
    }
    const upsertStart = statements.length;
    for (const entry of entries) {
      statements.push(
        this._db.prepare(UPSERT_SQL).bind(userId, entry.namespace, entry.key, entry.value, entry.updatedAt, now)
      );
    }

    let results;
    if (typeof this._db.batch === 'function') {
      results = await this._db.batch(statements);
    } else {
      results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
    }

    // cleanup 与探针不计入 upserted/skipped/outcomes，只看 entries 对应的语句。
    const outcomes = results.slice(upsertStart).map((res) => res.meta.changes > 0);
    let upserted = 0;
    let skipped = 0;
    for (const wrote of outcomes) {
      if (wrote) upserted++; else skipped++;
    }
    const result = { upserted, skipped, outcomes };
    if (cleanups.length > 0) {
      // 探针查出来还有行 → 删除被拦下（false）；没行了 → 这个 key 已不在（true）。
      result.cleanupOutcomes = probeIndexes.map((probeAt) => {
        if (probeAt === null) return null;
        const row = results[probeAt] && Array.isArray(results[probeAt].results) ? results[probeAt].results[0] : null;
        return Number(row?.n ?? 0) === 0;
      });
    }
    return result;
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
   * 例行清理：把指定命名空间下太久没更新的条目删掉（run-tick 每跳顺手调，
   * 宿主配了 `clientStateTtl` 才会调）。
   *
   * 不限用户——「这个命名空间只留最近 N 天」是命名空间级的约定，单用户部署
   * 下也就是这一个用户的行。指令由 lib/client-state-store.js 的
   * `planClientStateCleanup` 算好（含大值切片所在的保留命名空间），这里只负
   * 责照着删。
   *
   * @param {Array<{ namespace: string, updatedBefore: number }>} targets
   *   `updatedBefore` 是 epoch 毫秒，与 `updated_at` 列同一把尺子。
   * @returns {Promise<number>} 删掉的行数
   */
  async cleanupClientState(targets = []) {
    if (!Array.isArray(targets) || targets.length === 0) return 0;
    const SQL = 'DELETE FROM client_state WHERE namespace = ? AND updated_at < ?';
    const statements = targets.map((target) =>
      this._db.prepare(SQL).bind(target.namespace, target.updatedBefore)
    );
    let results;
    if (typeof this._db.batch === 'function') {
      results = await this._db.batch(statements);
    } else {
      results = [];
      for (const statement of statements) results.push(await statement.run());
    }
    return results.reduce((sum, res) => sum + (res.meta.changes || 0), 0);
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

  // ── llm_credentials (user-level LLM API credentials) ───────────────────

  /**
   * 批量 upsert 这个用户的凭据（value 已是密文，加密在上层）。已存在的行
   * 覆盖 encrypted_value 并刷 updated_at，created_at 保留首次写入的时刻。
   *
   * @param {string} userId
   * @param {Array<{ credId: string, encryptedValue: string }>} entries
   * @returns {Promise<number>} 实际写入/覆盖的行数
   */
  async upsertLlmCredentials(userId, entries) {
    if (!entries || entries.length === 0) return 0;
    const now = this._now();
    const SQL =
      `INSERT INTO llm_credentials (user_id, cred_id, encrypted_value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, cred_id) DO UPDATE SET
         encrypted_value = excluded.encrypted_value,
         updated_at = excluded.updated_at`;
    const statements = entries.map((entry) =>
      this._db.prepare(SQL).bind(userId, entry.credId, entry.encryptedValue, now, now)
    );
    let results;
    if (typeof this._db.batch === 'function') {
      results = await this._db.batch(statements);
    } else {
      results = [];
      for (const stmt of statements) results.push(await stmt.run());
    }
    return results.reduce((n, res) => n + ((res.meta.changes || 0) > 0 ? 1 : 0), 0);
  }

  /**
   * 按 cred_id 批量读这个用户的凭据行（`encrypted_value` 是密文，解密在上
   * 层）。排程时的存在性检查和 fire 时的解析共用这一个口。
   *
   * @param {string} userId
   * @param {string[]} credIds
   * @returns {Promise<Array<{ cred_id: string, encrypted_value: string, updated_at: string }>>}
   */
  async getLlmCredentials(userId, credIds) {
    if (!credIds || credIds.length === 0) return [];
    // 读不走 _runInClauseWrite：分批读没有「写一半」那种中间态，用不上事务。
    const statements = this._prepareInClauseStatements(
      (placeholders) =>
        `SELECT cred_id, encrypted_value, updated_at
         FROM llm_credentials
         WHERE user_id = ? AND cred_id IN (${placeholders})`,
      [userId],
      credIds
    );
    const rows = [];
    for (const stmt of statements) {
      const res = await stmt.all();
      rows.push(...(res.results || []));
    }
    return rows;
  }

  /**
   * 这个用户名下所有凭据的对账清单（只有 cred_id 和 updated_at，密文不出
   * 这个方法）。按 cred_id 排序，输出稳定。
   *
   * @param {string} userId
   * @returns {Promise<Array<{ cred_id: string, updated_at: string }>>}
   */
  async listLlmCredentials(userId) {
    const res = await this._db.prepare(
      `SELECT cred_id, updated_at FROM llm_credentials
       WHERE user_id = ? ORDER BY cred_id ASC`
    ).bind(userId).all();
    return res.results || [];
  }

  /**
   * 删凭据。`credIds` 传数组删指定那几行；传 null 删这个用户的全部
   * （「清空云端数据」用）。
   *
   * @param {string} userId
   * @param {string[]|null} credIds
   * @returns {Promise<number>} 删掉的行数
   */
  async deleteLlmCredentials(userId, credIds = null) {
    if (credIds !== null && credIds.length === 0) return 0;
    if (credIds === null) {
      const res = await this._db.prepare(
        'DELETE FROM llm_credentials WHERE user_id = ?'
      ).bind(userId).run();
      return res.meta.changes || 0;
    }
    return this._runInClauseWrite(
      (placeholders) => `DELETE FROM llm_credentials WHERE user_id = ? AND cred_id IN (${placeholders})`,
      [userId],
      credIds
    );
  }

  // ── message_outbox（服务端消息收件箱，客户端 ack）────────────────────────

  /**
   * 发送前把这一批 push 落进 outbox（一次 batch）。(user_id, message_id)
   * 唯一：重试同一 occurrence 带着同一批 messageId 再来时更新 payload、不加
   * 第二行；客户端已经 ack 过的行不动（ack 是终态，重试不该把它拉回未读）。
   *
   * @param {string} userId
   * @param {Array<{ message_id: string, task_uuid?: string|null, session_id?: string|null,
   *   message_index?: number|null, total_messages?: number|null, payload: string, created_at: number }>} rows
   *   `payload` 是整条 push JSON 的 encryptForStorage 密文。
   * @returns {Promise<number>} 实际写入/更新的行数
   */
  async appendOutboxMessages(userId, rows) {
    if (!rows || rows.length === 0) return 0;
    const SQL =
      `INSERT INTO message_outbox
         (user_id, message_id, task_uuid, session_id, message_index, total_messages, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, message_id) DO UPDATE SET
         payload = excluded.payload,
         created_at = excluded.created_at,
         delivered_at = NULL
       WHERE message_outbox.acked_at IS NULL`;
    const statements = rows.map((r) =>
      this._db.prepare(SQL).bind(
        userId, r.message_id, r.task_uuid ?? null, r.session_id ?? null,
        r.message_index ?? null, r.total_messages ?? null, r.payload, r.created_at
      )
    );
    let results;
    if (typeof this._db.batch === 'function') {
      results = await this._db.batch(statements);
    } else {
      results = [];
      for (const stmt of statements) results.push(await stmt.run());
    }
    return results.reduce((n, res) => n + ((res.meta.changes || 0) > 0 ? 1 : 0), 0);
  }

  /**
   * 把这一批标记为「Web Push 已发出」。发送失败的段不标——delivered_at 为
   * null 的行正是客户端最需要拉的那部分。
   *
   * @param {string} userId
   * @param {string[]} messageIds
   * @param {number} deliveredAt - epoch 毫秒
   * @returns {Promise<number>}
   */
  async markOutboxDelivered(userId, messageIds, deliveredAt) {
    if (!messageIds || messageIds.length === 0) return 0;
    return this._runInClauseWrite(
      (placeholders) =>
        `UPDATE message_outbox SET delivered_at = ?
         WHERE user_id = ? AND message_id IN (${placeholders})`,
      [deliveredAt, userId],
      messageIds
    );
  }

  /**
   * 把这一批还没发出去的行删掉（任务投递到一半被取消 / 顶替时用）。
   *
   * 只删 delivered_at 仍为 NULL 的行：已经推给设备的那几条撤不回来，行留着让
   * 客户端照常 ack。已 ack 的行更不动。
   *
   * @param {string} userId
   * @param {string[]} messageIds
   * @returns {Promise<number>} 删掉的行数
   */
  async discardOutboxMessages(userId, messageIds) {
    if (!messageIds || messageIds.length === 0) return 0;
    return this._runInClauseWrite(
      (placeholders) =>
        `DELETE FROM message_outbox
         WHERE user_id = ? AND delivered_at IS NULL AND acked_at IS NULL
           AND message_id IN (${placeholders})`,
      [userId],
      messageIds
    );
  }

  /**
   * 把某条任务名下还没发出去的行一次删掉（取消 / 顶替时的 outbox 清理）。
   *
   * 判据与 discardOutboxMessages 相同：只删 delivered_at 与 acked_at 均为
   * NULL 的行——已经推给设备 / 已 ack 的照旧留着。按 task_uuid 直删是为了不
   * 受未 ack 积压量的影响：靠翻页扫描挑行的话，积压一大这条任务的行就落在
   * 扫描上限之外（见 lib/outbox-store.js 的 discardUndeliveredPushesForTask）。
   *
   * @param {string} userId
   * @param {string} taskUuid
   * @returns {Promise<number>} 删掉的行数
   */
  async discardUndeliveredOutboxForTask(userId, taskUuid) {
    const res = await this._db.prepare(
      `DELETE FROM message_outbox
       WHERE user_id = ? AND task_uuid = ? AND delivered_at IS NULL AND acked_at IS NULL`
    ).bind(userId, taskUuid).run();
    return res.meta.changes || 0;
  }

  /**
   * 未 ack 的行（id 升序，游标翻页）。payload 仍是密文，解密在 handler。
   *
   * @param {string} userId
   * @param {number} sinceId - 上一页游标（0 = 从头）
   * @param {number} limit
   * @returns {Promise<Array<{ id: number, message_id: string, task_uuid: string|null,
   *   session_id: string|null, message_index: number|null, total_messages: number|null,
   *   payload: string, created_at: number, delivered_at: number|null }>>}
   */
  async listUnackedOutbox(userId, sinceId = 0, limit = 50) {
    const res = await this._db.prepare(
      `SELECT id, message_id, task_uuid, session_id, message_index, total_messages, payload, created_at, delivered_at
       FROM message_outbox
       WHERE user_id = ? AND acked_at IS NULL AND id > ?
       ORDER BY id ASC
       LIMIT ?`
    ).bind(userId, sinceId, limit).all();
    return res.results || [];
  }

  /**
   * 客户端确认收到这一批（幂等：已 ack 的行再 ack 不动）。
   *
   * @param {string} userId
   * @param {string[]} messageIds
   * @param {number} ackedAt - epoch 毫秒
   * @returns {Promise<number>} 本次真正被 ack 的行数
   */
  async ackOutboxMessages(userId, messageIds, ackedAt) {
    if (!messageIds || messageIds.length === 0) return 0;
    return this._runInClauseWrite(
      (placeholders) =>
        `UPDATE message_outbox SET acked_at = ?
         WHERE user_id = ? AND acked_at IS NULL AND message_id IN (${placeholders})`,
      [ackedAt, userId],
      messageIds
    );
  }

  /**
   * outbox 的例行清理（run-tick 每跳顺手调）：已 ack 的行留短一些，未 ack 的
   * 也不无限留（Web Push TTL 上限四周，比它更老的推送谁也收不到了）。
   *
   * @param {{ ackedBeforeMs?: number, allBeforeMs?: number }} opts - epoch 毫秒阈值
   * @returns {Promise<number>} 删掉的行数
   */
  async cleanupOutbox({ ackedBeforeMs, allBeforeMs } = {}) {
    let deleted = 0;
    if (Number.isFinite(ackedBeforeMs)) {
      const res = await this._db.prepare(
        'DELETE FROM message_outbox WHERE acked_at IS NOT NULL AND acked_at < ?'
      ).bind(ackedBeforeMs).run();
      deleted += res.meta.changes || 0;
    }
    if (Number.isFinite(allBeforeMs)) {
      const res = await this._db.prepare(
        'DELETE FROM message_outbox WHERE created_at < ?'
      ).bind(allBeforeMs).run();
      deleted += res.meta.changes || 0;
    }
    return deleted;
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
