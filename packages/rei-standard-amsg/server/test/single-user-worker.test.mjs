import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createWebCryptoWebPush } from '../src/server/lib/webpush-webcrypto.js';
import { deriveUserEncryptionKey, encryptPayload, encryptForStorage } from '../src/server/lib/encryption.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

function makeWorker(d1) {
  return createSingleUserCloudflareWorker((env) => ({
    db: createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} }
  }));
}

test('fetch routes init + schedule + messages, unknown → 404', async () => {
  const d1 = createTestD1();
  const worker = makeWorker(d1);
  const env = { DB: d1 };

  // build tables via the init route
  const initRes = await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
  assert.equal(initRes.status, 200);

  // 排程要求这个用户已经登记过推送订阅（任务行不携带订阅了）。
  await seedPushSubscription(createD1Adapter(d1), USER, MASTER_KEY);

  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const body = JSON.stringify(await encryptPayload({
    contactName: 'Rei', messageType: 'fixed', userMessage: 'hi',
    firstSendTime: '2999-01-01T00:00:00.000Z', recurrenceType: 'none'
  }, userKey));

  const schedRes = await worker.fetch(new Request('https://w.dev/schedule-message', {
    method: 'POST',
    headers: { 'X-User-Id': USER, 'X-Payload-Encrypted': 'true', 'X-Encryption-Version': '1' },
    body
  }), env);
  assert.equal(schedRes.status, 201);

  const listRes = await worker.fetch(new Request('https://w.dev/messages?status=all', {
    method: 'GET', headers: { 'X-User-Id': USER }
  }), env);
  assert.equal(listRes.status, 200);

  // 复数是列表、单数是单条。两条路由都用 endsWith 匹配，这里钉住它们不会互相
  // 吃掉请求：/messages 拿到的是列表（上面那条 200），/message 缺 id 会被单条
  // 处理器打回 400 —— 要是路由串了，这里会变成列表的 200。
  const detailNoId = await worker.fetch(new Request('https://w.dev/message', {
    method: 'GET', headers: { 'X-User-Id': USER }
  }), env);
  assert.equal(detailNoId.status, 400);
  assert.equal((await detailNoId.json()).error.code, 'TASK_ID_REQUIRED');

  const notFound = await worker.fetch(new Request('https://w.dev/nope', { method: 'GET' }), env);
  assert.equal(notFound.status, 404);

  // A trailing slash routes the same as without it (not a 404).
  const trailingSlash = await worker.fetch(new Request('https://w.dev/init-tenant/', { method: 'POST' }), env);
  assert.equal(trailingSlash.status, 200);
});

test('scheduled() runs the tick over env.DB', async () => {
  const d1 = createTestD1();
  const adapter = createD1Adapter(d1);
  await adapter.initSchema();
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const enc = await encryptForStorage(JSON.stringify({
    contactName: 'Rei', messageType: 'fixed', userMessage: 'hi', recurrenceType: 'none'
  }), userKey);
  await seedPushSubscription(adapter, USER, MASTER_KEY);
  await adapter.createTask({ user_id: USER, uuid: 'due', encrypted_payload: enc, next_send_at: new Date(Date.now() - 30_000).toISOString(), message_type: 'fixed' });

  let sent = 0;
  const worker = createSingleUserCloudflareWorker(() => ({
    db: adapter,
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() { sent++; } }
  }));

  await worker.scheduled({}, { DB: d1 });
  assert.ok(sent >= 1);
  assert.equal((await adapter.getPendingTasks(50)).length, 0);
});

test('fetch() turns an unexpected error into a JSON 500 (not the runtime error page)', async () => {
  const worker = createSingleUserCloudflareWorker(() => { throw new Error('config boom'); });
  const origErr = console.error;
  let logged = 0;
  console.error = () => { logged++; };
  let res;
  try {
    res = await worker.fetch(new Request('https://w.dev/messages', { method: 'GET' }), {});
  } finally {
    console.error = origErr;
  }
  assert.equal(res.status, 500);
  assert.equal(res.headers.get('Content-Type'), 'application/json; charset=utf-8');
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.ok(logged >= 1); // logged, not silently swallowed
});

test('scheduled() logs and swallows a tick failure so the next cron retries', async () => {
  const worker = createSingleUserCloudflareWorker(() => ({
    db: { async getPendingTasks() { throw new Error('db down'); } },
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} }
  }));
  const origErr = console.error;
  let logged = 0;
  console.error = () => { logged++; };
  try {
    await worker.scheduled({}, { DB: null }); // must NOT throw
  } finally {
    console.error = origErr;
  }
  assert.ok(logged >= 1);
});

