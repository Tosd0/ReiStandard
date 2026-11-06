import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import { sendWebPush, buildVapidJwt, verifyVapidJwt } from '../src/webpush.js';
import { bytesToBase64Url, jsonToBase64Url, randomBytes, utf8 } from '../src/webcrypto-utils.js';

const subtle = globalThis.crypto.subtle;

async function generateTestVapid() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pubRaw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  return {
    email: 'mailto:vapid@example.com',
    publicKey: bytesToBase64Url(pubRaw),
    privateKey: jwk.d,
    _privateCryptoKey: kp.privateKey,
  };
}

async function generateTestSubscription() {
  const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pubRaw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return {
    endpoint: 'https://push.example.com/sub/test-token',
    keys: { p256dh: bytesToBase64Url(pubRaw), auth: bytesToBase64Url(randomBytes(16)) },
  };
}

/** Sign an arbitrary VAPID payload directly, bypassing buildVapidJwt's fixed exp. */
async function signJwt(payload, privateCryptoKey) {
  const h = jsonToBase64Url({ typ: 'JWT', alg: 'ES256' });
  const p = jsonToBase64Url(payload);
  const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateCryptoKey, utf8(`${h}.${p}`));
  return `${h}.${p}.${bytesToBase64Url(sig)}`;
}

function okResponse(extra = {}) {
  return { ok: true, status: 201, statusText: 'Created', headers: new Headers(), text: async () => '', ...extra };
}

let vapid;
let subscription;

before(async () => {
  vapid = await generateTestVapid();
  subscription = await generateTestSubscription();
});

// ─── sendWebPush: signal / timeout ─────────────────────────────────────

test('sendWebPush: fetch receives an AbortSignal even when the caller passes none', async () => {
  let init;
  await sendWebPush({
    subscription, payload: '{}', vapid,
    fetch: async (_url, i) => { init = i; return okResponse(); },
  });
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.signal.aborted, false);
});

test('sendWebPush: timeoutMs aborts a push service that never answers', async () => {
  const started = Date.now();
  await assert.rejects(
    () => sendWebPush({
      subscription, payload: '{}', vapid, timeoutMs: 20,
      fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      }),
    }),
    (err) => err.code === 'PUSH_SEND_FAILED' && err.cause?.name === 'TimeoutError',
  );
  assert.ok(Date.now() - started < 2000);
});

test('sendWebPush: caller signal is merged into the fetch signal', async () => {
  const controller = new AbortController();
  const pending = sendWebPush({
    subscription, payload: '{}', vapid, signal: controller.signal,
    // Like real fetch: an already-aborted signal rejects right away.
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason));
    }),
  });
  controller.abort();
  await assert.rejects(pending, (err) => err.code === 'PUSH_SEND_FAILED' && err.cause?.name === 'AbortError');
});

// ─── sendWebPush: response body cap ────────────────────────────────────

test('sendWebPush: stops reading a streamed response body at 16 KiB and cancels the stream', async () => {
  let cancelled = false;
  let pulls = 0;
  const endless = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024).fill(0x61)); },
    cancel() { cancelled = true; },
  });
  const result = await sendWebPush({
    subscription, payload: '{}', vapid,
    fetch: async () => okResponse({ body: endless, text: async () => 'a'.repeat(100_000) }),
  });
  assert.equal(result.body.length, 16 * 1024);
  assert.ok(pulls < 64, `pulled ${pulls} chunks`);
  assert.equal(cancelled, true);
});

test('sendWebPush: truncates text() when the response has no body stream', async () => {
  const result = await sendWebPush({
    subscription, payload: '{}', vapid,
    fetch: async () => okResponse({ body: null, text: async () => 'b'.repeat(100_000) }),
  });
  assert.equal(result.body.length, 16 * 1024);
});

// ─── verifyVapidJwt: aud / exp bound ───────────────────────────────────

test('verifyVapidJwt: expectedAudience must match aud', async () => {
  const jwt = await buildVapidJwt({
    audience: 'https://push.example.com',
    subject: 'mailto:vapid@example.com',
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
  });
  const payload = await verifyVapidJwt(jwt, vapid.publicKey, { expectedAudience: 'https://push.example.com' });
  assert.equal(payload.aud, 'https://push.example.com');
  await assert.rejects(
    () => verifyVapidJwt(jwt, vapid.publicKey, { expectedAudience: 'https://other.example.com' }),
    /audience mismatch/,
  );
});

test('verifyVapidJwt: rejects exp more than 24h ahead', async () => {
  const now = Math.floor(Date.now() / 1000);
  const base = { aud: 'https://push.example.com', sub: 'mailto:vapid@example.com' };
  const tooFar = await signJwt({ ...base, exp: now + 48 * 3600 }, vapid._privateCryptoKey);
  await assert.rejects(() => verifyVapidJwt(tooFar, vapid.publicKey), /24h/);
  const fine = await signJwt({ ...base, exp: now + 23 * 3600 }, vapid._privateCryptoKey);
  assert.equal((await verifyVapidJwt(fine, vapid.publicKey)).sub, base.sub);
});
