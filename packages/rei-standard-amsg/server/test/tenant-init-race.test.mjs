import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTenantBlobStore } from '../src/server/tenant/blob-store.js';
import { createTenantContextManager } from '../src/server/tenant/context.js';

// 行为对齐 @netlify/blobs 的条件写：set(key, value, { onlyIfNew }) → { modified }。
function createRaceBlobStore() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async set(key, value, options = {}) {
      if (options.onlyIfNew && map.has(key)) return { modified: false };
      map.set(key, value);
      return { modified: true };
    },
    async delete(key) { map.delete(key); }
  };
}

// 「已存在」检查和落盘之间插进另一次同 tenantId 的 init 时，只能有一次成功，
// 先写进去的 masterKey 不能被后到的盖掉。
test('并发两次 initializeTenant 同 tenantId 只有一次成功', async () => {
  globalThis.__REI_BLOB_STORE__ = createRaceBlobStore();
  try {
    const tenantStore = createTenantBlobStore({ namespace: 'race', kek: 'kek' });
    const manager = createTenantContextManager({
      tenantStore,
      tokenSigningKey: 'signing-key',
      adapterFactory: async () => ({ async initSchema() {} })
    });
    const tenantId = '2b7f0d6e-5a1c-4d2e-9f3a-8c4b1e6d7a90';
    const init = () => manager.initializeTenant({ tenantId, driver: 'pg', connectionString: 'postgres://db' });

    const results = await Promise.allSettled([init(), init()]);
    const outcomes = results.map(r => r.status === 'fulfilled' ? 'ok' : r.reason.message).sort();
    assert.deepEqual(outcomes, ['TENANT_ALREADY_INITIALIZED', 'ok']);

    const winner = results.find(r => r.status === 'fulfilled').value;
    const stored = await tenantStore.getTenantConfig(tenantId);
    const resolved = await manager.resolveTenant({ authorization: `Bearer ${winner.tenantToken}` });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.context.masterKey, stored.masterKey);
  } finally {
    delete globalThis.__REI_BLOB_STORE__;
  }
});
