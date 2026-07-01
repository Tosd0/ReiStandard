# amsg-server 单用户 · Cloudflare Worker 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `@rei-standard/amsg-server` 能以「单用户」模式跑在一个 Cloudflare Worker 上：定时消息存 D1，cron 用 CF Cron Trigger，绕过多租户注册表 / Blob / token。

**Architecture:** 只替换 tenant-context 层——单用户版 context 从 env+binding 直接给出 `{ db: D1adapter, masterKey, tenantId:'single' }`，接口和多租户版同构，5 个业务 handler（schedule/messages/update/cancel/user-key）一行不改直接复用。D1 adapter 实现现有 13 方法的 `DbAdapter` 接口（SQLite 方言）。定时批处理内核抽成 `runScheduledTick` 纯函数，CF `scheduled()` 直接调。Web Push 因为 `web-push` npm 在 Worker 上跑不了，复用 instant 的纯 Web Crypto 实现。

**Tech Stack:** Node.js ESM、Cloudflare Workers（D1 + Cron Triggers）、`node --test`、better-sqlite3（测试用 D1 兼容后端）、Web Crypto（RFC 8291/8292 Web Push、constant-time 比较）。

**设计稿：** `docs/superpowers/specs/2026-07-01-amsg-single-user-cloudflare-design.md`

---

## 文件结构

包内路径都相对 `packages/rei-standard-amsg/`。

**新增（server 包）**
| 文件 | 职责 |
|---|---|
| `server/src/server/adapters/schema.sqlite.js` | SQLite 方言的建表 + 索引 SQL 常量 |
| `server/src/server/adapters/d1.js` | D1 adapter：实现 13 个 `DbAdapter` 方法 + `createD1Adapter(db)` |
| `server/src/server/lib/constant-time.js` | 可移植 constant-time 字符串比较（Node + Worker 都能跑） |
| `server/src/server/tenant/single-user-context.js` | 单用户 context manager（`resolveTenant` / `initializeTenant`） |
| `server/src/server/handlers/single-user-init.js` | 单用户建表路由（只跑 `initSchema`，不复用多租户 init） |
| `server/src/server/single-user.js` | `createSingleUserServer(config)` 组装 handlers |
| `server/src/server/lib/run-tick.js` | `runScheduledTick(ctx)` 定时批处理内核（从 send-notifications 抽出） |
| `server/src/server/lib/webpush-webcrypto.js` | 从 instant 移植的纯 Web Crypto Web Push + `createWebCryptoWebPush(vapid)` 包装 |
| `server/src/server/lib/webcrypto-utils.js` | 从 instant 移植的 Web Crypto 工具函数（webpush-webcrypto 依赖） |
| `server/src/server/cloudflare/single-user-worker.js` | `createSingleUserCloudflareWorker(buildConfig)` → `{ fetch, scheduled }` |
| `server/examples/cloudflare-single-user/worker.js` | 示例 Worker 入口（薄接线） |
| `server/examples/cloudflare-single-user/wrangler.toml` | D1 binding + cron trigger 配置 |
| `server/examples/cloudflare-single-user/schema.sql` | 命令行建表脚本 |
| `server/examples/cloudflare-single-user/README.md` | 部署跑通说明 |
| `server/test/helpers/sqlite-d1.mjs` | 测试用：better-sqlite3 上的 D1 兼容 shim |
| `server/test/*.test.mjs` | 各单元测试 |

**改动**
| 文件 | 改动 |
|---|---|
| `server/src/server/handlers/send-notifications.js` | 批处理内核换成调 `runScheduledTick` |
| `server/src/server/index.js` | 导出 `createSingleUserServer` / `createD1Adapter` / `createWebCryptoWebPush` / `runScheduledTick` / `createSingleUserCloudflareWorker` |
| `server/package.json` | devDependencies 加 `better-sqlite3` |
| `client/src/index.js` | `ReiClientConfig` 加 `serverToken`；5 条 server 路径带 `X-Client-Token` |
| `client/package.json` | 加 `test` 脚本（若无） |

**关键约定（读源码确认过，实现时照此）**
- Handler 是普通函数，返回 `{ status, body }` 明文对象，**每个方法的入参约定不同**：
  - `getUserKey.GET(url, headers)`、`messages.GET(url, headers)`、`cancelMessage.DELETE(url, headers)`
  - `scheduleMessage.POST(headers, body)`、`singleUserInit.POST(headers, body)`
  - `updateMessage.PUT(url, headers, body)`
- `resolveTenant(headers, options?)` 返回 `{ ok:true, context:{ tenantId, tokenType, db, masterKey } }` 或 `{ ok:false, error:{ status, body } }`。
- D1 binding API：`db.prepare(sql).bind(...p).run()` → `{ meta:{ changes, last_row_id } }`；`.first()` → 单行或 null；`.all()` → `{ results:[...] }`。
- 时间戳在 SQLite 里存 TEXT（ISO8601 UTC）；adapter 写入/比较前一律 `new Date(v).toISOString()` 归一化，保证字典序=时间序。
- uuid 唯一冲突：D1 报 `UNIQUE constraint failed`，现有 `isUniqueViolation()` 已匹配 `"unique constraint"` 子串 → 冲突自动变 409，无需改动。

---

## Task 1: 测试用 D1 兼容 shim（better-sqlite3）

**Files:**
- Modify: `packages/rei-standard-amsg/server/package.json`（devDependencies 加 better-sqlite3）
- Create: `packages/rei-standard-amsg/server/test/helpers/sqlite-d1.mjs`
- Test: `packages/rei-standard-amsg/server/test/sqlite-d1-shim.test.mjs`

- [ ] **Step 1: 装 better-sqlite3 到 server 包**

Run（在仓库根目录）:
```bash
npm install better-sqlite3 --workspace @rei-standard/amsg-server --save-dev
```
Expected: `server/package.json` 的 `devDependencies` 出现 `better-sqlite3`，根 `package-lock.json` 更新。

- [ ] **Step 2: 写 shim**

Create `packages/rei-standard-amsg/server/test/helpers/sqlite-d1.mjs`:
```js
/**
 * Test-only D1-compatible wrapper over an in-memory better-sqlite3 database.
 * Exposes the subset of the Cloudflare D1 binding API the adapter uses:
 *   db.prepare(sql).bind(...params).run() / .first() / .all()
 * so adapter tests exercise real SQLite (real SQL, real constraints).
 */
import Database from 'better-sqlite3';

export function createTestD1() {
  const db = new Database(':memory:');

  function prepare(sql) {
    let bound = [];
    const stmt = {
      bind(...args) {
        bound = args;
        return stmt;
      },
      async run() {
        const info = db.prepare(sql).run(...bound);
        return { success: true, meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
      },
      async first() {
        const row = db.prepare(sql).get(...bound);
        return row === undefined ? null : row;
      },
      async all() {
        const rows = db.prepare(sql).all(...bound);
        return { success: true, results: rows, meta: {} };
      }
    };
    return stmt;
  }

  return {
    prepare,
    _raw: db,
    close() {
      db.close();
    }
  };
}
```

- [ ] **Step 3: 写 shim 自测**

Create `packages/rei-standard-amsg/server/test/sqlite-d1-shim.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/sqlite-d1.mjs';

test('sqlite-d1 shim returns D1-shaped run/first/all results', async () => {
  const db = createTestD1();
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)').run();

  const ins = await db.prepare('INSERT INTO t (v) VALUES (?)').bind('hello').run();
  assert.equal(ins.meta.changes, 1);
  assert.equal(typeof ins.meta.last_row_id, 'number');

  const row = await db.prepare('SELECT v FROM t WHERE id = ?').bind(ins.meta.last_row_id).first();
  assert.equal(row.v, 'hello');

  const missing = await db.prepare('SELECT v FROM t WHERE id = ?').bind(9999).first();
  assert.equal(missing, null);

  const list = await db.prepare('SELECT * FROM t').all();
  assert.equal(list.results.length, 1);

  db.close();
});
```

- [ ] **Step 4: 跑测试**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: PASS，包含 `sqlite-d1 shim returns D1-shaped run/first/all results`。

- [ ] **Step 5: 提交**

```bash
git add packages/rei-standard-amsg/server/package.json packages/rei-standard-amsg/server/test/helpers/sqlite-d1.mjs packages/rei-standard-amsg/server/test/sqlite-d1-shim.test.mjs package-lock.json
git commit -m "test(amsg): 加 D1 兼容 shim（better-sqlite3）供 adapter 测试"
```

---

## Task 2: SQLite 方言 schema 常量

**Files:**
- Create: `packages/rei-standard-amsg/server/src/server/adapters/schema.sqlite.js`
- Test: `packages/rei-standard-amsg/server/test/schema-sqlite.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `packages/rei-standard-amsg/server/test/schema-sqlite.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLITE_TABLE_SQL, SQLITE_INDEXES } from '../src/server/adapters/schema.sqlite.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';

