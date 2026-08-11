/**
 * 适配器的「失败要看得见」回归守卫。
 *
 * 两类故障，从外面看都是「服务没了」而不是「服务坏了」：
 *   1. Cloudflare 适配器构建配置时抛错 —— 异常冲出 fetch，跨域前端只有一句
 *      `TypeError: Failed to fetch`，状态码 / 错误码一概读不到，预检也一起挂。
 *   2. Node 适配器把响应整个缓冲住 —— SSE 静默退化成非流式，响应头却还写着
 *      `text/event-stream`。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import { createInstantHandler } from '../src/index.js';
import { createCloudflareWorker } from '../src/adapters/cloudflare.js';
import { toNodeHandler } from '../src/adapters/node.js';
import {
  generateTestVapid,
  generateTestSubscription,
  createFetchRouter,
  makeLlmResponse,
} from './helpers.mjs';

const LLM_URL = 'https://api.example.com/v1/chat/completions';
const ORIGIN = 'https://app.example.com';
const ENCODER = new TextEncoder();

let vapid;
let subKit;

before(async () => {
  vapid = await generateTestVapid();
  subKit = await generateTestSubscription();
});

function makePayload() {
  return {
    contactName: 'Rei',
    completePrompt: 'say hi briefly',
    apiUrl: LLM_URL,
    apiKey: 'sk-test',
    primaryModel: 'model-x',
    pushSubscription: subKit.subscription,
  };
}

function makeRouter(content = 'hi.') {
  return createFetchRouter({
    pushEndpoint: subKit.subscription.endpoint,
    llm: async () => makeLlmResponse(content),
  });
}

// 用例超时（缓冲住的旧实现会让客户端一直等）时 finally 不会跑，收尾就得靠这
// 里：没关掉的服务器 / 没放行的闸门会把测试进程一直挂住。
const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  cleanups.push(() => resolve());
  return { promise, resolve };
}

// ─── 1. Cloudflare 适配器：构建失败也要能被读到 ──────────────────────────

describe('createCloudflareWorker 构建失败的降级路径', () => {
  // 最典型的触发：wrangler.toml 里 binding 名字写错，optionsBuilder 里
  // `env.BLOB_KV` 是 undefined，读它的属性就炸。
  const missingBinding = (env) => {
    if (!env.BLOB_KV) throw new TypeError("Cannot read properties of undefined (reading 'get')");
    return { vapid, fetch: makeRouter().fetch };
  };

  function request(method, { origin = ORIGIN } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (origin) headers.origin = origin;
    return new Request('https://worker.example.com/instant', {
      method,
      headers,
      body: method === 'POST' ? '{}' : undefined,
    });
  }

  it('POST 回一个带 CORS 头、带机读 cause 的 500，而不是让异常冲出 fetch', async () => {
    const worker = createCloudflareWorker(missingBinding);

    const res = await worker.fetch(request('POST'), {});

    assert.equal(res.status, 500);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(res.headers.get('access-control-max-age'), '0');
    assert.equal(res.headers.get('vary'), 'Origin');
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.cause.stage, 'config');
    assert.equal(body.error.cause.name, 'TypeError');
    assert.match(body.error.cause.message, /Cannot read properties of undefined/);
  });

  it('OPTIONS 预检回 204 —— 预检挂掉的话那条真正的 POST 根本发不出去', async () => {
    const worker = createCloudflareWorker(missingBinding);

    const res = await worker.fetch(request('OPTIONS'), {});

    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match(res.headers.get('access-control-allow-headers') || '', /X-Client-Token/);
  });

  it('同源调用方（没有 Origin 头）同样收到可读的 500，只是不带 CORS 头', async () => {
    const worker = createCloudflareWorker(missingBinding);

    const res = await worker.fetch(request('POST', { origin: '' }), {});

    assert.equal(res.status, 500);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal((await res.json()).error.cause.stage, 'config');
  });

  it('构建失败不被记住：binding 补上之后下一个请求就正常了', async () => {
    const worker = createCloudflareWorker(missingBinding);

    assert.equal((await worker.fetch(request('POST'), {})).status, 500);

    const res = await worker.fetch(
      new Request('https://worker.example.com/instant', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', origin: ORIGIN },
        body: JSON.stringify(makePayload()),
      }),
      { BLOB_KV: {} }
    );

    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);
  });

  it('cause.message 里长得像凭据的串会被遮掉（这条响应跨域前端能直接读到）', async () => {
    const worker = createCloudflareWorker(() => {
      throw new Error('upstream rejected Bearer sk-live-0123456789abcdefghijklmnop');
    });

    const res = await worker.fetch(request('POST'), {});

    const { message } = (await res.json()).error.cause;
    assert.ok(!message.includes('0123456789abcdefghijklmnop'), `凭据没遮住: ${message}`);
    assert.match(message, /redacted/);
  });

  it('handler 抛出的异常也收成 500（它自己的错误边界之外还有几步）', async () => {
    // handler 内部对请求处理有 try/catch，但边界之外还有几步（读 method、
    // 鉴权）。这里用一个「读 method 就炸」的请求对象把那一段逼出来。
    const worker = createCloudflareWorker(() => ({ vapid, fetch: makeRouter().fetch }));
    const hostile = {
      url: 'https://worker.example.com/instant',
      get method() {
        throw new TypeError('runtime lost the request method');
      },
      headers: {
        get: (name) => (String(name).toLowerCase() === 'origin' ? ORIGIN : ''),
      },
    };

    const res = await worker.fetch(hostile, {});

    assert.equal(res.status, 500);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    const body = await res.json();
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.cause.stage, 'request');
    assert.equal(body.error.cause.name, 'TypeError');
  });
});

// ─── 2. Node 适配器：SSE 必须真流式 ─────────────────────────────────────

/** 起一个真的 node:http 服务器 —— 缓冲与否只有走真 socket 才看得出来。 */
async function startServer(nodeHandler) {
  const server = http.createServer(nodeHandler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const close = async () => {
    if (!server.listening) return;
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  };
  cleanups.push(close);
  return { url: `http://127.0.0.1:${port}/instant`, close };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

describe('toNodeHandler 流式转发', () => {
  /**
   * 一个「先吐一段、卡住、放行后再吐一段」的 SSE 响应：上游还没结束时客户端
   * 手里就该有第一个 chunk。整体缓冲的实现在这里连响应头都还没发出去。
   */
  function makeGatedSseHandler(gate, state) {
    return async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(ENCODER.encode(': keepalive\n\n'));
          gate.promise.then(() => {
            // 客户端已经断开时这个流早被 cancel 了，enqueue/close 都会抛。
            try {
              controller.enqueue(ENCODER.encode('event: done\ndata: {}\n\n'));
              state.upstreamFinished = true;
              controller.close();
            } catch { /* 流已经关了 */ }
          });
        },
        cancel() {
          state.canceled = true;
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } }
    );
  }

  it('第一个 chunk 在上游还没结束时就到达客户端', { timeout: 15000 }, async () => {
    const gate = deferred();
    const state = { upstreamFinished: false, canceled: false };
    const server = await startServer(toNodeHandler(makeGatedSseHandler(gate, state)));

    try {
      const res = await fetch(server.url, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(3000),
      });
      assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

      const reader = res.body.getReader();
      const first = await reader.read();

      assert.equal(first.done, false);
      assert.equal(new TextDecoder().decode(first.value), ': keepalive\n\n');
      assert.equal(state.upstreamFinished, false, '上游还没跑完，第一个 chunk 就该在客户端手里了');

      // 放行之后剩下的字节照常到达，流正常收尾。
      gate.resolve();
      let rest = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rest += new TextDecoder().decode(value);
      }
      assert.match(rest, /event: done/);
    } finally {
      gate.resolve();
      await server.close();
    }
  });

  it('客户端提前断开会 cancel 上游那个流（instant 据此切到 Web Push 兜底）', { timeout: 15000 }, async () => {
    const gate = deferred();
    const state = { upstreamFinished: false, canceled: false };
    const server = await startServer(toNodeHandler(makeGatedSseHandler(gate, state)));

    try {
      const controller = new AbortController();
      const res = await fetch(server.url, {
        method: 'POST',
        body: '{}',
        // 缓冲住的实现里响应头永远等不到，超时把它变成失败而不是挂死。
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
      });
      const reader = res.body.getReader();
      await reader.read();

      controller.abort();

      assert.equal(await waitFor(() => state.canceled), true, '客户端走了，上游流必须被 cancel');
      assert.equal(state.upstreamFinished, false);
    } finally {
      gate.resolve();
      await server.close();
    }
  });

  it('JSON 模式（Accept: application/json）不受影响', async () => {
    const router = makeRouter();
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const server = await startServer(toNodeHandler(handler));

    try {
      const res = await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(makePayload()),
      });

      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.data.messagesSent, 1);
      assert.equal(router.pushCalls.length, 1);
    } finally {
      await server.close();
    }
  });

  it('真 handler 的 SSE 跑通整条 Node 链路', async () => {
    const router = makeRouter();
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    const server = await startServer(toNodeHandler(handler));

    try {
      const res = await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makePayload()),
      });

      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
      const text = await res.text();
      assert.match(text, /event: payload/);
      assert.match(text, /event: done/);
    } finally {
      await server.close();
    }
  });
});
