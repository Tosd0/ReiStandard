import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWebCryptoWebPush,
  withPushSignal,
  assertVapidConfigured,
  verifyVapidJwt,
  measurePushPayload,
  MAX_PUSH_PAYLOAD_BYTES,
  PUSH_ENVELOPE_RESERVED_BYTES,
  WEB_PUSH_MAX_BODY_BYTES,
  WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES,
} from '../src/server/lib/webpush-webcrypto.js';

// Real P-256 VAPID keypair + a real subscriber key are needed for the
// encryption path to run. Generate them at test time via Web Crypto.
async function genVapid() {
  const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey)); // 65-byte uncompressed
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', kp.privateKey);
  const b64url = (u8) => Buffer.from(u8).toString('base64url');
  return { publicKey: b64url(pub), privateKey: Buffer.from(jwk.d, 'base64url').toString('base64url') };
}

async function genSubscription() {
  const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const b64url = (u8) => Buffer.from(u8).toString('base64url');
  return { endpoint: 'https://push.example.com/sub/abc', keys: { p256dh: b64url(raw), auth: b64url(auth) } };
}

test('sendNotification encrypts + attaches VAPID and posts to the endpoint', async () => {
  const { publicKey, privateKey } = await genVapid();
  const sub = await genSubscription();
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(null, { status: 201 });
  };

  const sender = createWebCryptoWebPush({ email: 'mailto:x@example.com', publicKey, privateKey });
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await sender.sendNotification(sub, JSON.stringify({ messageKind: 'content', message: 'hello' }));
  } finally {
    globalThis.fetch = original;
  }

  assert.ok(captured, 'fetch was called');
  assert.equal(captured.url, sub.endpoint);
  assert.equal(captured.init.headers['Content-Encoding'], 'aes128gcm');
  // Scheduled reminders default to a 4-week TTL so an offline device still gets them.
  assert.equal(captured.init.headers['TTL'], '2419200');
  const authz = captured.init.headers['Authorization'] || captured.init.headers['authorization'];
  assert.match(authz, /^vapid t=/);
  // Extract the JWT and verify it against the VAPID public key (proves the key encoding is correct).
  // verifyVapidJwt throws on a signature/expiry problem and otherwise returns the decoded payload,
  // so a returned payload with the expected claims proves the signature checked out.
  const jwt = authz.slice('vapid t='.length).split(',')[0].trim();
  const decoded = await verifyVapidJwt(jwt, publicKey);
  assert.equal(decoded.aud, 'https://push.example.com');
  assert.equal(decoded.sub, 'mailto:x@example.com');
});

