/**
 * Netlify Functions adapter for @rei-standard/amsg-instant.
 *
 * Netlify Functions (v2, Fetch-API-style) accept a handler of the
 * shape `(req: Request, context: Context) => Response | Promise<Response>`,
 * which is compatible with the shape produced by `createInstantHandler`.
 * This adapter forwards the Netlify context so `context.waitUntil` can
 * protect the main LLM → split → push pipeline when the platform provides it.
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
 * @param {(request: Request, runtime?: { waitUntil?: (work: Promise<unknown>) => void }) => Promise<Response>} fetchHandler
 * @returns {(req: Request, context?: { waitUntil?: (work: Promise<unknown>) => void }) => Promise<Response>}
 */
export function toNetlifyHandler(fetchHandler) {
  return async function netlifyHandler(req, context) {
    return fetchHandler(req, context);
  };
}

export default { toNetlifyHandler };
