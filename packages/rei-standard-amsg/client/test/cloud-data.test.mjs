import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReiClient } from '../src/index.js';

async function initializedClient() {
  const client = new ReiClient({ baseUrl: 'https://w.dev', userId: 'user-1', serverToken: 'secret' });
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ success: true, data: { userKey: 'ab'.repeat(32) } });
  try { await client.init(); } finally { globalThis.fetch = original; }
  return client;
}

const owner = { type: 'character', id: 'a/b & c' };
const page = { resources: [], nextCursor: 'next/1', complete: false, gaps: [{ source: 'state', code: 'READ_FAILED', message: 'unavailable' }] };

test('cloud inventory GETs encode filters and preserve incomplete encrypted pages', async () => {
  const client = await initializedClient();
  const original = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    assert.equal(init.method, 'GET');
    assert.equal(init.headers['X-User-Id'], 'user-1');
    assert.equal(init.headers['X-Client-Token'], 'secret');
    assert.equal(init.headers['X-Response-Encrypted'], 'true');
    return Response.json({ success: true, encrypted: true, version: 1, data: await client._encrypt(JSON.stringify(page)) });
  };
  try {
    assert.deepEqual((await client.listCloudDataResources({ owner, type: 'state', cursor: 'c/1', limit: 10 })).data, page);
    await client.getCloudDataSummary();
    await client.listCloudDataCleanupOperations();
    await client.getCloudDataCleanupOperation('op/1');
    await client.getCloudDataOwner(owner);
  } finally { globalThis.fetch = original; }
  const resourceUrl = new URL(urls[0]);
  assert.equal(resourceUrl.pathname, '/cloud-data/resources');
  assert.equal(resourceUrl.searchParams.get('ownerType'), 'character');
  assert.equal(resourceUrl.searchParams.get('ownerId'), 'a/b & c');
  assert.equal(resourceUrl.searchParams.get('type'), 'state');
  assert.equal(resourceUrl.searchParams.get('cursor'), 'c/1');
  assert.equal(resourceUrl.searchParams.get('limit'), '10');
  assert.equal(urls[1], 'https://w.dev/cloud-data/summary');
  assert.equal(urls[2], 'https://w.dev/cloud-data/cleanup-operations');
  assert.equal(urls[3], 'https://w.dev/cloud-data/cleanup-operations/op%2F1');
  assert.equal(new URL(urls[4]).searchParams.get('ownerId'), owner.id);
});

test('cleanup and owner restore POST encrypted input and decrypt returned results', async () => {
  const client = await initializedClient();
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['X-Payload-Encrypted'], 'true');
    assert.equal(init.headers['X-Response-Encrypted'], 'true');
    assert.equal(init.headers['X-Client-Token'], 'secret');
    assert.ok(!init.body.includes('character'));
    requests.push({ url: String(url), body: await client._decrypt(JSON.parse(init.body)) });
    return Response.json({ success: true, encrypted: true, version: 1, data: await client._encrypt('{"id":"result-1"}') });
  };
  try {
    assert.deepEqual((await client.createCloudDataCleanupPlan({ mode: 'retire-owner', owner })).data, { id: 'result-1' });
    await client.createCloudDataCleanupPlan({ mode: 'purge', resourceIds: ['resource-1'], types: ['state'] });
    await client.startCloudDataCleanup({ planId: 'plan-1', idempotencyKey: 'retry-1' });
    await client.restoreCloudDataOwner(owner);
  } finally { globalThis.fetch = original; }
  assert.deepEqual(requests, [
    { url: 'https://w.dev/cloud-data/cleanup-plans', body: { mode: 'retire-owner', owner } },
    { url: 'https://w.dev/cloud-data/cleanup-plans', body: { mode: 'purge', resourceIds: ['resource-1'], types: ['state'] } },
    { url: 'https://w.dev/cloud-data/cleanup-operations', body: { planId: 'plan-1', idempotencyKey: 'retry-1' } },
    { url: 'https://w.dev/cloud-data/owner', body: { action: 'restore', owner } },
  ]);
});

test('cloud cleanup rejects empty or ambiguous scope before contacting server', async () => {
  const client = await initializedClient();
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('unexpected network call'); };
  try {
    for (const input of [undefined, {}, { mode: 'purge' }, { mode: 'purge', resourceIds: [] }, { mode: 'purge', resourceIds: [''] }, { mode: 'retire-owner' }, { mode: 'retire-owner', owner, resourceIds: ['x'] }, { mode: 'retire-owner', owner, types: ['state'] }, { mode: 'purge', types: [] }, { mode: 'purge', types: ['state'] }, { mode: 'purge', types: ['invalid'] }, { mode: 'purge', owner: { type: '', id: 'x' } }]) {
      await assert.rejects(() => client.createCloudDataCleanupPlan(input), TypeError);
    }
    await assert.rejects(() => client.startCloudDataCleanup({ planId: 'x', idempotencyKey: '' }), TypeError);
    await assert.rejects(() => client.getCloudDataCleanupOperation(''), TypeError);
    await assert.rejects(() => client.restoreCloudDataOwner({ type: 'character' }), TypeError);
    await assert.rejects(() => client.listCloudDataResources({ limit: 0 }), TypeError);
    await assert.rejects(() => client.listCloudDataResources({ type: 'invalid' }), TypeError);
  } finally { globalThis.fetch = original; }
});

test('cloud methods preserve server errors instead of reporting an empty success', async () => {
  const client = await initializedClient();
  const original = globalThis.fetch;
  const failure = { success: false, error: { code: 'PLAN_STALE', message: 'Preview again' } };
  globalThis.fetch = async () => Response.json(failure, { status: 409 });
  try { assert.deepEqual(await client.startCloudDataCleanup({ planId: 'p', idempotencyKey: 'k' }), failure); }
  finally { globalThis.fetch = original; }
});

test('owner registry remains discoverable independently of existing resources or cleanup history', async () => {
  const client = await initializedClient();
  const original = globalThis.fetch;
  const data = { owners: [{ owner: { type: 'character', id: 'retired' }, retired: true, generation: 1, updatedAt: 1, complete: true, gaps: [] }], complete: true, gaps: [] };
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://w.dev/cloud-data/owners');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers['X-Response-Encrypted'], 'true');
    return Response.json({ success: true, encrypted: true, version: 1, data: await client._encrypt(JSON.stringify(data)) });
  };
  try { assert.deepEqual((await client.listCloudDataOwners()).data, data); }
  finally { globalThis.fetch = original; }
});
