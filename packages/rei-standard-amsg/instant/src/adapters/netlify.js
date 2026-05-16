/**
 * Netlify Functions adapter for @rei-standard/amsg-instant.
 *
 * Netlify Functions (v2, Fetch-API-style) accept a handler of the
 * shape `(req: Request) => Response | Promise<Response>`, which is
 * exactly the shape produced by `createInstantHandler`. This file is
 * a thin pass-through for symmetry with the other adapters and to
 * give downstream a consistent import path.
 *
 * Usage:
 *   // netlify/functions/instant.js
 *   import { createInstantHandler } from '@rei-standard/amsg-instant';
 *   import { toNetlifyHandler } from '@rei-standard/amsg-instant/adapters/netlify';
 *
 *   const handler = createInstantHandler({ ... });
 *   export default toNetlifyHandler(handler);
 *   export const config = { path: '/api/v1/instant' };
 */

/**
 * @param {(request: Request) => Promise<Response>} fetchHandler
 * @returns {(req: Request) => Promise<Response>}
 */
export function toNetlifyHandler(fetchHandler) {
  return async function netlifyHandler(req) {
    return fetchHandler(req);
  };
}

export default { toNetlifyHandler };
