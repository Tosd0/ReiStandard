/**
 * Cloudflare Workers adapter for @rei-standard/amsg-instant.
 *
 * Cloudflare Workers is the primary deployment target for amsg-instant:
 *   - No DB needed
 *   - Subrequest time waiting for the LLM does not count against CPU quota
 *   - Wall-time is uncapped (within reason)
 *   - The free tier easily covers most one-shot instant push workloads
 *
 * Usage (option 1 — env at module-init time, simplest):
 *   import { createInstantHandler } from '@rei-standard/amsg-instant';
 *
 *   export default {
 *     fetch: createInstantHandler({
 *       vapid: {
 *         email: 'mailto:you@example.com',
 *         publicKey: globalThis.VAPID_PUBLIC_KEY,
 *         privateKey: globalThis.VAPID_PRIVATE_KEY,
 *       },
 *       clientToken: globalThis.AMSG_CLIENT_TOKEN,   // optional weak auth
 *     }),
 *   };
 *
 * Usage (option 2 — read env from per-request bindings, recommended):
 *   import { createCloudflareWorker } from '@rei-standard/amsg-instant/adapters/cloudflare';
 *
 *   export default createCloudflareWorker((env) => ({
 *     vapid: {
 *       email: 'mailto:you@example.com',
 *       publicKey: env.VAPID_PUBLIC_KEY,
 *       privateKey: env.VAPID_PRIVATE_KEY,
 *     },
 *     clientToken: env.AMSG_CLIENT_TOKEN,            // optional
 *   }));
 *
 * wrangler.toml (excerpt):
 *   compatibility_flags = ["nodejs_compat"]
 *   # Secrets — set via `wrangler secret put NAME`
 *   #   VAPID_PUBLIC_KEY
 *   #   VAPID_PRIVATE_KEY
 *   #   AMSG_CLIENT_TOKEN   # optional
 */

import { redactCredentials } from '@rei-standard/amsg-shared';
import { createInstantHandler, buildCorsHeaders } from '../index.js';

/**
 * @typedef {Object} ErrorCause
 * @property {'config'|'request'} stage - 在哪一段炸的：'config' = 构建配置 /
 *   构建 handler 时抛的（binding 名字写错、环境变量丢了）；'request' = handler
 *   自己抛出来的
 * @property {string} name - 错误类型（`error.name`，认不出来时是 'Error'）
 * @property {string} [message] - 脱敏后的错误消息。降级 500（配置都没建起来那
 *   条路）回给跨域调用方时不带这个字段——那条路的 CORS 头是回显来访 Origin 的，
 *   任意第三方页面都能读，而构建期异常原文里常有内网域名、binding 名、环境变量
 *   名。同源 / 无 Origin 的请求（`curl`、服务端之间调用）照旧带全文，服务端日志
 *   （`wrangler tail`）里也一直有。
 * @property {string} [code] - 错误自带的 `code` 字符串（有才带）
 */

/** 回给调用方的错误摘要最长留这么多字符。 */
const ERROR_SUMMARY_MAX_CHARS = 500;

/**
 * 把错误消息压成能随响应体回给调用方的一行。
 *
 * 错误消息偶尔会回显请求细节（上游 API 的报错带 URL、header 片段），所以长得
 * 像凭据的串一律遮掉，再截断——带上消息的那些响应（请求阶段的 500、同源的降级
 * 500）前端都能直接读到。
 *
 * 遮什么、怎么遮由 @rei-standard/amsg-shared 的 `redactCredentials` 说了算，
 * 这里只负责压平空白和截断。
 *
 * @param {unknown} reason
 * @returns {string}
 */
function sanitizeErrorSummary(reason) {
  const flattened = String(reason ?? '').replace(/\s+/g, ' ').trim();
  const safe = redactCredentials(flattened);
  return safe.length > ERROR_SUMMARY_MAX_CHARS
    ? `${safe.slice(0, ERROR_SUMMARY_MAX_CHARS - 3)}…`
    : safe;
}

/**
 * 把一个异常整理成能机读的原因（stage / name / message [/ code]）。
 *
 * 500 只回一句「服务器内部错误」的话，真因（`env.BLOB_KV is undefined`）就只剩
 * `wrangler tail` 里那一行，调用方拿不到、运维从外面也看不出来。
 *
 * 整理出来的这份谁能看到多少，由调用方决定：跨域读得到的降级 500 只发 stage /
 * 异常类名这类标注，消息原文不出去（见 publicErrorCause）。
 *
 * @param {unknown} error
 * @param {'config'|'request'} stage
 * @returns {ErrorCause}
 */
