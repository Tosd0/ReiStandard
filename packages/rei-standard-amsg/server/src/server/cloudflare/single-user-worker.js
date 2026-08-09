/**
 * Cloudflare Worker factory for the single-user amsg-server.
 *
 * Mirrors instant's createCloudflareWorker: you pass a buildConfig(env) that
 * returns the single-user config; we build the server per request (cheap) and
 * dispatch. Returns { fetch, scheduled } for `export default`.
 *
 * Routes (server endpoints only — NO /send-notifications; cron is scheduled()):
 *   POST /init-tenant       → build tables (idempotent)
 *   GET  /get-user-key      → derive user key
 *   POST /schedule-message  → create task
 *   GET  /messages          → list
 *   GET  /message?id=<uuid> → 单条任务（比列表多一个完整的 metadata）
 *   PUT  /update-message    → patch
 *   DELETE /cancel-message  → delete
 *   GET  /vapid-public-key  → this worker's VAPID public key (for the frontend's
 *                             Web Push subscription); 503 if VAPID_PUBLIC_KEY unset
 *   GET  /capabilities      → { serverVersion, features }（特性探测；老部署无此路由 → 404）
 *   PUT  /client-state      → batch upsert client state (last-write-wins on updatedAt)
 *   GET  /client-state      → read one namespace's entries (?namespace=<ns>)
 *   DELETE /client-state    → wipe this user's client state
 *   PUT    /push-subscription → 登记 / 覆盖这个用户的 Web Push 订阅
 *   GET    /push-subscription → { exists, updatedAt, endpoint }
 *   DELETE /push-subscription → 删掉这个用户的订阅
 *   GET  /outbox?since=<cursor> → 拉未 ack 的服务端消息（补收的事实来源）
 *   POST /outbox/ack        → 确认收到 { messageIds }
 *
 * CORS is opt-in: pass `cors: { origin }` in the config (a fixed origin, '*', or
 * an (origin) => allowedOrigin function) to answer OPTIONS preflights and echo
 * Access-Control-* on responses. With no `cors` the Worker stays same-origin.
 * Error responses carry the same headers as the success path — a header-less
 * 500 is invisible to a cross-origin caller (the browser drops it and `fetch`
 * rejects as a network error), so a server-side exception would otherwise be
 * indistinguishable from the worker being unreachable.
 *
 * Fire-time hooks are opt-in too: pass `hooks: { onBeforeFire, onLLMOutput,
 * executeToolCalls }` (+ optional `maxToolIterations` / `totalTimeoutMs` /
 * `maxScheduledTasksPerFire`) in the config to let scheduled AI tasks assemble
 * their prompt and run a server-side tool loop at fire time. Omit them and AI
 * tasks replay the schedule-time frozen prompt exactly as before. See
 * lib/agentic-fire.js.
 *
 * scheduled() 每次触发都会先给任务占位（在行的 lease_until 上写租约），同一
 * 条任务不会被相邻两跳重复触发（见 lib/run-tick.js）。投递期间租约按心跳滚动
 * 续租（默认 30s 心跳 / 90s 租约）：isolate 中途被回收时任务在 ~90 秒内就能
 * 被下一跳接手，不用等长租约走完。config 里的 `leaseHeartbeatMs` 可调心跳
 * 间隔（0 = 关掉心跳，退回一次性长租约，租期由 `claimLeaseMs` 决定，默认
 * 10 分钟）。
 *
 * 同一个角色（或宿主定义的任何一组）的多条任务不想同时跑，就配一个
 * `serializeBy`；一次 fire 无论什么结局都想收到回执，就配 `onFireSettled`。
 * 两个都不配时行为与以前完全一致。
 *
 * 工厂的第二个参数是 worker 级选项，目前只有一个 `onError`——fetch / cron 任
 * 何一段出错都调它一次。它故意放在 buildConfig 外面：buildConfig 自己抛错
 * （少个 binding、环境变量丢了）时，配置里的东西一个都读不到，而那恰恰是最
 * 需要被看见的一种故障。
 *
 * 返回的对象除了 `fetch` / `scheduled`，还有三个给宿主自己调的方法：
 *   - `runTask(uuid, env)`      → 只跑指定那一条任务（见 lib/run-tick.js）
 *   - `getSchemaVersion(env)`   → 活库的表结构够不够这一版用（只读）
 *   - `ensureSchema(env)`       → 不够就补齐（见 lib/schema-version.js）
 */

import { createSingleUserServer } from '../single-user.js';
import { createD1Adapter } from '../adapters/d1.js';
import { runScheduledTick, runTask as runTaskWithContext } from '../lib/run-tick.js';
import { getSchemaVersion as readSchemaVersion, ensureSchema as applySchema } from '../lib/schema-version.js';
import { summarizeErrorCause } from '../lib/errors.js';

