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
 *   PUT  /update-message    → patch
 *   DELETE /cancel-message  → delete
 *   GET  /vapid-public-key  → this worker's VAPID public key (for the frontend's
 *                             Web Push subscription); 503 if VAPID_PUBLIC_KEY unset
 *
 * CORS is opt-in: pass `cors: { origin }` in the config (a fixed origin, '*', or
 * an (origin) => allowedOrigin function) to answer OPTIONS preflights and echo
 * Access-Control-* on responses. With no `cors` the Worker stays same-origin.
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

export function createSingleUserCloudflareWorker(buildConfig) {
  async function resolveConfig(env) {
    const cfg = await buildConfig(env);
    if (!cfg.db) cfg.db = createD1Adapter(env.DB);
    return cfg;
  }

  async function fetch(request, env /* , ctx */) {
    // Error boundary: a handler (or config build) may throw — e.g.
    // schedule-message re-throws a non-unique DB error. Keep the client-facing
    // contract consistent (a JSON envelope, not the runtime's HTML error page).
    try {
      const cfg = await resolveConfig(env);
      const cors = corsHeadersFor(cfg.cors, request.headers.get('origin') || '');
      const method = request.method.toUpperCase();

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
      } else if (method === 'PUT' && pathname.endsWith('/update-message')) {
        result = await server.handlers.updateMessage.PUT(url, headers, await request.text());
      } else if (method === 'DELETE' && pathname.endsWith('/cancel-message')) {
        result = await server.handlers.cancelMessage.DELETE(url, headers);
      } else if (method === 'GET' && pathname.endsWith('/vapid-public-key')) {
        result = await server.handlers.vapidPublicKey.GET(url, headers);
      } else {
        result = { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Unknown route' } } };
      }

      return jsonResponse(result.status, result.body, cors);
    } catch (error) {
      console.error('[amsg single-user] fetch() unhandled error:', error && error.message);
      return jsonResponse(500, { success: false, error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } });
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
      await runScheduledTick({ db: cfg.db, masterKey: cfg.masterKey, vapid, webpush: cfg.webpush });
    } catch (error) {
      console.error('[amsg single-user] scheduled(): tick failed:', error && error.message);
    }
  }

  return { fetch, scheduled };
}
