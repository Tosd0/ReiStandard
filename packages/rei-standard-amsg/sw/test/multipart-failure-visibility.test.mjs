import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeIndexedDB, FakeDOMException } from './helpers/fake-indexeddb.mjs';
import { buildChunksFromText, buildMultipartPayloads } from './helpers/multipart-wire.mjs';

// 先装可控 IndexedDB 再 import SDK（`node --test` 每个文件一个进程，不会串到别的
// 套件里）。这里要的不只是「有个库能用」，还要能在重组成功之后精准打断收尾那一步。
const fake = installFakeIndexedDB();

const QUEUE_DB_NAME = 'rei-sw';
const MULTIPART_DONE_STORE = 'multipart-done';
const MULTIPART_PENDING_STORE = 'multipart-pending';
const MULTIPART_CHUNK_STORE = 'multipart-chunk';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** 某个仓库里现在攒了多少行。用来盯「放弃一条 id 之后有没有留下孤儿分片」。 */
function storeSize(connection, storeName) {
  const data = connection && connection._meta && connection._meta.stores.get(storeName);
  return data ? data.records.size : 0;
}

/** 某个仓库里有没有这个 key。仓库是整个文件共享的，盯单条比数总行数稳。 */
function storeHas(connection, storeName, key) {
  const data = connection && connection._meta && connection._meta.stores.get(storeName);
  return !!data && data.records.has(key);
}

const { installReiSW, REI_SW_EVENT } = await import('../src/index.js');

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

/** 收走 console.error，既让测试输出干净，也能断言日志确实能归因。 */
async function captureErrors(run) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    return { value: await run(), lines };
  } finally {
    console.error = original;
  }
}
/** 从广播里挑出 MULTIPART_EXPIRED。 */
function expiredEvents(postedMessages) {
  return postedMessages
    .filter((m) => m.event === REI_SW_EVENT.MULTIPART_EXPIRED)
    .map((m) => m.payload);
}

let dedupeCounter = 0;
function freshDedupeDbName() {
  dedupeCounter += 1;
  return `dedupe_multipart_failure_${dedupeCounter}`;
}

function install(sw, multipart = {}) {
  const business = [];
  installReiSW(sw, {
    dedupe: { dbName: freshDedupeDbName(), cleanupIntervalMs: 0 },
    multipart: { cleanupIntervalMs: 0, ...multipart },
    onBusinessPayload: (payload) => { business.push(payload); },
  });
  return business;
}

// --- 进不了重组管线的分片 ----------------------------------------------------

test('multipart: an unusable chunk envelope is reported instead of silently dropped', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  const business = install(sw);

  const original = { messageKind: 'content', messageId: 'msg_mp_invalid', message: 'x'.repeat(200) };
  const parts = buildMultipartPayloads(original, { id: 'mp_invalid_version' });
  // 发送端用了本包不认识的 wire 版本：这条 id 的每一片都会是同样的下场。
  parts[0].multipart.version = 2;

  const { lines } = await captureErrors(() => triggerPush(parts[0]));

  assert.equal(notifications.length, 0, '手里只有半条消息，绝不能拿去弹通知');
  assert.equal(business.length, 0);
  assert.ok(
    lines.some((line) => line.includes('multipart chunk rejected (invalid-chunk)')),
    `拒收要留下能归因的日志：${JSON.stringify(lines)}`,
  );

  const expired = expiredEvents(postedMessages);
  assert.equal(expired.length, 1, '页面得知道这条分片消息不用再等了');
  assert.equal(expired[0].id, 'mp_invalid_version');
  assert.equal(expired[0].reason, 'invalid-chunk');
  assert.equal(expired[0].total, parts.length);
});

test('multipart: chunks arriving while multipart is disabled are reported', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  const business = install(sw, { enabled: false });

  const original = { messageKind: 'content', messageId: 'msg_mp_disabled', message: 'x'.repeat(200) };
  const parts = buildMultipartPayloads(original, { id: 'mp_disabled' });

  const { lines } = await captureErrors(() => triggerPush(parts[0]));

  assert.equal(notifications.length, 0);
  assert.equal(business.length, 0);
  assert.ok(
    lines.some((line) => line.includes('multipart chunk rejected (disabled)')),
    `关掉 multipart 却收到分片，要能从日志里看出来：${JSON.stringify(lines)}`,
  );

  const expired = expiredEvents(postedMessages);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, 'mp_disabled');
  assert.equal(expired[0].reason, 'disabled');
});

