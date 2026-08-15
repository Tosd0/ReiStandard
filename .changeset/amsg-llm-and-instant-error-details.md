---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-instant": minor
"@rei-standard/amsg-server": patch
---

LLM 上游拒了请求时能看到它到底说了什么，推送失败时能看到推送服务回的状态码

**LLM 调用失败：上游的错误响应体不再被丢掉**

上游回非 2xx 时，原来只拿状态行拼一句 `AI API error: 400 Bad Request. Request URL: https://…/chat/completions` 就抛，响应体从来没读过。而「模型名写错、余额不够、上下文超长、被内容审核拦下」这些区别全在那份响应体里，状态行一律只说 400。定时任务的用户看到的是 `GET /message` 里那句话，instant 的调用方看到的是 502 里同一句话，谁都查不出原因，只能等三轮重试白跑十几分钟。

现在这份响应体会读出来，说明文字接在原来那句后面，格式跟推送失败那边一致：

```
AI API error: 401 Unauthorized. Request URL: https://api.example.com/v1/chat/completions
  — Incorrect API key provided: sk-[redacted]. (provider code: invalid_api_key)
```

各家的错误体形状不一样，按「先找最精确的、找不到退一层」取：OpenAI / Azure 与多数中转的 `{ error: { message, type, code } }`、Anthropic 的 `{ error: { type, message } }`、Gemini 的 `{ error: { message, status } }`，都认；反代挂掉回的 HTML 错误页、纯文本这类解析不了的，原文照抄。

外传之前会先脱敏再截断：长得像 API Key 的串遮成 `[redacted]`（上游报错很爱把 Key 原样抄回来），说明文字截到 300 字符（内容审核类的报错常把整段请求内容回显回来）。读响应体这一步自己失败了也不影响报错，只是少了说明。

`@rei-standard/amsg-server` 不用改代码就一起受益：任务的失败记录里，`reason` 带上了上游的原话，`errorCode` 现在是 `LLM_CALL_FAILED`（原来这一类失败的 `errorCode` 是 `null`），「这一跳是 LLM 挂了还是推送挂了」不用读那句人话也能分。

**`@rei-standard/amsg-instant`：失败信封里多了上游的状态码**

纯 Push 模式（`Accept: application/json`）下的错误信封，原来只有 `code` 和 `message`：

```jsonc
{ "success": false, "error": { "code": "PUSH_SEND_FAILED", "message": "Web Push delivery failed: 410 Gone — …" } }
```

订阅已经失效（410 / 404）和推送服务临时抽风（5xx）在这里长得一模一样，要分开只能拿正则去 `message` 里捞那个数字。而前者重发多少次都是同一个结果，instant 又是先跑 LLM 再推送，每次重试都把整轮生成重跑一遍。

现在信封里按上游分别带上状态码，`onEvent` 的 `error` 事件也带同一份：

```jsonc
// 推送失败：410 / 404 = 这份订阅没了，该让用户重新订阅，不是重试
{ "success": false, "error": { "code": "PUSH_SEND_FAILED", "message": "…", "pushStatus": 410 } }

// LLM 失败：llmStatus 是上游回的状态码，providerCode 是 provider 自己的错误码
{ "success": false, "error": { "code": "LLM_CALL_FAILED", "message": "…",
                               "llmStatus": 401, "providerCode": "invalid_api_key" } }
```

`pushStatus` 与 `@rei-standard/amsg-server` 记进 `lastError` 的字段同名同义，两个包的告警规则能照抄一份。`llmStatus` / `providerCode` 只在上游确实答复了时才有——网络直接炸、超时的时候不会出现，据此也能分清「上游拒了」和「根本没连上」。

三条路带的是同一组字段：JSON 信封挂在 `error` 对象上，SSE 的 `event: error` 和掉线兜底的 Web Push 挂在 `ErrorPush` 顶层，`onEvent` 的 `error` 事件也带。SSE 是默认传输方式，只给信封那条路的话，浏览器客户端遇到 Key 失效仍然只能回去正则匹配那句人话。`ErrorPush` 的类型定义随之多了可选的 `llmStatus` / `providerCode`。

HTTP 状态码没变，这类失败仍然是 502：`error.code` 是这个包对外承诺的分流依据，改状态码会把按 502 分支的老调用方一起打掉，而信息量并不比新字段多。要不要重试读 `error.pushStatus` 就够。

错误响应体最多读开头 16 KB 就把流断开。错误信封（`{"error":{"message":…}}`）永远在最前面，而中转出问题时能把整个请求体回显回来——任务正文上限接近 1 MB，一次网关故障把一批任务同时打挂时，这些只为留 300 字符而读进来的整段文本会一起压在 Worker 的内存上限上。

被这个上限切出来的前缀不是合法 JSON，严格解析必然失败，所以这种情况下会从残缺前缀里把 `message` / `detail` / `code` / `status` / `type` 这几个字段扫出来（同名只取第一个——错误信封在最前面，后面重复出现的多半来自被回显的请求）。一个都捞不到时给一句「响应体被截断了」的说明，而不是把一大段裸 JSON 当上游原话外传。非 JSON 的响应体（反代的 HTML 错误页、纯文本）行为不变，原文照抄。
