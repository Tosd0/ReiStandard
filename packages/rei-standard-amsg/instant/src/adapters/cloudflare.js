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

import { createInstantHandler, buildCorsHeaders, CORS_ALLOW_HEADERS } from '../index.js';

/**
 * @typedef {Object} ErrorCause
 * @property {'config'|'request'} stage - 在哪一段炸的：'config' = 构建配置 /
 *   构建 handler 时抛的（binding 名字写错、环境变量丢了）；'request' = handler
 *   自己抛出来的
 * @property {string} name - 错误类型（`error.name`，认不出来时是 'Error'）
 * @property {string} message - 脱敏后的错误消息
 * @property {string} [code] - 错误自带的 `code` 字符串（有才带）
 */

/**
 * 「短前缀 + 长随机串」形态的 key（`sk-…` / `xai-…` / `sk-ant-api03-…`）。
 *
 * 尾巴要有连续 16 个以上的字母数字才算数。模型 ID 长得很像这个形状
 * （`gpt-4o-mini-2024-07-18`、`claude-3-5-sonnet-20241022`），但它是一串被连
 * 字符切开的短词，凑不出这么长的一段随机串。规则与 @rei-standard/amsg-shared
 * 的 `redactCredentials` 一致，改一处要几处一起改。
 */
const CREDENTIAL_LIKE_TOKEN = /\b[A-Za-z]{2,6}-[A-Za-z0-9_-]*[A-Za-z0-9]{16,}/g;

/**
 * 把错误消息压成能随响应体回给调用方的一行。
 *
 * 错误消息偶尔会回显请求细节（上游 API 的报错带 URL、header 片段），所以长得
 * 像凭据的串一律遮掉，再截断——这条响应是跨域前端能直接读到的。
 *
 * @param {unknown} reason
 * @returns {string}
 */
function sanitizeErrorSummary(reason) {
  let s = String(reason ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]');
  s = s.replace(CREDENTIAL_LIKE_TOKEN, '[redacted]');
  s = s.replace(/[A-Za-z0-9+/_.-]{48,}/g, '[redacted]');
  if (s.length > 500) s = `${s.slice(0, 497)}…`;
  return s;
}

/**
 * 把一个异常整理成能机读的原因（stage / name / message [/ code]）。
 *
 * 500 只回一句「服务器内部错误」的话，真因（`env.BLOB_KV is undefined`）就只剩
 * `wrangler tail` 里那一行，调用方拿不到、运维从外面也看不出来。
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

/**
 * 降级路径专用的 CORS 头：配置都没建起来，这个部署允许哪些 origin 无从得知，
 * 但错误响应还是得带头——不带头的跨域响应浏览器直接丢掉，`fetch` 只抛一个
 * `TypeError: Failed to fetch`，看起来和 Worker 根本没部署一模一样。
 *
 * 回显来访 Origin，不用 '*'：这条路上放出去的只有一个固定的错误信封，没有数据
 * 也不带凭据，别人的页面顶多知道「这个 Worker 正在坏」；配置一修好，所有响应
 * 立刻回到 handler 自己那套 CORS，同源部署不会因此变成开放部署。maxAge 0 保证
 * 故障期间答的这次 preflight 不会留在浏览器缓存里。
 *
 * @param {string} requestOrigin - 请求的 Origin 头（''：同源调用方，不需要 CORS 头）
 * @returns {Record<string, string>|null}
 */
function degradedCorsHeaders(requestOrigin) {
  if (!requestOrigin) return null;
  return {
    'Access-Control-Allow-Origin': requestOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': CORS_ALLOW_HEADERS,
    'Access-Control-Max-Age': '0',
    'Vary': 'Origin',
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
          return internalErrorResponse(degraded, cause);
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