test('multipart: 一条收不了的消息只报一次，不按片数刷屏', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  const business = install(sw, { enabled: false });

  const original = { messageKind: 'content', messageId: 'msg_mp_flood', message: 'x'.repeat(600) };
  const parts = buildMultipartPayloads(original, { id: 'mp_disabled_flood', maxChunkBytes: 40 });
  assert.ok(parts.length >= 5, `要多片才量得出刷屏：${parts.length}`);

  await captureErrors(async () => {
    for (const part of parts) await triggerPush(part);
  });

  assert.equal(notifications.length, 0);
  assert.equal(business.length, 0);

  const expired = expiredEvents(postedMessages);
  assert.equal(
    expired.length, 1,
    `${parts.length} 片属于同一条消息，页面只该收到一次「收不了」，实际 ${expired.length} 次`,
  );
  assert.equal(expired[0].id, 'mp_disabled_flood');
  assert.equal(expired[0].reason, 'disabled');
});

// --- 进了管线但收不齐 --------------------------------------------------------

test('multipart: 重组窗口过完就整条放弃 —— 已落库的分片一起清掉', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  // 清扫按默认节流（15 分钟）走：迟到分片撞上的是重组那一步的过期判断，不是清扫。
  const business = install(sw, { cleanupIntervalMs: 15 * 60_000 });

  const original = { messageKind: 'content', messageId: 'msg_mp_window', message: 'x'.repeat(400) };
  const parts = buildMultipartPayloads(original, {
    id: 'mp_window_elapsed',
    maxChunkBytes: 40,
    ttlMs: 20,
  });
  assert.ok(parts.length >= 4, `要多片才排得出「先到几片、剩下的迟到」：${parts.length}`);

  await captureErrors(async () => {
    await triggerPush(parts[0]);
    await triggerPush(parts[1]);
    // 设备睡了一觉，剩下的分片迟到得超过了整个重组窗口。
    await sleep(40);
    for (const part of parts.slice(2)) await triggerPush(part);
    // 推送服务把早到的那几片重投一遍。
    await triggerPush(parts[0]);
  });

  assert.equal(notifications.length, 0, '手里只有半条消息，绝不能拿去弹通知');
  assert.equal(business.length, 0);

  const expired = expiredEvents(postedMessages);
  assert.equal(expired.length, 1, `一条消息只该报一次收不了，实际 ${expired.length} 次`);
  assert.equal(expired[0].id, 'mp_window_elapsed');

  // 早到那两片必须跟着一起清掉：只删 pending 的话，新窗口计数从 0 重来，而旧
  // 分片会被「这一片已经有了」挡在门外，这条 id 再也收不齐。
  const conn = fake.lastConnection(QUEUE_DB_NAME);
  assert.equal(storeSize(conn, MULTIPART_CHUNK_STORE), 0, '放弃这条 id 之后不该留下孤儿分片');
  assert.equal(storeSize(conn, MULTIPART_PENDING_STORE), 0, 'pending 也该清干净');
});

test('multipart: chunks that disagree on total give up on the id observably', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  const business = install(sw);

  const original = { messageKind: 'content', messageId: 'msg_mp_conflict', message: 'x'.repeat(300) };
  const wide = buildMultipartPayloads(original, { id: 'mp_conflict', maxChunkBytes: 120 });
  const narrow = buildMultipartPayloads(original, { id: 'mp_conflict', maxChunkBytes: 40 });
  assert.notEqual(wide.length, narrow.length, 'need two different totals for the same id');

  await triggerPush(wide[0]);
  assert.equal(postedMessages.length, 0, '第一片正常落库，什么都不该广播');

  const { lines } = await captureErrors(() => triggerPush(narrow[1]));

  assert.equal(notifications.length, 0);
  assert.equal(business.length, 0);
  assert.ok(
    lines.some((line) => line.includes('multipart chunks disagree on total/encoding')),
    `分片自相矛盾要留下能归因的日志：${JSON.stringify(lines)}`,
  );

  const expired = expiredEvents(postedMessages);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, 'mp_conflict');
  assert.equal(expired[0].reason, 'chunk-conflict');
  assert.equal(expired[0].total, wide.length, '按已经收着的那份 total 报');
  assert.equal(expired[0].received, 1);
});