test('CORS off by default: OPTIONS → 404 and no Access-Control header on responses', async () => {
  const d1 = createTestD1();
  const worker = makeWorker(d1);
  const env = { DB: d1 };
  await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

  const preflight = await worker.fetch(
    new Request('https://w.dev/messages', { method: 'OPTIONS', headers: { Origin: 'https://app.example.com' } }),
    env
  );
  assert.equal(preflight.status, 404);

  const listed = await worker.fetch(
    new Request('https://w.dev/messages?status=all', { method: 'GET', headers: { 'X-User-Id': USER, Origin: 'https://app.example.com' } }),
    env
  );
  assert.equal(listed.headers.get('Access-Control-Allow-Origin'), null);
});

test('CORS opt-in: OPTIONS preflight answered, real response echoes the allowed origin', async () => {
  const d1 = createTestD1();
  const worker = createSingleUserCloudflareWorker((env) => ({
    db: createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} },
    cors: { origin: 'https://app.example.com' }
  }));
  const env = { DB: d1 };
  await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

  const preflight = await worker.fetch(
    new Request('https://w.dev/schedule-message', { method: 'OPTIONS', headers: { Origin: 'https://app.example.com' } }),
    env
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://app.example.com');
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /X-Client-Token/);
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /DELETE/);

  const listed = await worker.fetch(
    new Request('https://w.dev/messages?status=all', { method: 'GET', headers: { 'X-User-Id': USER, Origin: 'https://app.example.com' } }),
    env
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('Access-Control-Allow-Origin'), 'https://app.example.com');
  assert.equal(listed.headers.get('Vary'), 'Origin');
});

// 回归守卫：抛异常那条 500 也必须带 CORS 头。少了 Access-Control-Allow-Origin，
// 浏览器会把整条响应吞掉、前端的 fetch 直接 reject 成网络错误（Safari 显示
// "Load failed"）—— 服务端异常在前端长得和断网一模一样，真因谁也查不出来。
test('CORS: a throwing handler still returns a 500 the browser can read', async () => {
  const worker = createSingleUserCloudflareWorker(() => ({
    db: { async listTasks() { throw new Error('db boom'); } },
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} },
    cors: { origin: 'https://app.example.com' }
  }));
  const origErr = console.error;
  console.error = () => {};
  let res;
  try {
    res = await worker.fetch(new Request('https://w.dev/messages?status=all', {
      method: 'GET', headers: { 'X-User-Id': USER, Origin: 'https://app.example.com' }
    }), {});
  } finally {
    console.error = origErr;
  }
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, 'INTERNAL_ERROR');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://app.example.com');
});

// 同一个洞的配置级版本：buildConfig 自己炸了（少个 binding、环境变量丢了）时
// 连预检都会掉进错误分支。预检不是 2xx 浏览器就不会发真正那条请求，前端拿到的
// 还是「网络失败」，整个站挂掉且零报错信息。
test('CORS: a config build failure answers the preflight and returns a readable 500', async () => {
  const worker = createSingleUserCloudflareWorker(() => { throw new Error('config boom'); });
  const origErr = console.error;
  console.error = () => {};
  let preflight, res, sameOrigin;
  try {
    preflight = await worker.fetch(
      new Request('https://w.dev/messages', { method: 'OPTIONS', headers: { Origin: 'https://app.example.com' } }),
      {}
    );
    res = await worker.fetch(
      new Request('https://w.dev/messages?status=all', {
        method: 'GET', headers: { 'X-User-Id': USER, Origin: 'https://app.example.com' }
      }),
      {}
    );
    sameOrigin = await worker.fetch(new Request('https://w.dev/messages?status=all', { method: 'GET' }), {});
  } finally {
    console.error = origErr;
  }

  assert.ok(preflight.status >= 200 && preflight.status < 300, '预检必须是 2xx，否则真正那条请求根本发不出去');
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://app.example.com');
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /X-User-Id/);
  assert.match(preflight.headers.get('Access-Control-Allow-Methods'), /GET/);

  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, 'INTERNAL_ERROR');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://app.example.com');

  // 兜底只回显来访的 Origin，不退化成 '*'：没配 CORS 的部署不该因为配置炸了就变成全开。
  assert.equal(sameOrigin.status, 500);
  assert.equal(sameOrigin.headers.get('Access-Control-Allow-Origin'), null);
});

