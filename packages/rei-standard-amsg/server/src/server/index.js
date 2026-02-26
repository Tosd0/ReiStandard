/**
 * ReiStandard Server SDK Entry Point
 * v2.0.1
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
import { createTenantBlobStore } from './tenant/blob-store.js';
import { createTenantContextManager } from './tenant/context.js';

function normalizeVapidSubject(email) {
  const trimmedEmail = String(email || '').trim();
  if (!trimmedEmail) return '';
  return /^mailto:/i.test(trimmedEmail) ? trimmedEmail : `mailto:${trimmedEmail}`;
}

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
      messages: createMessagesHandler(ctx)
    }
  };
}

// Re-export utilities that consumers may need
export { createAdapter } from './adapters/factory.js';
export { deriveUserEncryptionKey, decryptPayload, encryptForStorage, decryptFromStorage } from './lib/encryption.js';
export { validateScheduleMessagePayload, isValidISO8601, isValidUrl, isValidUUID, isValidUUIDv4 } from './lib/validation.js';
export { createTenantToken, verifyTenantToken } from './tenant/token.js';
