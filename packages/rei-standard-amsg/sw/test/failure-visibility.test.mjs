import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeIndexedDB, FakeDOMException } from './helpers/fake-indexeddb.mjs';
import { buildMultipartPayloads } from './helpers/multipart-wire.mjs';

// 先装可控 IndexedDB 再 import SDK（`node --test` 每个文件独立进程，不会串到
// 别的套件里）。离线队列这条路无论如何都要 IndexedDB，没有 fallback。
const fake = installFakeIndexedDB();

const QUEUE_DB_NAME = 'rei-sw';

// helpers 里的 fake 打得开就一定能用，没有注入故障的口子；它是连接韧性套件的
// 共用夹具，不该为这里的用例改。所以在外面再套一层：名字进了这个集合的库，
// open 照常成功，但 db.transaction() 抛 NotFoundError —— 宿主占了同一个
// dbName 却没有 delivery-dedupe 这个 store 时就是这个形状。
const brokenDbNames = new Set();
const realIndexedDB = globalThis.indexedDB;

function brokenConnection(storeName) {
  return {
    objectStoreNames: { contains: () => true },
    transaction() {
      throw new FakeDOMException(`No object store ${storeName}`, 'NotFoundError');
    },
    close() {},
  };
}

globalThis.indexedDB = {
  open(name, version) {
    if (!brokenDbNames.has(name)) return realIndexedDB.open(name, version);

    const request = {
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      result: brokenConnection('delivery-dedupe'),
      error: null,
      transaction: null,
    };
    queueMicrotask(() => {
      if (typeof request.onsuccess === 'function') request.onsuccess();
    });
    return request;
  },
};

const { installReiSW, REI_SW_EVENT } = await import('../src/index.js');

const QUEUE_RESULT = 'REI_QUEUE_RESULT';
const QUEUE_DROPPED = 'REI_QUEUE_DROPPED';
const ENQUEUE_REQUEST = 'REI_ENQUEUE_REQUEST';
const FLUSH_QUEUE = 'REI_FLUSH_QUEUE';
const DELIVER = 'REI_AMSG_DELIVER';

