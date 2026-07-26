import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWebCryptoWebPush,
  verifyVapidJwt,
  measurePushPayload,
  MAX_PUSH_PAYLOAD_BYTES,
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
