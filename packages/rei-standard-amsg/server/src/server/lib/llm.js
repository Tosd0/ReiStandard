/**
 * OpenAI-compatible LLM call for the server-side fire chain.
 *
 * Extracted from message-processor.js so the agentic fire loop
 * (lib/agentic-fire.js) can call the LLM without a circular import.
 * The legacy single-shot path (processSingleMessage) and the multi-round
 * loop share this one function.
 *
 * 实现已收敛到 `@rei-standard/amsg-shared` 的 `llm-call` 模块（instant
 * 与 server 共用同一份「构造请求体 + fetch + 超时 + 解析响应 + trim」
 * 核心），本文件只保留 server 侧的导出名。shared 的默认 options 即
 * server 语义：不带 `stream` 字段、转发 payload.tools / toolChoice、
 * `requireContent` 默认 true、`timeoutMs` 默认 300000（agentic 循环传
 * 剩余墙钟预算，见 lib/agentic-fire.js）。
 *
 * server 侧只多做一件事：上游明确拒了这次请求（401 / 403 / 400 …）时，给
 * 抛出来的错误标上 `permanent: true`，投递侧据此一跳终审、不再把整条生成重跑
 * 几遍（口径见 lib/errors.js 的 isPermanentLlmFailure）。标在这里而不是
 * shared：amsg-instant 也用那份 callLlm，它有自己的失败语义。
 *
 * `buildAiRequestBody` 是 shared `buildLlmRequestBody` 的 server 侧
 * 别名（历史导出名，测试与文档都钉着它）。
 */

import { callLlm as callSharedLlm } from '@rei-standard/amsg-shared';
import { markPermanentIfLlmRejected } from './errors.js';

/**
 * 与 shared 的 callLlm 同签名、同返回值；失败时抛出的错误若是「上游拒了、重试
 * 也不会好」的那一类，会多带 `permanent: true`。
 *
 * @param {Object} payload
 * @param {Object} [options]
 * @returns {Promise<{ response: unknown, content: string }>}
 */
export async function callLlm(payload, options) {
  try {
    return await callSharedLlm(payload, options);
  } catch (error) {
    throw markPermanentIfLlmRejected(error);
  }
}

export {
  buildLlmRequestBody as buildAiRequestBody,
  normalizeAiApiUrl,
} from '@rei-standard/amsg-shared';
