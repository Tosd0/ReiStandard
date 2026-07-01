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