let dbCounter = 0;
function brokenDedupeDbName() {
  dbCounter += 1;
  const name = `dedupe_broken_${dbCounter}`;
  brokenDbNames.add(name);
  return name;
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

  // 置成 true 后 showNotification 一律 reject —— 模拟权限被撤 / 配额 / OS 错误。
  const state = { rejectNotifications: false };

  const sw = {
    addEventListener(name, handler) { listeners.set(name, handler); },
    registration: {
      showNotification(title, options) {
        if (state.rejectNotifications) {
          return Promise.reject(new Error('notification permission revoked'));
        }
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

  async function triggerMessage(message) {
    const pending = [];
    const replies = [];
    listeners.get('message')({
      data: message,
      ports: [{ postMessage(reply) { replies.push(reply); } }],
      waitUntil(work) { pending.push(Promise.resolve(work)); },
    });
    await Promise.all(pending);
    return replies;
  }

  return { sw, state, notifications, postedMessages, triggerPush, triggerMessage };
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

/** 替换 globalThis.fetch，并记下每次调用的 url。 */
function stubFetch(respond) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(calls.length);
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

const QUEUED_REQUEST = Object.freeze({
  url: 'https://example.test/api/v1/schedule-message',
  method: 'POST',
  body: { text: 'schedule me' },
});

// --- 离线队列：被 4xx 拒掉的请求不能悄悄消失 ---------------------------------

test('queue: a delivered request acks delivered:true and stays quiet', async () => {
  const { sw, postedMessages, triggerMessage } = createSwMock();
  installReiSW(sw);

  const fetchStub = stubFetch(() => ({ ok: true, status: 200 }));
  let replies;
  const { lines } = await captureErrors(async () => {
    replies = await triggerMessage({ type: ENQUEUE_REQUEST, request: QUEUED_REQUEST });
  });
  fetchStub.restore();

  assert.equal(replies[0].ok, true);
  assert.equal(replies[0].delivered, true, 'ack must say the request actually went out');
  assert.equal(replies[0].dropped, undefined);
  assert.deepEqual(postedMessages, [], '成功不广播，别刷屏');
  assert.deepEqual(lines, []);
});

test('queue: a 4xx-rejected request is reported instead of vanishing', async () => {
  const { sw, postedMessages, triggerMessage } = createSwMock();
  installReiSW(sw);

  const fetchStub = stubFetch(() => ({ ok: false, status: 401 }));
  let replies;
  const { lines } = await captureErrors(async () => {
    replies = await triggerMessage({ type: ENQUEUE_REQUEST, request: QUEUED_REQUEST });
  });

  // 1）页面拿到的 ack 不再只说「排上了」。
  const ack = replies[0];
  assert.equal(ack.ok, true, '入队这一步确实成功了，`ok` 的老含义不变');
  assert.equal(typeof ack.queueId, 'number');
  assert.equal(ack.delivered, false);
  assert.equal(ack.dropped, true, '被永久拒绝、已从队列删掉，必须说出来');
  assert.equal(ack.status, 401, '下游按状态码机读判断，不靠正则匹配人话');

  // 2）页面侧还有一条广播能收到（没用 MessageChannel 的调用方也能看见）。
  //    它用的是独立的 QUEUE_DROPPED，不跟点对点的入队回执抢同一个 type——
  //    共用的话，页面等自己那条 ack 时会先收到这条广播、当成自己的结果。
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].type, QUEUE_DROPPED);
  assert.notEqual(postedMessages[0].type, QUEUE_RESULT, '广播不能和入队回执撞 type');
  assert.equal(postedMessages[0].ok, false);
  assert.equal(postedMessages[0].dropped, true);
  assert.equal(postedMessages[0].status, 401);
  assert.equal(postedMessages[0].queueId, ack.queueId);
  assert.equal(postedMessages[0].request.url, QUEUED_REQUEST.url);
  assert.equal(postedMessages[0].request.method, 'POST');
  assert.equal(postedMessages[0].request.body, undefined, '广播不带 body / headers');

  // 3）控制台留下能归因的一条。
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('queued request dropped'), lines[0]);

  // 4）重试策略没被改坏：4xx 之后记录就是没了，不会再发第二次。
  const before = fetchStub.calls.length;
  await triggerMessage({ type: FLUSH_QUEUE });
  fetchStub.restore();
  assert.equal(fetchStub.calls.length, before, '4xx 之后不再重试');
});

test('queue: a network failure keeps the request queued and is not reported as dropped', async () => {
  const { sw, postedMessages, triggerMessage } = createSwMock();
  installReiSW(sw);

  const failing = stubFetch(() => { throw new TypeError('Failed to fetch'); });
  const replies = await triggerMessage({ type: ENQUEUE_REQUEST, request: QUEUED_REQUEST });
  failing.restore();

  assert.equal(replies[0].ok, true);
  assert.equal(replies[0].delivered, false, '没发出去');
  assert.equal(replies[0].dropped, undefined, '离线只是还没轮到，不是被拒');
  assert.deepEqual(postedMessages, []);

  // 还在队列里：网络恢复后的下一次冲刷应当把它发出去。
  const recovered = stubFetch(() => ({ ok: true, status: 200 }));
  await triggerMessage({ type: FLUSH_QUEUE });
  recovered.restore();
  assert.equal(recovered.calls.length, 1, '记录仍在队列里，恢复后照常重试');
});

// --- 离线队列：被并发 flush 抢先结算的请求，ack 不能撒谎 ---------------------

/**
 * 入队方 add 完还要 await 一次 Background Sync 注册才轮到自己 flush；这个空当
 * 里，刚注册的 sync flush（或别的窗口发的 FLUSH_QUEUE）完全可能先跑完、把这条
 * 记录结算掉。在 mock 的 sync.register 里就地跑完一轮并发 flush，就是把这个
 * 空当钉死放大。
 */
function armConcurrentFlush(sw, triggerMessage) {
  const state = { runs: 0 };
  sw.registration.sync = {
    async register() {
      if (state.runs > 0) return;
      state.runs += 1;
      await triggerMessage({ type: FLUSH_QUEUE });
    },
  };
  return state;
}

test('queue: 并发 flush 抢先送走的请求，ack 要如实报 delivered:true', async () => {
  const { sw, postedMessages, triggerMessage } = createSwMock();
  installReiSW(sw);
  const concurrent = armConcurrentFlush(sw, triggerMessage);

  const fetchStub = stubFetch(() => ({ ok: true, status: 200 }));
  let replies;
  const { lines } = await captureErrors(async () => {
    replies = await triggerMessage({ type: ENQUEUE_REQUEST, request: QUEUED_REQUEST });
  });
  fetchStub.restore();

  assert.equal(concurrent.runs, 1, '并发 flush 得真的抢跑过，不然这条测试白测了');
  assert.equal(fetchStub.calls.length, 1, '请求只发了一次（并发那轮发的），没有重复发送');
  assert.equal(replies[0].ok, true);
  // 记录已被并发 flush 成功送走。ack 报 delivered:false 的话，页面会按「还在
  // 排队等重试」处理——而成功送达不广播任何事件，没有第二条消息来纠正它，
  // 用户手动重试就会在服务端排出重复任务。
  assert.equal(replies[0].delivered, true, '被并发 flush 送达也得如实报 delivered:true');
  assert.equal(replies[0].dropped, undefined);
  assert.deepEqual(postedMessages, [], '成功送达不该有任何广播');
  assert.deepEqual(lines, []);
});

test('queue: 并发 flush 里被 4xx 拒掉的请求，ack 也要带上 dropped 的结局', async () => {
  const { sw, postedMessages, triggerMessage } = createSwMock();
  installReiSW(sw);
  const concurrent = armConcurrentFlush(sw, triggerMessage);

  const fetchStub = stubFetch(() => ({ ok: false, status: 401 }));
  let replies;
  await captureErrors(async () => {
    replies = await triggerMessage({ type: ENQUEUE_REQUEST, request: QUEUED_REQUEST });
  });
  fetchStub.restore();

  assert.equal(concurrent.runs, 1);
  assert.equal(fetchStub.calls.length, 1);
  const ack = replies[0];
  assert.equal(ack.ok, true);
  assert.equal(ack.delivered, false);
  assert.equal(ack.dropped, true, '被并发 flush 判了永久拒绝，ack 不能只说「没送达」');
  assert.equal(ack.status, 401);
  // 广播照旧只有并发那轮结算时发出的一条。
  assert.equal(postedMessages.filter((m) => m.type === QUEUE_DROPPED).length, 1);
});

// --- push：去重仓库坏掉不能把整条 push 吞掉 ----------------------------------

test('push: a broken dedupe store still shows the notification and runs business', async () => {
  const business = [];
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw, {
    dedupe: { dbName: brokenDedupeDbName(), cleanupIntervalMs: 0 },
    onBusinessPayload: (payload) => { business.push(payload); },
  });

  const { lines } = await captureErrors(() => triggerPush({
    messageKind: 'content',
    messageId: 'msg_dedupe_broken_1',
    message: 'still deliver me',
  }));

  assert.equal(notifications.length, 1, '去重坏了应该多弹一条，不该一条都不弹');
  assert.equal(business.length, 1, 'onBusinessPayload 照常跑');
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].event, REI_SW_EVENT.CONTENT_RECEIVED);
  assert.ok(
    lines.some((line) => line.includes('dedupe claim failed')),
    `失败要留下能归因的日志：${JSON.stringify(lines)}`,
  );
});

