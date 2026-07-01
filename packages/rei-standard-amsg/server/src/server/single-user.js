/**
 * Single-user ReiStandard server assembly.
 *
 * Same shape as createReiServer ({ handlers }), but wired for a single user:
 *   - tenant context comes from createSingleUserContextManager (db + masterKey
 *     supplied by the caller; no blob registry, no tenant token)
 *   - only the 5 business handlers + an idempotent init route are exposed
 *   - send-notifications is NOT exposed over HTTP (cron runs via CF scheduled())
 *
 * @param {Object} config
 * @param {import('./adapters/interface.js').DbAdapter} config.db
 * @param {string} config.masterKey
 * @param {string} [config.serverToken]  - optional shared secret (X-Client-Token)
 * @param {{ email?: string, publicKey?: string, privateKey?: string }} [config.vapid]
 * @param {{ sendNotification: function }} [config.webpush] - web-push-compatible sender
 * @returns {{ handlers: Object, ctx: Object }}
 */

import { createSingleUserContextManager } from './tenant/single-user-context.js';
import { createSingleUserInitHandler } from './handlers/single-user-init.js';
import { createGetUserKeyHandler } from './handlers/get-user-key.js';
import { createScheduleMessageHandler } from './handlers/schedule-message.js';
import { createUpdateMessageHandler } from './handlers/update-message.js';
import { createCancelMessageHandler } from './handlers/cancel-message.js';
import { createMessagesHandler } from './handlers/messages.js';

export function createSingleUserServer(config) {
  if (!config || !config.db) throw new Error('[amsg-server single-user] config.db is required');
  if (!config.masterKey) throw new Error('[amsg-server single-user] config.masterKey is required');

  const vapid = config.vapid || {};
  const tenantManager = createSingleUserContextManager({
    db: config.db,
    masterKey: config.masterKey,
    serverToken: config.serverToken
  });

  const ctx = {
    vapid: {
      email: vapid.email || '',
      publicKey: vapid.publicKey || '',
      privateKey: vapid.privateKey || ''
    },
    webpush: config.webpush || null,
    tenantManager
  };

  return {
    ctx,
    handlers: {
      init: createSingleUserInitHandler(ctx),
      getUserKey: createGetUserKeyHandler(ctx),
      scheduleMessage: createScheduleMessageHandler(ctx),
      updateMessage: createUpdateMessageHandler(ctx),
      cancelMessage: createCancelMessageHandler(ctx),
      messages: createMessagesHandler(ctx)
    }
  };
}
