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
