/**
 * Handler: capabilities
 *
 * GET /capabilities → { success, serverVersion, features }。前端用它做特性
 * 探测：worker 部署版本落后时，新链路只是「探测不到」（而不是静默失效），
 * 设置页可以据此提示重新部署 worker。老部署没有这个路由 → 404，客户端 SDK
 * 的 getCapabilities() 把 404 归一成 null。
 *
 * features 表达「这份代码支持什么」，随版本静态演进追加；不反映部署配置——
 * 例如 'agentic-hooks' 表示该版本认识 fire-time hooks，宿主配没配 hooks 不
 * 影响它出现。
 *
 * 鉴权与 /vapid-public-key 同待遇：走 resolveTenant，配置 serverToken 后同样
 * 要求 X-Client-Token。
 */

import { SERVER_VERSION } from '../lib/version.js';

export const SERVER_FEATURES = Object.freeze([
  'client-state',
  'client-state-chunking',
  'client-state-partial-failure',
  'agentic-hooks',
  'agentic-scratch',
  'agentic-write-state',
  'agentic-fire-tools',
  'agentic-schedule-task',
  'vapid-public-key',
  'tick-stale-guard',
  'recurring-skip-occurrence',
  'occurrence-scoped-push-ids',
  'after-send-hook',
  'update-message-credentials',
  // config 级 hook（onAfterSend / onStaleSkip）的载荷带 readState / writeState。
  'hook-state-accessors',
  // onAfterSend 的载荷带本次 fire 的 scratch（与 onBeforeFire / onLLMOutput 同一个引用）。
  'after-send-scratch',
  // onLLMOutput / executeToolCalls 的 ctx 带 taskId / taskUuid / occurrenceMs。
  'fire-task-identity',
  // 每条 push 顶层带 taskId / taskUuid / recurrenceType / occurrenceMs。
  'push-task-identity',
  // 导出 PUSH_ENVELOPE_RESERVED_BYTES：库补完信封字段之后的额度。
  'push-envelope-reserved-bytes',
  // scheduleTask 撞 uuid 时回已存在任务行的投影（{ created:false, …, task }）。
  'schedule-task-duplicate-row',
  // 循环任务过期快进也调 onStaleSkip、也写 lastError。
  'recurring-stale-skip-hook',
  // 任务行支持 tzId：daily / weekly 按该时区的墙钟推进。
  'task-timezone',
  // 推送订阅是用户级的一份（PUT/GET/DELETE /push-subscription），任务不携带。
  'user-push-subscription',
  // GET /message?id=<uuid>：单条任务，带完整 metadata（列表只给两个子字段）。
  'get-message-detail',
  // PUT /update-message 认 contactName（改了角色名之后旧任务的通知标题跟着改）。
  'update-message-contact-name',
  // runScheduledTick 认 serializeBy：同一分组的任务同时只跑一条，跨跳也算。
  'tick-serialize-by',
  // 一次 fire 无论什么结局都调 onFireSettled（发完 / 跳过 / 抛错）。
  'fire-settled-hook',
]);

export function createCapabilitiesHandler(ctx) {
  async function GET(url, headers) {
    const effectiveHeaders = headers || url || {};
    const tenantResult = await ctx.tenantManager.resolveTenant(effectiveHeaders);
    if (!tenantResult.ok) {
      return tenantResult.error;
    }
    return {
      status: 200,
      body: { success: true, serverVersion: SERVER_VERSION, features: [...SERVER_FEATURES] },
    };
  }
  return { GET };
}
