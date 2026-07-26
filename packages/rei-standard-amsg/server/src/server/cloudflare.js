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
 * This subgraph uses no Node builtins — encryption and Web Push signing both
 * run on `globalThis.crypto` (Web Crypto) — so the bundle needs no
 * `nodejs_compat` compatibility flag.
 */

export { createSingleUserCloudflareWorker } from './cloudflare/single-user-worker.js';
export { createSingleUserServer } from './single-user.js';
export { createD1Adapter } from './adapters/d1.js';
export {
  createWebCryptoWebPush,
  measurePushPayload,
  MAX_PUSH_PAYLOAD_BYTES,
  WEB_PUSH_MAX_BODY_BYTES,
  WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES,
} from './lib/webpush-webcrypto.js';
export { runScheduledTick } from './lib/run-tick.js';
export {
  deriveUserEncryptionKey,
  decryptPayload,
  encryptForStorage,
  decryptFromStorage
} from './lib/encryption.js';
