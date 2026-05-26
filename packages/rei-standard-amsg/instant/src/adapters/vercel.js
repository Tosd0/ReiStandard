/**
 * Vercel Functions adapter for @rei-standard/amsg-instant.
 *
 * Two flavors are supported:
 *   - Edge Runtime: Fetch-API style handler (use `toVercelEdgeHandler`).
 *   - Node Runtime: classic (req, res) handler (use `toVercelNodeHandler`,
 *     re-exported from the Node adapter).
 *
 * Usage (Edge Runtime, recommended):
 *   // api/instant.js
 *   import { createInstantHandler } from '@rei-standard/amsg-instant';
 *   import { toVercelEdgeHandler } from '@rei-standard/amsg-instant/adapters/vercel';
 *
 *   export const config = { runtime: 'edge' };
 *
 *   const handler = createInstantHandler({
 *     vapid: {
 *       email: 'mailto:you@example.com',
 *       publicKey: process.env.VAPID_PUBLIC_KEY,
 *       privateKey: process.env.VAPID_PRIVATE_KEY,
 *     },
 *     clientToken: process.env.AMSG_CLIENT_TOKEN,   // optional weak auth
 *   });
 *   export default toVercelEdgeHandler(handler);
 */

import { toNodeHandler } from './node.js';

/**
 * Edge runtime is already Fetch-API native, so this is mostly a pass-through
 * that keeps a uniform import path with the other adapters. The optional
 * second argument is forwarded for runtimes that expose a request-scoped
 * `waitUntil` on context-like objects. For Vercel's `@vercel/functions`
 * helper, pass `waitUntil` directly to `createInstantHandler({ waitUntil })`.
 *
 * @param {(request: Request, runtime?: { waitUntil?: (work: Promise<unknown>) => void }) => Promise<Response>} fetchHandler
 * @returns {(request: Request, context?: { waitUntil?: (work: Promise<unknown>) => void }) => Promise<Response>}
 */
export function toVercelEdgeHandler(fetchHandler) {
  return async function vercelEdgeHandler(request, context) {
    return fetchHandler(request, context);
  };
}

export { toNodeHandler as toVercelNodeHandler };

export default { toVercelEdgeHandler, toVercelNodeHandler: toNodeHandler };
