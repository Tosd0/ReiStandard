import { test } from 'node:test';
import assert from 'node:assert/strict';
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
