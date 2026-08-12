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
 * @param {{ maxChunkBytes?: number, maxChunks?: number, maxTotalBytes?: number, ttlMs?: number }} [config.multipart]
 *   分片传输的限额，跟传给 `installReiSW` 的那一份保持一致（同名同键，原样传过来
 *   即可）。一条 push 装不下的思考过程要切片发，切多大、最多几片、重组窗口多长由
 *   接收端说了算——发送端不知道这份配置的话，切出来的分片到了那边会被逐片拒收，
 *   或者整批没能在重组窗口内发完，一条也拼不回来。不配 = 两边都用默认值。
 * @param {Object} [config.hooks] - optional fire-time hooks (see lib/agentic-fire.js):
 *   { onBeforeFire, onLLMOutput, executeToolCalls }. When omitted, AI tasks
 *   replay the schedule-time frozen prompt (legacy behavior, unchanged).
 * @param {number} [config.maxToolIterations] - factory default LLM-round cap for the agentic loop (default 5).
 * @param {number} [config.totalTimeoutMs] - factory default wall-time ceiling for the agentic loop (default 240000).
 * @param {number} [config.maxStateValueBytes] - client_state 单条 value 的总上限（默认 5MB）。超过 200KB 的值由服务端透明分块存储（见 lib/state-chunks.js）。
 * @param {number} [config.maxScheduledTasksPerFire] - 一次 fire 里 hook 用 ctx.scheduleTask() 最多能建几条后续任务（默认 2，0 表示不许自排）。
 * @param {function} [config.onAfterSend] - 推送发出（或发挂）之后的可选 hook：
 *   ({ task, sentCount, total, error, scratch, readState, writeState }) =>
 *   void|Promise。task 是任务行本身（并发投递时靠它区分回执属于哪条任务）；
 *   scratch 是本次 fire 的便签对象，与 onBeforeFire / onLLMOutput 拿到的是同
 *   一个引用；readState / writeState 是 client_state 的读写口。全部成功
 *   error 为 null；第 k 段失败时 sentCount = k、error 带原始错误，且在错误往
 *   上抛之前调用完。hook 自身抛错只记日志，不影响主流程（见
 *   lib/agentic-fire.js）。
 * @param {function} [config.onFireSettled] - 一次 fire 收尾的可选 hook：
 *   ({ task, status, skipReason, sentCount, total, iterations, error,
 *   scratch, readState, writeState }) => void|Promise。onBeforeFire 被调用过
 *   就一定会调一次，无论这次是发完（status 'sent'）、跳过（'skipped'）、抛错
 *   （'failed'）还是交还给冻结 prompt 老链路（'not-handled'）。onAfterSend 只
 *   走「有 push 要发」那条路，「开始时占点什么、结束时放掉」的写法挂这个才不
 *   会漏（见 lib/agentic-fire.js）。
 * @returns {{ handlers: Object, ctx: Object }}
 */

import { createSingleUserContextManager } from './tenant/single-user-context.js';
import { createSingleUserInitHandler } from './handlers/single-user-init.js';
import { createGetUserKeyHandler } from './handlers/get-user-key.js';
import { createScheduleMessageHandler } from './handlers/schedule-message.js';
import { createUpdateMessageHandler } from './handlers/update-message.js';
import { createCancelMessageHandler } from './handlers/cancel-message.js';
import { createMessagesHandler } from './handlers/messages.js';
import { createGetMessageHandler } from './handlers/get-message.js';
import { createVapidPublicKeyHandler } from './handlers/vapid-public-key.js';
import { createClientStateHandler } from './handlers/client-state.js';
import { createPushSubscriptionHandler } from './handlers/push-subscription.js';
import { createLlmCredentialsHandler } from './handlers/llm-credentials.js';
import { createCapabilitiesHandler } from './handlers/capabilities.js';
import { createOutboxHandler } from './handlers/outbox.js';

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
    // 分片传输的限额（与 installReiSW 的 multipart 同一份）。instant 消息也走
    // 这个 ctx 发，所以它要跟着 handlers 一起进来。
    multipart: config.multipart || null,
    tenantManager,
    // Fire-time hooks (optional): the in-server instant path fires through
    // processMessagesByUuid with this ctx, so instant-type tasks can take
    // the agentic path too.
    hooks: config.hooks || null,
    maxToolIterations: config.maxToolIterations,
    totalTimeoutMs: config.totalTimeoutMs,
    maxStateValueBytes: config.maxStateValueBytes,
    // 推送发出（或发挂）之后的 hook（见 lib/agentic-fire.js 的 notifyAfterSend）。
    onAfterSend: config.onAfterSend,
    // 一次 fire 收尾的 hook，什么结局都会调一次（见 lib/agentic-fire.js 的
    // notifyFireSettled）。
    onFireSettled: config.onFireSettled,
    // hook 的 ctx.scheduleTask() 单次 fire 建任务的条数上限（默认 2）。
    maxScheduledTasksPerFire: config.maxScheduledTasksPerFire
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
      getMessage: createGetMessageHandler(ctx),
      vapidPublicKey: createVapidPublicKeyHandler(ctx),
      clientState: createClientStateHandler(ctx),
      pushSubscription: createPushSubscriptionHandler(ctx),
      llmCredentials: createLlmCredentialsHandler(ctx),
      capabilities: createCapabilitiesHandler(ctx),
      outbox: createOutboxHandler(ctx)
    }
  };
}
