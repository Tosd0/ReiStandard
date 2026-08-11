/**
 * Node / Express / Fastify adapter for @rei-standard/amsg-instant.
 *
 * Converts a Fetch-API-style handler (`(req: Request) => Response`)
 * into a Node-style handler (`(req, res) => void`).
 *
 * Usage (Express):
 *   import express from 'express';
 *   import { createInstantHandler } from '@rei-standard/amsg-instant';
 *   import { toNodeHandler } from '@rei-standard/amsg-instant/adapters/node';
 *
 *   const app = express();
 *   const fetchHandler = createInstantHandler({ ... });
 *   app.post('/instant', toNodeHandler(fetchHandler));
 *
 * Notes:
 *   - The Node handler reads the raw body itself; do NOT install
 *     `express.json()` on this route. Conversely, ensure no body parser
 *     has already consumed the stream before this middleware runs.
 *   - Headers are forwarded case-insensitively via the Fetch API.
 *   - Plain Node / Express does not define a standard `waitUntil`
 *     lifecycle. If your host exposes one, pass it through the optional
 *     adapter options so `createInstantHandler` can protect the main
 *     LLM → split → push pipeline.
 *   - 响应是边产边写的（instant 的默认传输是 SSE）。中间件如果自己缓冲响应，
 *     流式就会被它压回非流式：`compression` 默认会把 `text/event-stream` 一起
 *     压，压缩缓冲区攒够才吐字节。这条路由上把它关掉即可
 *     （`compression({ filter: (req) => req.path !== '/instant' })`）。
 */

/**
 * Lazy Web Crypto polyfill for Node 18.
 *
 * Node 19+ exposes `globalThis.crypto` natively, but Node 18 (the current
 * LTS at time of writing, and the default Netlify Functions runtime) does
 * not. The dynamic import path keeps Node out of the bundle on every other
 * platform — Workers / Edge / Deno never executes this branch, and tsup
 * leaves the specifier untouched because `node:crypto` is externalized.
 */
let _polyfillApplied = false;
async function ensureWebCryptoPolyfill() {
  if (_polyfillApplied || globalThis.crypto) return;
  const { webcrypto } = await import('node:crypto');
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', {
      value: webcrypto,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  }
  _polyfillApplied = true;
}

/**
 * Lazy `node:stream` helpers, same reasoning as the crypto polyfill above:
 * `adapters/vercel.js` re-exports `toNodeHandler` for the Node runtime, so a
 * static `import 'node:stream'` here would end up inside the Edge bundle too
 * (ESM imports evaluate eagerly) and break a runtime that has no such module.
 */
let _streamHelpers = null;
async function loadStreamHelpers() {
  if (!_streamHelpers) {
    const [{ Readable }, { pipeline }] = await Promise.all([
      import('node:stream'),
      import('node:stream/promises'),
    ]);
    _streamHelpers = { Readable, pipeline };
  }
  return _streamHelpers;
}

/**
 * @typedef {Object} NodeAdapterOptions
 * @property {(work: Promise<unknown>) => void} [waitUntil]
 * @property {{ waitUntil?: (work: Promise<unknown>) => void }} [runtime]
 * @property {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => { waitUntil?: (work: Promise<unknown>) => void } | undefined | null} [getRuntime]
 */

/**
 * @param {(request: Request, runtime?: { waitUntil?: (work: Promise<unknown>) => void }) => Promise<Response>} fetchHandler
 * @param {NodeAdapterOptions} [options]
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void>}
 */
export function toNodeHandler(fetchHandler, options = {}) {
  return async function nodeHandler(req, res) {
    try {
      await ensureWebCryptoPolyfill();
      const fetchRequest = await nodeRequestToFetchRequest(req);
      const fetchResponse = await fetchHandler(fetchRequest, resolveNodeRuntime(options, req, res));
      await writeFetchResponseToNode(fetchResponse, res);
    } catch (err) {
      // 能走到这里的都是服务端自己的故障——客户端提前断开在
      // writeFetchResponseToNode 里就当成正常收场了。先留一行能归因的日志再说：
      // SSE 中途炸掉时响应头早就发出去了，状态码这条路已经用不上，不记日志的话
      // 这次失败就彻底没痕迹，运维只能从客户端那句 `TypeError: network error`
      // 反推。
      console.error('[amsg-instant] toNodeHandler: 请求处理失败:', err);
      // 连接已经收尾（响应写完了 / 流已经被销毁）就没有能报错的地方了。
      if (res.writableEnded || res.destroyed) return;
      if (res.headersSent) {
        // 字节已经在路上（多半是 SSE 流中途炸的）：200 + 半截流已经发出去，
        // 再追加一个 JSON 信封只是往流里塞垃圾。直接断掉，让调用方看到一个
        // 明确失败的连接——而不是一条看起来正常收尾、其实少了后半截的流。
        res.destroy(err);
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          success: false,
          error: { code: 'ADAPTER_ERROR', message: err?.message || 'Node adapter error' }
        })
      );
    }
  };
}