test('multipart: exceeding maxTotalBytes gives up on the id observably', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  const business = install(sw, { maxTotalBytes: 100 });

  const original = { messageKind: 'content', messageId: 'msg_mp_oversize', message: 'x'.repeat(300) };
  const parts = buildMultipartPayloads(original, { id: 'mp_oversize', maxChunkBytes: 80 });
  assert.ok(parts.length >= 3, 'need enough chunks to blow past the limit');

  await triggerPush(parts[0]);
  assert.equal(postedMessages.length, 0, '第一片还没超限');

  const { lines } = await captureErrors(() => triggerPush(parts[1]));

  assert.equal(notifications.length, 0);
  assert.equal(business.length, 0);
  assert.ok(
    lines.some((line) => line.includes('multipart payload exceeds maxTotalBytes')),
    `超限要留下能归因的日志：${JSON.stringify(lines)}`,
  );

  const expired = expiredEvents(postedMessages);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].id, 'mp_oversize');
  assert.equal(expired[0].reason, 'size-limit-exceeded');
  assert.equal(expired[0].total, parts.length);
});

test('multipart: a payload that cannot be restored is reported instead of silently dropped', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  const business = install(sw);

  // 分片全都到齐，拼出来却不是合法 JSON —— 收齐之后才发现的失败。
  const parts = buildChunksFromText('this is not json at all, sorry', {
    id: 'mp_restore_failed',
    maxChunkBytes: 12,
    originalMessageKind: 'content',
  });
  assert.ok(parts.length >= 2, 'need a multi-chunk payload');

  for (const part of parts.slice(0, -1)) {
    await triggerPush(part);
  }
  assert.equal(postedMessages.length, 0, '没收齐之前什么都不该广播');

  const { lines } = await captureErrors(() => triggerPush(parts[parts.length - 1]));

  assert.equal(notifications.length, 0, '拼不出来的东西不能拿去弹通知');
  assert.equal(business.length, 0);
  assert.ok(
    lines.some((line) => line.includes('multipart restore failed')),
    `重组失败要留下能归因的日志：${JSON.stringify(lines)}`,
  );

  const expired = expiredEvents(postedMessages);
  assert.equal(expired.length, 1, '页面得知道这条分片消息不用再等了');
  assert.equal(expired[0].id, 'mp_restore_failed');
  assert.equal(expired[0].reason, 'restore-failed');
  assert.equal(expired[0].total, parts.length);
});

// --- 拼好了之后 --------------------------------------------------------------

test('multipart: a failed cleanup after a completed restore still delivers the message', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  const business = install(sw);

  const original = {
    messageKind: 'content',
    messageId: 'msg_mp_cleanup_failed',
    title: 'Cleanup Failed Rei',
    message: 'y'.repeat(200),
  };
  const parts = buildMultipartPayloads(original, { id: 'mp_cleanup_failed', maxChunkBytes: 80 });
  assert.ok(parts.length >= 2, 'need a multi-chunk payload');

  for (const part of parts.slice(0, -1)) {
    await triggerPush(part);
  }

  // 最后一片到达前，把「写 done 标记」这一步打断：重组本身照常成功，只有收尾挂掉。
  // 同一个 store 的读（判重投）仍然放行，否则还没走到重组就先炸了。
  const conn = fake.lastConnection(QUEUE_DB_NAME);
  const realTransaction = conn.transaction;
  conn.transaction = function patchedTransaction(storeName, mode) {
    if (storeName === MULTIPART_DONE_STORE && mode === 'readwrite') {
      throw new FakeDOMException(`No object store ${MULTIPART_DONE_STORE}`, 'NotFoundError');
    }
    return realTransaction.call(this, storeName, mode);
  };

  let lines;
  try {
    ({ lines } = await captureErrors(() => triggerPush(parts[parts.length - 1])));
  } finally {
    conn.transaction = realTransaction;
  }

  assert.deepEqual(expiredEvents(postedMessages), [], '数据已经拼回来了，不能报成丢了');
  assert.equal(business.length, 1, 'onBusinessPayload 照常拿到完整 payload');
  assert.deepEqual(business[0], original);
  assert.equal(notifications.length, 1, '通知照常弹');
  assert.equal(notifications[0].title, 'Cleanup Failed Rei');

  const content = postedMessages.filter((m) => m.event === REI_SW_EVENT.CONTENT_RECEIVED);
  assert.equal(content.length, 1);
  assert.deepEqual(content[0].payload, original);

  assert.ok(
    lines.some((line) => line.includes('multipart cleanup after a completed restore failed')),
    `收尾失败自己要留下日志：${JSON.stringify(lines)}`,
  );
});

