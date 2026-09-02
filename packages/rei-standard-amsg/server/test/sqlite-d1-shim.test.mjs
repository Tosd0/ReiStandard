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

// D1 的 run() 对 SELECT 同样返回 results；适配器靠这一点往 batch 里夹探针 SELECT
// （client_state 的删除要靠它分「本来就没有」和「被条件写拦下」）。
test('sqlite-d1 shim: run() 对 SELECT 也回 results，batch 里夹 SELECT 不炸', async () => {
  const db = createTestD1();
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)').run();
  await db.prepare('INSERT INTO t (v) VALUES (?)').bind('a').run();

  const viaRun = await db.prepare('SELECT COUNT(*) AS n FROM t').run();
  assert.equal(Number(viaRun.results[0].n), 1);

  const results = await db.batch([
    db.prepare('DELETE FROM t WHERE v = ?').bind('a'),
    db.prepare('SELECT COUNT(*) AS n FROM t'),
  ]);
  assert.equal(results[0].meta.changes, 1);
  assert.equal(Number(results[1].results[0].n), 0);

  db.close();
});