test('sendNotification honours a custom ttl override', async () => {
  const { publicKey, privateKey } = await genVapid();
  const sub = await genSubscription();
  let captured = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { captured = { url, init }; return new Response(null, { status: 201 }); };
  try {
    const sender = createWebCryptoWebPush({ email: 'mailto:x@example.com', publicKey, privateKey }, { ttl: 120 });
    await sender.sendNotification(sub, JSON.stringify({ messageKind: 'content', message: 'hi' }));
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(captured.init.headers['TTL'], '120');
});

describe('取消信号透传', () => {
  test('sendNotification 的 signal / timeoutMs 一路传到 fetch，调用方中止 → PUSH_SEND_FAILED 且不带 statusCode', async () => {
    const { publicKey, privateKey } = await genVapid();
    const sub = await genSubscription();
    const controller = new AbortController();
    let captured = null;
    const original = globalThis.fetch;
    // 像真 fetch 一样：信号一中止就 reject。
    globalThis.fetch = (url, init) => new Promise((_, reject) => {
      captured = { url, init };
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
    try {
      const sender = createWebCryptoWebPush({ email: 'mailto:x@example.com', publicKey, privateKey });
      const pending = sender.sendNotification(sub, '{"a":1}', { signal: controller.signal, timeoutMs: 60_000 });
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.ok(captured.init.signal instanceof AbortSignal, 'fetch 收到了 signal');
      assert.equal(captured.init.signal.aborted, false);
      controller.abort();
      await assert.rejects(pending, (err) => err.code === 'PUSH_SEND_FAILED' && err.statusCode === undefined && !!err.cause);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('withPushSignal：认第三个参数的 sender 绑上信号，不认的原样返回，外层绑定盖过内层', async () => {
    const seen = [];
    const marked = { acceptsSendOptions: true, async sendNotification(_s, _p, options) { seen.push(options); } };
    const inner = new AbortController();
    const outer = new AbortController();
    const bound = withPushSignal(marked, inner.signal);
    await bound.sendNotification({}, 'x');
    assert.equal(seen[0].signal, inner.signal);
    assert.equal(bound.acceptsSendOptions, true, '标记顺着原型链还在');

    // 像 run-tick 的租约守卫那样再包一层，外面再绑一次：新信号要赢。
    const guarded = Object.create(bound);
    Object.defineProperty(guarded, 'sendNotification', { value: (...args) => bound.sendNotification(...args), writable: true, enumerable: true, configurable: true });
    await withPushSignal(guarded, outer.signal).sendNotification({}, 'x');
    assert.equal(seen[1].signal, outer.signal);

    // npm web-push 这种不认未知 option 的 sender：不碰。
    const plain = { async sendNotification(_s, _p, options) { if (options) throw new Error('invalid option'); seen.push('plain'); } };
    assert.equal(withPushSignal(plain, inner.signal), plain);
    await withPushSignal(plain, inner.signal).sendNotification({}, 'x');
    assert.equal(seen[2], 'plain');
    assert.equal(withPushSignal(null, inner.signal), null);
    assert.equal(withPushSignal(marked, undefined), marked);
  });

  test('assertVapidConfigured：缺整个 vapid 或缺任一项都抛 VAPID_CONFIG_MISSING', () => {
    for (const vapid of [undefined, null, {}, { email: 'e', publicKey: 'p' }, { email: 'e', privateKey: 'k' }, { publicKey: 'p', privateKey: 'k' }]) {
      assert.throws(() => assertVapidConfigured(vapid), (err) => err.code === 'VAPID_CONFIG_MISSING');
    }
    assert.doesNotThrow(() => assertVapidConfigured({ email: 'e', publicKey: 'p', privateKey: 'k' }));
  });
});

describe('payload 大小护栏', () => {
  // 上限是怎么算出来的，靠这条钉住：正好 MAX_PUSH_PAYLOAD_BYTES 的明文，
  // 加密后的 body 恰好等于推送服务的 4096 字节上限，一个字节不多不少。
  test('上限大小的 payload 发得出去，且密文 body 正好 4096 字节', async () => {
    const { publicKey, privateKey } = await genVapid();
    const sub = await genSubscription();
    let captured = null;
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => { captured = { url, init }; return new Response(null, { status: 201 }); };
    try {
      const sender = createWebCryptoWebPush({ email: 'mailto:x@example.com', publicKey, privateKey });
      await sender.sendNotification(sub, 'x'.repeat(MAX_PUSH_PAYLOAD_BYTES));
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(captured.init.body.byteLength, WEB_PUSH_MAX_BODY_BYTES);
    assert.equal(
      WEB_PUSH_MAX_BODY_BYTES - MAX_PUSH_PAYLOAD_BYTES,
      WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES
    );
  });

  test('超一个字节就抛 PUSH_PAYLOAD_TOO_LARGE，且根本没发出去', async () => {
    const { publicKey, privateKey } = await genVapid();
    const sub = await genSubscription();
    let fetchCalls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async () => { fetchCalls++; return new Response(null, { status: 201 }); };
    try {
      const sender = createWebCryptoWebPush({ email: 'mailto:x@example.com', publicKey, privateKey });
      await assert.rejects(
        () => sender.sendNotification(sub, 'x'.repeat(MAX_PUSH_PAYLOAD_BYTES + 1)),
        (err) => {
          assert.equal(err.code, 'PUSH_PAYLOAD_TOO_LARGE');
          assert.equal(err.bytes, MAX_PUSH_PAYLOAD_BYTES + 1);
          assert.equal(err.maxBytes, MAX_PUSH_PAYLOAD_BYTES);
          // 错误消息里要能直接看到实际字节数和上限
          assert.match(err.message, new RegExp(`${MAX_PUSH_PAYLOAD_BYTES + 1} bytes`));
          assert.match(err.message, new RegExp(`${MAX_PUSH_PAYLOAD_BYTES}-byte limit`));
          return true;
        }
      );
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(fetchCalls, 0, '超限的 payload 不能发给推送服务等 413');
  });

  test('measurePushPayload 按 UTF-8 字节算预算，多字节字符不按字符数糊弄', async () => {
    const ascii = measurePushPayload('abc');
    assert.deepEqual(
      [ascii.bytes, ascii.remainingBytes, ascii.withinLimit],
      [3, MAX_PUSH_PAYLOAD_BYTES - 3, true]
    );

    // 中文每字 3 字节：字符数 3，字节数 9
    const cjk = measurePushPayload('中文字');
    assert.equal(cjk.bytes, 9);
    assert.equal(cjk.remainingBytes, MAX_PUSH_PAYLOAD_BYTES - 9);

    const over = measurePushPayload('x'.repeat(MAX_PUSH_PAYLOAD_BYTES + 10));
    assert.equal(over.withinLimit, false);
    assert.equal(over.remainingBytes, -10);

    // 预算用法：骨架量完，剩下的额度正好能把 payload 填到上限
    const skeleton = JSON.stringify({ messageKind: 'content', message: '' });
    const { remainingBytes } = measurePushPayload(skeleton);
    const filled = JSON.stringify({ messageKind: 'content', message: 'y'.repeat(remainingBytes) });
    assert.equal(measurePushPayload(filled).withinLimit, true);
    assert.equal(measurePushPayload(filled).remainingBytes, 0);
  });
});

describe('信封预留字节（PUSH_ENVELOPE_RESERVED_BYTES）', () => {
  // hook 把 payload 交还给库之后，库还会补一批「这是谁、第几条、什么时候」的
  // 字段。hook 手里量到的从来不是最终 payload——不留出这批字节的话，卡在边界
  // 上的消息会「量出来装得下、补完字段就超了」，既没走旁路存储也发不出去。
  const STAMPED_KEYS = [
    'messageId', 'sessionId', 'timestamp', 'messageIndex', 'totalMessages',
    'taskId', 'taskUuid', 'recurrenceType', 'occurrenceMs',
  ];

  /** 库补完之后最坏情况下多出来的字节数。 */
  function worstCaseEnvelopeBytes() {
    const base = { messageKind: 'content', message: '' };
    const stamped = {
      ...base,
      // 任务行 id 取 32 位整数上限，occurrence 取 13 位 epoch 毫秒
      messageId: `msg_task_2147483647@9999999999999_hook_999`,
      sessionId: `sess_task_2147483647@9999999999999`,
      timestamp: '2026-08-02T12:34:56.789Z',
      messageIndex: 999,
      totalMessages: 999,
      taskId: 2147483647,
      taskUuid: 'u'.repeat(64), // scheduleTask 允许宿主传任意字符串当 uuid
      recurrenceType: 'weekly',
      occurrenceMs: 9999999999999,
    };
    for (const key of STAMPED_KEYS) {
      assert.ok(key in stamped, `信封字段清单漏了 ${key}`);
    }
    return measurePushPayload(JSON.stringify(stamped)).bytes
      - measurePushPayload(JSON.stringify(base)).bytes;
  }

  test('预留字节能盖住库真正会补上的那批字段', () => {
    const needed = worstCaseEnvelopeBytes();
    assert.ok(
      needed <= PUSH_ENVELOPE_RESERVED_BYTES,
      `信封实际要 ${needed} 字节，PUSH_ENVELOPE_RESERVED_BYTES 只留了 ${PUSH_ENVELOPE_RESERVED_BYTES}`
    );
    // 也别留得离谱——留太多等于白白少发正文。
    assert.ok(PUSH_ENVELOPE_RESERVED_BYTES - needed < 200, '预留得太宽松了，正文额度被白白吃掉');
  });

  test('按预留额度组的 payload，补完信封字段之后仍在上限内', () => {
    const skeleton = JSON.stringify({ messageKind: 'content', message: '' });
    const { remainingBytes } = measurePushPayload(skeleton, { reserveEnvelope: true });
    const push = { messageKind: 'content', message: 'x'.repeat(remainingBytes) };
    assert.equal(measurePushPayload(JSON.stringify(push), { reserveEnvelope: true }).remainingBytes, 0);

    const stamped = JSON.stringify({
      ...push,
      messageId: 'msg_task_2147483647@9999999999999_hook_999',
      sessionId: 'sess_task_2147483647@9999999999999',
      timestamp: '2026-08-02T12:34:56.789Z',
      messageIndex: 999,
      totalMessages: 999,
      taskId: 2147483647,
      taskUuid: 'u'.repeat(64),
      recurrenceType: 'weekly',
      occurrenceMs: 9999999999999,
    });
    assert.equal(measurePushPayload(stamped).withinLimit, true, '补完信封之后就该还装得下');
  });

  test('不留信封的老口径正好会溢出（这就是要留的理由）', () => {
    const skeleton = JSON.stringify({ messageKind: 'content', message: '' });
    const { remainingBytes } = measurePushPayload(skeleton); // 没留信封
    const push = { messageKind: 'content', message: 'x'.repeat(remainingBytes) };
    assert.equal(measurePushPayload(JSON.stringify(push)).withinLimit, true);

    const stamped = JSON.stringify({
      ...push,
      messageId: 'msg_task_7@1577836800000_hook_0',
      sessionId: 'sess_task_7@1577836800000',
      timestamp: '2026-08-02T12:34:56.789Z',
      messageIndex: 1,
      totalMessages: 1,
      taskId: 7,
      taskUuid: '550e8400-e29b-41d4-a716-446655440000',
      recurrenceType: 'daily',
      occurrenceMs: 1577836800000,
    });
    assert.equal(measurePushPayload(stamped).withinLimit, false);
  });

  test('reserveEnvelope 只影响额度口径，bytes 还是这段字符串本身', () => {
    const payload = 'x'.repeat(100);
    const plain = measurePushPayload(payload);
    const reserved = measurePushPayload(payload, { reserveEnvelope: true });
    assert.equal(plain.bytes, reserved.bytes);
    assert.equal(plain.envelopeReservedBytes, 0);
    assert.equal(reserved.envelopeReservedBytes, PUSH_ENVELOPE_RESERVED_BYTES);
    assert.equal(reserved.maxBytes, MAX_PUSH_PAYLOAD_BYTES - PUSH_ENVELOPE_RESERVED_BYTES);
    assert.equal(plain.remainingBytes - reserved.remainingBytes, PUSH_ENVELOPE_RESERVED_BYTES);
  });
});
