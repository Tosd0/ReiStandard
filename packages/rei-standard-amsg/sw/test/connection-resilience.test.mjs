import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

// Install a controllable IndexedDB BEFORE importing the SDK. `node --test`
// runs each test file in its own process, so this never leaks into the
// memory-fallback suite in dispatch.test.mjs.
const fake = installFakeIndexedDB();

const { installReiSW, REI_SW_EVENT } = await import('../src/index.js');

const QUEUE_DB_NAME = 'rei-sw';

let dbCounter = 0;
function uniqueDbName() {
  dbCounter += 1;
  return `dedupe_resilience_${dbCounter}`;
}

function createSwMock() {
  const listeners = new Map();
  const notifications = [];
  const postedMessages = [];
  const client = {
    id: 'client-0',
    visibilityState: 'hidden',
    postMessage(message) { postedMessages.push(message); },
  };

  const sw = {
    addEventListener(name, handler) { listeners.set(name, handler); },
    registration: {
      showNotification(title, options) {
        notifications.push({ title, options: options || {} });
        return Promise.resolve();
      },
    },
    clients: {
      async matchAll() { return [client]; },
    },
  };

  async function triggerPush(payload) {
    const pending = [];
    listeners.get('push')({
      data: { json: () => payload },
      waitUntil(work) { pending.push(Promise.resolve(work)); },
    });
    await Promise.all(pending);
  }

  return { sw, notifications, postedMessages, triggerPush };
}

function buildMultipartPayloads(payload, { id, maxChunkBytes = 80, ttlMs = 60_000, createdAt = Date.now() }) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const total = Math.ceil(bytes.byteLength / maxChunkBytes);
  return Array.from({ length: total }, (_, index) => {
    const start = index * maxChunkBytes;
    const chunk = bytes.subarray(start, Math.min(start + maxChunkBytes, bytes.byteLength));
    return {
      messageKind: '_multipart',
      multipart: {
        version: 1,
        id,
        index: index + 1,
        total,
        encoding: 'json-utf8-base64url',
        originalMessageKind: typeof payload.messageKind === 'string' ? payload.messageKind : null,
        createdAt,
        ttlMs,
      },
      chunk: Buffer.from(chunk).toString('base64url'),
    };
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Smoke: the fake IndexedDB drives the real dedupe path end-to-end ---

test('smoke: dedupe gate works over the fake IndexedDB (live connection)', async () => {
  const business = [];
  const { sw, notifications, triggerPush } = createSwMock();
  installReiSW(sw, {
    dedupe: { dbName: uniqueDbName(), cleanupIntervalMs: 0 },
    onBusinessPayload: (payload) => { business.push(payload); },
  });

  const payload = { messageKind: 'content', message: 'hi', messageId: 'smoke_msg_1' };
  await triggerPush(payload);
  await triggerPush(payload);

  assert.equal(business.length, 1, 'duplicate messageId dispatches business once');
  assert.equal(notifications.length, 1);
});

// --- Gap 1 (b): transaction-level reopen on a dead dedupe connection ---

test('dedupe: a closed cached connection transparently reopens on the next push', async () => {
  const dbName = uniqueDbName();
  const business = [];
  const { sw, triggerPush } = createSwMock();
  installReiSW(sw, {
    dedupe: { dbName, cleanupIntervalMs: 0 },
    onBusinessPayload: (payload) => { business.push(payload); },
  });

  await triggerPush({ messageKind: 'content', message: 'a', messageId: 'reopen_a' });
  assert.equal(business.length, 1);

  // Simulate the connection going closed underneath the cache. close()
  // does NOT fire `close`, so the cache still holds this dead handle and
  // the next db.transaction() on it throws InvalidStateError.
  fake.lastConnection(dbName).close();
  const opensBefore = fake.openCount;

  await triggerPush({ messageKind: 'content', message: 'b', messageId: 'reopen_b' });

  assert.equal(business.length, 2, 'second push must still reach the business callback');
  assert.ok(fake.openCount > opensBefore, 'a fresh connection must have been opened');
});

// --- Gap 1 (a): db.onclose evicts the cached dedupe connection ---

test('dedupe: db.onclose evicts the cached connection so a strong-close self-heals', async () => {
  const dbName = uniqueDbName();
  const business = [];
  const { sw, triggerPush } = createSwMock();
  installReiSW(sw, {
    dedupe: { dbName, cleanupIntervalMs: 0 },
    onBusinessPayload: (payload) => { business.push(payload); },
  });

  await triggerPush({ messageKind: 'content', message: 'a', messageId: 'onclose_a' });
  const conn = fake.lastConnection(dbName);

  assert.equal(typeof conn.onclose, 'function', 'source must register db.onclose');

  // Browser-style forced close event (the connection stays usable in the
  // fake — this test verifies the cache eviction, not the transaction retry).
  conn._emitClose();
  const opensBefore = fake.openCount;

  await triggerPush({ messageKind: 'content', message: 'b', messageId: 'onclose_b' });

  assert.equal(business.length, 2);
  assert.ok(fake.openCount > opensBefore, 'evicted cache forces a reopen on the next push');
});

// --- Gap 1: cleanup self-heals instead of logging every sweep (criterion 3) ---

test('dedupe cleanup: reopens after a dead connection instead of spamming "dedupe cleanup failed"', async () => {
  const dbName = uniqueDbName();
  const business = [];
  const { sw, triggerPush } = createSwMock();
  installReiSW(sw, {
    dedupe: { dbName, cleanupIntervalMs: 1 },
    onBusinessPayload: (payload) => { business.push(payload); },
  });

  await triggerPush({ messageKind: 'content', message: 'a', messageId: 'cleanup_a' });

  fake.lastConnection(dbName).close();
  await sleep(5); // let the cleanup interval elapse so the next push sweeps

  const originalError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args.map(String).join(' ')); };
  try {
    await triggerPush({ messageKind: 'content', message: 'b', messageId: 'cleanup_b' }).catch(() => {});
  } finally {
    console.error = originalError;
  }

  assert.ok(
    !errors.some((line) => line.includes('dedupe cleanup failed')),
    'cleanup over a dead connection must reopen, not log a failure every sweep',
  );
  assert.equal(business.length, 2, 'the push that triggered cleanup still lands');
});

