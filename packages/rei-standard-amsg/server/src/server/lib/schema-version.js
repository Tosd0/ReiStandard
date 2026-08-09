/**
 * Schema 自查与补齐。
 *
 * 建表语句是 `CREATE TABLE IF NOT EXISTS`，已经存在的表不会被改动，后加的列
 * 靠 `initSchema()` 里的 ALTER 补。库升级之后没人再跑一次 `initSchema()` 的
 * 话，老部署的表就停在旧形状上：cron 每分钟挂在缺的那一列上，任务一条都不
 * 发，而前端界面一切正常——挂在哪、要不要修，谁也看不出来。
 *
 * 这两个函数把「我需要什么 / 现在是什么 / 帮我补齐」露出来：
 *   - `getSchemaVersion(db)` 只读，回报够不够用、缺什么；
 *   - `ensureSchema(db)` 缺什么就跑一次 `initSchema()` 补上。
 *
 * 什么时候调、缺了怎么提示用户，由调用方决定——库这边不会在每次请求里偷偷
 * 迁移。`POST /init-tenant` 的行为也照旧（它内部同样是跑 `initSchema()`）。
 */

import { SQLITE_REQUIRED_SCHEMA } from '../adapters/schema.sqlite.js';

/**
 * 表结构自己的版本号，只在表 / 列 / 关键索引变化时抬，与包版本各走各的。
 * 数值取自引入当前这套表结构的那条发布线。
 */
export const SCHEMA_VERSION = '2.6.0';

/**
 * @typedef {Object} SchemaVersionResult
 * @property {string|null} current - 活库当前满足的版本：够用就是 `SCHEMA_VERSION`，
 *   缺东西就是 `null`（只知道不够用，不知道它停在哪一版）
 * @property {string} required - 这一版代码需要的表结构版本
 * @property {boolean} ok - 需要的表 / 列 / 关键索引是不是都在
 * @property {string[]} missing - 缺什么，形如 `'table:message_outbox'` /
 *   `'column:scheduled_messages.last_error'` / `'index:uidx_uuid'`。整张表缺席
 *   时只报这一张表，不再逐列展开。`ok` 为 true 时是空数组
 */

/**
 * @typedef {SchemaVersionResult & { migrated: boolean, schema: Object|null }} EnsureSchemaResult
 * @property {boolean} migrated - 这次有没有真的跑 `initSchema()`（本来就够用 → false）
 * @property {Object|null} schema - `initSchema()` 的返回（没跑 → null）
 */

function requireIntrospection(db) {
  if (!db || typeof db.describeSchema !== 'function') {
    throw new Error(
      '[amsg-server] 这个数据库适配器不支持 schema 自查（没实现 describeSchema）。'
      + '内置适配器里目前只有 D1 实现了它。'
    );
  }
}

/**
 * 活库的表结构够不够这一版代码用。只读，不改任何东西。
 *
 * @param {import('../adapters/interface.js').DbAdapter} db - 数据库适配器
 *   （要实现 `describeSchema()`；内置的 D1 适配器实现了）
 * @returns {Promise<SchemaVersionResult>}
 */
export async function getSchemaVersion(db) {
  requireIntrospection(db);
  const live = await db.describeSchema();
  const liveTables = (live && live.tables) || {};
  const liveIndexes = new Set((live && live.indexes) || []);

  const missing = [];
  for (const [table, columns] of Object.entries(SQLITE_REQUIRED_SCHEMA.tables)) {
    const liveColumns = liveTables[table];
    if (!liveColumns) {
      // 整张表都没有，逐列再报一遍只是噪音。
      missing.push(`table:${table}`);
      continue;
    }
    const present = new Set(liveColumns);
    for (const column of columns) {
      if (!present.has(column)) missing.push(`column:${table}.${column}`);
    }
  }
  for (const index of SQLITE_REQUIRED_SCHEMA.indexes) {
    if (!liveIndexes.has(index)) missing.push(`index:${index}`);
  }

  const ok = missing.length === 0;
  return { current: ok ? SCHEMA_VERSION : null, required: SCHEMA_VERSION, ok, missing };
}

/**
 * 缺什么补什么：自查一遍，不够用就跑一次 `initSchema()`（建表 + 补列 + 建索
 * 引，重复跑没事），再自查一遍把结果回报出去。
 *
 * 本来就够用时不跑——`initSchema()` 是好几个来回，能省则省。
 *
 * @param {import('../adapters/interface.js').DbAdapter} db - 数据库适配器
 * @returns {Promise<EnsureSchemaResult>} 补齐之后的自查结果；`migrated` 说明这
 *   次有没有真的动手。补完仍然 `ok: false`（例如 ALTER 被库拒了）时 `missing`
 *   里还留着没补上的那几项
 */
export async function ensureSchema(db) {
  const before = await getSchemaVersion(db);
  if (before.ok) return { ...before, migrated: false, schema: null };

  const schema = await db.initSchema();
  const after = await getSchemaVersion(db);
  return { ...after, migrated: true, schema };
}
