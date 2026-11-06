---
"@rei-standard/amsg-instant": minor
---

请求体有了 32 MiB 上限；`pushSubscription` 在入口处校验；推送失败的信封带上第几条失败

**1. 请求体上限 32 MiB，超限回 `413 REQUEST_BODY_TOO_LARGE`**

带 `X-Amsg-Request-Encoding: gzip` 的请求，压缩前的字节数和解压后的字节数各自计，任一超过 32 MiB 就回 413，`details.maxBytes` 是上限字节数。解压是边读边数，超限当场停，不会把整份展开的数据先读进内存。`adapters/node` 读到的原始请求体超过同一上限也回 413。没压缩的请求体在 Cloudflare Workers / Vercel Edge / Netlify 上仍由平台自己的上限管。

新导出 `RequestBodyTooLargeError`（`code: 'REQUEST_BODY_TOO_LARGE'`，带 `maxBytes`）和 `MAX_REQUEST_BODY_BYTES`。

**2. `pushSubscription` 在 `/instant` 和 `/continue` 入口处校验**

`endpoint` 必须是不带凭据的 https URL：`http://`、`localhost`、`*.localhost`、IP 字面量、URL 里带用户名或密码的都拒。`keys.p256dh` / `keys.auth` 必填且为非空字符串。不合格回 `400 INVALID_PAYLOAD_FORMAT`，`details.invalidFields` 指出字段（整个对象缺失时是 `details.missingFields`）。这样不用等整轮 LLM 跑完才在推送那一步失败。

**3. `PUSH_SEND_FAILED` 的 `message` 经脱敏与截断，新增 `failedMessageIndex`**

推送服务回的原文先遮掉像 API Key / Bearer token 的串，再截到 300 字符。`failedMessageIndex`（1-based）指出失败的是本次投递的第几条，JSON 信封、`onEvent` 的 `error` 事件、SSE 的 `event: error` 三处都带。

**4. SSE 下 hook 返回不可 JSON 序列化的 push 时，客户端收到 `event: error`**

这种情况现在会以 `code: 'HOOK_THREW'` 的 `event: error` 结束流，不再是流直接断掉。`onLLMOutput` 抛错 / 返回非法 decision 时的行为不变：诊断 ErrorPush 已经作为 `event: payload` 送出，不重复发 `event: error`。

**5. 配置校验与并发**

- `blobStore.maxInlineBytes` 超过单条 push 明文上限 3993 字节时，`createInstantHandler` 当场抛 `TypeError`，不再留到投递时被推送服务 413 拒收。
- SSE 的 Web Push backup 同一条流内同一时刻最多 4 条在飞，其余排队，总数不变。Workers 对同时打开的出站连接有上限，长回复一口气几十条会排队甚至失败。

**6. LLM messages 的 `role` 接受 `developer`**

合法集合是 `system / developer / user / assistant / tool`。

**7. Node 版本要求 ≥ 20.3.0**

`package.json` 的 `engines` 定为 `node >= 20.3.0`。