function summarizeErrorCause(error, stage) {
  const raw = (error && typeof error === 'object') ? /** @type {any} */ (error) : {};
  const name = typeof raw.name === 'string' && raw.name ? raw.name : 'Error';
  const rawMessage = typeof raw.message === 'string' && raw.message ? raw.message : String(error ?? '');
  /** @type {ErrorCause} */
  const cause = {
    stage,
    name: sanitizeErrorSummary(name).slice(0, 100),
    message: sanitizeErrorSummary(rawMessage),
  };
  if (typeof raw.code === 'string' && raw.code) {
    cause.code = sanitizeErrorSummary(raw.code).slice(0, 100);
  }
  return cause;
}

// ─── 降级路径（配置没建起来时的 500）───────────────────────────────────────
//
// 下面这一段——degradedCorsHeaders、internalErrorResponse、config 与 request
// 两个阶段的切分、OPTIONS 必须回 204 的例外、Max-Age: 0——和 amsg-server 的
// server/src/server/cloudflare/single-user-worker.js 是同一套行为，两个包各留
// 一份、不互相 import：instant 会把 blob-store 和一整排 adapter 拖进去，破坏
// server 那边「D1-only、不开 nodejs_compat 也能打包」的目标。
//
// 改这边的信封形状（状态码、error.code/message、cause 的字段、CORS 头）记得同
// 步改那边，反之亦然。形状由 test/adapter-failure-modes.test.mjs 逐字段钉着。
//
// 有一处两边不同、且是故意的：跨域读得到的那份 cause 在 instant 这边不带
// `message`（见 publicErrorCause）。

/**
 * 降级路径专用的 CORS 头：配置都没建起来，这个部署允许哪些 origin 无从得知，
 * 但错误响应还是得带头——不带头的跨域响应浏览器直接丢掉，`fetch` 只抛一个
 * `TypeError: Failed to fetch`，看起来和 Worker 根本没部署一模一样。
 *
 * 回显来访 Origin，不用 '*'：这条路上放出去的是一个固定的错误信封加几个不含
 * 部署信息的标注（哪一段炸的、异常类名），没有数据也不带凭据，别人的页面顶多
 * 知道「这个 Worker 正在坏、坏在哪一段」；配置一修好，所有响应立刻回到 handler
 * 自己那套 CORS，同源部署不会因此变成开放部署。maxAge 0 保证故障期间答的这次
 * preflight 不会留在浏览器缓存里。
 *
 * @param {string} requestOrigin - 请求的 Origin 头（''：同源调用方，不需要 CORS 头）
 * @returns {Record<string, string>|null}
 */
function degradedCorsHeaders(requestOrigin) {
  if (!requestOrigin) return null;
  return {
    ...buildCorsHeaders({ allowOrigin: requestOrigin }),
    'Access-Control-Max-Age': '0',
  };
}

/** 来访 Origin（读不到就当同源，不为了一个响应头再抛一次）。 */
function originOf(request) {
  try {
    return request.headers.get('origin') || '';
  } catch (_error) {
    return '';
  }
}

/**
 * 这次调用是不是「自己人」：没有 Origin 头（`curl`、服务端之间调用、同源 GET），
 * 或者 Origin 就是这个 Worker 自己的域名。
 *
 * 问的其实是「谁能读到这条响应」。降级路径回显来访 Origin，所以任意第三方页面
 * 一个 `fetch` 就能读全响应体；而同源 / 无 Origin 的调用者读到的本来就是自己的
 * 东西，多给细节没有额外暴露面。哪些 origin 算自己人，本该由部署配的 CORS 说了
 * 算——但降级路径存在的前提正是那份配置没建起来，只能退到这条按请求本身就能判
 * 断的线上。
 *
 * @param {Request} request
 * @param {string} requestOrigin
 * @returns {boolean}
 */
function isSameOriginCall(request, requestOrigin) {
  if (!requestOrigin) return true;
  try {
    return new URL(request.url).origin === requestOrigin;
  } catch (_error) {
    return false;
  }
}

/**
 * 跨域能读到的那一份 cause：只留不含部署内容的标注（stage、异常类名、错误自带
 * 的 code），异常消息原文不跟着出去。
 *
 * 构建期异常的原文是部署信息本身：`env.BLOB_KV is undefined` 报的是 binding 名，
 * 配置校验的报错里可能有内网域名、环境变量名。运维要的排障线索留在两处：服务端
 * 日志（console.error 那一行，`wrangler tail` 看得到），以及同源 / 无 Origin 的
 * 请求——部署方 `curl` 一下就是全文。
 *
 * @param {ErrorCause} cause
 * @returns {ErrorCause}
 */
