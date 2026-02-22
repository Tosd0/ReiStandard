/**
 * ReiStandard Server SDK Entry Point
 * v1.1.0
 *
 * Usage:
 *   import { createReiServer } from '@rei-standard/amsg-server';
 *
 *   const rei = createReiServer({
 *     db: { driver: 'neon', connectionString: process.env.DATABASE_URL },
 *     encryptionKey: process.env.ENCRYPTION_KEY,
 *     cronSecret: process.env.CRON_SECRET,
 *     vapid: {
 *       email: process.env.VAPID_EMAIL,
 *       publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
 *       privateKey: process.env.VAPID_PRIVATE_KEY,
 *     },
 *     initSecret: process.env.INIT_SECRET,
 *   });
 *
 *   // rei.handlers  – object with 7 route handler factories
 *   // rei.adapter   – the underlying database adapter
 */

import { createAdapter } from './adapters/factory.js';
import { createInitDatabaseHandler } from './handlers/init-database.js';
import { createGetMasterKeyHandler } from './handlers/get-master-key.js';
import { createScheduleMessageHandler } from './handlers/schedule-message.js';
import { createSendNotificationsHandler } from './handlers/send-notifications.js';
import { createUpdateMessageHandler } from './handlers/update-message.js';
import { createCancelMessageHandler } from './handlers/cancel-message.js';
import { createMessagesHandler } from './handlers/messages.js';

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
 * @typedef {'neon'|'pg'} DriverName
 */

/**
 * @typedef {Object} DbConfig
 * @property {DriverName} driver           - Database driver name.
 * @property {string}     connectionString - Database connection URL.
 */

/**
 * @typedef {Object} ReiServerConfig
 * @property {DbConfig}    db            - Database configuration.
 * @property {string}      encryptionKey - 64-char hex master encryption key.
 * @property {string}      [cronSecret]  - Bearer token for cron-triggered endpoints.
 * @property {VapidConfig} [vapid]       - VAPID keys for Web Push.
 * @property {string}      [initSecret]  - Bearer token for the init-database endpoint.
 */

/**
 * @typedef {Object} ReiHandlers
 * @property {{ GET: function, POST: function }} initDatabase
 * @property {{ GET: function }} getMasterKey
 * @property {{ POST: function }} scheduleMessage
 * @property {{ POST: function }} sendNotifications
 * @property {{ PUT: function }} updateMessage
 * @property {{ DELETE: function }} cancelMessage
 * @property {{ GET: function }} messages
 */

/**
 * @typedef {Object} ReiServer
 * @property {ReiHandlers} handlers - The 7 standard API route handler objects.
 * @property {import('./adapters/interface.js').DbAdapter} adapter - The database adapter instance.
 */

/**
 * Initialise the ReiStandard server.
 *
 * @param {ReiServerConfig} config
 * @returns {Promise<ReiServer>}
 */
export async function createReiServer(config) {
  if (!config) throw new Error('[rei-standard-amsg-server] config is required');
  if (!config.encryptionKey) throw new Error('[rei-standard-amsg-server] encryptionKey is required');

  const adapter = await createAdapter(config.db);

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

  /** @type {Object} Shared context injected into every handler */
  const ctx = {
    db: adapter,
    encryptionKey: config.encryptionKey,
    cronSecret: config.cronSecret || '',
    initSecret: config.initSecret || '',
    vapid: {
      email: vapid.email || '',
      publicKey: vapid.publicKey || '',
      privateKey: vapid.privateKey || ''
    },
    webpush: webpushModule
  };

  return {
    handlers: {
      initDatabase: createInitDatabaseHandler(ctx),
      getMasterKey: createGetMasterKeyHandler(ctx),
      scheduleMessage: createScheduleMessageHandler(ctx),
      sendNotifications: createSendNotificationsHandler(ctx),
      updateMessage: createUpdateMessageHandler(ctx),
      cancelMessage: createCancelMessageHandler(ctx),
      messages: createMessagesHandler(ctx)
    },
    adapter
  };
}

// Re-export utilities that consumers may need
export { createAdapter } from './adapters/factory.js';
export { deriveUserEncryptionKey, decryptPayload, encryptForStorage, decryptFromStorage } from './lib/encryption.js';
export { validateScheduleMessagePayload, isValidISO8601, isValidUrl, isValidUUID } from './lib/validation.js';
