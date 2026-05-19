/**
 * Netlify Blobs BlobStoreAdapter.
 *
 * Netlify Blobs has **no native TTL** — we wrap the body as
 * `{body, expiresAt}` JSON and treat expired reads as missing. The
 * physical key remains until you sweep it, but `read` correctly
 * returns null past expiry so the SW path is honest.
 *
 * Production deployments SHOULD schedule a Netlify Scheduled Function
 * to walk the store and delete expired entries — without it the
 * store grows unboundedly:
 *
 *   // netlify/functions/sweep-amsg-blobs.js
 *   import { getStore } from '@netlify/blobs';
 *   export default async () => {
 *     const store = getStore('amsg-blobs');
 *     const { blobs } = await store.list();
 *     const now = Date.now();
 *     for (const { key } of blobs) {
 *       const raw = await store.get(key);
 *       try {
 *         const parsed = JSON.parse(raw);
 *         if (parsed?.expiresAt <= now) await store.delete(key);
 *       } catch { await store.delete(key); }
 *     }
 *     return new Response('ok');
 *   };
 *   export const config = { schedule: '* /15 * * * *' };
 *
 * Usage:
 *
 *   import { getStore } from '@netlify/blobs';
 *   import { createNetlifyBlobStore } from '@rei-standard/amsg-instant/blob/netlify';
 *   const adapter = createNetlifyBlobStore(getStore('amsg-blobs'));
 */

/**
 * @typedef {Object} NetlifyBlobsStore
 * @property {(key: string, value: string) => Promise<void>} set
 * @property {(key: string) => Promise<string | null>} get
 */

/**
 * @param {NetlifyBlobsStore} store
 * @returns {import('./interface.js').BlobStoreAdapter}
 */
export function createNetlifyBlobStore(store) {
  if (!store || typeof store.set !== 'function' || typeof store.get !== 'function') {
    throw new TypeError('createNetlifyBlobStore: store must be a Netlify Blobs store (returned by getStore())');
  }
  return {
    async put(key, body, ttlSeconds) {
      const wrapped = JSON.stringify({
        body,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      await store.set(key, wrapped);
    },
    async read(key) {
      const raw = await store.get(key);
      if (typeof raw !== 'string') return null;
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return null;
      }
      if (!parsed || typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) {
        return null;
      }
      return typeof parsed.body === 'string' ? parsed.body : null;
    },
  };
}