test('SQLITE_TABLE_SQL uses SQLite dialect', () => {
  assert.match(SQLITE_TABLE_SQL, /INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(SQLITE_TABLE_SQL, /next_send_at TEXT NOT NULL/);
  assert.doesNotMatch(SQLITE_TABLE_SQL, /SERIAL/);
  assert.doesNotMatch(SQLITE_TABLE_SQL, /TIMESTAMP WITH TIME ZONE/);
});

test('SQLITE_INDEXES defines the 5 indexes incl. the critical unique guard', () => {
  assert.equal(SQLITE_INDEXES.length, 5);
  const uidx = SQLITE_INDEXES.find((i) => i.name === 'uidx_uuid');
  assert.ok(uidx && uidx.critical === true);
});

test('schema applies cleanly on real SQLite', async () => {
  const db = createTestD1();
  await db.prepare(SQLITE_TABLE_SQL).run();
  for (const index of SQLITE_INDEXES) {
    await db.prepare(index.sql).run();
  }
  // CHECK constraint rejects a bad status
  await assert.rejects(
    db.prepare(
      `INSERT INTO scheduled_messages (user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count, created_at, updated_at)
       VALUES ('u', 'x', 'p', 'fixed', '2026-01-01T00:00:00.000Z', 'bogus', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
    ).run()
  );
  db.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: FAIL，`Cannot find module '../src/server/adapters/schema.sqlite.js'`。

- [ ] **Step 3: 写 schema 常量**

Create `packages/rei-standard-amsg/server/src/server/adapters/schema.sqlite.js`:
```js
/**
 * SQLite (Cloudflare D1) dialect schema for scheduled_messages.
 *
 * Differences from the Postgres schema (adapters/schema.js):
 *   - id: INTEGER PRIMARY KEY AUTOINCREMENT (vs SERIAL)
 *   - timestamps stored as TEXT ISO8601 UTC (vs TIMESTAMP WITH TIME ZONE)
 *   - no NOW()/DEFAULT; the adapter always writes timestamps explicitly
 * Partial indexes and CHECK constraints are native to SQLite, so they carry over.
 */

export const SQLITE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS scheduled_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    uuid TEXT,
    encrypted_payload TEXT NOT NULL,
    message_type TEXT NOT NULL CHECK (message_type IN ('fixed', 'prompted', 'auto', 'instant')),
    next_send_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`;

export const SQLITE_INDEXES = [
  {
    name: 'idx_pending_tasks_optimized',
    sql: `CREATE INDEX IF NOT EXISTS idx_pending_tasks_optimized
          ON scheduled_messages (status, next_send_at, id, retry_count)
          WHERE status = 'pending'`,
    critical: false
  },
  {
    name: 'idx_cleanup_completed',
    sql: `CREATE INDEX IF NOT EXISTS idx_cleanup_completed
          ON scheduled_messages (status, updated_at)
          WHERE status IN ('sent', 'failed')`,
    critical: false
  },
  {
    name: 'idx_failed_retry',
    sql: `CREATE INDEX IF NOT EXISTS idx_failed_retry
          ON scheduled_messages (status, retry_count, next_send_at)
          WHERE status = 'failed' AND retry_count < 3`,
    critical: false
  },
  {
    name: 'idx_user_id',
    sql: `CREATE INDEX IF NOT EXISTS idx_user_id
          ON scheduled_messages (user_id)`,
    critical: false
  },
  {
    name: 'uidx_uuid',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uidx_uuid
          ON scheduled_messages (uuid)
          WHERE uuid IS NOT NULL`,
    critical: true
  }
];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: PASS（3 个 schema 测试全过）。

- [ ] **Step 5: 提交**

```bash
git add packages/rei-standard-amsg/server/src/server/adapters/schema.sqlite.js packages/rei-standard-amsg/server/test/schema-sqlite.test.mjs
git commit -m "feat(amsg): D1 用的 SQLite 方言 schema 常量"
```

---

## Task 3: D1 adapter（13 方法）

**Files:**
- Create: `packages/rei-standard-amsg/server/src/server/adapters/d1.js`
- Modify: `packages/rei-standard-amsg/server/src/server/index.js`（导出 `createD1Adapter`）
- Test: `packages/rei-standard-amsg/server/test/d1-adapter.test.mjs`

- [ ] **Step 1: 写失败测试（覆盖全 13 方法 + 时间归一化 + uuid 唯一）**

Create `packages/rei-standard-amsg/server/test/d1-adapter.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';

async function freshAdapter() {
  const db = createTestD1();
  const adapter = createD1Adapter(db);
  await adapter.initSchema();
  return { adapter, db };
}

function baseTask(overrides = {}) {
  return {
    user_id: USER,
    uuid: overrides.uuid || 'uuid-1',
    encrypted_payload: 'enc',
    next_send_at: overrides.next_send_at || '2026-01-01T00:00:00.000Z',
    message_type: overrides.message_type || 'fixed'
  };
}

test('initSchema creates table and indexes', async () => {
  const { adapter } = await freshAdapter();
  const res = await adapter.initSchema(); // idempotent (IF NOT EXISTS)
  assert.equal(res.indexesFailed, 0);
  assert.equal(res.indexesCreated, 5);
});

test('createTask returns id/uuid/status/created_at and normalizes next_send_at', async () => {
  const { adapter } = await freshAdapter();
  // input uses +08:00 offset — must be normalized to Z form on store
  const row = await adapter.createTask(baseTask({ next_send_at: '2026-01-01T08:00:00+08:00' }));
  assert.equal(typeof row.id, 'number');
  assert.equal(row.uuid, 'uuid-1');
  assert.equal(row.status, 'pending');
  assert.equal(row.next_send_at, '2026-01-01T00:00:00.000Z');
});

test('getPendingTasks respects next_send_at <= now with mixed-offset inputs', async () => {
  const { adapter } = await freshAdapter();
  await adapter.createTask(baseTask({ uuid: 'due', next_send_at: '2020-01-01T00:00:00.000Z' }));      // past → due
  await adapter.createTask(baseTask({ uuid: 'future', next_send_at: '2999-01-01T00:00:00+00:00' }));   // future → not due
  const pending = await adapter.getPendingTasks(50);
  const uuids = pending.map((t) => t.uuid);
  assert.deepEqual(uuids, ['due']);
});

test('getTaskByUuid / getTaskByUuidOnly find pending tasks', async () => {
  const { adapter } = await freshAdapter();
  await adapter.createTask(baseTask({ uuid: 'a' }));
  assert.ok(await adapter.getTaskByUuid('a', USER));
  assert.equal(await adapter.getTaskByUuid('a', 'other-user'), null);
  assert.ok(await adapter.getTaskByUuidOnly('a'));
});

test('updateTaskById updates fields + bumps updated_at', async () => {
  const { adapter } = await freshAdapter();
  const row = await adapter.createTask(baseTask({ uuid: 'u' }));
  const updated = await adapter.updateTaskById(row.id, { status: 'failed', retry_count: 2 });
  assert.equal(updated.status, 'failed');
  assert.equal(updated.retry_count, 2);
});

test('updateTaskByUuid updates only pending rows and returns {uuid, updated_at}', async () => {
  const { adapter } = await freshAdapter();
  await adapter.createTask(baseTask({ uuid: 'u' }));
  const res = await adapter.updateTaskByUuid('u', USER, 'enc2', { next_send_at: '2027-01-01T00:00:00.000Z' });
  assert.equal(res.uuid, 'u');
  assert.ok(res.updated_at);
  assert.equal(await adapter.updateTaskByUuid('missing', USER, 'enc2'), null);
});

test('delete + getTaskStatus', async () => {
  const { adapter } = await freshAdapter();
  const row = await adapter.createTask(baseTask({ uuid: 'd' }));
  assert.equal(await adapter.getTaskStatus('d', USER), 'pending');
  assert.equal(await adapter.deleteTaskById(row.id), true);
  assert.equal(await adapter.deleteTaskById(row.id), false);
  assert.equal(await adapter.getTaskStatus('d', USER), null);
});

test('deleteTaskByUuid scoped to user', async () => {
  const { adapter } = await freshAdapter();
  await adapter.createTask(baseTask({ uuid: 'd2' }));
  assert.equal(await adapter.deleteTaskByUuid('d2', 'other'), false);
  assert.equal(await adapter.deleteTaskByUuid('d2', USER), true);
});

test('listTasks paginates and counts', async () => {
  const { adapter } = await freshAdapter();
  for (let i = 0; i < 3; i++) await adapter.createTask(baseTask({ uuid: `l${i}` }));
  const page = await adapter.listTasks(USER, { limit: 2, offset: 0 });
  assert.equal(page.total, 3);
  assert.equal(page.tasks.length, 2);
});

test('cleanupOldTasks removes only old sent/failed rows', async () => {
  const { adapter } = await freshAdapter();
  const row = await adapter.createTask(baseTask({ uuid: 'old' }));
  // mark sent with an updated_at far in the past
  await adapter.updateTaskById(row.id, { status: 'sent', updated_at: '2000-01-01T00:00:00.000Z' });
  const removed = await adapter.cleanupOldTasks(7);
  assert.equal(removed, 1);
});

test('uuid uniqueness violation surfaces as an error matched by isUniqueViolation', async () => {
  const { adapter } = await freshAdapter();
  await adapter.createTask(baseTask({ uuid: 'dup' }));
  await assert.rejects(
    adapter.createTask(baseTask({ uuid: 'dup' })),
    (err) => /unique constraint/i.test(err.message)
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: FAIL，`Cannot find module '../src/server/adapters/d1.js'`。

- [ ] **Step 3: 写 D1 adapter**

Create `packages/rei-standard-amsg/server/src/server/adapters/d1.js`:
```js
/**
 * Cloudflare D1 (SQLite) Database Adapter.
 *
 * @implements {import('./interface.js').DbAdapter}
 *
 * Timestamps are stored as ISO8601 UTC TEXT. Every timestamp is normalized
 * with new Date(v).toISOString() before store/compare so lexical ordering
 * equals chronological ordering (mixed offsets like +08:00 vs Z are unified).
 */

import { SQLITE_TABLE_SQL, SQLITE_INDEXES } from './schema.sqlite.js';

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

    const indexResults = [];
    for (const index of SQLITE_INDEXES) {
      try {
        await this._db.prepare(index.sql).run();
        indexResults.push({ name: index.name, status: 'success', critical: !!index.critical });
      } catch (error) {
        indexResults.push({ name: index.name, status: 'failed', critical: !!index.critical, error: error.message });
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
```

- [ ] **Step 4: 导出 createD1Adapter**

Modify `packages/rei-standard-amsg/server/src/server/index.js` — 在 `export { createAdapter } from './adapters/factory.js';` 那一行后面加：
```js
export { createD1Adapter } from './adapters/d1.js';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: PASS（d1-adapter 全部 11 个测试通过，含时间归一化与 uuid 唯一冲突）。

- [ ] **Step 6: 提交**

```bash
git add packages/rei-standard-amsg/server/src/server/adapters/d1.js packages/rei-standard-amsg/server/src/server/index.js packages/rei-standard-amsg/server/test/d1-adapter.test.mjs
git commit -m "feat(amsg): D1 (SQLite) adapter 实现 DbAdapter 全部方法"
```

---

## Task 4: 可移植 constant-time 比较

**Files:**
- Create: `packages/rei-standard-amsg/server/src/server/lib/constant-time.js`
- Test: `packages/rei-standard-amsg/server/test/constant-time.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `packages/rei-standard-amsg/server/test/constant-time.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constantTimeEqual } from '../src/server/lib/constant-time.js';

test('constantTimeEqual matches equal strings', async () => {
  assert.equal(await constantTimeEqual('secret-token', 'secret-token'), true);
});

test('constantTimeEqual rejects different strings', async () => {
  assert.equal(await constantTimeEqual('secret-token', 'wrong-token'), false);
});

test('constantTimeEqual rejects different lengths', async () => {
  assert.equal(await constantTimeEqual('abc', 'abcd'), false);
});

test('constantTimeEqual handles empty / non-string safely', async () => {
  assert.equal(await constantTimeEqual('', ''), true);
  assert.equal(await constantTimeEqual('x', ''), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: FAIL，`Cannot find module '.../constant-time.js'`。

- [ ] **Step 3: 写实现**

Create `packages/rei-standard-amsg/server/src/server/lib/constant-time.js`:
```js
/**
 * Portable constant-time string comparison.
 *
 * Runs identically on Node (tests) and Cloudflare Workers (prod). We avoid
 * both node:crypto's timingSafeEqual (undefined on Workers historically) and
 * crypto.subtle.timingSafeEqual (absent on Node). Instead we compare the
 * HMAC-SHA256 of each input under a fresh random key (the "double HMAC"
 * pattern): equal-length fixed digests, no early-out, length-independent.
 *
 * globalThis.crypto (Web Crypto) is available on Node >= 20 and on Workers.
 */
export async function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const da = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(String(a))));
  const db = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, enc.encode(String(b))));

  let diff = 0;
  for (let i = 0; i < da.length; i++) {
    diff |= da[i] ^ db[i];
  }
  return diff === 0;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/rei-standard-amsg/server/src/server/lib/constant-time.js packages/rei-standard-amsg/server/test/constant-time.test.mjs
git commit -m "feat(amsg): 可移植 constant-time 比较（Node + Worker 通用）"
```

---

## Task 5: 单用户 context manager

**Files:**
- Create: `packages/rei-standard-amsg/server/src/server/tenant/single-user-context.js`
- Test: `packages/rei-standard-amsg/server/test/single-user-context.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `packages/rei-standard-amsg/server/test/single-user-context.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleUserContextManager } from '../src/server/tenant/single-user-context.js';

const fakeDb = { async initSchema() { return { indexesCreated: 5, indexesFailed: 0 }; } };

test('no serverToken → open, resolves fixed single-user context', async () => {
  const mgr = createSingleUserContextManager({ db: fakeDb, masterKey: 'mk' });
  const res = await mgr.resolveTenant({});
  assert.equal(res.ok, true);
  assert.equal(res.context.tenantId, 'single');
  assert.equal(res.context.tokenType, 'tenant');
  assert.equal(res.context.masterKey, 'mk');
  assert.equal(res.context.db, fakeDb);
});

test('serverToken set → missing header rejected 401', async () => {
  const mgr = createSingleUserContextManager({ db: fakeDb, masterKey: 'mk', serverToken: 's3cret' });
  const res = await mgr.resolveTenant({});
  assert.equal(res.ok, false);
  assert.equal(res.error.status, 401);
});

test('serverToken set → wrong header rejected, correct header accepted', async () => {
  const mgr = createSingleUserContextManager({ db: fakeDb, masterKey: 'mk', serverToken: 's3cret' });
  assert.equal((await mgr.resolveTenant({ 'X-Client-Token': 'nope' })).ok, false);
  assert.equal((await mgr.resolveTenant({ 'x-client-token': 's3cret' })).ok, true);
});

test('initializeTenant only builds schema, issues no token', async () => {
  const mgr = createSingleUserContextManager({ db: fakeDb, masterKey: 'mk' });
  const res = await mgr.initializeTenant();
  assert.equal(res.tenantId, 'single');
  assert.ok(res.schema);
  assert.equal(res.tenantToken, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: FAIL，`Cannot find module '.../single-user-context.js'`。

- [ ] **Step 3: 写实现**

Create `packages/rei-standard-amsg/server/src/server/tenant/single-user-context.js`:
```js
/**
 * Single-user tenant context manager.
 *
 * Interface-compatible with createTenantContextManager (resolveTenant /
 * initializeTenant), so the existing business handlers reuse it unchanged.
 * No blob registry, no tenant token — db and masterKey come from the caller
 * (the Worker resolves them from env + D1 binding per request).
 */

import { constantTimeEqual } from '../lib/constant-time.js';
import { getHeader } from '../lib/request.js';

export function createSingleUserContextManager({ db, masterKey, serverToken } = {}) {
  if (!db) throw new Error('[amsg-server single-user] db (adapter) is required');
  if (!masterKey) throw new Error('[amsg-server single-user] masterKey is required');
  const token = String(serverToken || '').trim();

  async function isAuthorized(headers) {
    if (!token) return true; // open when no shared secret configured
    const provided = getHeader(headers, 'x-client-token');
    if (!provided) return false;
    return constantTimeEqual(provided, token);
  }

  async function resolveTenant(headers) {
    if (!(await isAuthorized(headers))) {
      return {
        ok: false,
        error: {
          status: 401,
          body: { success: false, error: { code: 'INVALID_CLIENT_TOKEN', message: '共享密钥无效或缺失' } }
        }
      };
    }
    return {
      ok: true,
      context: { tenantId: 'single', tokenType: 'tenant', db, masterKey }
    };
  }

  async function initializeTenant() {
    const schema = await db.initSchema();
    return { tenantId: 'single', schema };
  }

  return { resolveTenant, initializeTenant };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/rei-standard-amsg/server/src/server/tenant/single-user-context.js packages/rei-standard-amsg/server/test/single-user-context.test.mjs
git commit -m "feat(amsg): 单用户 context manager（接口同构，复用现有 handler）"
```

---

## Task 6: 单用户建表路由

**Files:**
- Create: `packages/rei-standard-amsg/server/src/server/handlers/single-user-init.js`
- Test: `packages/rei-standard-amsg/server/test/single-user-init.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `packages/rei-standard-amsg/server/test/single-user-init.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleUserInitHandler } from '../src/server/handlers/single-user-init.js';
import { createSingleUserContextManager } from '../src/server/tenant/single-user-context.js';

function makeCtx(serverToken) {
  let initCalled = 0;
  const db = { async initSchema() { initCalled++; return { indexesCreated: 5, indexesFailed: 0 }; } };
  const tenantManager = createSingleUserContextManager({ db, masterKey: 'mk', serverToken });
  return { ctx: { tenantManager }, calls: () => initCalled };
}

test('init builds schema and returns 200', async () => {
  const { ctx, calls } = makeCtx();
  const handler = createSingleUserInitHandler(ctx);
  const res = await handler.POST({}, undefined);
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.tenantId, 'single');
  assert.equal(calls(), 1);
});

test('init rejects wrong shared secret with 401 and does not build schema', async () => {
  const { ctx, calls } = makeCtx('s3cret');
  const handler = createSingleUserInitHandler(ctx);
  const res = await handler.POST({ 'x-client-token': 'wrong' }, undefined);
  assert.equal(res.status, 401);
  assert.equal(calls(), 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: FAIL，`Cannot find module '.../single-user-init.js'`。

- [ ] **Step 3: 写实现**

Create `packages/rei-standard-amsg/server/src/server/handlers/single-user-init.js`:
```js
/**
 * Handler: single-user-init
 *
 * Idempotent "just create the tables" endpoint for single-user deployments
 * (the degenerate form of init-tenant). Reuses resolveTenant purely to enforce
 * the optional shared secret, then runs initSchema. Issues no token.
 *
 * @param {Object} ctx - Single-user server context (ctx.tenantManager).
 * @returns {{ POST: function }}
 */
export function createSingleUserInitHandler(ctx) {
  async function POST(headers /* , body */) {
    const auth = await ctx.tenantManager.resolveTenant(headers || {});
    if (!auth.ok) {
      return auth.error;
    }
    try {
      const result = await ctx.tenantManager.initializeTenant();
      return {
        status: 200,
        body: { success: true, data: { tenantId: result.tenantId, schema: result.schema } }
      };
    } catch (error) {
      return {
        status: 500,
        body: { success: false, error: { code: 'INIT_FAILED', message: error.message } }
      };
    }
  }

  return { POST };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/rei-standard-amsg/server/src/server/handlers/single-user-init.js packages/rei-standard-amsg/server/test/single-user-init.test.mjs
git commit -m "feat(amsg): 单用户幂等建表路由"
```

---

## Task 7: createSingleUserServer 组装

**Files:**
- Create: `packages/rei-standard-amsg/server/src/server/single-user.js`
- Modify: `packages/rei-standard-amsg/server/src/server/index.js`（导出 `createSingleUserServer`）
- Test: `packages/rei-standard-amsg/server/test/single-user-server.test.mjs`

- [ ] **Step 1: 写失败测试（真 D1 + 已知 masterKey，跑 schedule→list→cancel 全链路）**

Create `packages/rei-standard-amsg/server/test/single-user-server.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleUserServer } from '../src/server/single-user.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptPayload, encryptForStorage, decryptFromStorage } from '../src/server/lib/encryption.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

async function makeServer() {
  const db = createD1Adapter(createTestD1());
  await db.initSchema();
  const server = createSingleUserServer({ db, masterKey: MASTER_KEY });
  return server;
}

function encBody(obj) {
  const userKey = deriveUserEncryptionKey(USER, MASTER_KEY);
  return JSON.stringify(encryptPayload(obj, userKey));
}

test('createSingleUserServer exposes the reused handlers + init', async () => {
  const server = await makeServer();
  for (const k of ['init', 'getUserKey', 'scheduleMessage', 'updateMessage', 'cancelMessage', 'messages']) {
    assert.ok(server.handlers[k], `missing handler ${k}`);
  }
  assert.equal(server.handlers.sendNotifications, undefined); // NOT exposed in single-user
});

test('schedule → list → cancel round-trips through single-user server over D1', async () => {
  const server = await makeServer();
  const headers = {
    'X-User-Id': USER,
    'X-Payload-Encrypted': 'true',
    'X-Encryption-Version': '1'
  };

  const payload = {
    contactName: 'Rei',
    messageType: 'fixed',
    userMessage: 'hi',
    firstSendTime: '2999-01-01T00:00:00.000Z',
    recurrenceType: 'none',
    pushSubscription: { endpoint: 'https://example.com/x', keys: { p256dh: 'k', auth: 'a' } }
  };
  const created = await server.handlers.scheduleMessage.POST(headers, encBody(payload));
  assert.equal(created.status, 201);
  const uuid = created.body.data.uuid;

  const listed = await server.handlers.messages.GET(`/messages?status=all`, { 'X-User-Id': USER });
  assert.equal(listed.status, 200);

  const cancelled = await server.handlers.cancelMessage.DELETE(`/cancel-message?id=${uuid}`, { 'X-User-Id': USER });
  assert.equal(cancelled.status, 200);
});

test('masterKey wiring: storage encrypt/decrypt round-trips', () => {
  const userKey = deriveUserEncryptionKey(USER, MASTER_KEY);
  const round = JSON.parse(decryptFromStorage(encryptForStorage(JSON.stringify({ a: 1 }), userKey), userKey));
  assert.equal(round.a, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: FAIL，`Cannot find module '.../single-user.js'`。

- [ ] **Step 3: 写实现**

Create `packages/rei-standard-amsg/server/src/server/single-user.js`:
```js
/**
 * Single-user ReiStandard server assembly.
 *
 * Same shape as createReiServer ({ handlers }), but wired for a single user:
 *   - tenant context comes from createSingleUserContextManager (db + masterKey
 *     supplied by the caller; no blob registry, no tenant token)
 *   - only the 5 business handlers + an idempotent init route are exposed
 *   - send-notifications is NOT exposed over HTTP (cron runs via CF scheduled())
 *
 * @param {Object} config
 * @param {import('./adapters/interface.js').DbAdapter} config.db
 * @param {string} config.masterKey
 * @param {string} [config.serverToken]  - optional shared secret (X-Client-Token)
 * @param {{ email?: string, publicKey?: string, privateKey?: string }} [config.vapid]
 * @param {{ sendNotification: function }} [config.webpush] - web-push-compatible sender
 * @returns {{ handlers: Object, ctx: Object }}
 */

import { createSingleUserContextManager } from './tenant/single-user-context.js';
import { createSingleUserInitHandler } from './handlers/single-user-init.js';
import { createGetUserKeyHandler } from './handlers/get-user-key.js';
import { createScheduleMessageHandler } from './handlers/schedule-message.js';
import { createUpdateMessageHandler } from './handlers/update-message.js';
import { createCancelMessageHandler } from './handlers/cancel-message.js';
import { createMessagesHandler } from './handlers/messages.js';

export function createSingleUserServer(config) {
  if (!config || !config.db) throw new Error('[amsg-server single-user] config.db is required');
  if (!config.masterKey) throw new Error('[amsg-server single-user] config.masterKey is required');

  const vapid = config.vapid || {};
  const tenantManager = createSingleUserContextManager({
    db: config.db,
    masterKey: config.masterKey,
    serverToken: config.serverToken
  });

  const ctx = {
    vapid: {
      email: vapid.email || '',
      publicKey: vapid.publicKey || '',
      privateKey: vapid.privateKey || ''
    },
    webpush: config.webpush || null,
    tenantManager
  };

  return {
    ctx,
    handlers: {
      init: createSingleUserInitHandler(ctx),
      getUserKey: createGetUserKeyHandler(ctx),
      scheduleMessage: createScheduleMessageHandler(ctx),
      updateMessage: createUpdateMessageHandler(ctx),
      cancelMessage: createCancelMessageHandler(ctx),
      messages: createMessagesHandler(ctx)
    }
  };
}
```

- [ ] **Step 4: 导出**

Modify `packages/rei-standard-amsg/server/src/server/index.js` — 在 `createD1Adapter` 导出行后面加：
```js
export { createSingleUserServer } from './single-user.js';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: PASS（含 schedule→list→cancel 全链路，证明 5 handler 在单用户 context + D1 下零改动可跑）。

- [ ] **Step 6: 提交**

```bash
git add packages/rei-standard-amsg/server/src/server/single-user.js packages/rei-standard-amsg/server/src/server/index.js packages/rei-standard-amsg/server/test/single-user-server.test.mjs
git commit -m "feat(amsg): createSingleUserServer 组装单用户 handlers"
```

---

## Task 8: 抽出 runScheduledTick + 重构 send-notifications

**Files:**
- Create: `packages/rei-standard-amsg/server/src/server/lib/run-tick.js`
- Modify: `packages/rei-standard-amsg/server/src/server/handlers/send-notifications.js`
- Modify: `packages/rei-standard-amsg/server/src/server/index.js`（导出 `runScheduledTick`）
- Test: `packages/rei-standard-amsg/server/test/run-tick.test.mjs`

- [ ] **Step 1: 写回归测试（锁住抽取前后行为一致）**

Create `packages/rei-standard-amsg/server/test/run-tick.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScheduledTick } from '../src/server/lib/run-tick.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const VAPID = { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' };

async function seed(adapter, { uuid, recurrenceType, nextSendAt }) {
  const userKey = deriveUserEncryptionKey(USER, MASTER_KEY);
  const enc = encryptForStorage(JSON.stringify({
    contactName: 'Rei',
    messageType: 'fixed',
    userMessage: 'hi',
    recurrenceType,
    pushSubscription: { endpoint: 'https://example.com/x', keys: { p256dh: 'k', auth: 'a' } }
  }), userKey);
  await adapter.createTask({ user_id: USER, uuid, encrypted_payload: enc, next_send_at: nextSendAt, message_type: 'fixed' });
}

function fakeWebpush() {
  const sent = [];
  return { sent, async sendNotification(sub, payload) { sent.push(payload); } };
}

test('one-off task: delivered then deleted', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'once', recurrenceType: 'none', nextSendAt: '2020-01-01T00:00:00.000Z' });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.successCount, 1);
  assert.equal(res.details.deletedOnceOffTasks, 1);
  assert.ok(webpush.sent.length >= 1);
  assert.equal((await adapter.getPendingTasks(50)).length, 0);
});

test('daily task: delivered then rescheduled +24h, retry reset', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'daily', recurrenceType: 'daily', nextSendAt: '2020-01-01T00:00:00.000Z' });

  const webpush = fakeWebpush();
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.successCount, 1);
  assert.equal(res.details.updatedRecurringTasks, 1);
  const row = await adapter.getTaskByUuidOnly('daily');
  assert.equal(row.next_send_at, '2020-01-02T00:00:00.000Z');
  assert.equal(row.retry_count, 0);
});

test('delivery failure increments retry_count', async () => {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seed(adapter, { uuid: 'fail', recurrenceType: 'none', nextSendAt: '2020-01-01T00:00:00.000Z' });

  const webpush = { async sendNotification() { throw new Error('push failed'); } };
  const res = await runScheduledTick({ db: adapter, masterKey: MASTER_KEY, vapid: VAPID, webpush });

  assert.equal(res.failedCount, 1);
  const row = await adapter.getTaskByUuidOnly('fail');
  assert.equal(row.retry_count, 1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: FAIL，`Cannot find module '.../run-tick.js'`。

- [ ] **Step 3: 写 runScheduledTick（把 send-notifications 的批处理内核原样搬进来）**

Create `packages/rei-standard-amsg/server/src/server/lib/run-tick.js`:
```js
/**
 * Scheduled tick core: fetch due tasks, deliver, reschedule/retry, cleanup.
 * Extracted verbatim from the send-notifications handler so both the HTTP
 * handler (multi-tenant) and the CF scheduled() path (single-user) share it.
 *
 * @param {Object} ctx - { db, masterKey, vapid, webpush }
 * @returns {Promise<Object>} summary { totalTasks, successCount, failedCount, processedAt, executionTime, details }
 */

import { deriveUserEncryptionKey, decryptFromStorage } from './encryption.js';
import { processSingleMessage } from './message-processor.js';

export async function runScheduledTick(ctx) {
  const db = ctx.db;
  const masterKey = ctx.masterKey;

  const startTime = Date.now();
  const tasks = await db.getPendingTasks(50);

  const MAX_CONCURRENT = 8;
  const results = {
    totalTasks: tasks.length,
    successCount: 0,
    failedCount: 0,
    deletedOnceOffTasks: 0,
    updatedRecurringTasks: 0,
    failedTasks: []
  };

  async function handleDeliveryFailure(task, reason) {
    results.failedCount++;
    try {
      if (task.retry_count >= 3) {
        await db.updateTaskById(task.id, { status: 'failed' });
        results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count, status: 'permanently_failed' });
      } else {
        const nextRetryTime = new Date(Date.now() + (task.retry_count + 1) * 2 * 60 * 1000);
        await db.updateTaskById(task.id, { next_send_at: nextRetryTime.toISOString(), retry_count: task.retry_count + 1 });
        results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count + 1, nextRetryAt: nextRetryTime.toISOString() });
      }
    } catch (updateError) {
      results.failedTasks.push({ taskId: task.id, reason, status: 'retry_update_failed', updateError: updateError.message });
    }
  }

  async function handlePostSendPersistenceFailure(task, reason) {
    results.failedCount++;
    let markedSent = false;
    try {
      await db.updateTaskById(task.id, { status: 'sent', retry_count: 0 });
      markedSent = true;
    } catch (_markSentError) {
      markedSent = false;
    }
    results.failedTasks.push({
      taskId: task.id,
      reason,
      status: markedSent ? 'post_send_cleanup_failed_marked_sent' : 'post_send_cleanup_failed',
      messageDelivered: true
    });
  }

  async function processTask(task) {
    let sendResult;
    try {
      sendResult = await processSingleMessage(task, { ...ctx, db, masterKey }, masterKey);
    } catch (error) {
      await handleDeliveryFailure(task, error.message || '消息发送失败');
      return;
    }

    if (!sendResult.success) {
      await handleDeliveryFailure(task, sendResult.error || '消息发送失败');
      return;
    }

    try {
      const userKey = deriveUserEncryptionKey(task.user_id, masterKey);
      const decryptedPayload = JSON.parse(decryptFromStorage(task.encrypted_payload, userKey));

      if (decryptedPayload.recurrenceType === 'none') {
        await db.deleteTaskById(task.id);
        results.deletedOnceOffTasks++;
      } else {
        let nextSendAt;
        const currentSendAt = new Date(task.next_send_at);
        if (decryptedPayload.recurrenceType === 'daily') {
          nextSendAt = new Date(currentSendAt.getTime() + 24 * 60 * 60 * 1000);
        } else if (decryptedPayload.recurrenceType === 'weekly') {
          nextSendAt = new Date(currentSendAt.getTime() + 7 * 24 * 60 * 60 * 1000);
        }
        await db.updateTaskById(task.id, { next_send_at: nextSendAt.toISOString(), retry_count: 0 });
        results.updatedRecurringTasks++;
      }

      results.successCount++;
    } catch (error) {
      await handlePostSendPersistenceFailure(task, error.message || '发送后状态更新失败');
    }
  }

  const taskQueue = [...tasks];
  const processing = [];

  while (taskQueue.length > 0 || processing.length > 0) {
    while (processing.length < MAX_CONCURRENT && taskQueue.length > 0) {
      const task = taskQueue.shift();
      const promise = processTask(task);
      processing.push(promise);
      promise.finally(() => {
        const index = processing.indexOf(promise);
        if (index > -1) processing.splice(index, 1);
      });
    }
    if (processing.length > 0) {
      await Promise.race(processing);
    }
  }

  await db.cleanupOldTasks(7);

  const executionTime = Date.now() - startTime;

  return {
    totalTasks: results.totalTasks,
    successCount: results.successCount,
    failedCount: results.failedCount,
    processedAt: new Date().toISOString(),
    executionTime,
    details: {
      deletedOnceOffTasks: results.deletedOnceOffTasks,
      updatedRecurringTasks: results.updatedRecurringTasks,
      failedTasks: results.failedTasks
    }
  };
}
```

- [ ] **Step 4: 重构 send-notifications handler 调用它**

Modify `packages/rei-standard-amsg/server/src/server/handlers/send-notifications.js` — 用下面整段替换 `import` 之后到 `return { POST };` 之间的实现（保留顶部 doc 注释、`export function` 签名、`resolveTenant` 与 VAPID 校验，把批处理那一大坨换成 `runScheduledTick`）：
```js
import { runScheduledTick } from '../lib/run-tick.js';

export function createSendNotificationsHandler(ctx) {
  async function POST(urlOrHeaders, maybeHeaders) {
    const url = typeof urlOrHeaders === 'string' ? urlOrHeaders : '';
    const headers = maybeHeaders || (typeof urlOrHeaders === 'object' ? urlOrHeaders : {});

    const tenantResult = await ctx.tenantManager.resolveTenant(headers, { allowCronToken: true, url });
    if (!tenantResult.ok) {
      return tenantResult.error;
    }

    const { db, masterKey } = tenantResult.context;

    if (!ctx.vapid.email || !ctx.vapid.publicKey || !ctx.vapid.privateKey) {
      return {
        status: 500,
        body: {
          success: false,
          error: {
            code: 'VAPID_CONFIG_ERROR',
            message: 'VAPID 配置缺失，无法发送推送通知',
            details: {
              missingKeys: [
                !ctx.vapid.email && 'VAPID_EMAIL',
                !ctx.vapid.publicKey && 'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
                !ctx.vapid.privateKey && 'VAPID_PRIVATE_KEY'
              ].filter(Boolean)
            }
          }
        }
      };
    }

    const data = await runScheduledTick({ ...ctx, db, masterKey });
    return { status: 200, body: { success: true, data } };
  }

  return { POST };
}
```
> 删掉旧的 `import { deriveUserEncryptionKey }...`、`import { decryptFromStorage }...`、`import { processSingleMessage }...`（现在都在 run-tick.js 里）。

- [ ] **Step 5: 导出 runScheduledTick**

Modify `packages/rei-standard-amsg/server/src/server/index.js` — 在 `createSingleUserServer` 导出行后面加：
```js
export { runScheduledTick } from './lib/run-tick.js';
```

- [ ] **Step 6: 跑测试确认通过（含现有 sdk / message-processor 测试不回归）**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: PASS，run-tick 3 个测试 + 原有 `sdk.test.mjs` / `message-processor.test.mjs` 全绿。

- [ ] **Step 7: 提交**

```bash
git add packages/rei-standard-amsg/server/src/server/lib/run-tick.js packages/rei-standard-amsg/server/src/server/handlers/send-notifications.js packages/rei-standard-amsg/server/src/server/index.js packages/rei-standard-amsg/server/test/run-tick.test.mjs
git commit -m "refactor(amsg): 抽出 runScheduledTick，HTTP handler 与 CF cron 共用"
```

---

## Task 9: Web Crypto Web Push shim（移植 instant）

**Files:**
- Create: `packages/rei-standard-amsg/server/src/server/lib/webcrypto-utils.js`（复制自 instant）
- Create: `packages/rei-standard-amsg/server/src/server/lib/webpush-webcrypto.js`（复制自 instant + 加包装）
- Modify: `packages/rei-standard-amsg/server/src/server/index.js`（导出 `createWebCryptoWebPush`）
- Test: `packages/rei-standard-amsg/server/test/webpush-webcrypto.test.mjs`

- [ ] **Step 1: 复制 instant 的两个文件**

Run（在仓库根目录）:
```bash
cp packages/rei-standard-amsg/instant/src/utils.js packages/rei-standard-amsg/server/src/server/lib/webcrypto-utils.js
cp packages/rei-standard-amsg/instant/src/webpush.js packages/rei-standard-amsg/server/src/server/lib/webpush-webcrypto.js
```
Expected: 两个文件出现在 server/src/server/lib/。

- [ ] **Step 2: 改导入路径**

Modify `packages/rei-standard-amsg/server/src/server/lib/webpush-webcrypto.js` — 把顶部
```js
import { ... } from './utils.js';
```
改成
```js
import { ... } from './webcrypto-utils.js';
```
（`...` 保留原有的 `utf8, toUint8, concatBytes, bytesToBase64Url, base64UrlToBytes, jsonToBase64Url, hmacSha256, randomBytes` 那一串，只改文件名。）
> 注：`webpush-webcrypto.js` 顶部还 `import { normalizeVapidSubject } from '@rei-standard/amsg-shared'` —— server 的 package.json 已依赖 amsg-shared，无需改。若 `webcrypto-utils.js` 内部再 import 别的相对文件，一并把路径核对好（instant/src/utils.js 目前零内部相对依赖）。

- [ ] **Step 3: 追加 createWebCryptoWebPush 包装（web-push 兼容接口）**

Edit `packages/rei-standard-amsg/server/src/server/lib/webpush-webcrypto.js` — 在文件末尾追加：
```js

/**
 * web-push-compatible sender backed by the Web Crypto implementation above.
 * message-processor calls `ctx.webpush.sendNotification(subscription, payloadString)`,
 * so we only need that one method. VAPID keys are baked in at construction.
 *
 * @param {{ email: string, publicKey: string, privateKey: string }} vapid
 * @returns {{ sendNotification: (subscription: Object, payload: string) => Promise<any> }}
 */
export function createWebCryptoWebPush(vapid) {
  const subject = vapid.email;
  const publicKey = vapid.publicKey;
  const privateKey = vapid.privateKey;
  return {
    async sendNotification(subscription, payload) {
      return sendWebPush({
        subscription,
        payload,
        vapid: { subject, publicKey, privateKey },
        fetch: globalThis.fetch
      });
    }
  };
}
```
> 前置核对（读 `sendWebPush` 签名后确认）：`sendWebPush({ subscription, payload, vapid, ttl, fetch })` 里 `vapid` 用的字段名是 `subject / publicKey / privateKey`。若实际字段名不同（例如 `email`），把上面对象里的键改成一致的。`payload` 传字符串即可（`sendWebPush` 内部会转字节）。

- [ ] **Step 4: 写测试（真实生成一个订阅，跑通加密 + VAPID JWT，mock fetch）**

Create `packages/rei-standard-amsg/server/test/webpush-webcrypto.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebCryptoWebPush, verifyVapidJwt } from '../src/server/lib/webpush-webcrypto.js';

// A real, valid P-256 VAPID keypair + a real subscriber key are needed for the
// encryption path to run. Generate them at test time via Web Crypto.
async function genVapid() {
  const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey)); // 65-byte uncompressed
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', kp.privateKey);
  const b64url = (u8) => Buffer.from(u8).toString('base64url');
  return { publicKey: b64url(pub), privateKeyJwk: jwk };
}

async function genSubscription() {
  const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const b64url = (u8) => Buffer.from(u8).toString('base64url');
  return { endpoint: 'https://push.example.com/sub/abc', keys: { p256dh: b64url(raw), auth: b64url(auth) } };
}

test('sendNotification encrypts + attaches VAPID and posts to the endpoint', async () => {
  const { publicKey, privateKeyJwk } = await genVapid();
  // sendWebPush expects the VAPID private key in the same encoding instant uses.
  // Verify against instant/src/webpush.js buildVapidJwt for the exact expected
  // privateKey format (raw d value base64url vs JWK). Adjust `privateKey` below
  // to match; this test asserts the wire request shape, not a live push.
  const privateKey = Buffer.from(privateKeyJwk.d, 'base64url').toString('base64url');

  const sub = await genSubscription();
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(null, { status: 201 });
  };

  const sender = createWebCryptoWebPush({ email: 'mailto:x@example.com', publicKey, privateKey });
  // Inject our fetch by temporarily overriding globalThis.fetch
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await sender.sendNotification(sub, JSON.stringify({ messageKind: 'content', message: 'hello' }));
  } finally {
    globalThis.fetch = original;
  }

  assert.ok(captured, 'fetch was called');
  assert.equal(captured.url, sub.endpoint);
  assert.equal(captured.init.headers['Content-Encoding'], 'aes128gcm');
  const authz = captured.init.headers['Authorization'] || captured.init.headers['authorization'];
  assert.match(authz, /^vapid t=/);
});
```
> 说明：这个测试对「VAPID 私钥编码」较敏感——`buildVapidJwt` 期望的 `privateKey` 具体格式（raw `d` 的 base64url，还是别的）要对着 instant `webpush.js` 里 `buildVapidJwt` 的 `importKey` 调用核对，Step 4 里 `privateKey` 那行按实际改。若在 CI 上编码对齐困难，退一步：把断言收敛为「`sendNotification` 调到了 fetch、URL 是 endpoint、`Content-Encoding: aes128gcm`」，VAPID 头单独用 `verifyVapidJwt` 在另一条能造出匹配密钥的测试里验。

- [ ] **Step 5: 导出 createWebCryptoWebPush**

Modify `packages/rei-standard-amsg/server/src/server/index.js` — 在 `runScheduledTick` 导出行后面加：
```js
export { createWebCryptoWebPush } from './lib/webpush-webcrypto.js';
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add packages/rei-standard-amsg/server/src/server/lib/webcrypto-utils.js packages/rei-standard-amsg/server/src/server/lib/webpush-webcrypto.js packages/rei-standard-amsg/server/src/server/index.js packages/rei-standard-amsg/server/test/webpush-webcrypto.test.mjs
git commit -m "feat(amsg): 移植 instant 的 Web Crypto Web Push，供 CF Worker 用"
```

---

## Task 10: CF Worker 工厂（fetch 路由 + scheduled）

**Files:**
- Create: `packages/rei-standard-amsg/server/src/server/cloudflare/single-user-worker.js`
- Modify: `packages/rei-standard-amsg/server/src/server/index.js`（导出 `createSingleUserCloudflareWorker`）
- Test: `packages/rei-standard-amsg/server/test/single-user-worker.test.mjs`

- [ ] **Step 1: 写失败测试（用全局 Request/Response + 测试 D1 跑 fetch 路由 + scheduled）**

Create `packages/rei-standard-amsg/server/test/single-user-worker.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { deriveUserEncryptionKey, encryptPayload, encryptForStorage } from '../src/server/lib/encryption.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

function makeWorker(d1) {
  return createSingleUserCloudflareWorker((env) => ({
    db: createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} }
  }));
}