function resolveNodeRuntime(options, req, res) {
  if (options && typeof options.getRuntime === 'function') {
    return options.getRuntime(req, res) || undefined;
  }
  if (options && options.runtime && typeof options.runtime === 'object') {
    return options.runtime;
  }
  if (options && typeof options.waitUntil === 'function') {
    return { waitUntil: options.waitUntil };
  }
  return undefined;
}

async function nodeRequestToFetchRequest(req) {
  const host = req.headers.host || 'localhost';
  const protocol = req.socket && req.socket.encrypted ? 'https' : 'http';
  // req.url is usually a path (origin-form), but some proxy / sub-router setups
  // can hand back an absolute URL. Detect that case and use it verbatim
  // instead of double-prefixing the scheme+host.
  const rawUrl = req.url || '/';
  const url = /^https?:\/\//i.test(rawUrl)
    ? rawUrl
    : `${protocol}://${host}${rawUrl}`;

  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(name, v);
    } else if (value !== undefined) {
      headers.set(name, String(value));
    }
  }

  const method = (req.method || 'GET').toUpperCase();
  const init = { method, headers };

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = await readBody(req);
    init.duplex = 'half';
  }

  return new Request(url, init);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 客户端提前断开是正常收场，不是服务端故障。
 *
 * 断开时 `res` 先 close，pipeline 判定为 premature close 并把两端销毁；socket
 * 已经没了，再往上抛只会让外层去写一个没人读的 500。
 *
 * 只认错误码，不看 `res` 的状态：pipeline 无论因为什么失败都会先把目的端销毁，
 * 所以到这一步 `res.destroyed` 恒为 true、`writableFinished` 恒为 false，拿它
 * 当判据的话，服务端自己抛的流错误（LLM 流中途炸、推送扇出失败）会被一并算成
 * 「客户端走了」而无声吞掉——日志没有、500 没有、连接就那么断了。
 */
function isClientDisconnect(err) {
  const code = err && err.code;
  return code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ERR_STREAM_DESTROYED'
    || code === 'EPIPE' || code === 'ECONNRESET';
}

/**
 * 把 Fetch Response 写到 Node 的 `res` 上——边收边写，不整体缓冲。
 *
 * instant 的默认传输是 SSE：响应体是一个「LLM 边跑边吐、全部推送发完才关」的
 * ReadableStream。先 `arrayBuffer()` 读完再写的话，传输层就静默退化成非流式——
 * 客户端要等整轮跑完才收到第一个字节，keepalive 心跳全被压在缓冲里（它本来就是
 * 为了防连接闲置被掐才存在的），中间隔着 nginx 之类的反代还会直接
 * proxy_read_timeout 判 504；而响应头写的仍然是 `text/event-stream`，从外面
 * 完全看不出已经不流式了。
 *
 * 用 `Readable.fromWeb` + `pipeline` 而不是手写 reader 循环：背压、错误传播、
 * 两端销毁都交给 stream 机制。客户端提前断开时 pipeline 会销毁源 Readable，
 * 销毁会 cancel 上游那个 ReadableStream —— instant 的 SSE 分支收到 cancel 就停
 * keepalive 定时器、把剩下的消息切到 Web Push 兜底，不会留下一个没人读的流。
 *
 * 非流式的 JSON 响应走同一条路：字节一样，只是改由 chunked 传输编码发出。
 */
async function writeFetchResponseToNode(response, res) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });

  // 204 / 304 这类没有 body 的响应，`response.body` 是 null。
  if (!response.body) {
    res.end();
    return;
  }

  const { Readable, pipeline } = await loadStreamHelpers();
  try {
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (err) {
    if (isClientDisconnect(err)) return;
    throw err;
  }
}

export default { toNodeHandler };
