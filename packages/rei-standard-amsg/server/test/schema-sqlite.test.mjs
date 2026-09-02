import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SQLITE_TABLE_SQL,
  SQLITE_INDEXES,
  CLIENT_STATE_INDEXES,
  MESSAGE_OUTBOX_INDEXES,
  SQLITE_ALL_INDEXES,
  SQLITE_REQUIRED_SCHEMA,
} from '../src/server/adapters/schema.sqlite.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';

const INSERT_SQL = `INSERT INTO scheduled_messages
  (user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count, created_at, updated_at)
  VALUES (?, ?, 'p', ?, '2026-01-01T00:00:00.000Z', 'pending', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;

async function applySchema(db) {
  await db.prepare(SQLITE_TABLE_SQL).run();
  for (const index of SQLITE_INDEXES) {
    await db.prepare(index.sql).run();
  }
}

test('SQLITE_TABLE_SQL uses SQLite dialect', () => {
  assert.match(SQLITE_TABLE_SQL, /INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(SQLITE_TABLE_SQL, /next_send_at TEXT NOT NULL/);
  assert.doesNotMatch(SQLITE_TABLE_SQL, /SERIAL/);
  assert.doesNotMatch(SQLITE_TABLE_SQL, /TIMESTAMP WITH TIME ZONE/);
});

test('SQLITE_INDEXES defines the 6 indexes incl. the critical unique guard', () => {
  assert.equal(SQLITE_INDEXES.length, 6);
  const uidx = SQLITE_INDEXES.find((i) => i.name === 'uidx_uuid');
  assert.ok(uidx && uidx.critical === true);
  // Every entry mirrors the Postgres INDEXES shape so both adapters'
  // initSchema() return the same index metadata (name/sql/description/critical).
  for (const index of SQLITE_INDEXES) {
    assert.equal(typeof index.description, 'string');
    assert.ok(index.description.length > 0, `${index.name} missing description`);
  }
});

test('client_state / message_outbox 的索引组与 SQLITE_INDEXES 同形，合集顺序固定，都不是 critical', () => {
  assert.equal(CLIENT_STATE_INDEXES.length, 1);
  assert.equal(MESSAGE_OUTBOX_INDEXES.length, 4);
  assert.deepEqual(SQLITE_ALL_INDEXES, [...SQLITE_INDEXES, ...CLIENT_STATE_INDEXES, ...MESSAGE_OUTBOX_INDEXES]);
  for (const index of [...CLIENT_STATE_INDEXES, ...MESSAGE_OUTBOX_INDEXES]) {
    assert.match(index.sql, /CREATE INDEX IF NOT EXISTS/, `${index.name} 必须是 IF NOT EXISTS，老库重跑 initSchema 才补得上`);
    assert.ok(index.sql.includes(index.name), `${index.name} 的 sql 里应出现同名索引`);
    assert.equal(typeof index.description, 'string');
    assert.ok(index.description.length > 0, `${index.name} missing description`);
    // 缺了只是慢，不是不能用：不许把老库判成「不够用」。
    assert.equal(index.critical, false, `${index.name} 不该是 critical`);
  }
  // 名字全局唯一
  const names = SQLITE_ALL_INDEXES.map((index) => index.name);
  assert.equal(new Set(names).size, names.length, '索引名重复');
  // 自查清单只认 critical 的：这几个新索引一个都不该进去
  assert.deepEqual([...SQLITE_REQUIRED_SCHEMA.indexes], ['uidx_uuid']);
});

test('schema applies cleanly on real SQLite', async () => {
  const db = createTestD1();
  try {
    await applySchema(db);
    // CHECK constraint rejects a bad status
    await assert.rejects(
      db.prepare(
        `INSERT INTO scheduled_messages (user_id, uuid, encrypted_payload, message_type, next_send_at, status, retry_count, created_at, updated_at)
         VALUES ('u', 'x', 'p', 'fixed', '2026-01-01T00:00:00.000Z', 'bogus', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
    );
  } finally {
    db.close();
  }
});

test('CHECK rejects an invalid message_type', async () => {
  const db = createTestD1();
  try {
    await applySchema(db);
    await assert.rejects(db.prepare(INSERT_SQL).bind('u', 'mt', 'nope').run());
  } finally {
    db.close();
  }
});

test('uidx_uuid enforces uniqueness on non-null uuid but allows multiple NULLs', async () => {
  const db = createTestD1();
  try {
    await applySchema(db);
    // First row with uuid 'dup' inserts fine.
    await db.prepare(INSERT_SQL).bind('u', 'dup', 'fixed').run();
    // Second row reusing the same uuid is blocked by the unique guard.
    await assert.rejects(
      db.prepare(INSERT_SQL).bind('u', 'dup', 'fixed').run(),
      /unique/i
    );
    // Partial index (WHERE uuid IS NOT NULL) lets multiple NULL-uuid rows coexist.
    await db.prepare(INSERT_SQL).bind('u', null, 'fixed').run();
    await db.prepare(INSERT_SQL).bind('u', null, 'fixed').run();
    const rows = await db.prepare('SELECT COUNT(*) AS c FROM scheduled_messages WHERE uuid IS NULL').all();
    assert.equal(Number(rows.results[0].c), 2);
  } finally {
    db.close();
  }
});