// --- Gap 1 (b): queue/multipart cachedDB reopens mid-reassembly (criterion 4) ---

test('multipart: a closed queue connection reopens mid-reassembly', async () => {
  const business = [];
  const { sw, triggerPush } = createSwMock();
  installReiSW(sw, {
    dedupe: { dbName: uniqueDbName(), cleanupIntervalMs: 0 },
    onBusinessPayload: (payload) => { business.push(payload); },
  });

  const payload = { messageKind: 'content', message: 'queue reopen body '.repeat(10), messageId: 'queue_reopen_1' };
  const parts = buildMultipartPayloads(payload, { id: 'mp_queue_reopen', maxChunkBytes: 80 });
  assert.ok(parts.length >= 2, 'need a multi-chunk payload');

  await triggerPush(parts[0]);
  const deadConn = fake.lastConnection(QUEUE_DB_NAME);
  deadConn.close();

  for (const part of parts.slice(1)) {
    await triggerPush(part).catch(() => {});
  }

  assert.notEqual(
    fake.lastConnection(QUEUE_DB_NAME),
    deadConn,
    'a new queue connection must have been opened after the close',
  );
  assert.equal(business.length, 1, 'multipart payload restores and dispatches business');
});

// --- Gap 1 (a): queue connection onclose evicts cachedDB (criterion 4) ---

test('multipart: queue connection onclose evicts cachedDB so a strong-close self-heals', async () => {
  const business = [];
  const { sw, triggerPush } = createSwMock();
  installReiSW(sw, {
    dedupe: { dbName: uniqueDbName(), cleanupIntervalMs: 0 },
    onBusinessPayload: (payload) => { business.push(payload); },
  });

  const payload = { messageKind: 'content', message: 'queue onclose body '.repeat(10), messageId: 'queue_onclose_1' };
  const parts = buildMultipartPayloads(payload, { id: 'mp_queue_onclose', maxChunkBytes: 80 });

  await triggerPush(parts[0]);
  const conn = fake.lastConnection(QUEUE_DB_NAME);

  assert.equal(typeof conn.onclose, 'function', 'source must register onclose on the queue connection');

  conn._emitClose();

  for (const part of parts.slice(1)) {
    await triggerPush(part);
  }

  assert.notEqual(fake.lastConnection(QUEUE_DB_NAME), conn, 'evicted cachedDB forces a reopen');
  assert.equal(business.length, 1);
});