// --- 重组窗口从本地首次收片起算 ----------------------------------------------

test('multipart: chunks that sat in the push service still reassemble', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  const business = install(sw);

  const original = {
    messageKind: 'content',
    messageId: 'msg_mp_delayed',
    title: 'Delayed Rei',
    message: 'z'.repeat(200),
  };
  // 设备离线时段排出去的定时消息：分片在推送服务里躺了五分钟才送到本地，而
  // 发送端标的 createdAt 是它发出去那一刻。重组窗口要是按 createdAt 算，这几
  // 片一到就全被判过期，思考过程永远拼不回来。
  const parts = buildMultipartPayloads(original, { id: 'mp_delayed', maxChunkBytes: 80 });
  const fiveMinutesAgo = Date.now() - 5 * 60_000;
  for (const part of parts) part.multipart.createdAt = fiveMinutesAgo;

  for (const part of parts) {
    await triggerPush(part);
  }

  assert.deepEqual(expiredEvents(postedMessages), [], '晚到不等于收不齐');
  assert.equal(business.length, 1);
  assert.deepEqual(business[0], original);
  assert.equal(notifications.length, 1);
});

test('multipart: a sender clock running ahead does not shrink the window', async () => {
  const { sw, postedMessages, triggerPush } = createSwMock();
  const business = install(sw);

  const original = { messageKind: 'content', messageId: 'msg_mp_skew', message: 'q'.repeat(200) };
  const parts = buildMultipartPayloads(original, { id: 'mp_skew', maxChunkBytes: 80 });
  // 发送端的钟比设备快十分钟——按 createdAt 算窗口的话，expiresAt 反而跑到了未来，
  // 一条早就该放弃的半截消息会在本地挂着不走；按本地时钟算就没有这种事。
  const tenMinutesAhead = Date.now() + 10 * 60_000;
  for (const part of parts) part.multipart.createdAt = tenMinutesAhead;

  for (const part of parts) {
    await triggerPush(part);
  }

  assert.deepEqual(expiredEvents(postedMessages), []);
  assert.equal(business.length, 1, '时钟差多少都不影响「分片是一起到的」这件事');
});

// --- 放弃是粘的 --------------------------------------------------------------

test('multipart: giving up on an id sticks — later chunks cannot restart it', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  const business = install(sw, { maxTotalBytes: 100 });

  const original = { messageKind: 'content', messageId: 'msg_mp_sticky', message: 'x'.repeat(300) };
  const parts = buildMultipartPayloads(original, { id: 'mp_sticky', maxChunkBytes: 80 });
  assert.ok(parts.length >= 3, 'need enough chunks to blow past the limit');

  await triggerPush(parts[0]);
  await captureErrors(() => triggerPush(parts[1]));

  const afterGiveUp = expiredEvents(postedMessages);
  assert.equal(afterGiveUp.length, 1);
  assert.equal(afterGiveUp[0].reason, 'size-limit-exceeded');

  // 推送服务对前几片做常规重投，剩下的片也照常到达。放弃要是不粘，这里会重开
  // 一份 pending 从零累计，整份被重新凑齐还原出来——maxTotalBytes 这道闸门等于
  // 没有；就算凑不齐，TTL 清扫也会为同一个 id 再广播一次自相矛盾的过期事件。
  await captureErrors(async () => {
    for (const part of parts) await triggerPush(part);
  });

  assert.equal(business.length, 0, '这条 id 已经放弃了，不能靠重投把它救回来');
  assert.equal(notifications.length, 0);
  assert.deepEqual(
    expiredEvents(postedMessages).map((e) => e.reason),
    ['size-limit-exceeded'],
    '同一个 id 只报一次结论',
  );
});

// --- 存储出错报出去的「收不到」同样要算数 ------------------------------------

