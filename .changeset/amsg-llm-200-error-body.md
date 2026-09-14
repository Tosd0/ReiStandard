---
"@rei-standard/amsg-shared": patch
"@rei-standard/amsg-server": patch
"@rei-standard/amsg-instant": patch
---

中转站回 200 但响应体是报错时，按 LLM 调用失败处理，不再当成「模型这轮没说话」

不少中转站出错时照样回 HTTP 200，响应体里装的是 `{"error":{…}}` 或 `{"code":401,"msg":"…"}`，没有 `choices`。`callLlm` 现在只要拿到的 2xx 响应体解析不成 JSON，或者没有非空的 `choices` 数组，就抛上游错误，`requireContent` 取什么都一样：

```
AI API error: HTTP 200 but body is not a chat completion (no choices). Request URL: https://…/chat/completions
  — 当前分组上游负载已饱和，请稍后再试 (provider code: upstream_saturated)

AI API error: HTTP 200 but body is not valid JSON. Request URL: https://…/chat/completions
  — <html><title>Just a moment...</title></html>
```

错误上的机读字段跟非 2xx 那一类相同：`code` 是 `LLM_CALL_FAILED`，`llmStatus` 是上游实际回的 2xx 状态码（据此能分清「HTTP 就失败了」和「200 里装着报错」），`providerCode` 取响应体里的错误码。响应体里只有数字错误码时（`{"code":401,"msg":"…"}`），它会转成字符串放进 `providerCode`。说明文字的取法、脱敏和截断规则也跟非 2xx 一致。有两种情况不回显响应体内容，因为里面装的多半是模型生成的正文：响应体是 JSON 但一个报错字段都认不出时（比如 apiUrl 指到了非 OpenAI 格式的端点），只列出顶层字段名；中转站无视 `stream: false`、回了流式数据（SSE）时，只说明「回的是流」。

`choices` 在、只是 `content` 为空（模型只回了 tool_calls、被内容审核拦下）不算格式错误，行为不变。

各包的表现：

- `@rei-standard/amsg-server`：配了 fire-time hook 的任务（agentic 路径），这类响应之前会作为一轮空输出交给 `onLLMOutput`，通常被当成「没话说」跳过，任务算成功消费，失败原因一个字都不留；不走 hook 的单次调用之前会失败，但失败原因只有一句「缺 content」，看不到中转站说了什么。现在两条路都按普通的 LLM 调用失败处理：`last_error` 里记下中转站的原话，`errorCode` 是 `LLM_CALL_FAILED`，任务留在重试阶梯上。这跟 HTTP 401 / 5xx 这类 LLM 失败的处理一样，不会因为响应体里写着 401 就判成永久失败。
- `@rei-standard/amsg-instant`：agentic 路径之前会把这类响应当成一轮空回复交给 hook，legacy 路径只报一句没有上游原话的「缺 content」。现在两条路跟其他 LLM 调用失败一样回 502，错误信封带 `llmStatus` / `providerCode`。

非 2xx 的错误响应体也多认一种写法：最外层的 `msg` 字段（`{"code":…,"msg":"…"}`）会当作说明文字取出来，不再整段 JSON 原文照抄。
