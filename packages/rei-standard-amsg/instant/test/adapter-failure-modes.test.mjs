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
  });

  // 这条路的 CORS 头是回显来访 Origin 猜出来的，任意第三方页面 fetch 一下就能
  // 读到响应体；而构建期异常的原文就是部署信息本身（binding 名、内网域名、环境
  // 变量名）。排障线索留在服务端日志和同源请求里，见下一条。
  it('跨域读到的 cause 不带异常原文，只有 stage / 异常类名这类标注', async () => {
    const worker = createCloudflareWorker(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'get') at env.INTERNAL_KV");
    });

    const res = await worker.fetch(request('POST'), {});
    const { cause } = (await res.json()).error;

    assert.equal(cause.stage, 'config');
    assert.equal(cause.name, 'TypeError');
    assert.equal('message' in cause, false, `异常原文不该跨域回出去：${JSON.stringify(cause)}`);
    assert.ok(
      !JSON.stringify(cause).includes('INTERNAL_KV'),
      `信封任何一处都不该有构建期异常的原文：${JSON.stringify(cause)}`,
    );
  });

  it('Origin 就是 Worker 自己域名时（同源页面）照旧给全文', async () => {
    const worker = createCloudflareWorker(missingBinding);

    // 同源页面读到的本来就是自己部署的东西，没有额外暴露面。
    const res = await worker.fetch(request('POST', { origin: 'https://worker.example.com' }), {});

    assert.equal(res.status, 500);
    assert.match((await res.json()).error.cause.message, /Cannot read properties of undefined/);
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
    const { cause } = (await res.json()).error;
    assert.equal(cause.stage, 'config');
    // 部署方 `curl` 一下就该看到真因，不用回去翻 `wrangler tail`。
    assert.match(cause.message, /Cannot read properties of undefined/);
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

  it('给出全文的那条路上，长得像凭据的串照样遮掉', async () => {
    // 无 Origin / 同源才带 message，凭据脱敏是这条路上的第二道闸：机器之间的调
    // 用日志、终端回滚记录也不该留下能直接拿去用的 Key。
    const worker = createCloudflareWorker(() => {
      throw new Error('upstream rejected Bearer sk-live-0123456789abcdefghijklmnop');
    });

    const res = await worker.fetch(request('POST', { origin: '' }), {});

    const { message } = (await res.json()).error.cause;
    assert.ok(!message.includes('0123456789abcdefghijklmnop'), `凭据没遮住: ${message}`);
    assert.match(message, /redacted/);
  });

  /** 「读 method 就炸」的请求对象——把 handler 错误边界之外那一段逼出来。 */
  function hostileRequest() {
    return {
      url: 'https://worker.example.com/instant',
      get method() {
        throw new TypeError('runtime lost the request method');
      },
      headers: {
        get: (name) => (String(name).toLowerCase() === 'origin' ? ORIGIN : ''),
      },
    };
  }

  it('handler 抛出的异常也收成 500（它自己的错误边界之外还有几步）', async () => {
    // handler 内部对请求处理有 try/catch，但边界之外还有几步（读 method、鉴权）。
    const worker = createCloudflareWorker(() => ({ vapid, fetch: makeRouter().fetch }));

    const res = await worker.fetch(hostileRequest(), {});

    assert.equal(res.status, 500);
    // 没配 cors 的部署本来就是 '*'，这条 500 跟正常响应用同一套头。
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    const body = await res.json();
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.cause.stage, 'request');
    assert.equal(body.error.cause.name, 'TypeError');
  });

  it('请求阶段的 500 走部署自己的 CORS 白名单，不回显来访 Origin', async () => {
    // 回归守卫：handler 已经建起来了 = 白名单是已知的。这条兜底 500 要是照
    // 「降级」那样回显来访 Origin，任意第三方页面都能跨域读到它和它的 cause。
    const worker = createCloudflareWorker(() => ({
      vapid,
      fetch: makeRouter().fetch,
      cors: { allowOrigin: ORIGIN },
    }));
    // 白名单之外的来访者。
    const outsider = hostileRequest();
    outsider.headers = { get: (name) => (String(name).toLowerCase() === 'origin' ? 'https://evil.example' : '') };

    const res = await worker.fetch(outsider, {});

    assert.equal(res.status, 500);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN, '白名单里的那个，不是来访的那个');
  });
});