// Regression guard (design spec §7): with serverToken set, EVERY exposed HTTP
// endpoint must require X-Client-Token. Today all handlers funnel through the
// same resolveTenant, but this pins it down so a future handler that forgets
// that call can't silently ship an auth-bypassing route.
test('serverToken set → every exposed route rejects wrong/missing token with 401', async () => {
  const d1 = createTestD1();
  const worker = createSingleUserCloudflareWorker(() => ({
    db: createD1Adapter(d1),
    masterKey: MASTER_KEY,
    serverToken: 's3cret',
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} }
  }));
  const env = { DB: d1 };

  const routes = [
    ['POST', 'https://w.dev/init-tenant'],
    ['GET', 'https://w.dev/get-user-key'],
    ['POST', 'https://w.dev/schedule-message'],
    ['GET', 'https://w.dev/messages?status=all'],
    ['PUT', 'https://w.dev/update-message?id=x'],
    ['DELETE', 'https://w.dev/cancel-message?id=x'],
    ['GET', 'https://w.dev/vapid-public-key'],
    ['PUT', 'https://w.dev/client-state'],
    ['GET', 'https://w.dev/client-state?namespace=n'],
    ['DELETE', 'https://w.dev/client-state']
  ];

  for (const [method, url] of routes) {
    const wrong = await worker.fetch(
      new Request(url, { method, headers: { 'X-Client-Token': 'nope', 'X-User-Id': USER } }),
      env
    );
    assert.equal(wrong.status, 401, `${method} ${url} with a wrong token must be 401`);

    const missing = await worker.fetch(
      new Request(url, { method, headers: { 'X-User-Id': USER } }),
      env
    );
    assert.equal(missing.status, 401, `${method} ${url} with no token must be 401`);
  }
});

// ─── GET /vapid-public-key ─────────────────────────────────────────────────
// The frontend needs THIS worker's own VAPID public key at runtime to build a
// Web Push subscription (applicationServerKey). Each self-hosted worker owns its
// keypair, so the key can't be baked into the frontend — it pulls it from here.

// A real P-256 keypair, so the push-signing path (buildVapidJwt) runs for real.
// Needed to prove the endpoint hands back the very key that signs pushes.
async function genVapid() {
  const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey));
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', kp.privateKey);
  const b64url = (u8) => Buffer.from(u8).toString('base64url');
  return { publicKey: b64url(pub), privateKey: Buffer.from(jwk.d, 'base64url').toString('base64url') };
}

// A real subscriber keypair, so the aes128gcm encryption path runs (a fake
// p256dh would throw before push signing ever puts the key on the wire).
async function genSubscription() {
  const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const b64url = (u8) => Buffer.from(u8).toString('base64url');
  return { endpoint: 'https://push.example.com/sub/abc', keys: { p256dh: b64url(raw), auth: b64url(auth) } };
}

test('GET /vapid-public-key returns the configured public key', async () => {
  const d1 = createTestD1();
  const worker = makeWorker(d1); // vapid.publicKey === 'pub', no serverToken
  const res = await worker.fetch(new Request('https://w.dev/vapid-public-key', { method: 'GET' }), { DB: d1 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.publicKey, 'pub');
});

// Anti-divergence guard: the endpoint reads cfg.vapid.publicKey while push
// signing reads cfg.webpush — two separate config fields that COULD drift. If
// they ever point at different keys, the frontend subscribes with a key this
// worker can't sign for and every push 403s. Pin them to the same value.
test('the exposed VAPID public key is the same key push signing actually uses', async () => {
  const { publicKey, privateKey } = await genVapid();
  const email = 'mailto:x@example.com';
  const sub = await genSubscription();

  const d1 = createTestD1();
  const adapter = createD1Adapter(d1);
  await adapter.initSchema();
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const enc = await encryptForStorage(JSON.stringify({
    contactName: 'Rei', messageType: 'fixed', userMessage: 'hi', recurrenceType: 'none'
  }), userKey);
  await seedPushSubscription(adapter, USER, MASTER_KEY, sub);
  await adapter.createTask({ user_id: USER, uuid: 'due', encrypted_payload: enc, next_send_at: new Date(Date.now() - 30_000).toISOString(), message_type: 'fixed' });

  const worker = createSingleUserCloudflareWorker(() => ({
    db: adapter,
    masterKey: MASTER_KEY,
    vapid: { email, publicKey, privateKey },
    webpush: createWebCryptoWebPush({ email, publicKey, privateKey })
  }));
  const env = { DB: d1 };

  // 1) what the endpoint hands the frontend
  const res = await worker.fetch(new Request('https://w.dev/vapid-public-key', { method: 'GET' }), env);
  const endpointKey = (await res.json()).publicKey;

  // 2) what push signing puts on the wire: `Authorization: vapid t=<jwt>, k=<publicKey>`
  let wireKey = null;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const authz = (init.headers && (init.headers['Authorization'] || init.headers['authorization'])) || '';
    const m = /k=([^,\s]+)/.exec(authz);
    if (m) wireKey = m[1];
    return new Response(null, { status: 201 });
  };
  try {
    await worker.scheduled({}, env);
  } finally {
    globalThis.fetch = original;
  }

  assert.equal(endpointKey, publicKey);
  assert.ok(wireKey, 'push signing put a k= on the wire');
  assert.equal(endpointKey, wireKey);
});

