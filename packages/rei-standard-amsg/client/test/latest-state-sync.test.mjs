import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { encryptPayload } from '../../server/src/server/lib/encryption.js';
import * as sdk from '../src/index.js';

const entry = (value, updatedAt = 100) => ({ namespace: 'tools', key: 'config', value, updatedAt });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('latest state sync persists a newer save during upload and uploads it immediately afterward', async () => {
  const firstSent = deferred();
  const release = deferred();
  const uploads = [];
  let persisted = [];
  const sync = sdk.createLatestStateSync({
    savePending(entries) { persisted = structuredClone(entries); },
    async send(entries) {
      uploads.push(entries[0].value);
      if (uploads.length === 1) { firstSent.resolve(); await release.promise; }
      return { success: true, data: { upserted: 1, skipped: 0 } };
    },
  });
  const first = sync.enqueue([entry('enabled')]);
  await firstSent.promise;
  const second = sync.enqueue([entry('disabled', 101)]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(persisted[0].value, 'disabled');
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(uploads, ['enabled', 'disabled']);
  assert.deepEqual(persisted, []);
  assert.deepEqual(await sync.getPending(), []);
});

test('skipped entries stay pending with their original timestamp until the caller chooses a conflict resolution', async () => {
  let calls = 0;
  let persisted = [];
  const sync = sdk.createLatestStateSync({
    savePending(entries) { persisted = structuredClone(entries); },
    send() { calls++; return { success: true, data: { upserted: 0, skipped: 1, skippedEntries: [{ namespace: 'tools', key: 'config' }] } }; },
  });
  const result = await sync.enqueue([entry('disabled', 90)]);
  assert.equal(calls, 1, 'a conflict must not create an unbounded retry loop');
  assert.equal(result.outcomes[0].status, 'conflict');
  assert.deepEqual(persisted, [entry('disabled', 90)]);
  await sync.flush();
  assert.equal(calls, 2, 'an explicit retry is bounded to one attempt per pending version');
});

test('failed upload preserves pending for recovery and still sends a newer save from the same flight', async () => {
  const sent = deferred();
  const release = deferred();
  let persisted = [];
  let calls = 0;
  const sync = sdk.createLatestStateSync({
    loadPending() { return [entry('restored')]; },
    savePending(entries) { persisted = structuredClone(entries); },
    async send() { calls++; if (calls === 1) { sent.resolve(); await release.promise; throw new Error('offline'); } return { success: true, data: { upserted: 1, skipped: 0 } }; },
  });
  const initial = sync.flush();
  await sent.promise;
  const newer = sync.enqueue([entry('newer', 101)]);
  await new Promise(resolve => setImmediate(resolve));
  release.resolve();
  await Promise.all([initial, newer]);
  assert.equal(calls, 2);
  assert.deepEqual(persisted, []);
});

test('strict state receipts distinguish applied, rejected, conflicts, and ambiguous success', () => {
  const entries = [entry('a'), { ...entry('b'), key: 'b' }, { ...entry('c'), key: 'c' }];
  const outcomes = sdk.classifyClientStateWrite(entries, { success: true, data: { upserted: 1, skipped: 1, skippedEntries: [{ namespace: 'tools', key: 'b' }], rejected: [{ index: 2, namespace: 'tools', key: 'c', code: 'INVALID_STATE_VALUE' }] } });
  assert.deepEqual(outcomes.map(outcome => outcome.status), ['applied', 'conflict', 'rejected']);
  assert.equal(sdk.classifyClientStateWrite([entry('a')], { success: true })[0].status, 'unknown');
});

test('a persistence failure never clears the recoverable pending version', async () => {
  let persisted = [];
  const sync = sdk.createLatestStateSync({
    savePending(entries) { if (!entries.length) throw new Error('disk full'); persisted = structuredClone(entries); },
    send() { return { success: true, data: { upserted: 1, skipped: 0 } }; },
  });
  await assert.rejects(sync.enqueue([entry('a')]), /disk full/);
  assert.deepEqual(persisted, [entry('a')]);
  assert.deepEqual(await sync.getPending(), [entry('a')]);
});

test('failed pending restoration cannot silently replace unknown durable work with a new queue', async () => {
  let sends = 0;
  let writes = 0;
  const sync = sdk.createLatestStateSync({
    loadPending() { throw new Error('storage unavailable'); },
    savePending() { writes++; },
    send() { sends++; return { success: true, data: { upserted: 1, skipped: 0 } }; },
  });
  await assert.rejects(sync.enqueue([entry('new')]), /storage unavailable/);
  await assert.rejects(sync.enqueue([entry('another')]), /storage unavailable/);
  await assert.rejects(sync.getPending(), /storage unavailable/);
  assert.equal(sends, 0);
  assert.equal(writes, 0);
});


test('discard removes only the reported snapshot and preserves later saves', async () => {
  let durable = [];
  const sync = sdk.createLatestStateSync({
    savePending(entries) { durable = entries; },
    send(entries) { return { success: true, data: { upserted: 0, skipped: entries.length, skippedEntries: entries } }; },
  });
  const first = await sync.enqueue([entry('first')]);
  await sync.discard(first.outcomes.map(outcome => outcome.entry));
  assert.deepEqual(await sync.getPending(), []);
  assert.deepEqual(durable, []);
  await sync.enqueue([entry('later', 101)]);
  await sync.discard(first.outcomes.map(outcome => outcome.entry));
  assert.deepEqual(await sync.getPending(), [entry('later', 101)]);
  const sameStamp = await sync.enqueue([entry('same-stamp-old', 102)]);
  await sync.enqueue([entry('same-stamp-new', 102)]);
  await sync.discard(sameStamp.outcomes.map(outcome => outcome.entry));
  assert.deepEqual(await sync.getPending(), [entry('same-stamp-new', 102)]);
});

test('state sync splits encrypted request bytes including JSON escaping and UTF-8', async () => {
  const batches = [];
  const sync = sdk.createLatestStateSync({
    maxRequestBodyBytes: 600,
    async send(entries) {
      const envelope = await encryptPayload({ entries }, 'a'.repeat(64));
      assert.ok(Buffer.byteLength(JSON.stringify(envelope)) <= 600, 'actual encrypted wire body must fit');
      batches.push(entries);
      return { success: true, data: { upserted: entries.length, skipped: 0 } };
    },
  });
  const result = await sync.enqueue(Array.from({ length: 3 }, (_, i) => ({ ...entry('界"\n'.repeat(30)), key: String(i) })));
  assert.equal(batches.length, 3);
  assert.deepEqual(result.pending, []);
});

test('state sync rejects one oversized value without uploading or blocking valid peers', async () => {
  const uploaded = [];
  const sync = sdk.createLatestStateSync({ send(entries) {
    uploaded.push(...entries.map(item => item.key));
    return { success: true, data: { upserted: entries.length, skipped: 0 } };
  } });
  const large = { ...entry('x'.repeat(5 * 1024 * 1024 + 1)), key: 'large' };
  const result = await sync.enqueue([large, entry('valid')]);
  assert.deepEqual(uploaded, ['config']);
  assert.equal(result.outcomes.find(item => item.entry.key === 'large').status, 'rejected');
  assert.equal(result.outcomes.find(item => item.entry.key === 'large').error.code, 'STATE_VALUE_TOO_LARGE');
  assert.deepEqual(result.pending.map(item => item.key), ['large']);
  await sync.discard(result.outcomes.filter(item => item.status === 'rejected').map(item => item.entry));
  assert.deepEqual(await sync.getPending(), []);
});

test('state sync isolates a single entry whose encrypted body cannot fit', async () => {
  const uploaded = [];
  const sync = sdk.createLatestStateSync({ maxRequestBodyBytes: 300, send(entries) {
    uploaded.push(...entries.map(item => item.key));
    return { success: true, data: { upserted: entries.length, skipped: 0 } };
  } });
  const result = await sync.enqueue([{ ...entry('x'.repeat(200)), key: 'large' }, entry('ok')]);
  assert.deepEqual(uploaded, ['config']);
  assert.equal(result.outcomes.find(item => item.entry.key === 'large').error.code, 'STATE_REQUEST_TOO_LARGE');
});

test('state sync caps default multi-entry batches near 1 MiB but still sends one large value alone', async () => {
  const batches = [];
  const sync = sdk.createLatestStateSync({ send(entries) {
    batches.push(entries.map(item => item.key));
    return { success: true, data: { upserted: entries.length, skipped: 0 } };
  } });
  const medium = (key) => ({ ...entry('m'.repeat(400 * 1024)), key });
  const result = await sync.enqueue([medium('a'), medium('b'), medium('c'), { ...entry('L'.repeat(2 * 1024 * 1024)), key: 'large' }]);
  assert.deepEqual(batches, [['a'], ['b'], ['c'], ['large']]);
  assert.deepEqual(result.pending, []);
  assert.ok(result.outcomes.every(item => item.status === 'applied'));
});

test('state sync keeps the 200-entry server batch limit while draining the remainder', async () => {
  const sizes = [];
  const sync = sdk.createLatestStateSync({ send(entries) {
    sizes.push(entries.length);
    return { success: true, data: { upserted: entries.length, skipped: 0 } };
  } });
  await sync.enqueue(Array.from({ length: 201 }, (_, i) => ({ ...entry('ok'), key: String(i) })));
  assert.deepEqual(sizes, [200, 1]);
});

test('unattended loadPending failure does not become an unhandled rejection', () => {
  const moduleUrl = new URL('../src/latest-state-sync.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', `
    import { createLatestStateSync } from ${JSON.stringify(moduleUrl)};
    createLatestStateSync({ send() {}, loadPending() { throw new Error('unavailable'); } });
    await new Promise(resolve => setTimeout(resolve, 20));
  `], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});


test('legacy physical-row receipts only clear a fully written batch, including UTF-8 boundaries', async () => {
  const value = '界'.repeat(136_533);
  const large = entry(value);
  const classify = (upserted, skipped = 0) => sdk.classifyClientStateWrite([large], { success: true, data: { upserted, skipped } })[0].status;
  assert.equal(classify(4), 'applied', 'codepoint-safe split has three chunks plus the root');
  assert.equal(classify(3), 'unknown', 'ceil(byteLength / chunkSize) undercounts this value');
  assert.equal(classify(3, 1), 'unknown');
  assert.equal(classify(0, 4), 'unknown');
  const sync = sdk.createLatestStateSync({ send() { return { success: true, data: { upserted: 4, skipped: 0 } }; } });
  assert.deepEqual((await sync.enqueue([large])).pending, []);
  const partial = sdk.createLatestStateSync({ send() { return { success: true, data: { upserted: 3, skipped: 1 } }; } });
  assert.equal((await partial.enqueue([large])).pending.length, 1);
});
