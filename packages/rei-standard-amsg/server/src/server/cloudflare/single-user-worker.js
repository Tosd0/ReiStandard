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
 * 条任务不会被相邻两跳重复触发（见 lib/run-tick.js）。租期默认 10 分钟，可以
 * 用 config 里的 `claimLeaseMs` 调整。
 *
 * 同一个角色（或宿主定义的任何一组）的多条任务不想同时跑，就配一个
 * `serializeBy`；一次 fire 无论什么结局都想收到回执，就配 `onFireSettled`。
 * 两个都不配时行为与以前完全一致。
 */

import { createSingleUserServer } from '../single-user.js';
import { createD1Adapter } from '../adapters/d1.js';
import { runScheduledTick } from '../lib/run-tick.js';

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
const CORS_ALLOW_HEADERS =
  'Content-Type, X-User-Id, X-Payload-Encrypted, X-Encryption-Version, X-Response-Encrypted, X-Client-Token';
const CORS_ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';

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
  const allowOrigin = typeof cors.origin === 'function'
    ? cors.origin(requestOrigin) || null
    : cors.origin; // e.g. '*' or a fixed origin like 'https://app.example.com'
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

function internalErrorResponse(cors) {
  return jsonResponse(500, { success: false, error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } }, cors);
}

export function createSingleUserCloudflareWorker(buildConfig) {
  async function resolveConfig(env) {
    const cfg = await buildConfig(env);
    if (!cfg.db) cfg.db = createD1Adapter(env.DB);
    return cfg;
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
      const degraded = degradedCorsHeaders(requestOrigin);
      // A preflight must be 2xx or the browser never sends the real request —
      // and then the readable 500 below never reaches the caller.
      if (method === 'OPTIONS' && degraded) return new Response(null, { status: 204, headers: degraded });
      return internalErrorResponse(degraded);
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
      return internalErrorResponse(cors);
    }
  }

  async function scheduled(event, env /* , ctx */) {
    const cfg = await resolveConfig(env);
    const vapid = cfg.vapid || {};
    if (!cfg.webpush || !vapid.email || !vapid.publicKey || !vapid.privateKey) {
      console.error('[amsg single-user] scheduled(): VAPID/webpush not configured; skipping tick');
      return;
    }
    // Swallow tick failures: pending tasks stay pending, so the next cron tick
    // retries them. Logging keeps the failure visible in the tail log.
    try {
      await runScheduledTick({
        db: cfg.db,
        masterKey: cfg.masterKey,
        vapid,
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
        // 任务占位租期（默认 10 分钟，随 totalTimeoutMs 抬高）。
        claimLeaseMs: cfg.claimLeaseMs
      });
    } catch (error) {
      console.error('[amsg single-user] scheduled(): tick failed:', error && error.message);
    }
  }

  return { fetch, scheduled };
}
