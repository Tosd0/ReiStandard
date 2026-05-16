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
 *     masterKey: process.env.AMSG_MASTER_KEY,
 *   });
 *   export default toVercelEdgeHandler(handler);
 */

import { toNodeHandler } from './node.js';

/**
 * Edge runtime is already Fetch-API native, so this is a pass-through
 * that keeps a uniform import path with the other adapters.
 *
 * @param {(request: Request) => Promise<Response>} fetchHandler
 * @returns {(request: Request) => Promise<Response>}
 */
export function toVercelEdgeHandler(fetchHandler) {
  return async function vercelEdgeHandler(request) {
    return fetchHandler(request);
  };
}

export { toNodeHandler as toVercelNodeHandler };

export default { toVercelEdgeHandler, toVercelNodeHandler: toNodeHandler };
