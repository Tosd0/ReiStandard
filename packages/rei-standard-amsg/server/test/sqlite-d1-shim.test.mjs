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
