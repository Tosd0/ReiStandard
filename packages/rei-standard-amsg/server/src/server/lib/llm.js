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
 * `buildAiRequestBody` 是 shared `buildLlmRequestBody` 的 server 侧
 * 别名（历史导出名，测试与文档都钉着它）。
 */

export {
  callLlm,
  buildLlmRequestBody as buildAiRequestBody,
  normalizeAiApiUrl,
} from '@rei-standard/amsg-shared';
