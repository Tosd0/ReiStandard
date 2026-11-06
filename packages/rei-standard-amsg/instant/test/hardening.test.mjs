/**
 * 入口防线的回归守卫：请求体上限、订阅校验、推送失败文案、SSE 下的 hook
 * 契约违反、配置上限、备份推送并发、失败定位字段。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';

import { createInstantHandler, validateInstantPayload, validateContinuePayload, MAX_REQUEST_BODY_BYTES } from '../src/index.js';
import { toNodeHandler } from '../src/adapters/node.js';
import { createMemoryBlobStore } from '../src/blob-store/memory.js';
import {
  generateTestVapid,
  generateTestSubscription,
  createFetchRouter,
  buildHandlerRequest,
  makeLlmResponse,
  consumeSse,
  waitForPushCalls,
} from './helpers.mjs';

const LLM_URL = 'https://api.example.com/v1/chat/completions';

let vapid;
let subKit;

before(async () => {
  vapid = await generateTestVapid();
  subKit = await generateTestSubscription();
});

function makeValidPayload(overrides = {}) {
  return {
    contactName: 'Rei',
    completePrompt: 'say hi briefly',
    apiUrl: LLM_URL,
    apiKey: 'sk-test',
    primaryModel: 'model-x',
    pushSubscription: subKit.subscription,
    ...overrides,
  };
}

function makeRouter(content = 'hi.', extra = {}) {
  return createFetchRouter({
    pushEndpoint: subKit.subscription.endpoint,
    llm: async () => makeLlmResponse(content),
    ...extra,
  });
}

// ─── 请求体上限 ─────────────────────────────────────────────────────────

describe('请求体上限', () => {
  it('gzip 解压后超过上限回 413，不把整份展开的数据读进内存', async () => {
    // 比上限多 1MB 的重复字符，压完只有几十 KB——压缩炸弹就是这么来的。
    const bomb = gzipSync(Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1024 * 1024, 0x41));
    const router = makeRouter();
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(new Request('http://localhost/instant', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-amsg-request-encoding': 'gzip' },
      body: bomb,
    }));
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.equal(body.error.code, 'REQUEST_BODY_TOO_LARGE');
    assert.equal(body.error.details.maxBytes, MAX_REQUEST_BODY_BYTES);
    assert.equal(router.pushCalls.length, 0);
  });

  it('gzip 的压缩字节本身超过上限也回 413', async () => {
    // 随机字节压不动，压缩后的体积 ≈ 原始体积。
    const incompressible = Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1024);
    for (let i = 0; i < incompressible.length; i += 4096) incompressible[i] = i & 0xff;
    const handler = createInstantHandler({ vapid });
    const res = await handler(new Request('http://localhost/instant', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-amsg-request-encoding': 'gzip' },
      body: incompressible,
    }));
    assert.equal(res.status, 413);
  });

  it('Node 适配器的原始 body 超过上限回 413', { timeout: 30000 }, async () => {
    const server = http.createServer(toNodeHandler(createInstantHandler({ vapid })));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/instant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1024, 0x41),
      });
      assert.equal(res.status, 413);
      assert.equal(res.headers.get('connection'), 'close', '没读完的 body 堵在连接上，这条连接不能复用');
      const body = await res.json();
      assert.equal(body.error.code, 'REQUEST_BODY_TOO_LARGE');
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });
});

// ─── pushSubscription 校验 ──────────────────────────────────────────────

describe('pushSubscription 校验', () => {
  const badEndpoints = [
    'http://push.example/sub',
    'https://localhost/sub',
    'https://foo.localhost/sub',
    'https://127.0.0.1/sub',
    'https://[::1]/sub',
    'https://user:pass@push.example/sub',
    'not a url',
  ];

  for (const endpoint of badEndpoints) {
    it(`/instant 与 /continue 都拒掉 endpoint ${endpoint}`, () => {
      const subscription = { ...subKit.subscription, endpoint };
      for (const validate of [validateInstantPayload, validateContinuePayload]) {
        const r = validate({
          ...makeValidPayload({ pushSubscription: subscription }),
          sessionId: 'sess-x',
          completePrompt: undefined,
          messages: [{ role: 'user', content: 'hi' }],
        });
        assert.equal(r.valid, false, `${validate.name} 应拒掉 ${endpoint}`);
        assert.equal(r.errorCode, 'INVALID_PAYLOAD_FORMAT');
        assert.deepEqual(r.details.invalidFields, ['pushSubscription.endpoint']);
      }
    });
  }

  it('公网 https 端点照常通过', () => {
    const r = validateInstantPayload(makeValidPayload({
      pushSubscription: { ...subKit.subscription, endpoint: 'https://push.example/sub/abc' },
    }));
    assert.equal(r.valid, true);
  });

  it('keys 缺失或不是字符串时 400，且不会去调 LLM', async () => {
    let llmCalls = 0;
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: async () => { llmCalls++; return makeLlmResponse('hi.'); },
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const cases = [
      { endpoint: subKit.subscription.endpoint },
      { endpoint: subKit.subscription.endpoint, keys: { p256dh: subKit.subscription.keys.p256dh } },
      { endpoint: subKit.subscription.endpoint, keys: { p256dh: 1, auth: 'x' } },
      { endpoint: subKit.subscription.endpoint, keys: { p256dh: 'x', auth: '' } },
    ];
    for (const pushSubscription of cases) {
      const res = await handler(buildHandlerRequest({ body: makeValidPayload({ pushSubscription }) }));
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error.code, 'INVALID_PAYLOAD_FORMAT');
      assert.match(body.error.details.invalidFields[0], /^pushSubscription\.keys\./);
    }
    assert.equal(llmCalls, 0);
  });
});

// ─── 推送失败文案 ───────────────────────────────────────────────────────

describe('推送失败的错误文案', () => {
  it('推送服务回的原文经过脱敏与截断才回给客户端', async () => {
    const secret = 'Bearer sk-live-abcdefghijklmnopqrstuvwxyz0123456789';
    const router = makeRouter('你好。', {
      pushHandler: () => new Response(`${secret} ${'x'.repeat(5000)}`, { status: 410, statusText: 'Gone' }),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(buildHandlerRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PUSH_SEND_FAILED');
    assert.equal(body.error.pushStatus, 410);
    assert.ok(!body.error.message.includes('sk-live'), body.error.message);
    assert.ok(body.error.message.length <= 300, `message 长度 ${body.error.message.length}`);
  });
});

// ─── SSE 下 hook 返回不可序列化 payload ─────────────────────────────────

describe('SSE 下不可序列化的 pushPayload', () => {
  it('客户端收到 code 为 HOOK_THREW 的 event: error，而不是悄悄断流', async () => {
    const router = makeRouter('whatever');
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: () => ({ decision: 'finish', pushPayloads: [{ type: 'finish', big: 1n }] }),
    });
    const res = await handler(buildHandlerRequest({
      mode: 'sse',
      body: makeValidPayload({ completePrompt: undefined, messages: [{ role: 'user', content: 'hi' }] }),
    }));
    assert.equal(res.status, 200);
    const { payloads, errors } = await consumeSse(res);
    assert.equal(payloads.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].code, 'HOOK_THREW');
  });
});

// ─── blobStore.maxInlineBytes 上限 ──────────────────────────────────────

describe('blobStore.maxInlineBytes 上限', () => {
  it('超过单条 push 明文上限时 createInstantHandler 当场抛', () => {
    const adapter = createMemoryBlobStore();
    assert.throws(
      () => createInstantHandler({ vapid, blobStore: { adapter, maxInlineBytes: 3994 } }),
      /maxInlineBytes = 3994/
    );
    assert.doesNotThrow(() => createInstantHandler({ vapid, blobStore: { adapter, maxInlineBytes: 3993 } }));
  });
});

// ─── SSE 备份推送并发 ───────────────────────────────────────────────────

describe('SSE 备份推送并发', () => {
  it('20 段同时推时 in-flight 不超过上限，且一条不少', async () => {
    let inFlight = 0;
    let peak = 0;
    const router = makeRouter('a。'.repeat(20), {
      pushHandler: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return null;
      },
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const res = await handler(buildHandlerRequest({ mode: 'sse', body: makeValidPayload() }));
    const { payloads, doneReceived } = await consumeSse(res);
    assert.equal(payloads.length, 20);
    assert.equal(doneReceived, true);
    await waitForPushCalls(router, 20);
    assert.ok(peak > 1, '备份推送应该是并发的');
    assert.ok(peak <= 4, `同一时刻 in-flight ${peak} 条`);
  });
});

// ─── 部分投递失败时定位到第几段 ─────────────────────────────────────────

describe('部分投递失败', () => {
  it('信封与 error 事件带 failedMessageIndex', async () => {
    const router = makeRouter('一。二。三。', {
      pushHandler: ({ callIndex }) => (callIndex === 2
        ? new Response('upstream busy', { status: 500, statusText: 'Internal Server Error' })
        : null),
    });
    const events = [];
    const handler = createInstantHandler({ vapid, fetch: router.fetch, onEvent: (e) => events.push(e), });
    const res = await handler(buildHandlerRequest({ body: makeValidPayload() }));
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.code, 'PUSH_SEND_FAILED');
    assert.equal(body.error.pushStatus, 500);
    assert.equal(body.error.failedMessageIndex, 2);
    assert.equal(events.find((e) => e.type === 'error').failedMessageIndex, 2);
  });
});
