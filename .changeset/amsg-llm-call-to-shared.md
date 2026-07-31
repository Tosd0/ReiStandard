---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-instant": patch
"@rei-standard/amsg-server": patch
---

LLM 调用器收敛到 shared：新模块 `shared/src/llm-call.js` 承载「构造请求体 + fetch + 超时 + 解析响应 + trim」的公共核心，从包根导出 `callLlm` / `buildLlmRequestBody` / `normalizeAiApiUrl`

此前 instant（`message-processor.js` 的 `callLlmRaw`）与 server（`lib/llm.js` 的 `callLlm`）各写一份 LLM HTTP 调用，已出现漂移（stream 字段、messages 模式探测、超时可配性、trim 位置）。现在单一来源在 shared，两侧差异走 options 参数化（`stream` / `forwardTools` / `timeoutMs` / `fetch` / `requireContent`），instant 与 server 的调用点改薄，各自的导出名（instant 的 `normalizeAiApiUrl`、server 的 `callLlm` / `buildAiRequestBody` / `normalizeAiApiUrl`）与错误码包装不变。`llm.js` 里「两包各自拷贝以避免架构依赖」的过期注释一并删除——两包都已依赖 shared，该理由不再成立。

行为变化（均为边缘修正）：

- instant：messages 模式探测统一为 `Array.isArray(payload.messages) && payload.messages.length > 0`（server 语义）。`messages: []` 从「把空数组原样发给上游 LLM」改为「回退 completePrompt 模式」——这是修正错误行为。经公开 handler 不可触达（校验层已拒绝空 messages），仅影响直接调用 `processInstantMessage` 的调用方。
- instant：`maxTokens` 非法时的错误文案统一为 server 措辞（`Invalid maxTokens: maxTokens must be a positive integer when provided.`）。handler 校验在前，正常路径不可触达。
- server：`normalizeAiApiUrl` 对非字符串输入统一为 instant 的宽松语义（先 `String()` 强转再解析；此前直接抛「apiUrl is required」）。字符串输入两侧行为本就一致，不受影响。
- server：`callLlm` 现接受额外 options（`fetch` / `stream` / `forwardTools`），默认值即原 server 语义，既有调用不受影响。