test('GET /vapid-public-key → 503 VAPID_NOT_CONFIGURED when no public key is set', async () => {
  const d1 = createTestD1();
  const worker = createSingleUserCloudflareWorker((env) => ({
    db: createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', privateKey: 'priv' }, // publicKey absent
    webpush: { async sendNotification() {} }
  }));
  const res = await worker.fetch(new Request('https://w.dev/vapid-public-key', { method: 'GET' }), { DB: d1 });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'VAPID_NOT_CONFIGURED');
});

test('GET /vapid-public-key honours serverToken: right token → 200, wrong/missing → 401', async () => {
  const d1 = createTestD1();
  const worker = createSingleUserCloudflareWorker(() => ({
    db: createD1Adapter(d1),
    masterKey: MASTER_KEY,
    serverToken: 's3cret',
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} }
  }));
  const env = { DB: d1 };

  const ok = await worker.fetch(
    new Request('https://w.dev/vapid-public-key', { method: 'GET', headers: { 'X-Client-Token': 's3cret' } }),
    env
  );
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).publicKey, 'pub');

  const wrong = await worker.fetch(
    new Request('https://w.dev/vapid-public-key', { method: 'GET', headers: { 'X-Client-Token': 'nope' } }),
    env
  );
  assert.equal(wrong.status, 401);

  const missing = await worker.fetch(new Request('https://w.dev/vapid-public-key', { method: 'GET' }), env);
  assert.equal(missing.status, 401);
});

test('CORS: OPTIONS /vapid-public-key preflight answered, GET echoes the allowed origin', async () => {
  const d1 = createTestD1();
  const worker = createSingleUserCloudflareWorker((env) => ({
    db: createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} },
    cors: { origin: 'https://app.example.com' }
  }));
  const env = { DB: d1 };

  const preflight = await worker.fetch(
    new Request('https://w.dev/vapid-public-key', { method: 'OPTIONS', headers: { Origin: 'https://app.example.com' } }),
    env
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'https://app.example.com');
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /X-Client-Token/);

  const got = await worker.fetch(
    new Request('https://w.dev/vapid-public-key', { method: 'GET', headers: { Origin: 'https://app.example.com' } }),
    env
  );
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('Access-Control-Allow-Origin'), 'https://app.example.com');
});

// 过期任务被判定不再补发后，GET /messages 要能看到原因（lastError），
// 前端才知道那条是「错过了」而不是无声消失。
test('scheduled() 过期跳过后，GET /messages 透出 lastError', async () => {
  const d1 = createTestD1();
  const adapter = createD1Adapter(d1);
  await adapter.initSchema();
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const missedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 两小时前
  const enc = await encryptForStorage(JSON.stringify({
    contactName: 'Rei', messageType: 'fixed', userMessage: 'hi', recurrenceType: 'none'
  }), userKey);
  await seedPushSubscription(adapter, USER, MASTER_KEY);
  await adapter.createTask({ user_id: USER, uuid: 'missed', encrypted_payload: enc, next_send_at: missedAt, message_type: 'fixed' });

  let sent = 0;
  const worker = createSingleUserCloudflareWorker(() => ({
    db: adapter,
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() { sent++; } }
  }));
  const env = { DB: d1 };
  await worker.scheduled({}, env);

  assert.equal(sent, 0, '过期任务不该补发');

  const res = await worker.fetch(new Request('https://w.dev/messages?status=all', {
    method: 'GET', headers: { 'X-User-Id': USER }
  }), env);
  assert.equal(res.status, 200);
  const { decryptPayload } = await import('../src/server/lib/encryption.js');
  const data = await decryptPayload((await res.json()).data, userKey);
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0].status, 'failed');
  assert.equal(data.tasks[0].lastError.reason, 'stale');
  assert.equal(data.tasks[0].lastError.occurrence, missedAt);
});
