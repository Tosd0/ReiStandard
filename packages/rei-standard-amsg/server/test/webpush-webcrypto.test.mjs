import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebCryptoWebPush, verifyVapidJwt } from '../src/server/lib/webpush-webcrypto.js';

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