/**
 * 让下一次读分片仓库炸一次，之后自愈。
 *
 * 挑「读分片仓库」这一步是为了不跟 TTL 清扫抢：清扫碰的是 pending 仓库和分片
 * 仓库的写事务，读事务只有重组这条路会走。抛 `NotFoundError` 而不是
 * `InvalidStateError`，是因为后者会被连接自愈那层透明重开一次、根本传不出来。
 */
function breakNextChunkStoreRead(conn) {
  const realTransaction = conn.transaction;
  let armed = true;
  conn.transaction = function patchedTransaction(storeName, mode) {
    if (armed && storeName === MULTIPART_CHUNK_STORE && mode === 'readonly') {
      armed = false;
      throw new FakeDOMException(`No object store ${MULTIPART_CHUNK_STORE}`, 'NotFoundError');
    }
    return realTransaction.call(this, storeName, mode);
  };
  return () => { conn.transaction = realTransaction; };
}

test('multipart: 存储出错报了「收不到」之后，后面的分片不能把这条消息偷偷投出来', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  const business = install(sw);

  const original = {
    messageKind: 'reasoning',
    messageId: 'msg_mp_storage_transient',
    message: 'r'.repeat(600),
  };
  const parts = buildMultipartPayloads(original, {
    id: 'mp_storage_transient',
    maxChunkBytes: 60,
  });
  assert.ok(parts.length >= 5, `要多片才排得出「中间某一片撞上存储错误」：${parts.length}`);

  await triggerPush(parts[0]);
  await triggerPush(parts[1]);
  assert.equal(postedMessages.length, 0, '前两片正常落库，什么都不该广播');

  // 第三片撞上一次性的 IndexedDB 错误：这一片什么都没落库，存储随后自己好了。
  const restore = breakNextChunkStoreRead(fake.lastConnection(QUEUE_DB_NAME));
  let lines;
  try {
    ({ lines } = await captureErrors(() => triggerPush(parts[2])));
  } finally {
    restore();
  }

  assert.ok(
    lines.some((line) => line.includes('multipart chunk rejected (storage-failed)')),
    `这条测试要的就是「存储炸一次」，没炸到就白测了：${JSON.stringify(lines)}`,
  );
  const expired = expiredEvents(postedMessages);
  assert.equal(expired.length, 1, '页面得知道这条分片消息不用再等了');
  assert.equal(expired[0].id, 'mp_storage_transient');
  assert.equal(expired[0].reason, 'storage-failed');

  // 剩下的分片照常到达，推送服务也把出错那一片重投了一遍。说了「收不到」就得
  // 算数：这时候再把消息拼齐投出去，用户会看着一条读得到的消息，旁边永远挂着
  // 一张「这条消息收不到」的横幅——没有任何事件能把那句话收回来。
  await captureErrors(async () => {
    for (const part of parts.slice(3)) await triggerPush(part);
    await triggerPush(parts[2]);
  });

  assert.equal(business.length, 0, '已经报过收不到的 id，不能靠后面的分片救回来');
  assert.equal(notifications.length, 0);
  assert.deepEqual(
    postedMessages.filter((m) => m.event === REI_SW_EVENT.REASONING_RECEIVED),
    [],
    '页面这边同样不该收到这条消息的业务事件',
  );
  assert.deepEqual(
    expiredEvents(postedMessages).map((e) => e.reason),
    ['storage-failed'],
    '同一个 id 只报一次结论',
  );
});

test('multipart: 存储出错报过的 id，TTL 清扫不会再报第二次', async () => {
  const { sw, postedMessages, triggerPush } = createSwMock();
  // pending 记录 120ms 后过期；cleanupIntervalMs = 0 → 每条 push 都顺手扫一遍。
  const PENDING_TTL_MS = 120;
  const business = install(sw, { ttlMs: PENDING_TTL_MS });

  const original = {
    messageKind: 'content',
    messageId: 'msg_mp_storage_swept',
    message: 's'.repeat(400),
  };
  const parts = buildMultipartPayloads(original, { id: 'mp_storage_swept', maxChunkBytes: 60 });

  // 第一片正常落库，留下一条 pending 记录；第二片撞上存储错误。
  await triggerPush(parts[0]);
  const restore = breakNextChunkStoreRead(fake.lastConnection(QUEUE_DB_NAME));
  try {
    await captureErrors(() => triggerPush(parts[1]));
  } finally {
    restore();
  }

  assert.deepEqual(
    expiredEvents(postedMessages).map((e) => e.reason),
    ['storage-failed'],
  );

  // 等那条留下来的 pending 记录过期，再拿一条无关的 push 触发清扫。
  await sleep(PENDING_TTL_MS + 30);
  await captureErrors(() => triggerPush({
    messageKind: 'content',
    messageId: 'msg_mp_unrelated_sweep',
    message: 'trigger cleanup',
  }));

  assert.equal(business.length, 1, '无关的那条 push 照常交付');
  assert.deepEqual(
    expiredEvents(postedMessages).map((e) => e.reason),
    ['storage-failed'],
    '这个 id 的结论页面已经收到过了，清扫不该把同一句话再说一遍',
  );
});

