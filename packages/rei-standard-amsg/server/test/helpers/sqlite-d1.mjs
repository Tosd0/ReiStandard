/**
 * Test-only D1-compatible wrapper over an in-memory better-sqlite3 database.
 * Exposes the subset of the Cloudflare D1 binding API the adapter uses:
 *   db.prepare(sql).bind(...params).run() / .first() / .all()
 *   db.batch([stmt, ...])
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
        const prepared = db.prepare(sql);
        // D1 的 run() 对会返回行的语句（SELECT）同样给 results，所以适配器可以往
        // batch 里夹一条探针 SELECT。better-sqlite3 的 run() 遇到这种语句会抛错，
        // 这里按 D1 的样子改走 all()。
        if (prepared.reader) {
          const rows = prepared.all(...bound);
          return { success: true, results: rows, meta: { changes: 0, last_row_id: 0 } };
        }
        const info = prepared.run(...bound);
        return { success: true, results: [], meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } };
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

  // Mirrors D1's batch(): one call executes every statement, inside a
  // transaction. D1 documents batches as SQL transactions — "if a statement in
  // the sequence fails ... it aborts or rolls back the entire sequence" — and
  // adapter code relies on that (a failed cleanup must not leave half a batch
  // applied). BEGIN/COMMIT here so a failing statement rolls the whole batch
  // back the way D1 does, instead of leaving the earlier ones committed.
  async function batch(statements) {
    db.exec('BEGIN');
    try {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      db.exec('COMMIT');
      return results;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    prepare,
    batch,
    _raw: db,
    close() {
      db.close();
    }
  };
}

/**
 * 同一个 shim，外面包一层记录：每条 `prepare(sql).bind(...args)` 都记进
 * `calls`，语句照常执行（底下还是真的 SQLite）。
 *
 * 用来断言「发出去的 SQL 长什么样」——D1 的几条平台限制（LIKE pattern 50 字
 * 节、单条语句 100 个绑定参数）本地 SQLite 全都不触发，只能盯语句形态，盯不
 * 了执行结果。
 *
 * @returns {{ db: { prepare: Function, batch: Function }, calls: Array<{ sql: string, args: unknown[] }> }}
 */
export function createSpyD1() {
  const d1 = createTestD1();
  /** @type {Array<{ sql: string, args: unknown[] }>} */
  const calls = [];
  const prepare = (sql) => {
    const inner = d1.prepare(sql);
    const wrapper = {
      bind(...args) {
        calls.push({ sql, args });
        inner.bind(...args);
        return wrapper;
      },
      run: () => inner.run(),
      first: () => inner.first(),
      all: () => inner.all(),
    };
    return wrapper;
  };
  return { db: { prepare, batch: d1.batch }, calls, _raw: d1._raw };
}
