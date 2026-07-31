---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-instant": patch
"@rei-standard/amsg-server": patch
---

messages 数组形状校验统一到 amsg-shared，修复 amsg-server 误拒 agentic 会话的 bug。

- amsg-shared 新增 `validateLlmMessagesShape(messages)` 与 `LLM_MESSAGES_ERROR` 错误码常量（新模块 `src/llm-messages.js`）：返回结构化错误（稳定 code + 定位索引），支持 assistant 带 `tool_calls` 时 content 可空、`role:'tool'` 要求 `tool_call_id` 的 OpenAI 协议形状。
- amsg-instant 的 `validateMessagesArray` 改为调用 shared 实现的薄封装，导出名、错误文案与返回形状不变。
- amsg-server 的 `validateLlmMessagesArray` 同样改为调用 shared 实现。修复：此前该函数缺少 tool_calls / tool 消息分支，注释却声称与 amsg-instant lockstep，导致 agentic 会话（assistant tool_calls + tool 结果）回放到 `scheduleMessage` / `updateMessage` 会被 400 拒绝；现在与 amsg-instant 接受完全相同的形状。畸形 tool 消息新增对应英文错误文案（`tool_calls[j] is malformed` / `tool_call_id is required` 等）。
