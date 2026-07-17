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

  // Mirrors D1's batch(): one call executes every statement (D1 wraps them
  // in an implicit transaction and does a single network round trip; here
  // it's just sequential in-process execution, which is equivalent for tests).
  async function batch(statements) {
    const results = [];
    for (const stmt of statements) {
      results.push(await stmt.run());
    }
    return results;
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
