/**
 * ReiStandard Server SDK Entry Point
 *
 * Usage:
 *   import { createReiServer } from '@rei-standard/amsg-server';
 *
 *   const rei = await createReiServer({
 *     vapid: {
 *       email: process.env.VAPID_EMAIL,
 *       publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
 *       privateKey: process.env.VAPID_PRIVATE_KEY,
 *     },
 *     tenant: {
 *       blobNamespace: 'rei-tenants',
 *       kek: process.env.TENANT_CONFIG_KEK,
 *       tokenSigningKey: process.env.TENANT_TOKEN_SIGNING_KEY,
 *       initSecret: process.env.INIT_SECRET,
 *       publicBaseUrl: process.env.PUBLIC_BASE_URL
 *     }
 *   });
 */

import { createAdapter } from './adapters/factory.js';
import { createInitTenantHandler } from './handlers/init-tenant.js';
import { createGetUserKeyHandler } from './handlers/get-user-key.js';
import { createScheduleMessageHandler } from './handlers/schedule-message.js';
import { createSendNotificationsHandler } from './handlers/send-notifications.js';
import { createUpdateMessageHandler } from './handlers/update-message.js';
import { createCancelMessageHandler } from './handlers/cancel-message.js';
import { createMessagesHandler } from './handlers/messages.js';
import { createGetMessageHandler } from './handlers/get-message.js';
import { createPushSubscriptionHandler } from './handlers/push-subscription.js';
import { createTenantBlobStore } from './tenant/blob-store.js';
import { createTenantContextManager } from './tenant/context.js';
import { normalizeVapidSubject } from '@rei-standard/amsg-shared';

/**
 * @typedef {Object} VapidConfig
 * @property {string} [email]      - VAPID contact email (e.g. mailto:…).
 * @property {string} [publicKey]  - VAPID public key.
 * @property {string} [privateKey] - VAPID private key.
 */

/**
 * @typedef {Object} TenantServerConfig
 * @property {string} [blobNamespace]  - Netlify Blob namespace.
 * @property {string} kek              - KEK used to encrypt tenant config in blobs.
 * @property {string} tokenSigningKey  - HMAC key used to sign tenant/cron tokens.
 * @property {string} [initSecret]     - Optional secret for /init-tenant bootstrap endpoint.
 * @property {string} [publicBaseUrl]  - Optional base URL for generated cron webhook.
 * @property {(db: {driver:'neon'|'pg', connectionString:string}) => Promise<any>} [adapterFactory]
 *   Optional adapter factory override (mainly for tests).
 */

/**
 * @typedef {Object} ReiServerConfig
 * @property {VapidConfig} [vapid]   - VAPID keys for Web Push.
 * @property {TenantServerConfig} tenant - Tenant config & auth settings.
 */

/**
 * @typedef {Object} ReiHandlers
 * @property {{ POST: function }} initTenant
 * @property {{ GET: function }} getUserKey
 * @property {{ POST: function }} scheduleMessage
 * @property {{ POST: function }} sendNotifications
 * @property {{ PUT: function }} updateMessage
 * @property {{ DELETE: function }} cancelMessage
 * @property {{ GET: function }} messages
 * @property {{ GET: function }} getMessage
 * @property {{ PUT: function, GET: function, DELETE: function }} pushSubscription
 */

/**
 * @typedef {Object} ReiServer
 * @property {ReiHandlers} handlers - Standard API route handler objects.
 */

/**
 * Initialise the ReiStandard server.
 *
 * @param {ReiServerConfig} config
 * @returns {Promise<ReiServer>}
 */
