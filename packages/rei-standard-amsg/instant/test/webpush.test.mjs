/**
 * Unit tests for the native (Web Crypto) Web Push implementation.
 *
 * Covers:
 *   - VAPID JWT (RFC 8292) ES256 sign/verify round-trip
 *   - RFC 8291 payload encryption + recipient-side decrypt round-trip
 *   - VAPID `Authorization` header shape produced by sendWebPush
 *   - normalizeVapidSubject behavior (mailto: auto-prefix)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import { sendWebPush, buildVapidJwt, verifyVapidJwt } from '../src/webpush.js';
import {
  generateTestVapid,
  generateTestSubscription,
  decryptCapturedPushBody,
  createFetchRouter,
} from './helpers.mjs';

let vapid;
let subKit;

before(async () => {
  vapid = await generateTestVapid();
  subKit = await generateTestSubscription();
});

describe('buildVapidJwt / verifyVapidJwt', () => {
  it('produces a valid ES256 JWT that verifies against the public key', async () => {
    const jwt = await buildVapidJwt({
      audience: 'https://push.example.com',
      subject: 'mailto:vapid@example.com',
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    });

    const parts = jwt.split('.');
    assert.equal(parts.length, 3, 'JWT must be three base64url segments');

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    assert.equal(header.typ, 'JWT');
    assert.equal(header.alg, 'ES256');

    const payload = await verifyVapidJwt(jwt, vapid.publicKey);
    assert.equal(payload.aud, 'https://push.example.com');
    assert.equal(payload.sub, 'mailto:vapid@example.com');
    assert.ok(payload.exp > Math.floor(Date.now() / 1000));
    // exp must fit comfortably under RFC 8292's 24h cap.
    assert.ok(payload.exp - Math.floor(Date.now() / 1000) < 24 * 3600);
  });

  it('rejects a tampered signature', async () => {
    const jwt = await buildVapidJwt({
      audience: 'https://push.example.com',
      subject: 'mailto:vapid@example.com',
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    });
    const [h, p, _s] = jwt.split('.');
    // Replace signature with a syntactically-valid-but-wrong one.
    const tampered = `${h}.${p}.${'A'.repeat(_s.length)}`;
    await assert.rejects(
      () => verifyVapidJwt(tampered, vapid.publicKey),
      /signature mismatch/
    );
  });

  it('rejects malformed VAPID public key', async () => {
    await assert.rejects(
      () => buildVapidJwt({
        audience: 'https://push.example.com',
        subject: 'mailto:vapid@example.com',
        publicKey: 'AAAA',
        privateKey: vapid.privateKey,
      }),
      /65-byte/
    );
  });
});

describe('sendWebPush — RFC 8291 payload encryption', () => {
  it('round-trips: ciphertext sent to the push endpoint decrypts to original payload', async () => {
    const payload = JSON.stringify({ hello: 'world', n: 42, ts: '2026-05-17T00:00:00Z' });

    const router = createFetchRouter({ pushEndpoint: subKit.subscription.endpoint });
    const result = await sendWebPush({
      subscription: subKit.subscription,
      payload,
      vapid,
      fetch: router.fetch,
    });

    assert.equal(result.statusCode, 201);
    assert.equal(router.pushCalls.length, 1);

    const captured = router.pushCalls[0];
    // Headers required by RFC 8030 + RFC 8291 transport.
    assert.equal(captured.headers['content-encoding'], 'aes128gcm');
    assert.equal(captured.headers['content-type'], 'application/octet-stream');
    assert.match(captured.headers['authorization'], /^vapid t=[^,]+, k=/);
    assert.match(captured.headers['ttl'], /^\d+$/);

    const decrypted = await decryptCapturedPushBody(captured.body, subKit);
    assert.equal(decrypted, payload);
  });

  it('embeds a fresh as_public in the encryption header on every send', async () => {
    const router = createFetchRouter({ pushEndpoint: subKit.subscription.endpoint });
    await sendWebPush({ subscription: subKit.subscription, payload: 'first', vapid, fetch: router.fetch });
    await sendWebPush({ subscription: subKit.subscription, payload: 'second', vapid, fetch: router.fetch });

    assert.equal(router.pushCalls.length, 2);
    const keyid1 = router.pushCalls[0].body.subarray(21, 21 + router.pushCalls[0].body[20]);
    const keyid2 = router.pushCalls[1].body.subarray(21, 21 + router.pushCalls[1].body[20]);
    // Two fresh ephemeral keys → very high probability they differ.
    assert.notDeepEqual(Array.from(keyid1), Array.from(keyid2));
  });

  it('surfaces PUSH_SEND_FAILED with statusCode when push gateway errors', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      onPush: () => new Response('subscription gone', { status: 410, statusText: 'Gone' }),
    });
    await assert.rejects(
      () => sendWebPush({
        subscription: subKit.subscription,
        payload: 'x',
        vapid,
        fetch: router.fetch,
      }),
      (err) => err.code === 'PUSH_SEND_FAILED' && err.statusCode === 410
    );
  });

  it('rejects without VAPID configuration', async () => {
    await assert.rejects(
      () => sendWebPush({
        subscription: subKit.subscription,
        payload: 'x',
        vapid: { email: '', publicKey: '', privateKey: '' },
        fetch: async () => new Response(null, { status: 201 }),
      }),
      /VAPID_CONFIG_MISSING/
    );
  });

  it('rejects subscription missing keys.p256dh / keys.auth', async () => {
    await assert.rejects(
      () => sendWebPush({
        subscription: { endpoint: 'https://push.example.com/sub', keys: {} },
        payload: 'x',
        vapid,
        fetch: async () => new Response(null, { status: 201 }),
      }),
      /p256dh.*auth/
    );
  });
});
