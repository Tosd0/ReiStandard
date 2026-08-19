import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/index.js';

test('公共出口恰好是这些（加导出要有意识地改这里）', () => {
  assert.deepEqual(Object.keys(api).sort(), [
    'DEFAULT_PREFIX',
    'blobToDataUrl',
    'createBlobStore',
    'createIdbAdapter',
    'dataUrlToBlob',
    'extractRefs',
  ]);
});

test('store 实例的方法表面', async () => {
  const store = api.createBlobStore({
    adapter: { get: async () => null, put: async () => {}, delete: async () => {}, keys: async () => [] },
  });
  for (const m of ['put', 'get', 'delete', 'isRef', 'resolveToDataUrl', 'migrateDataUrl', 'resolveDeep', 'gc']) {
    assert.equal(typeof store[m], 'function', m);
  }
  assert.equal(store.prefix, 'blobref:');
});
