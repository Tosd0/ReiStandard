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
import { createLlmCredentialsHandler } from './handlers/llm-credentials.js';
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
 * @property {{ maxChunkBytes?: number, maxChunks?: number, maxTotalBytes?: number, ttlMs?: number }} [multipart]
 *   分片传输的限额，跟传给 `installReiSW` 的那一份保持一致（同名同键，原样传过来
 *   即可）。一条 push 装不下的思考过程要切片发，切多大、最多几片、重组窗口多长由
 *   接收端说了算——发送端不知道这份配置的话，切出来的分片到了那边会被逐片拒收，
 *   或者整批没能在重组窗口内发完，一条也拼不回来。不配 = 两边都用默认值。
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
 * @property {{ PUT: function, GET: function, DELETE: function }} llmCredentials
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
    // 分片传输的限额（与 installReiSW 的 multipart 同一份）。instant 消息在
    // schedule-message 里就地投递、定时消息走 send-notifications 的 tick，两条路
    // 都从这个 ctx 展开，所以配一次两边都认。
    multipart: config.multipart || null,
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
      pushSubscription: createPushSubscriptionHandler(ctx),
      llmCredentials: createLlmCredentialsHandler(ctx)
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
// 阶梯（见 lib/errors.js）。DeploymentConfigError 是它旁边那一档——坏的是整个
// 部署而不是这条任务，照旧走退避阶梯，配置修好后还在阶梯上的任务能自己发出去。
// summarizeErrorCause 是 500 响应体里 error.cause 的组装口（宿主自己包一层路
// 由、想回同样形状时用同一份）。
export {
  NonRetryableError,
  DeploymentConfigError,
  isNonRetryableError,
  summarizeErrorCause,
} from './lib/errors.js';
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
// 请求正文的读取口（`Content-Encoding: gzip` 在这一步还原）。自己包路由的宿主
// 用它代替 `await request.text()`，压缩请求体就跟单用户 Worker 一样自动认。
export { readRequestBody, DEFAULT_MAX_REQUEST_BODY_BYTES } from './lib/request.js';
// 一条任务正文的明文字节上限（超了 POST /schedule-message、PUT /update-message
// 回 400 TASK_PAYLOAD_TOO_LARGE）。客户端想在提交前自己预算就读这一份，别手抄
// 第二个数——它是按 D1 的单行上限反推出来的，见 lib/validation.js。
export { MAX_TASK_PAYLOAD_BYTES } from './lib/validation.js';
// 用户级 LLM 凭据存储（llm_credentials 表；任务 payload 的 credRefs 引用它）。
// 自定义适配器 / 自己包路由的宿主用得到校验和解析口。
export {
  supportsLlmCredentialsStore,
  isValidCredId,
  validateCredRefs,
  validateCredValue,
  hasChatCredRef,
  resolveLlmCredential,
  CRED_ID_MAX_LENGTH,
  CRED_PUT_BATCH_MAX,
  CRED_ROWS_PER_USER_MAX,
  CRED_REFS_MAX_ENTRIES,
} from './lib/llm-credentials-store.js';
export { advanceOccurrence, nextFutureOccurrence, planNextOccurrence } from './lib/recurrence.js';
export { createTenantToken, verifyTenantToken } from './tenant/token.js';