// --- 已经交付的消息不会被 TTL 清扫报成丢了 ------------------------------------

test('multipart: a delivered id is never reported expired by the TTL sweep', async () => {
  const { sw, postedMessages, triggerPush } = createSwMock();
  // pending 记录 40ms 后过期，done 墓碑活到 80ms：中间这段就是清扫必须认出
  // 「这条已经交付过了」的窗口。cleanupIntervalMs = 0 → 每条 push 都顺手扫一遍。
  const PENDING_TTL_MS = 40;
  const business = install(sw, { ttlMs: PENDING_TTL_MS });

  const original = {
    messageKind: 'content',
    messageId: 'msg_mp_stuck_pending',
    message: 'w'.repeat(200),
  };
  const parts = buildMultipartPayloads(original, { id: 'mp_stuck_pending', maxChunkBytes: 80 });

  for (const part of parts.slice(0, -1)) {
    await triggerPush(part);
  }

  // 最后一片到达时，把「删 pending」这一步打断（IndexedDB 配额炸了之类）：重组
  // 本身成功、消息照常交付，但 pending 记录留了下来。
  const conn = fake.lastConnection(QUEUE_DB_NAME);
  const realTransaction = conn.transaction;
  conn.transaction = function patchedTransaction(storeName, mode) {
    if (storeName === MULTIPART_PENDING_STORE && mode === 'readwrite') {
      throw new FakeDOMException(`No object store ${MULTIPART_PENDING_STORE}`, 'NotFoundError');
    }
    return realTransaction.call(this, storeName, mode);
  };
  let lines;
  try {
    ({ lines } = await captureErrors(() => triggerPush(parts[parts.length - 1])));
  } finally {
    conn.transaction = realTransaction;
  }

  assert.ok(
    lines.some((line) => line.includes('multipart cleanup after a completed restore failed')),
    `这条测试要的就是「收尾被打断」，没打断到就白测了：${JSON.stringify(lines)}`,
  );
  assert.equal(business.length, 1, '数据拼回来了，消息照常交付');
  assert.deepEqual(expiredEvents(postedMessages), []);

  // 等到那条残留的 pending 记录过期、而 done 墓碑还活着。
  await new Promise((resolve) => setTimeout(resolve, PENDING_TTL_MS + 15));

  // 下一条 push 顺手触发 TTL 清扫。收尾的第一步就是写墓碑，清扫要认得它——不认
  // 的话，页面会为一条用户已经读过的消息收到一次「没收到」。
  await captureErrors(() => triggerPush({
    messageKind: 'content',
    messageId: 'msg_mp_unrelated',
    message: 'trigger cleanup',
  }));

  assert.deepEqual(
    expiredEvents(postedMessages),
    [],
    '已经交付的 id 不能被清扫报成过期',
  );
});

/** 把「写 done 墓碑」这一步打断（restore 刚重读完全部分片，紧接着的第一笔写最容易撞上配额）。 */
function breakDoneStoreWrites(conn) {
  const realTransaction = conn.transaction;
  conn.transaction = function patchedTransaction(storeName, mode) {
    if (storeName === MULTIPART_DONE_STORE && mode === 'readwrite') {
      throw new FakeDOMException('quota exceeded', 'QuotaExceededError');
    }
    return realTransaction.call(this, storeName, mode);
  };
  return () => { conn.transaction = realTransaction; };
}

