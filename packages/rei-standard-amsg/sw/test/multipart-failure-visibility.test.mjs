import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

// 先装可控 IndexedDB 再 import SDK（`node --test` 每个文件一个进程，不会串到别的
// 套件里）。这里要的不只是「有个库能用」，还要能在重组成功之后精准打断收尾那一步。
const fake = installFakeIndexedDB();

const QUEUE_DB_NAME = 'rei-sw';
const MULTIPART_DONE_STORE = 'multipart-done';
const MULTIPART_PENDING_STORE = 'multipart-pending';

const { installReiSW, REI_SW_EVENT } = await import('../src/index.js');

class FakeDOMException extends Error {
  constructor(message, name) {
    super(message);
    this.name = name;
  }
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

/** 把任意字节切成 multipart 分片信封。text 不是 JSON 时用来造「拼得回、解不开」。 */
function buildChunksFromText(text, { id, maxChunkBytes = 80, ttlMs = 60_000, originalMessageKind = null }) {
  const bytes = new TextEncoder().encode(text);
  const total = Math.ceil(bytes.byteLength / maxChunkBytes);
  const createdAt = Date.now();
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
        originalMessageKind,
        createdAt,
        ttlMs,
      },
      chunk: Buffer.from(chunk).toString('base64url'),
    };
  });
}

function buildMultipartPayloads(payload, options) {
  return buildChunksFromText(JSON.stringify(payload), {
    originalMessageKind: typeof payload.messageKind === 'string' ? payload.messageKind : null,
    ...options,
  });
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

// --- 进了管线但收不齐 --------------------------------------------------------

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