function headersToObject(h) {
  const out = {};
  for (const [k, v] of h) out[k] = v;
  return out;
}

function jsonResponse(status, body, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(extraHeaders || {}) }
  });
}

// The custom headers the amsg-client sends; browsers preflight any request
// carrying them, so cross-origin callers need them echoed in the CORS response.
// 导出：在这个 worker 外面再包一层路由的宿主（自己的 fetch 里先答 OPTIONS）
// 直接 import 这一份，别手抄——两处手抄的列表迟早对不上，preflight 一挂整个
// 部署看起来就像离线。
export const CORS_ALLOW_HEADERS =
  'Content-Type, X-User-Id, X-Payload-Encrypted, X-Encryption-Version, X-Response-Encrypted, X-Client-Token';
export const CORS_ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

/**
 * Resolve the CORS response headers for a request, or null when CORS is off.
 * Opt-in: with no `cors` config the Worker stays same-origin (no headers, and
 * OPTIONS falls through to 404) — so nothing is exposed unless asked for.
 *
 * @param {undefined | { origin: string | ((requestOrigin: string) => string|null|undefined), allowHeaders?: string, maxAge?: number }} cors
 * @param {string} requestOrigin - the request's Origin header (may be '')
 */
function corsHeadersFor(cors, requestOrigin) {
  if (!cors || cors.origin == null) return null;
  let allowOrigin;
  if (typeof cors.origin === 'function') {
    // 宿主的回调抛错不能让整个请求逃出错误边界（这个函数在 fetch() 的
    // try 之外也会被调）：按「不放行这个 origin」处理，响应照常走 JSON 包体。
    try {
      allowOrigin = cors.origin(requestOrigin) || null;
    } catch (error) {
      console.warn('[amsg single-user] cors.origin 回调抛错，按不放行处理:', error && error.message);
      allowOrigin = null;
    }
  } else {
    allowOrigin = cors.origin; // e.g. '*' or a fixed origin like 'https://app.example.com'
  }
  if (!allowOrigin) return null;

  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': CORS_ALLOW_METHODS,
    'Access-Control-Allow-Headers': cors.allowHeaders || CORS_ALLOW_HEADERS,
    'Access-Control-Max-Age': String(cors.maxAge ?? 86400)
  };
  // A per-origin echo must vary the cache by Origin; '*' does not.
  if (allowOrigin !== '*') headers['Vary'] = 'Origin';
  return headers;
}

/**
 * CORS headers for the degraded path: buildConfig itself threw, so the
 * deployment's configured policy is unknowable — yet the error response still
 * needs headers, or a cross-origin caller cannot see it at all (the browser
 * drops a header-less response and `fetch` rejects as a network error, which
 * reads exactly like the worker being down).
 *
 * The fallback echoes the caller's Origin — never '*' — and is used ONLY on this
 * path. What it exposes is a fixed error envelope with no data and no
 * credentials, so a stranger's page learns nothing beyond "this worker is
 * failing"; the moment the config builds again, every response goes back to
 * cfg.cors, so a CORS-less (same-origin) deployment does not become an open one.
 * maxAge 0 keeps a preflight answered during the outage out of the browser cache.
 *
 * @param {string} requestOrigin - the request's Origin header ('' → null, i.e.
 *   a same-origin caller needs no headers, same as everywhere else)
 */
function degradedCorsHeaders(requestOrigin) {
  return corsHeadersFor({ origin: requestOrigin, maxAge: 0 }, requestOrigin);
}

/**
 * 500 的响应体。`error.code` / `error.message` 一直是那两句固定的（老调用方
 * 照着它们判断的逻辑不动），真因加在 `error.cause` 上：调用方能机读、能显示
 * 「哪儿坏了」，不用再去 tail 日志里捞，更不用去劫 console.error 偷听。
 *
 * @param {Object|null} cors
 * @param {import('../lib/errors.js').ErrorCause} [cause]
 */
function internalErrorResponse(cors, cause) {
  return jsonResponse(500, {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误',
      ...(cause ? { cause } : {})
    }
  }, cors);
}

/** 出错时给 onError 报的路径（拿不到就 null，不为了一个日志字段再抛一次）。 */
function pathOf(request) {
  try {
    return new URL(request.url).pathname;
  } catch (_error) {
    return null;
  }
}

