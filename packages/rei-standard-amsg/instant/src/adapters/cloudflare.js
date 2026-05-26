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

import { createInstantHandler } from '../index.js';

/**
 * Build a Cloudflare Workers module export that lazily constructs the
 * handler the first time a request arrives. The factory receives the
 * Workers `env` binding so secrets can be read at request time rather
 * than at module-init time (which is required by Workers when secrets
 * are scoped per environment). The request-scoped `ExecutionContext`
 * is forwarded into the handler so the main LLM → split → push pipeline
 * is registered with `ctx.waitUntil` when Cloudflare provides it.
 *
 * @param {(env: Record<string, string>) => import('../index.js').InstantHandlerOptions} optionsBuilder
 * @returns {{ fetch: (request: Request, env: Record<string, string>, ctx?: { waitUntil?: (work: Promise<unknown>) => void }) => Promise<Response> }}
 */
export function createCloudflareWorker(optionsBuilder) {
  let handler = null;
  return {
    async fetch(request, env, ctx) {
      if (!handler) {
        handler = createInstantHandler(optionsBuilder(env || {}));
      }
      return handler(request, ctx);
    }
  };
}

export { createInstantHandler };
export default { createCloudflareWorker };
