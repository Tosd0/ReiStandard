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
  // mixed-case key WITH correct value must also pass (guards case-insensitive lookup)
  assert.equal((await mgr.resolveTenant({ 'X-Client-Token': 's3cret' })).ok, true);
});

test('initializeTenant only builds schema, issues no token', async () => {
  const mgr = createSingleUserContextManager({ db: fakeDb, masterKey: 'mk' });
  const res = await mgr.initializeTenant();
  assert.equal(res.tenantId, 'single');
  assert.ok(res.schema);
  assert.equal(res.tenantToken, undefined);
});