test('fetch routes init + schedule + messages, unknown → 404', async () => {
  const d1 = createTestD1();
  const worker = makeWorker(d1);
  const env = { DB: d1 };

  // build tables via the init route
  const initRes = await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
  assert.equal(initRes.status, 200);

  const userKey = deriveUserEncryptionKey(USER, MASTER_KEY);
  const body = JSON.stringify(encryptPayload({
    contactName: 'Rei', messageType: 'fixed', userMessage: 'hi',
    firstSendTime: '2999-01-01T00:00:00.000Z', recurrenceType: 'none',
    pushSubscription: { endpoint: 'https://e.com/x', keys: { p256dh: 'k', auth: 'a' } }
  }, userKey));

  const schedRes = await worker.fetch(new Request('https://w.dev/schedule-message', {
    method: 'POST',
    headers: { 'X-User-Id': USER, 'X-Payload-Encrypted': 'true', 'X-Encryption-Version': '1' },
    body
  }), env);
  assert.equal(schedRes.status, 201);

  const listRes = await worker.fetch(new Request('https://w.dev/messages?status=all', {
    method: 'GET', headers: { 'X-User-Id': USER }
  }), env);
  assert.equal(listRes.status, 200);

  const notFound = await worker.fetch(new Request('https://w.dev/nope', { method: 'GET' }), env);
  assert.equal(notFound.status, 404);
});