test('deliver: a broken dedupe store acks ok:true with a machine-readable dedupeError', async () => {
  const { sw, notifications, triggerMessage } = createSwMock();
  installReiSW(sw, {
    dedupe: { dbName: brokenDedupeDbName(), cleanupIntervalMs: 0 },
  });

  let replies;
  await captureErrors(async () => {
    replies = await triggerMessage({
      type: DELIVER,
      source: 'sse',
      requestId: 'req-dedupe-broken',
      payload: { messageKind: 'content', messageId: 'msg_dedupe_broken_2', message: 'ack me' },
    });
  });

  assert.equal(replies[0].ok, true, '分发成功了，不该报成投递失败');
  assert.equal(replies[0].duplicate, false);
  assert.equal(replies[0].requestId, 'req-dedupe-broken');
  assert.equal(typeof replies[0].dedupeError, 'string', '发送端得知道这条没走去重');
  assert.equal(notifications.length, 1);
});

test('push: a duplicate whose repair notification is rejected must not hang the push', async () => {
  const duplicates = [];
  const { sw, state, triggerPush } = createSwMock();
  installReiSW(sw, {
    dedupe: { dbName: `dedupe_repair_reject_${Date.now()}`, cleanupIntervalMs: 0 },
    onDuplicate: (info) => { duplicates.push(info); },
  });

  const messageId = 'msg_repair_reject';
  // 首包按策略不弹通知，记录上留下 notificationShown: false。
  await triggerPush({
    messageKind: 'content',
    messageId,
    message: 'first',
    notification: { show: false },
  });

  // backup 到达，本该补一条通知，但这次 showNotification 被拒。
  state.rejectNotifications = true;
  const { lines } = await captureErrors(() => triggerPush({
    messageKind: 'content',
    messageId,
    message: 'first',
    notification: { show: 'always' },
  }));

  assert.equal(duplicates.length, 1, '补通知失败不能把整条 duplicate 处理带走');
  assert.equal(duplicates[0].duplicateNotificationShown, false, '没弹成就得如实说没弹');
  assert.ok(
    lines.some((line) => line.includes('duplicate showNotification rejected')),
    `失败要留下能归因的日志：${JSON.stringify(lines)}`,
  );
});

