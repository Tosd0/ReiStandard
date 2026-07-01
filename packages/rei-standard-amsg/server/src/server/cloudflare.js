/**
 * Cloudflare / D1 single-user entry point.
 *
 * Import this instead of the package root from a Worker bundle:
 *
 *   import { createSingleUserCloudflareWorker } from '@rei-standard/amsg-server/cloudflare';
 *
 * It reaches only the single-user + D1 + Web Crypto Web Push path — with no
 * reference to the multi-tenant server, the pluggable pg/neon adapter factory,
 * or the Node-oriented `web-push` module. That keeps a D1-only install (without
 * the optional `pg` / `@neondatabase/serverless` peers) bundling cleanly: the
 * root entry pulls those in through `createReiServer`, this one does not.
 *
 * node:crypto is the only Node builtin in this subgraph; enable it on Workers
 * with `compatibility_flags = ["nodejs_compat"]` (see the example wrangler.toml).
 */

export { createSingleUserCloudflareWorker } from './cloudflare/single-user-worker.js';
export { createSingleUserServer } from './single-user.js';
export { createD1Adapter } from './adapters/d1.js';
export { createWebCryptoWebPush } from './lib/webpush-webcrypto.js';
export { runScheduledTick } from './lib/run-tick.js';
export {
  deriveUserEncryptionKey,
  decryptPayload,
  encryptForStorage,
  decryptFromStorage
} from './lib/encryption.js';