test('scheduled() runs the tick over env.DB', async () => {
  const d1 = createTestD1();
  const adapter = createD1Adapter(d1);
  await adapter.initSchema();
  const userKey = deriveUserEncryptionKey(USER, MASTER_KEY);
  const enc = encryptForStorage(JSON.stringify({
    contactName: 'Rei', messageType: 'fixed', userMessage: 'hi', recurrenceType: 'none',
    pushSubscription: { endpoint: 'https://e.com/x', keys: { p256dh: 'k', auth: 'a' } }
  }), userKey);
  await adapter.createTask({ user_id: USER, uuid: 'due', encrypted_payload: enc, next_send_at: '2020-01-01T00:00:00.000Z', message_type: 'fixed' });

  let sent = 0;
  const worker = createSingleUserCloudflareWorker(() => ({
    db: adapter,
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() { sent++; } }
  }));

  await worker.scheduled({}, { DB: d1 });
  assert.ok(sent >= 1);
  assert.equal((await adapter.getPendingTasks(50)).length, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: FAIL，`Cannot find module '.../single-user-worker.js'`。

- [ ] **Step 3: 写实现**

Create `packages/rei-standard-amsg/server/src/server/cloudflare/single-user-worker.js`:
```js
/**
 * Cloudflare Worker factory for the single-user amsg-server.
 *
 * Mirrors instant's createCloudflareWorker: you pass a buildConfig(env) that
 * returns the single-user config; we build the server per request (cheap) and
 * dispatch. Returns { fetch, scheduled } for `export default`.
 *
 * Routes (server endpoints only — NO /send-notifications; cron is scheduled()):
 *   POST /init-tenant       → build tables (idempotent)
 *   GET  /get-user-key      → derive user key
 *   POST /schedule-message  → create task
 *   GET  /messages          → list
 *   PUT  /update-message    → patch
 *   DELETE /cancel-message  → delete
 */

import { createSingleUserServer } from '../single-user.js';
import { createD1Adapter } from '../adapters/d1.js';
import { runScheduledTick } from '../lib/run-tick.js';

function headersToObject(h) {
  const out = {};
  for (const [k, v] of h) out[k] = v;
  return out;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export function createSingleUserCloudflareWorker(buildConfig) {
  async function resolveConfig(env) {
    const cfg = await buildConfig(env);
    if (!cfg.db) cfg.db = createD1Adapter(env.DB);
    return cfg;
  }

  async function fetch(request, env /* , ctx */) {
    const cfg = await resolveConfig(env);
    const server = createSingleUserServer(cfg);

    const url = request.url;
    const { pathname } = new URL(url);
    const method = request.method.toUpperCase();
    const headers = headersToObject(request.headers);

    let result;
    if (method === 'POST' && pathname.endsWith('/init-tenant')) {
      result = await server.handlers.init.POST(headers, await request.text());
    } else if (method === 'GET' && pathname.endsWith('/get-user-key')) {
      result = await server.handlers.getUserKey.GET(url, headers);
    } else if (method === 'POST' && pathname.endsWith('/schedule-message')) {
      result = await server.handlers.scheduleMessage.POST(headers, await request.text());
    } else if (method === 'GET' && pathname.endsWith('/messages')) {
      result = await server.handlers.messages.GET(url, headers);
    } else if (method === 'PUT' && pathname.endsWith('/update-message')) {
      result = await server.handlers.updateMessage.PUT(url, headers, await request.text());
    } else if (method === 'DELETE' && pathname.endsWith('/cancel-message')) {
      result = await server.handlers.cancelMessage.DELETE(url, headers);
    } else {
      result = { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Unknown route' } } };
    }

    return jsonResponse(result.status, result.body);
  }

  async function scheduled(event, env /* , ctx */) {
    const cfg = await resolveConfig(env);
    const vapid = cfg.vapid || {};
    if (!cfg.webpush || !vapid.email || !vapid.publicKey || !vapid.privateKey) {
      console.error('[amsg single-user] scheduled(): VAPID/webpush not configured; skipping tick');
      return;
    }
    await runScheduledTick({ db: cfg.db, masterKey: cfg.masterKey, vapid, webpush: cfg.webpush });
  }

  return { fetch, scheduled };
}
```

- [ ] **Step 4: 导出**

Modify `packages/rei-standard-amsg/server/src/server/index.js` — 在 `createWebCryptoWebPush` 导出行后面加：
```js
export { createSingleUserCloudflareWorker } from './cloudflare/single-user-worker.js';
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test --workspace @rei-standard/amsg-server`
Expected: PASS（fetch 路由 + scheduled 都过）。

- [ ] **Step 6: 提交**

```bash
git add packages/rei-standard-amsg/server/src/server/cloudflare/single-user-worker.js packages/rei-standard-amsg/server/src/server/index.js packages/rei-standard-amsg/server/test/single-user-worker.test.mjs
git commit -m "feat(amsg): CF Worker 工厂（fetch 路由 + scheduled cron）"
```

---

## Task 11: 示例 Worker + wrangler + schema.sql + README

**Files:**
- Create: `packages/rei-standard-amsg/server/examples/cloudflare-single-user/worker.js`
- Create: `packages/rei-standard-amsg/server/examples/cloudflare-single-user/wrangler.toml`
- Create: `packages/rei-standard-amsg/server/examples/cloudflare-single-user/schema.sql`
- Create: `packages/rei-standard-amsg/server/examples/cloudflare-single-user/README.md`

（本任务是配置/文档产物，没有单测；验证靠 Step 5 的构建 + 可选 `wrangler dev` 冒烟。）

- [ ] **Step 1: worker.js**

Create `packages/rei-standard-amsg/server/examples/cloudflare-single-user/worker.js`:
```js
/**
 * Single-user amsg-server on Cloudflare Workers.
 * Schedules live in D1; cron runs via CF Cron Trigger (see wrangler.toml).
 */
import {
  createSingleUserCloudflareWorker,
  createWebCryptoWebPush
} from '@rei-standard/amsg-server';

export default createSingleUserCloudflareWorker((env) => ({
  // db defaults to createD1Adapter(env.DB)
  masterKey: env.AMSG_MASTER_KEY,
  serverToken: env.AMSG_SERVER_TOKEN, // optional shared secret; omit to leave endpoints open
  vapid: {
    email: env.VAPID_EMAIL,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  },
  webpush: createWebCryptoWebPush({
    email: env.VAPID_EMAIL,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  })
}));
```

- [ ] **Step 2: wrangler.toml**

Create `packages/rei-standard-amsg/server/examples/cloudflare-single-user/wrangler.toml`:
```toml
name = "amsg-single-user"
main = "worker.js"
compatibility_date = "2024-09-23"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "amsg"
database_id = "<你的 D1 database id>"

# CF Cron Trigger（5 段：分 时 日 月 周，UTC）。每分钟跑一次定时投递：
[triggers]
crons = ["* * * * *"]
```

- [ ] **Step 3: schema.sql**

Create `packages/rei-standard-amsg/server/examples/cloudflare-single-user/schema.sql`:
```sql
-- 单用户 amsg-server 的 D1 建表脚本。
-- 用法：wrangler d1 execute amsg --file schema.sql
-- 也可以部署后 POST /init-tenant 让服务端自动建（幂等）。

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  uuid TEXT,
  encrypted_payload TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('fixed', 'prompted', 'auto', 'instant')),
  next_send_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_tasks_optimized
  ON scheduled_messages (status, next_send_at, id, retry_count)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_cleanup_completed
  ON scheduled_messages (status, updated_at)
  WHERE status IN ('sent', 'failed');
CREATE INDEX IF NOT EXISTS idx_failed_retry
  ON scheduled_messages (status, retry_count, next_send_at)
  WHERE status = 'failed' AND retry_count < 3;
CREATE INDEX IF NOT EXISTS idx_user_id
  ON scheduled_messages (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_uuid
  ON scheduled_messages (uuid)
  WHERE uuid IS NOT NULL;
```

- [ ] **Step 4: README.md**

Create `packages/rei-standard-amsg/server/examples/cloudflare-single-user/README.md`:
```markdown
# 单用户 amsg-server · Cloudflare Worker

定时消息存 D1，定时投递用 CF Cron Trigger。适合只有自己一个人用、想全程跑在 Cloudflare 上的场景。

## 跑通步骤

1. 建 D1 数据库，把返回的 id 填进 `wrangler.toml` 的 `database_id`：
   ```bash
   wrangler d1 create amsg
   ```
2. 建表（二选一）：
   - 命令行：`wrangler d1 execute amsg --file schema.sql`
   - 或部署后调一次 `POST /init-tenant`（幂等；配了 serverToken 要带 `X-Client-Token`）
3. 配 secrets：
   ```bash
   wrangler secret put AMSG_MASTER_KEY      # 随机 32 字节 hex，见下
   wrangler secret put VAPID_EMAIL          # 例如 mailto:you@example.com
   wrangler secret put VAPID_PUBLIC_KEY
   wrangler secret put VAPID_PRIVATE_KEY
   wrangler secret put AMSG_SERVER_TOKEN    # 可选：共享密钥，配了才校验 X-Client-Token
   ```
   生成 `AMSG_MASTER_KEY`：
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. 部署：`wrangler deploy`

## 端点

`/get-user-key`、`/schedule-message`、`/messages`、`/update-message`、`/cancel-message`、`/init-tenant`。
**没有 HTTP `/send-notifications`**——定时投递由 CF Cron Trigger 直接触发 `scheduled()`。

## 客户端

`@rei-standard/amsg-client` 配 `baseUrl` 指向本 Worker；若设了 `AMSG_SERVER_TOKEN`，client 也要配同样的 `serverToken`。
```

- [ ] **Step 5: 构建校验（示例引用的导出都存在、能打进包）**

Run: `npm run build --workspace @rei-standard/amsg-server`
Expected: 构建成功，`dist/` 里 `createSingleUserCloudflareWorker` / `createWebCryptoWebPush` 都在导出中（构建不报缺失导出）。
（可选冒烟：在示例目录 `wrangler dev`，`curl -X POST localhost:8787/init-tenant` 返回 200。）

- [ ] **Step 6: 提交**

```bash
git add packages/rei-standard-amsg/server/examples/cloudflare-single-user/
git commit -m "docs(amsg): 单用户 CF Worker 示例（worker + wrangler + schema + README）"
```

---

## Task 12: client 单用户档（serverToken）

**Files:**
- Modify: `packages/rei-standard-amsg/client/src/index.js`
- Modify: `packages/rei-standard-amsg/client/package.json`（加 test 脚本，若无）
- Test: `packages/rei-standard-amsg/client/test/server-token.test.mjs`

- [ ] **Step 1: 写失败测试**

Create `packages/rei-standard-amsg/client/test/server-token.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReiClient } from '../src/index.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';

function stubFetch(captured) {
  return async (url, init) => {
    captured.push({ url: String(url), headers: (init && init.headers) || {} });
    return new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };
}

test('serverToken adds X-Client-Token to amsg-server requests', async () => {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch(captured);
  try {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER, serverToken: 's3cret' });
    await client.cancelMessage('some-uuid');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(captured.length, 1);
  assert.equal(captured[0].headers['X-Client-Token'], 's3cret');
});

test('no serverToken → no X-Client-Token on server requests', async () => {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = stubFetch(captured);
  try {
    const client = new ReiClient({ baseUrl: 'https://w.dev', userId: USER });
    await client.cancelMessage('some-uuid');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(captured[0].headers['X-Client-Token'], undefined);
});
```

- [ ] **Step 2: 确认 client 有 test 脚本**

Read `packages/rei-standard-amsg/client/package.json`。若 `scripts` 里没有 `test`，加上：
```json
"test": "node --test test/*.test.mjs"
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test --workspace @rei-standard/amsg-client`
Expected: FAIL（`serverToken` 未实现，`X-Client-Token` 缺失）。

- [ ] **Step 4: 加 serverToken 字段 + 私有 helper**

Modify `packages/rei-standard-amsg/client/src/index.js`：

(a) 构造器里，`this._instantClientToken = ...` 那一段（约 364-366 行）后面加：
```js
    /** @private */
    this._serverToken = typeof config.serverToken === 'string' && config.serverToken
      ? config.serverToken
      : '';
```

(b) `_resolveBaseUrl(endpointName)` 方法后面，加一个私有 helper：
```js
  /**
   * Attach the single-user shared secret to amsg-server endpoint requests.
   * Never applied to the instant path (that uses instantClientToken).
   * @private
   * @param {Record<string, string>} headers
   * @returns {Record<string, string>}
   */
  _withServerToken(headers) {
    if (this._serverToken) headers['X-Client-Token'] = this._serverToken;
    return headers;
  }
```

(c) `init()`（约 406-409 行）的 headers 换成：
```js
      headers: this._withServerToken({ 'X-User-Id': this._userId })
```

(d) `scheduleMessage()`（约 449-458 行）的 headers 换成：
```js
      headers: this._withServerToken({
        'Content-Type': 'application/json',
        'X-User-Id': this._userId,
        'X-Payload-Encrypted': 'true',
        'X-Encryption-Version': '1'
      }),
```

(e) `updateMessage()`（约 882-891 行）的 headers 换成：
```js
      headers: this._withServerToken({
        'Content-Type': 'application/json',
        'X-User-Id': this._userId,
        'X-Payload-Encrypted': 'true',
        'X-Encryption-Version': '1'
      }),
```

(f) `cancelMessage()`（约 903-906 行）的 headers 换成：
```js
      headers: this._withServerToken({ 'X-User-Id': this._userId })
```

(g) `listMessages()`（约 929-936 行）的 headers 换成：
```js
      headers: this._withServerToken({
        'X-User-Id': this._userId,
        'X-Response-Encrypted': 'true',
        'X-Encryption-Version': '1'
      })
```

(h) `ReiClientConfig` typedef（文件顶部，`instantClientToken` 那条 `@property` 附近）加一条：
```js
 * @property {string} [serverToken] - Optional shared secret for a single-user amsg-server.
 *   When set, sent as the `X-Client-Token` header on amsg-server endpoints
 *   (schedule / messages / update / cancel / user-key / init). Not applied to the
 *   instant path (that uses `instantClientToken`).
```

> `_buildInstantRequest`（约 1026 行）**不动**——instant 路径继续只用 `instantClientToken`，避免和 serverToken 在同一个 `X-Client-Token` 头上打架。

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test --workspace @rei-standard/amsg-client`
Expected: PASS（两个 serverToken 测试通过）。

- [ ] **Step 6: 构建 client（regen dist + d.ts）**

Run: `npm run build --workspace @rei-standard/amsg-client`
Expected: 构建成功，`dist/index.d.ts` 的 `ReiClientConfig` 出现 `serverToken`。

- [ ] **Step 7: 提交**

```bash
git add packages/rei-standard-amsg/client/src/index.js packages/rei-standard-amsg/client/package.json packages/rei-standard-amsg/client/test/server-token.test.mjs
git commit -m "feat(amsg-client): 单用户 serverToken，给 amsg-server 端点带共享密钥"
```

---

## 收尾校验

- [ ] **全量测试**：`npm test`（根目录，跑所有 workspace）→ 全绿。
- [ ] **全量构建**：`npm run build`（根目录）→ 全部包构建通过。
- [ ] **changeset**：本次改动涉及 `@rei-standard/amsg-server`（feat）和 `@rei-standard/amsg-client`（feat）。按仓库惯例加 changeset：`npx changeset`，两个包都选 minor，写一句面向用户的说明（「amsg-server 新增单用户 Cloudflare Worker 模式；amsg-client 新增 serverToken」）。
- [ ] 发版流程见 `RELEASING.md`，本计划不触发发布。

---

## 备注：已知风险与验证过的假设

- **web-push npm 在 CF Worker 跑不了**（用 Node 的 `crypto.createECDH` / `https.request`）——已证实，故 Task 9 用 instant 的纯 Web Crypto 实现。（来源：web-push-libs/web-push#718 及多个 Web Crypto 替代库。）
- **CF Cron Trigger 是 5 段 cron**（`分 时 日 月 周`，UTC），`scheduled(event, env, ctx)` 由平台内部触发、无 HTTP、无需 token。
- **constant-time 比较**：不用 Node 的 `crypto.timingSafeEqual`（Worker 上有历史 undefined bug），也不用 CF 的 `crypto.subtle.timingSafeEqual`（Node 没有）——用 `globalThis.crypto.subtle` 双 HMAC，两边通用。
- **D1 = SQLite**：partial index / CHECK / `AUTOINCREMENT` 原生支持；`createTask` 用 `INSERT` + `last_row_id` + `SELECT`，不依赖 `RETURNING`（绕开一个不确定点）。
- **uuid 唯一冲突 → 409**：`isUniqueViolation()` 匹配 `"unique constraint"` 子串，D1/SQLite 的报错天然命中，handler 无需改。
- **时间戳字典序**：全部归一化成 `toISOString()`（`Z` 定长格式）后，`next_send_at <= ?` 用字符串比较即等价时间比较。
