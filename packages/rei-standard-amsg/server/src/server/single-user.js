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
 * @param {Object} [config.hooks] - optional fire-time hooks (see lib/agentic-fire.js):
 *   { onBeforeFire, onLLMOutput, executeToolCalls }. When omitted, AI tasks
 *   replay the schedule-time frozen prompt (legacy behavior, unchanged).
 * @param {number} [config.maxToolIterations] - factory default LLM-round cap for the agentic loop (default 5).
 * @param {number} [config.totalTimeoutMs] - factory default wall-time ceiling for the agentic loop (default 240000).
 * @param {number} [config.maxStateValueBytes] - client_state 单条 value 的总上限（默认 5MB）。超过 200KB 的值由服务端透明分块存储（见 lib/state-chunks.js）。
 * @returns {{ handlers: Object, ctx: Object }}
 */

import { createSingleUserContextManager } from './tenant/single-user-context.js';
import { createSingleUserInitHandler } from './handlers/single-user-init.js';
import { createGetUserKeyHandler } from './handlers/get-user-key.js';
import { createScheduleMessageHandler } from './handlers/schedule-message.js';
import { createUpdateMessageHandler } from './handlers/update-message.js';
import { createCancelMessageHandler } from './handlers/cancel-message.js';
import { createMessagesHandler } from './handlers/messages.js';
import { createVapidPublicKeyHandler } from './handlers/vapid-public-key.js';
import { createClientStateHandler } from './handlers/client-state.js';
import { createCapabilitiesHandler } from './handlers/capabilities.js';

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
    tenantManager,
    // Fire-time hooks (optional): the in-server instant path fires through
    // processMessagesByUuid with this ctx, so instant-type tasks can take
    // the agentic path too.
    hooks: config.hooks || null,
    maxToolIterations: config.maxToolIterations,
    totalTimeoutMs: config.totalTimeoutMs,
    maxStateValueBytes: config.maxStateValueBytes
  };

  return {
    ctx,
    handlers: {
      init: createSingleUserInitHandler(ctx),
      getUserKey: createGetUserKeyHandler(ctx),
      scheduleMessage: createScheduleMessageHandler(ctx),
      updateMessage: createUpdateMessageHandler(ctx),
      cancelMessage: createCancelMessageHandler(ctx),
      messages: createMessagesHandler(ctx),
      vapidPublicKey: createVapidPublicKeyHandler(ctx),
      clientState: createClientStateHandler(ctx),
      capabilities: createCapabilitiesHandler(ctx)
    }
  };
}
