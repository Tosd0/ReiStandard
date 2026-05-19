/**
 * ⚠️ Memory adapter — only enable when the runtime guarantees a
 * single-instance, long-lived process:
 *
 *   - Node.js long-running server (PM2 / systemd)
 *   - Single-worker deployments (no horizontal scaling)
 *   - Tests / local dev
 *
 * DO NOT use in Cloudflare Workers / Vercel Edge / Netlify Edge /
 * Deno Deploy: each isolate is independent, so a key written by the
 * isolate that handled `/instant` will not be visible to the isolate
 * that handles the SW's subsequent `GET /blob/:key`.
 *
 * Full-store behavior is **fail-fast** (`MemoryStoreFullError`) rather
 * than LRU eviction: silently dropping a key would make a
 * still-in-flight envelope's blob fetch land on a 404, and that's
 * much harder to debug than an explicit "store is full" error.
 */

import { MemoryStoreFullError } from '../errors.js';

/**
 * Build an in-memory BlobStoreAdapter.
 *
 * @param {Object} [opts]
 * @param {number} [opts.maxEntries=100]   - Active (non-expired) keys cap.
 * @param {() => number} [opts.now]        - Clock override for tests (ms).
 * @returns {import('./interface.js').BlobStoreAdapter}
 */
export function createMemoryBlobStore(opts = {}) {
  const maxEntries = opts.maxEntries ?? 100;
  const clock = typeof opts.now === 'function' ? opts.now : () => Date.now();
  /** @type {Map<string, { body: string, expiresAt: number }>} */
  const store = new Map();

  function sweepExpired() {
    const now = clock();
    for (const [k, v] of store) {
      if (v.expiresAt <= now) store.delete(k);
    }
  }

  return {
    async put(key, body, ttlSeconds) {
      sweepExpired();
      if (!store.has(key) && store.size >= maxEntries) {
        throw new MemoryStoreFullError(maxEntries);
      }
      store.set(key, { body, expiresAt: clock() + ttlSeconds * 1000 });
    },
    async read(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= clock()) {
        // Lazy-delete the expired row but the read still returns null
        // — keeps memory bounded between explicit sweeps.
        store.delete(key);
        return null;
      }
      return entry.body;
    },
  };
}
