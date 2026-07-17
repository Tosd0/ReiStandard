---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-instant": patch
---

amsg-shared 新增 agentic 循环契约工具：`buildSessionContext`、`extractAssistantMessage`、`assertValidDecision`（新增 `inlineToolCalls` 选项，允许 `tool-request` 直接携带 `toolCalls`，供服务端就地执行工具的场景用）、`extractToolCallsFromDecision`。amsg-instant 的 SessionContext 构建与 decision 校验改为从 amsg-shared 复用同一实现，对外行为与错误信息不变。
