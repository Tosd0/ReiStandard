---
"@rei-standard/amsg-server": minor
---

fire 循环支持声明工具：`onBeforeFire` 的返回值可以带 `tools`

- `onBeforeFire` 返回对象时新增两个可选字段：`tools`（OpenAI 的 tools 数组）和 `toolChoice`。本次 fire 的每一轮 LLM 请求都会原样带上它们——补完那轮模型仍可能再发起调用，所以不是只带第一轮。此前循环只做了协议的下半场（给 assistant 补 tool_calls、配对 `role:'tool'` 结果），请求体这半边没有出口，宿主没有办法让模型走原生 function calling。库不解析 tools 的内容，执行仍然是 `executeToolCalls` 的事。
- `tools` 是空数组时不进请求体：部分 OpenAI 兼容中转把 `tools: []` 当协议错误直接拒掉。
- `GET /capabilities` 的 features 随之多一个 `agentic-fire-tools`，前端可以据此判断 worker 部署版本认不认这条链路。
- 修掉 assistant 补章的一个问题：模型自带的 tool_calls 与文本协议合成的调用同轮出现时，两边的 id 现在合并起来一起写在 assistant 上。此前只保留其中一边，另一边的 `role:'tool'` 结果就没有归属的 `tool_call_id`，严格的中转会拒掉下一轮请求。