test('multipart: done 墓碑写不进去时，TTL 清扫也不能把已交付的消息报成丢了', async () => {
  const { sw, postedMessages, triggerPush } = createSwMock();
  // pending 记录 120ms 后过期；cleanupIntervalMs = 0 → 每条 push 都顺手扫一遍。
  const PENDING_TTL_MS = 120;
  const business = install(sw, { ttlMs: PENDING_TTL_MS });

  const original = {
    messageKind: 'content',
    messageId: 'msg_mp_done_write_failed',
    message: 'v'.repeat(200),
  };
  const parts = buildMultipartPayloads(original, { id: 'mp_done_write_failed', maxChunkBytes: 80 });

  for (const part of parts.slice(0, -1)) {
    await triggerPush(part);
  }

  // 最后一片到达时收尾的第一步「写 done 墓碑」失败：重组成功、消息照常交付，
  // 但持久墓碑没写成，pending 记录和分片也留了下来（删它们排在写墓碑之后）。
  const conn = fake.lastConnection(QUEUE_DB_NAME);
  const restore = breakDoneStoreWrites(conn);
  let lines;
  try {
    ({ lines } = await captureErrors(() => triggerPush(parts[parts.length - 1])));
  } finally {
    restore();
  }

  assert.ok(
    lines.some((line) => line.includes('multipart cleanup after a completed restore failed')),
    `这条测试要的就是「墓碑写失败」，没打断到就白测了：${JSON.stringify(lines)}`,
  );
  assert.equal(business.length, 1, '数据拼回来了，消息照常交付');
  assert.deepEqual(expiredEvents(postedMessages), []);

  // 等残留的 pending 记录过期，再拿一条无关的 push 触发清扫。持久墓碑没写成，
  // 清扫只能靠内存里留下的结论认出「这条已经交付过了」。
  await sleep(PENDING_TTL_MS + 30);
  await captureErrors(() => triggerPush({
    messageKind: 'content',
    messageId: 'msg_mp_done_write_failed_sweep',
    message: 'trigger cleanup',
  }));

  assert.equal(business.length, 2, '无关的那条 push 照常交付');
  assert.deepEqual(
    expiredEvents(postedMessages),
    [],
    '用户已经读过的消息，不能因为墓碑那笔写失败就被清扫报成没收到',
  );
  // 清扫本身要真的跑到并清掉残留——不然上面那条断言只是「清扫没跑」的假阴性。
  assert.equal(
    storeHas(conn, MULTIPART_PENDING_STORE, 'mp_done_write_failed'), false,
    '残留的 pending 照常被清扫清掉',
  );
  assert.equal(
    storeHas(conn, MULTIPART_CHUNK_STORE, 'mp_done_write_failed_1'), false,
    '残留的分片也一起清掉',
  );
});

test('multipart: 墓碑写失败后，重投的旧分片不能把已交付的消息再投一次', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  const business = [];
  const PENDING_TTL_MS = 120;
  // 去重关掉：墓碑「重投旧分片不再触发业务事件」的承诺要自己站得住，不能靠
  // 上层 messageId 去重兜底（宿主可以合法关掉去重）。
  installReiSW(sw, {
    dedupe: { enabled: false },
    multipart: { cleanupIntervalMs: 0, ttlMs: PENDING_TTL_MS },
    onBusinessPayload: (payload) => { business.push(payload); },
  });

  const original = {
    messageKind: 'content',
    messageId: 'msg_mp_redelivered',
    message: 'u'.repeat(200),
  };
  const parts = buildMultipartPayloads(original, { id: 'mp_redelivered', maxChunkBytes: 80 });

  for (const part of parts.slice(0, -1)) {
    await triggerPush(part);
  }

  const conn = fake.lastConnection(QUEUE_DB_NAME);
  const restore = breakDoneStoreWrites(conn);
  try {
    await captureErrors(() => triggerPush(parts[parts.length - 1]));
  } finally {
    restore();
  }
  assert.equal(business.length, 1, '第一次照常交付');

  // pending 过期后，推送服务把整条消息的分片重投一遍。第一片到达时清扫顺手把
  // 残留的 pending 和分片清掉——之后要是没有任何结论挡着，剩下的重投分片会把
  // 这条消息从零重新拼齐、再交付一次。
  await sleep(PENDING_TTL_MS + 30);
  await captureErrors(async () => {
    for (const part of parts) await triggerPush(part);
  });

  assert.equal(business.length, 1, '重投不能把同一条消息再交付一次');
  assert.equal(notifications.length, 1, '通知也只该弹第一次那一条');
  assert.deepEqual(expiredEvents(postedMessages), [], '交付过的消息更不能被报成丢了');
});