// ─── 1b. 降级信封的形状 ─────────────────────────────────────────────────
//
// 这套降级行为在 amsg-server 的
// server/src/server/cloudflare/single-user-worker.js 里有对称的一份：两个包刻意
// 各留一份、不互相 import（instant 会把 blob-store 和一整排 adapter 拖进去，破
// 坏 server「D1-only、不开 nodejs_compat 也能打包」的目标）。没有测试钉着的话，
// 两边会慢慢漂成两种信封，接入方照其中一份写的判断换个部署就不灵。
//
// 下面把 instant 这份逐字段钉死；改这里记得对着那个文件一起改。已知且故意的差
// 别只有一处：跨域读到的 cause 在 instant 这边不带 message。

describe('降级 500 的信封形状（与 amsg-server 那份保持一致）', () => {
  function req(method, origin = ORIGIN) {
    return new Request('https://worker.example.com/instant', {
      method,
      headers: { 'content-type': 'application/json', origin },
      body: method === 'POST' ? '{}' : undefined,
    });
  }

  it('跨域 POST：信封字段与 CORS 头逐个对上', async () => {
    const worker = createCloudflareWorker(() => { throw new TypeError('binding 没了'); });

    const res = await worker.fetch(req('POST'), {});

    assert.equal(res.status, 500);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(res.headers.get('access-control-max-age'), '0');
    assert.equal(res.headers.get('vary'), 'Origin');
    assert.match(res.headers.get('access-control-allow-methods') || '', /POST/);
    assert.match(res.headers.get('access-control-allow-headers') || '', /Content-Type/);

    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['error', 'success']);
    assert.equal(body.success, false);
    assert.deepEqual(Object.keys(body.error).sort(), ['cause', 'code', 'message']);
    // 这两句是老调用方的判据，一直是固定的那两个字符串。
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.equal(body.error.message, '服务器内部错误');
    assert.deepEqual(Object.keys(body.error.cause).sort(), ['name', 'stage']);
    assert.equal(body.error.cause.stage, 'config');
  });

  it('异常自带 code 时跟着一起出去（仍然不带原文）', async () => {
    const worker = createCloudflareWorker(() => {
      const error = new Error('缺了个模块');
      error.code = 'ERR_MODULE_NOT_FOUND';
      throw error;
    });

    const res = await worker.fetch(req('POST'), {});
    const { cause } = (await res.json()).error;

    assert.deepEqual(Object.keys(cause).sort(), ['code', 'name', 'stage']);
    assert.equal(cause.code, 'ERR_MODULE_NOT_FOUND');
  });

  it('预检回 204、空体，CORS 头与那条 500 是同一套', async () => {
    const worker = createCloudflareWorker(() => { throw new TypeError('binding 没了'); });

    const res = await worker.fetch(req('OPTIONS'), {});

    assert.equal(res.status, 204);
    assert.equal(await res.text(), '');
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(res.headers.get('access-control-max-age'), '0');
    assert.equal(res.headers.get('vary'), 'Origin');
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

  // pipeline 无论因为什么失败都会先把 res 销毁，所以「res 被销毁了」根本分不出
  // 是客户端走了还是服务端自己炸了。拿它当判据的话，SSE 流中途炸掉会被一并当成
  // 「客户端走了」——连接就那么断了，一行痕迹都没有，运维只能从客户端那句
  // `TypeError: network error` 反推。
  it('服务端自己的流错误留下能归因的日志，不当成客户端断开吞掉', { timeout: 15000 }, async () => {
    const brokenSse = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(ENCODER.encode(': keepalive\n\n'));
          setTimeout(() => controller.error(new Error('SSE producer exploded')), 20);
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );
    const server = await startServer(toNodeHandler(brokenSse));

    const originalError = console.error;
    const lines = [];
    console.error = (...args) => { lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')); };
    try {
      const res = await fetch(server.url, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(3000),
      });
      const reader = res.body.getReader();
      await reader.read();
      // 流被服务端掐断：客户端这一侧读到的是一个失败的连接，不是正常收尾。
      await assert.rejects(async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) return;
        }
      }, '半截流不该看起来像正常读完了');

      assert.equal(
        await waitFor(() => lines.some((line) => line.includes('SSE producer exploded'))),
        true,
        `服务端的流错误必须留下痕迹：${JSON.stringify(lines)}`,
      );
    } finally {
      console.error = originalError;
      await server.close();
    }
  });

  // 「断连」这档只属于「字节已经发出去一部分」的场景。首字节前就失败的流，
  // 客户端一个字节都没收到，断连没有任何信息量——pipeline 失败会先把 res 销毁，
  // 拿「res 被销毁了」当「连接已收尾」的判据的话，这一档就只剩一句
  // UND_ERR_SOCKET，读不到状态码也读不到错误码。
  it('流在首次 pull 就失败（懒加载资源没起来）→ 干净的 500 信封，不是断连', { timeout: 15000 }, async () => {
    const failsOnFirstPull = async () => new Response(
      new ReadableStream({
        pull() {
          throw new Error('lazy resource failed to load');
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );
    const server = await startServer(toNodeHandler(failsOnFirstPull));

    const originalError = console.error;
    const lines = [];
    console.error = (...args) => { lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')); };
    try {
      const res = await fetch(server.url, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(3000),
      });

      assert.equal(res.status, 500);
      assert.match(res.headers.get('content-type') || '', /application\/json/);
      const body = await res.json();
      assert.equal(body.success, false);
      assert.equal(body.error.code, 'ADAPTER_ERROR');
      assert.equal(body.error.message, 'lazy resource failed to load');
      // 这是服务端自己的故障，归因日志照旧要有。
      assert.equal(
        lines.some((line) => line.includes('lazy resource failed to load')),
        true,
        `首字节前的流错误必须留下痕迹：${JSON.stringify(lines)}`,
      );
    } finally {
      console.error = originalError;
      await server.close();
    }
  });

  it('流在 start 里就 error（一个字节都没吐）→ 同样是 500 信封', { timeout: 15000 }, async () => {
    const failsInStart = async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('stream dead on arrival'));
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
    );
    const server = await startServer(toNodeHandler(failsInStart));

    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await fetch(server.url, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(3000),
      });

      assert.equal(res.status, 500);
      const body = await res.json();
      assert.equal(body.error.code, 'ADAPTER_ERROR');
      assert.equal(body.error.message, 'stream dead on arrival');
    } finally {
      console.error = originalError;
      await server.close();
    }
  });

  it('客户端提前断开不写错误日志（那是正常收场，不是故障）', { timeout: 15000 }, async () => {
    const gate = deferred();
    const state = { upstreamFinished: false, canceled: false };
    const server = await startServer(toNodeHandler(makeGatedSseHandler(gate, state)));

    const originalError = console.error;
    const lines = [];
    console.error = (...args) => { lines.push(args.map(String).join(' ')); };
    try {
      const controller = new AbortController();
      const res = await fetch(server.url, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
      });
      const reader = res.body.getReader();
      await reader.read();
      controller.abort();

      assert.equal(await waitFor(() => state.canceled), true);
      // 用户随手关掉页面是家常便饭，不能每次都往日志里写一条「请求处理失败」。
      await new Promise((r) => setTimeout(r, 50));
      assert.deepEqual(lines, [], `客户端走了不该记成故障：${JSON.stringify(lines)}`);
    } finally {
      console.error = originalError;
      gate.resolve();
      await server.close();
    }
  });

  // pipeline 把「客户端走了」和「服务端的流中途死了」收敛成同一个
  // ERR_STREAM_PREMATURE_CLOSE，从错误上分不出是谁先走的。分不出就不硬猜，但
  // 也不能一声不吭：全静默的话，服务端自己的流死掉时这里一个字都没有，运维只
  // 能从客户端那句 `TypeError: network error` 反推。
  it('流没写完就结束时留一行 warn（不记成 error，免得关页面刷屏）', { timeout: 15000 }, async () => {
    const gate = deferred();
    const state = { upstreamFinished: false, canceled: false };
    const server = await startServer(toNodeHandler(makeGatedSseHandler(gate, state)));

    const originalWarn = console.warn;
    const originalError = console.error;
    const warnings = [];
    const errors = [];
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    console.error = (...args) => { errors.push(args.map(String).join(' ')); };
    try {
      const controller = new AbortController();
      const res = await fetch(server.url, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]),
      });
      const reader = res.body.getReader();
      await reader.read();
      controller.abort();

      assert.equal(await waitFor(() => state.canceled), true);
      assert.equal(
        await waitFor(() => warnings.some((line) => line.includes('响应流提前结束'))),
        true,
        `流没写完就结束了，总得留一行：${JSON.stringify(warnings)}`,
      );
      assert.deepEqual(errors, [], `分不出是谁先走的，就不该记成故障：${JSON.stringify(errors)}`);
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
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
