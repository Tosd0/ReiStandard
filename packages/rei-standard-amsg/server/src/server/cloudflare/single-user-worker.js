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
 */

import { createSingleUserServer } from '../single-user.js';
import { createD1Adapter } from '../adapters/d1.js';
import { runScheduledTick } from '../lib/run-tick.js';

function headersToObject(h) {
  const out = {};
  for (const [k, v] of h) out[k] = v;
  return out;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
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
      const server = createSingleUserServer(cfg);

      const url = request.url;
      const { pathname } = new URL(url);
      const method = request.method.toUpperCase();
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
      } else {
        result = { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Unknown route' } } };
      }

      return jsonResponse(result.status, result.body);
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