function publicErrorCause(cause) {
  const { message: _serverSideOnly, ...safe } = cause;
  return safe;
}

/**
 * @param {Record<string, string>|null} cors
 * @param {ErrorCause} cause
 */
function internalErrorResponse(cors, cause) {
  return new Response(
    JSON.stringify({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: '服务器内部错误', cause },
    }),
    {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...(cors || {}) },
    }
  );
}

/**
 * Build a Cloudflare Workers module export that lazily constructs the
 * handler the first time a request arrives. The factory receives the
 * Workers `env` binding so secrets can be read at request time rather
 * than at module-init time (which is required by Workers when secrets
 * are scoped per environment). The request-scoped `ExecutionContext`
 * is forwarded into the handler so the main LLM → split → push pipeline
 * is registered with `ctx.waitUntil` when Cloudflare provides it.
 *
 * 构建失败（optionsBuilder 抛错、createInstantHandler 拒绝配置）和 handler 自己
 * 抛出的异常都不会冲出 `fetch`：两种都回一个带 CORS 头、带机读 code 与 cause 的
 * 500，OPTIONS 预检照答 204。否则异常直接把请求打成协议级失败，跨域前端只能读到
 * 一句 `TypeError: Failed to fetch`（Safari 是 Load failed）——状态码、错误码、
 * 错误信息一概拿不到，预检也一起挂，运维从外面探测就是「彻底离线且零报错」，
 * 可 Worker 其实部署成功、每次请求都在同一行抛。
 *
 * 构建失败不会被记住，下一个请求照常重试：binding 补上、secret 配好之后不用
 * 重新部署也能自己恢复。
 *
 * 两条路上 `cause` 带多少东西不一样：请求阶段的 500 走这个部署自己配的 CORS
 * 白名单，谁读得到是部署方批准过的，`cause.message` 照旧带上；构建失败那条的
 * CORS 头是回显来访 Origin 猜出来的，只带 stage / 异常类名这类标注，消息原文留
 * 在服务端日志和同源请求里（见 publicErrorCause）。
 *
 * @param {(env: Record<string, string>) => import('../index.js').InstantHandlerOptions} optionsBuilder
 * @returns {{ fetch: (request: Request, env: Record<string, string>, ctx?: { waitUntil?: (work: Promise<unknown>) => void }) => Promise<Response> }}
 */
export function createCloudflareWorker(optionsBuilder) {
  let handler = null;
  // 建 handler 时顺手记下这个部署配的 CORS：handler 建起来之后，「允许哪些
  // origin」就是已知的了，请求阶段的兜底 500 得用这一份，不能再走降级回显。
  let corsHeaders = null;
  return {
    async fetch(request, env, ctx) {
      const requestOrigin = originOf(request);

      if (!handler) {
        try {
          const options = optionsBuilder(env || {});
          handler = createInstantHandler(options);
          corsHeaders = buildCorsHeaders(options && options.cors);
        } catch (error) {
          console.error('[amsg-instant] createCloudflareWorker: 构建 handler 失败:', error && error.message);
          const cause = summarizeErrorCause(error, 'config');
          const degraded = degradedCorsHeaders(requestOrigin);
          // 预检必须是 2xx，否则浏览器根本不会发那条真正的 POST，下面这个能读的
          // 500 也就永远到不了调用方手里。
          if (request.method === 'OPTIONS' && degraded) {
            return new Response(null, { status: 204, headers: degraded });
          }
          // 跨域读得到的那份不带异常原文：这条响应的 CORS 头是回显来访 Origin
          // 猜出来的，不是这个部署自己批准的白名单。
          return internalErrorResponse(
            degraded,
            isSameOriginCall(request, requestOrigin) ? cause : publicErrorCause(cause)
          );
        }
      }

      // handler 内部对请求处理有自己的错误边界，但边界之外还有几步（读 method、
      // 鉴权）；那里抛出来的异常同样是「跨域前端只看到 Failed to fetch」。这层
      // 兜底把它也收成同一种可读的 500。
      //
      // 用的是这个部署自己那套 CORS 头，跟 handler 正常回的响应一致：配置已经
      // 建起来了，白名单是已知的，没有理由在这里放宽。降级回显只属于上面那条
      // 「配置都没建起来」的路。
      try {
        return await handler(request, ctx);
      } catch (error) {
        console.error('[amsg-instant] createCloudflareWorker: 请求处理失败:', error && error.message);
        return internalErrorResponse(corsHeaders, summarizeErrorCause(error, 'request'));
      }
    }
  };
}

export { createInstantHandler };
export default { createCloudflareWorker };