/**
 * @param {(env: Object) => Object|Promise<Object>} buildConfig
 * @param {{ onError?: (info: { stage: 'config'|'request'|'tick', error: unknown, cause: import('../lib/errors.js').ErrorCause, path: string|null }) => void|Promise<void> }} [options]
 *   `onError` 在 fetch 或 cron 出错时调一次（best-effort，自身抛错只记日志）。
 *   cron 那条路上没有调用方能看到错误响应，这个 hook 是宿主唯一的出口。
 */
export function createSingleUserCloudflareWorker(buildConfig, options = {}) {
  const onError = typeof options.onError === 'function' ? options.onError : null;

  async function resolveConfig(env) {
    const cfg = await buildConfig(env);
    if (!cfg.db) cfg.db = createD1Adapter(env.DB);
    return cfg;
  }

  /** 把这次故障递给宿主（best-effort：hook 抛错不能再把主流程带下去）。 */
  async function reportError(info) {
    if (!onError) return;
    try {
      await onError(info);
    } catch (hookError) {
      console.warn('[amsg single-user] onError hook 抛错（已忽略）:', hookError && hookError.message);
    }
  }

  /**
   * cron 与单任务入口共用的一份 tick ctx。两处各写一份的话，加了新配置项只
   * 改一边，「cron 跑得好好的、手动触发那条却不认这个配置」就是这么来的。
   */
  function buildTickContext(cfg) {
    return {
      db: cfg.db,
      masterKey: cfg.masterKey,
      vapid: cfg.vapid || {},
      webpush: cfg.webpush,
      // Fire-time hooks (optional; see lib/agentic-fire.js). runScheduledTick
      // spreads its ctx into processSingleMessage, so these ride along.
      hooks: cfg.hooks || null,
      maxToolIterations: cfg.maxToolIterations,
      totalTimeoutMs: cfg.totalTimeoutMs,
      // hook 的 ctx.writeState() 用它判断单条 value 的上限，和 PUT /client-state 同一个配置。
      maxStateValueBytes: cfg.maxStateValueBytes,
      // hook 的 ctx.scheduleTask() 单次 fire 建任务的条数上限（默认 2）。
      maxScheduledTasksPerFire: cfg.maxScheduledTasksPerFire,
      // 任务错过触发时刻太久（> 60 分钟）不再补发时的回执 hook：
      // (task, { reason, action, metadata, skippedCount, …, readState,
      // writeState })。一次性任务（action 'expired'）和循环任务快进
      //（action 'fast_forwarded'）都会调（凭据字段不透传；best-effort，
      // 见 lib/run-tick.js）。
      onStaleSkip: cfg.onStaleSkip,
      // 推送发出（或发挂）之后的 hook：{ task, sentCount, total, error,
      // scratch, readState, writeState }（best-effort，见 lib/agentic-fire.js）。
      onAfterSend: cfg.onAfterSend,
      // 一次 fire 收尾的 hook：{ task, status, skipReason, sentCount, total,
      // iterations, error, scratch, readState, writeState }。发完 / 跳过 /
      // 抛错都会调，宿主用它做「开始时占点什么、结束时放掉」那类收尾
      //（best-effort，见 lib/agentic-fire.js）。
      onFireSettled: cfg.onFireSettled,
      // 分组串行：(task) => 分组标识 | null。同一分组的任务同时只跑一条，
      // 跨跳也算（见 lib/run-tick.js）。不配 = 全并发，与以前一致。
      serializeBy: cfg.serializeBy,
      // 任务占位租期（只在心跳关掉时生效；默认 10 分钟，随 totalTimeoutMs 抬高）。
      claimLeaseMs: cfg.claimLeaseMs,
      // 租约心跳间隔（默认 30s；0 = 关掉心跳，退回一次性长租约）。
      leaseHeartbeatMs: cfg.leaseHeartbeatMs,
      // 补发新鲜度阈值（默认 60 分钟；见 lib/run-tick.js 的 STALE_AFTER_MS）。
      staleAfterMs: cfg.staleAfterMs
    };
  }

  /** 投递要用的 VAPID / webpush 齐不齐（不齐就别白跑一趟，任务白扣一次重试）。 */
  function pushConfigured(cfg) {
    const vapid = cfg.vapid || {};
    return !!(cfg.webpush && vapid.email && vapid.publicKey && vapid.privateKey);
  }

  async function fetch(request, env /* , ctx */) {
    const requestOrigin = request.headers.get('origin') || '';
    const method = request.method.toUpperCase();

    // The config is built on its own so that a build failure (a missing binding,
    // a lost env var) still answers with CORS headers — otherwise every request,
    // preflights included, comes back header-less and the whole deployment looks
    // offline to the frontend instead of broken.
    let cfg;
    try {
      cfg = await resolveConfig(env);
    } catch (error) {
      console.error('[amsg single-user] fetch() config build failed:', error && error.message);
      const cause = summarizeErrorCause(error, 'config');
      await reportError({ stage: 'config', error, cause, path: pathOf(request) });
      const degraded = degradedCorsHeaders(requestOrigin);
      // A preflight must be 2xx or the browser never sends the real request —
      // and then the readable 500 below never reaches the caller.
      if (method === 'OPTIONS' && degraded) return new Response(null, { status: 204, headers: degraded });
      return internalErrorResponse(degraded, cause);
    }

    const cors = corsHeadersFor(cfg.cors, requestOrigin);

    // Error boundary: a handler may throw — e.g. schedule-message re-throws a
    // non-unique DB error. Keep the client-facing contract consistent (a JSON
    // envelope, not the runtime's HTML error page) and carry the same CORS
    // headers as the success path, so the caller reads the error instead of a
    // browser-level network failure.
    try {
      // CORS preflight: answer OPTIONS directly when CORS is configured.
      if (method === 'OPTIONS') {
        return cors
          ? new Response(null, { status: 204, headers: cors })
          : jsonResponse(404, { success: false, error: { code: 'NOT_FOUND', message: 'Unknown route' } });
      }

      const server = createSingleUserServer(cfg);

      const url = request.url;
      // Strip trailing slash(es) so `/init-tenant/` routes like `/init-tenant`
      // (endsWith matching is kept so a prefixed mount still resolves).
      const pathname = new URL(url).pathname.replace(/\/+$/, '') || '/';
      const headers = headersToObject(request.headers);

      let result;
      if (method === 'POST' && pathname.endsWith('/init-tenant')) {
        result = await server.handlers.init.POST(headers, await request.text());
      } else if (method === 'GET' && pathname.endsWith('/get-user-key')) {
        result = await server.handlers.getUserKey.GET(url, headers);
      } else if (method === 'POST' && pathname.endsWith('/schedule-message')) {
        result = await server.handlers.scheduleMessage.POST(headers, await request.text());
      } else if (method === 'GET' && pathname.endsWith('/messages')) {
        result = await server.handlers.messages.GET(url, headers);
      } else if (method === 'GET' && pathname.endsWith('/message')) {
        // 复数是列表、单数是单条。'/messages' 不以 '/message' 结尾（末尾是
        // 's'），两条 endsWith 判断互不吃对方的请求。
        result = await server.handlers.getMessage.GET(url, headers);
      } else if (method === 'PUT' && pathname.endsWith('/update-message')) {
        result = await server.handlers.updateMessage.PUT(url, headers, await request.text());
      } else if (method === 'DELETE' && pathname.endsWith('/cancel-message')) {
        result = await server.handlers.cancelMessage.DELETE(url, headers);
      } else if (method === 'GET' && pathname.endsWith('/vapid-public-key')) {
        result = await server.handlers.vapidPublicKey.GET(url, headers);
      } else if (method === 'GET' && pathname.endsWith('/capabilities')) {
        result = await server.handlers.capabilities.GET(url, headers);
      } else if (method === 'PUT' && pathname.endsWith('/client-state')) {
        result = await server.handlers.clientState.PUT(headers, await request.text());
      } else if (method === 'GET' && pathname.endsWith('/client-state')) {
        result = await server.handlers.clientState.GET(url, headers);
      } else if (method === 'DELETE' && pathname.endsWith('/client-state')) {
        result = await server.handlers.clientState.DELETE(url, headers);
      } else if (method === 'GET' && pathname.endsWith('/outbox')) {
        result = await server.handlers.outbox.GET(url, headers);
      } else if (method === 'POST' && pathname.endsWith('/outbox/ack')) {
        result = await server.handlers.outbox.POST(headers, await request.text());
      } else if (method === 'PUT' && pathname.endsWith('/push-subscription')) {
        result = await server.handlers.pushSubscription.PUT(headers, await request.text());
      } else if (method === 'GET' && pathname.endsWith('/push-subscription')) {
        result = await server.handlers.pushSubscription.GET(url, headers);
      } else if (method === 'DELETE' && pathname.endsWith('/push-subscription')) {
        result = await server.handlers.pushSubscription.DELETE(url, headers);
      } else {
        result = { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Unknown route' } } };
      }

      return jsonResponse(result.status, result.body, cors);
    } catch (error) {
      console.error('[amsg single-user] fetch() unhandled error:', error && error.message);
      const cause = summarizeErrorCause(error, 'request');
      await reportError({ stage: 'request', error, cause, path: pathOf(request) });
      return internalErrorResponse(cors, cause);
    }
  }

  /**
   * cron 每跳的入口。这条路上没有调用方能读到错误响应，所以每种不跑的情形都
   * 走两个出口：`onError`（宿主自己接，best-effort）和返回值。
   *
   * 返回值不影响 Cloudflare（它不看），是给「自己包一层再转调 scheduled」的
   * 宿主和测试用的。
   *
   * @returns {Promise<{ ok: true, summary: Object } | { ok: false, cause: import('../lib/errors.js').ErrorCause }>}
   */
  async function scheduled(event, env /* , ctx */) {
    // fetch() 对 buildConfig 失败有降级路径，cron 这边同样不该以未捕获异常
    // 崩掉：记日志跳过这一跳，行保持 pending，配置修好后下一跳照常。
    let cfg;
    try {
      cfg = await resolveConfig(env);
    } catch (error) {
      console.error('[amsg single-user] scheduled(): config build failed; skipping tick:', error && error.message);
      const cause = summarizeErrorCause(error, 'config');
      await reportError({ stage: 'config', error, cause, path: null });
      return { ok: false, cause };
    }
    if (!pushConfigured(cfg)) {
      console.error('[amsg single-user] scheduled(): VAPID/webpush not configured; skipping tick');
      // 这一支没有异常对象，但对宿主来说和抛错一样是「这一跳没跑」，所以照样
      // 组一份 cause 递出去。
      const cause = summarizeErrorCause(
        { name: 'VapidNotConfigured', message: 'VAPID / webpush 未配置，本跳跳过' },
        'config'
      );
      await reportError({ stage: 'config', error: null, cause, path: null });
      return { ok: false, cause };
    }
    // Swallow tick failures: pending tasks stay pending, so the next cron tick
    // retries them. Logging keeps the failure visible in the tail log.
    try {
      const summary = await runScheduledTick(buildTickContext(cfg));
      return { ok: true, summary };
    } catch (error) {
      console.error('[amsg single-user] scheduled(): tick failed:', error && error.message);
      const cause = summarizeErrorCause(error, 'tick');
      await reportError({ stage: 'tick', error, cause, path: null });
      return { ok: false, cause };
    }
  }

  /**
   * 只跑指定那一条任务，走的是 cron 完全同一条投递链（占位、租约心跳、过期
   * 守卫、失败重试 / 终态、hook 全套）。刚落库的任务想立刻跑起来时用它，不用
   * 再靠触发一次全量扫描（全量扫描逼着宿主只能单实例串行，拿不到并行）。
   *
   * @param {string} uuid - 任务 uuid
   * @param {Object} env - Worker 的 env（和 fetch / scheduled 拿到的同一份）
   * @returns {Promise<{ ran: false, reason: 'not_configured'|'not_found'|'already_settled'|'not_due'|'retry_pending', status?: string, nextSendAt?: string, retryAfter?: string }
   *   | { ran: true, summary: Object }>} 不跑的四种情形见 lib/run-tick.js 的
   *   `runTask`；`not_configured` 是这一层多出来的：VAPID / webpush 没配齐，
   *   跑了也只是白扣这条任务一次重试。buildConfig 自己抛错时原样抛给调用方
   *   （这个方法是宿主主动调的，不像 fetch 那样有响应可回）
   */
  async function runTask(uuid, env) {
    const cfg = await resolveConfig(env);
    if (!pushConfigured(cfg)) return { ran: false, reason: 'not_configured' };
    return runTaskWithContext(buildTickContext(cfg), uuid);
  }

  /**
   * 活库的表结构够不够这一版代码用（只读）。库升级后表结构变了而这个部署没
   * 再跑过建表，cron 会每分钟静默挂在缺的那一列上——这个方法让宿主查得出来，
   * 也知道该提示用户点哪里。
   *
   * @param {Object} env
   * @returns {Promise<import('../lib/schema-version.js').SchemaVersionResult>}
   */
  async function getSchemaVersion(env) {
    const cfg = await resolveConfig(env);
    return readSchemaVersion(cfg.db);
  }

  /**
   * 缺什么补什么（建表 + 补列 + 建索引，重复调没事）。`POST /init-tenant` 内
   * 部做的就是这件事，这里把它单独露出来：什么时候补、补完怎么提示用户，由
   * 宿主决定，库不会在每次请求里偷偷迁移。
   *
   * @param {Object} env
   * @returns {Promise<import('../lib/schema-version.js').EnsureSchemaResult>}
   */
  async function ensureSchema(env) {
    const cfg = await resolveConfig(env);
    return applySchema(cfg.db);
  }

  return { fetch, scheduled, runTask, getSchemaVersion, ensureSchema };
}