export async function createReiServer(config) {
  if (!config) throw new Error('[rei-standard-amsg-server] config is required');
  if (!config.tenant) throw new Error('[rei-standard-amsg-server] tenant config is required');

  // web-push is a hard dependency for ReiStandard server features
  let webpushModule;
  try {
    const webpushImport = await import('web-push');
    webpushModule = webpushImport.default || webpushImport;
  } catch (_err) {
    throw new Error(
      '[rei-standard-amsg-server] web-push is required. Install it with: npm install web-push'
    );
  }

  const vapid = config.vapid || {};

  if (vapid.email && vapid.publicKey && vapid.privateKey) {
    webpushModule.setVapidDetails(
      normalizeVapidSubject(vapid.email),
      vapid.publicKey,
      vapid.privateKey
    );
  }

  const tenantStore = createTenantBlobStore({
    namespace: config.tenant.blobNamespace || 'rei-tenants',
    kek: config.tenant.kek
  });

  const tenantManager = createTenantContextManager({
    tenantStore,
    tokenSigningKey: config.tenant.tokenSigningKey,
    publicBaseUrl: config.tenant.publicBaseUrl,
    adapterFactory: config.tenant.adapterFactory
  });

  const initSecret = String(config.tenant.initSecret || '').trim();

  const ctx = {
    vapid: {
      email: vapid.email || '',
      publicKey: vapid.publicKey || '',
      privateKey: vapid.privateKey || ''
    },
    webpush: webpushModule,
    tenant: {
      initSecret
    },
    tenantManager
  };

  return {
    handlers: {
      initTenant: createInitTenantHandler(ctx),
      getUserKey: createGetUserKeyHandler(ctx),
      scheduleMessage: createScheduleMessageHandler(ctx),
      sendNotifications: createSendNotificationsHandler(ctx),
      updateMessage: createUpdateMessageHandler(ctx),
      cancelMessage: createCancelMessageHandler(ctx),
      messages: createMessagesHandler(ctx),
      getMessage: createGetMessageHandler(ctx),
      pushSubscription: createPushSubscriptionHandler(ctx)
    }
  };
}

// Re-export utilities that consumers may need
export { createAdapter } from './adapters/factory.js';
export { createD1Adapter } from './adapters/d1.js';
export { createSingleUserServer } from './single-user.js';
export {
  runScheduledTick,
  // 单任务入口：宿主接 CF Queue 消费者（15 分钟预算）跑 fire 时用它，
  // fetch 里只负责 enqueue。见 lib/run-tick.js。
  runTask,
  DEFAULT_CLAIM_LEASE_MS,
  DEFAULT_LEASE_HEARTBEAT_MS,
  DEFAULT_HEARTBEAT_LEASE_TTL_MS,
  sanitizeErrorSummary,
} from './lib/run-tick.js';
// hook 侧标注「重试也好不了」的失败：run-tick 收到即直接终审处置，不进退避
// 阶梯（见 lib/errors.js）。summarizeErrorCause 是 500 响应体里 error.cause 的
// 组装口（宿主自己包一层路由、想回同样形状时用同一份）。
export { NonRetryableError, isNonRetryableError, summarizeErrorCause } from './lib/errors.js';
// Schema 自查 / 补齐：升级后老部署的表没跟上时，cron 会每分钟静默挂在缺的那
// 一列上（见 lib/schema-version.js）。
export { getSchemaVersion, ensureSchema, SCHEMA_VERSION } from './lib/schema-version.js';
// agentic 循环的默认预算——包装层要对齐自己的档位时 import 这一份，别各写各的。
export {
  DEFAULT_MAX_TOOL_ITERATIONS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  DEFAULT_MAX_SCHEDULED_TASKS_PER_FIRE,
  MIN_SCHEDULE_LEAD_MS,
} from './lib/agentic-fire.js';
// 单用户 worker 的 CORS 允许头/方法列表（外层再包路由的宿主 import 这一份，
// 别手抄第二份）。
export { CORS_ALLOW_HEADERS, CORS_ALLOW_METHODS } from './cloudflare/single-user-worker.js';
export {
  createWebCryptoWebPush,
  measurePushPayload,
  MAX_PUSH_PAYLOAD_BYTES,
  PUSH_ENVELOPE_RESERVED_BYTES,
  WEB_PUSH_MAX_BODY_BYTES,
  WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES,
} from './lib/webpush-webcrypto.js';
export { createSingleUserCloudflareWorker } from './cloudflare/single-user-worker.js';
export { deriveUserEncryptionKey, decryptPayload, encryptForStorage, decryptFromStorage } from './lib/encryption.js';
export { validateScheduleMessagePayload, validateLlmMessagesArray, validateSplitPattern, validateAvatarUrl, isValidISO8601, isValidUrl, isValidUUID, isValidUUIDv4, isValidTimeZoneId } from './lib/validation.js';
export { advanceOccurrence, nextFutureOccurrence, planNextOccurrence } from './lib/recurrence.js';
export { createTenantToken, verifyTenantToken } from './tenant/token.js';
