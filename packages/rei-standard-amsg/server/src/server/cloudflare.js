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
  PUSH_ENVELOPE_RESERVED_BYTES,
  WEB_PUSH_MAX_BODY_BYTES,
  WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES,
} from './lib/webpush-webcrypto.js';
export {
  runScheduledTick,
  // 单任务入口：宿主想让某一条任务立刻跑起来（而不是触发一次全量扫描）时用
  // 它。见 lib/run-tick.js。
  runTask,
} from './lib/run-tick.js';
// Schema 自查 / 补齐：升级后老部署的表没跟上时，cron 会每分钟静默挂在缺的那
// 一列上。见 lib/schema-version.js。
export { getSchemaVersion, ensureSchema, SCHEMA_VERSION } from './lib/schema-version.js';
// 500 响应体里 error.cause 的组装（宿主自己包一层路由、也想回同样形状时用）。
export { summarizeErrorCause, NonRetryableError, isNonRetryableError } from './lib/errors.js';
export { isValidTimeZoneId, advanceOccurrence, nextFutureOccurrence, planNextOccurrence } from './lib/recurrence.js';
export {
  deriveUserEncryptionKey,
  decryptPayload,
  encryptForStorage,
  decryptFromStorage
} from './lib/encryption.js';