test('deliver: 通知弹不出来时，回执带 notificationError（首投）', async () => {
  const { sw, state, triggerMessage } = createSwMock();
  installReiSW(sw, {
    dedupe: { dbName: `dedupe_notify_reject_${Date.now()}`, cleanupIntervalMs: 0 },
  });

  state.rejectNotifications = true;
  let replies;
  await captureErrors(async () => {
    replies = await triggerMessage({
      type: DELIVER,
      source: 'sse',
      requestId: 'req-notify-reject',
      payload: { messageKind: 'content', messageId: 'msg_notify_reject', message: 'ack me' },
    });
  });

  // 收下了也分发了，所以 ok 保持 true——但把 DELIVER 当备份通道用的发送端要靠
  // 这个字段知道用户压根没看见这条消息，是该回退还是重试。
  assert.equal(replies[0].ok, true, '分发成功了，不该报成投递失败');
  assert.equal(replies[0].requestId, 'req-notify-reject');
  assert.equal(
    replies[0].notificationError, 'notification permission revoked',
    `通知没弹出来得如实报给发送端：${JSON.stringify(replies[0])}`,
  );
});

test('deliver: 重复包补通知被拒时，回执一样带 notificationError', async () => {
  const { sw, state, triggerPush, triggerMessage } = createSwMock();
  installReiSW(sw, {
    dedupe: { dbName: `dedupe_notify_reject_dup_${Date.now()}`, cleanupIntervalMs: 0 },
  });

  const messageId = 'msg_notify_reject_dup';
  // 首包按策略不弹通知，记录上留下 notificationShown: false。
  await triggerPush({
    messageKind: 'content', messageId, message: 'first', notification: { show: false },
  });

  // backup 走 DELIVER 到达，本该补一条通知，但这次 showNotification 被拒。
  state.rejectNotifications = true;
  let replies;
  await captureErrors(async () => {
    replies = await triggerMessage({
      type: DELIVER,
      source: 'sse',
      requestId: 'req-notify-reject-dup',
      payload: {
        messageKind: 'content', messageId, message: 'first', notification: { show: 'always' },
      },
    });
  });

  assert.equal(replies[0].ok, true);
  assert.equal(replies[0].duplicate, true);
  assert.equal(
    replies[0].notificationError, 'notification permission revoked',
    `补通知没弹成得如实报给发送端：${JSON.stringify(replies[0])}`,
  );
});

// --- push：分片存储坏掉要「放弃这条 multipart」，不是挂掉整条 push ----------

test('push: a broken multipart store gives up on the id instead of hanging the push', async () => {
  const business = [];
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw, {
    dedupe: { dbName: `dedupe_multipart_${Date.now()}`, cleanupIntervalMs: 0 },
    onBusinessPayload: (payload) => { business.push(payload); },
  });

  const original = { messageKind: 'content', messageId: 'msg_mp_broken', message: 'x'.repeat(200) };
  const parts = buildMultipartPayloads(original, { id: 'mp_broken_store', maxChunkBytes: 80 });
  assert.ok(parts.length >= 2, 'need a multi-chunk payload');

  // 第一片正常落库，顺便把 queue 连接开出来。
  await triggerPush(parts[0]);
  assert.equal(notifications.length, 0, '没收齐之前不该弹通知');

  const conn = fake.lastConnection(QUEUE_DB_NAME);
  const realTransaction = conn.transaction;
  conn.transaction = () => {
    throw new FakeDOMException('No object store multipart-chunk', 'NotFoundError');
  };

  let lines;
  try {
    ({ lines } = await captureErrors(() => triggerPush(parts[1])));
  } finally {
    conn.transaction = realTransaction;
  }

  assert.ok(
    lines.some((line) => line.includes('multipart chunk rejected (storage-failed)')),
    `失败要留下能归因的日志：${JSON.stringify(lines)}`,
  );
  assert.equal(notifications.length, 0, '手里只有半条消息，绝不能拿去弹通知');
  assert.equal(business.length, 0, '也不能当完整 payload 交给业务');

  const expired = postedMessages.filter((m) => m.event === REI_SW_EVENT.MULTIPART_EXPIRED);
  assert.equal(expired.length, 1, '要告诉页面这条分片消息别再等了');
  assert.equal(expired[0].payload.id, 'mp_broken_store');
  assert.equal(expired[0].payload.total, parts.length);
});
