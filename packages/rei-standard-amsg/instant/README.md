# @rei-standard/amsg-instant

**零运行时依赖**的无状态明文一次性即时推送处理器：整个生命周期 = 一次 HTTP 函数调用（解析 → 调 LLM → 构造/切分 push payloads → 发 Web Push → 返回 200）。无数据库、无 cron、无租户初始化。从 0.3.0 起 RFC 8291 (`aes128gcm`) payload 加密和 RFC 8292 VAPID JWT 由内置实现完成，不再需要 `web-push` / Node `crypto`。

定位是**单租户自部署**场景下的极简 instant 推送：前端、Worker、LLM key 都在你自己手里，链路只剩浏览器 → Worker 的 HTTPS。应用层加密在该场景下没有实际收益（HTTPS 已加密传输；apiKey 由前端塞进 payload 必然要让 Worker 见到；攻击者拿 Worker URL 也榨不出 apiKey、推不动别人订阅），所以从 0.2.0 起协议改为**纯明文**。

> 多租户 SaaS 场景请用 `@rei-standard/amsg-server` 的 `schedule-message` 路径（仍保留 AES-256-GCM 加密 + 租户隔离）。

## 选哪个包？

| 用途                                 | 包                  |
|--------------------------------------|---------------------|
| 一次性即时推送（按钮触发 → 通知）    | **amsg-instant**    |
| 指定时间的定时消息                   | amsg-server         |
| 周期性消息（每日/每周）              | amsg-server         |
| 多租户 SaaS（要应用层加密 + 租户隔离）| amsg-server         |

## 安装

```bash
npm install @rei-standard/amsg-instant
```

> 0.3.0 起不再需要 `web-push` 依赖。所有 Web Push 加密/签名都用 `globalThis.crypto.subtle` 完成。

## 配置项

| 选项                | 类型      | 必填 | 说明 |
|---------------------|-----------|------|------|
| `vapid.email`       | string    | ✅   | VAPID 联系邮箱，自动补 `mailto:` 前缀 |
| `vapid.publicKey`   | string    | ✅   | VAPID 公钥 |
| `vapid.privateKey`  | string    | ✅   | VAPID 私钥 |
| `clientToken`       | string    | ❌   | 弱共享密钥；配了则校验 `X-Client-Token` 头。**只防 URL 直怼/脚本小子**，不防有心人（前端 bundle 必然带着 token） |
| `tokenSigningKey`   | string    | ❌   | 强鉴权 HMAC 密钥；配了则校验 `Authorization: Bearer <jwt>` |
| `cors.allowOrigin`  | string    | ❌   | `Access-Control-Allow-Origin` 的值，默认 `*`。配成具体来源（如 `https://app.example.com`）会自动加 `Vary: Origin`。0.4.0 起 handler 在入口处短路 `OPTIONS` 预检请求并对所有响应（200/4xx/5xx 都包括）叠 CORS headers。 |
| `webpush`           | object    | ❌   | **0.3.0 起废弃**。保留参数兼容旧代码但被忽略；测试改用 `fetch` 拦截 push endpoint 的 POST。 |
| `fetch`             | function  | ❌   | 自定义 fetch（测试 / 自建代理用）。同时用于 **LLM 调用** 和 **Web Push 推送**两个出口。 |
| `onEvent`           | function  | ❌   | 事件钩子：`request` / `llm_done` / `push_sent` / `error`（明文模式下 `request` 事件不再带 userId —— 如果需要按用户分流日志，从 `payload.contactName` 或 `payload.metadata` 自取） |
| `onLLMOutput`       | function  | ❌   | **0.7.0+**：每轮 LLM 输出后的决策钩子。配了它就进 agentic loop 模式；不配则走 v0.6 老路径（字节级兼容）。见 [Agentic Loop](#agentic-loop070) |
| `onBeforeLoop`      | function  | ❌   | **0.9.0+**：主 LLM loop 启动前调用，约定同步启动副任务并返回 handle 对象。返回值透传给 `onAfterLoop` 的 `pending`。SSE / 纯 Push 两种传输模式都生效。见 [生命周期 hooks](#生命周期-hooks-onbeforeloop--onafterloop090) |
| `onAfterLoop`       | function  | ❌   | **0.9.0+**：主 loop 结束后、流关闭前调用，从 `pending` 拿到 `onBeforeLoop` 返回的副任务 handle，await 完用 `deliver(payload)` 追加 push |
| `blobStore`         | object    | ❌   | **0.7.0+**：可选 blob 后端。push payload UTF-8 字节超过 `maxInlineBytes`（默认 2600）时自动把 body 写进 store、改推 200 B envelope。见 [BlobStore](#blobstore070) |
| `multipart`         | object    | ❌   | **0.8.0+**：通用 multipart transport。超出 inline、且没配 BlobStore 时，任意 JSON-safe payload 都可拆成 `_multipart` 分片。默认 `enabled:true`、`maxChunkBytes:1800`、`ttlMs:60000`、`maxChunks:128`、`maxTotalBytes:256000`。见 [Generic multipart transport](#generic-multipart-transport080)。 |
| `sse`               | object    | ❌   | **0.9.0+**：SSE 传输配置。`backupPush` 固定为 `'on'`，每条 SSE payload enqueue 成功后也发送同 `messageId` 的 Web Push backup；`keepaliveMs` 默认 1000、最小 250；`immediateKeepalive` 默认 true。 |
| `maxLoopIterations` | number    | ❌   | **0.7.0+**：单次 worker 调用内 `decision:'continue'` 的硬上限，默认 10。仅防本进程内 hook 反复 continue 失控；跨请求的 `/continue` 洪水攻击由上游 auth/rate-limit 处理 |
| `autoEmitReasoning` | boolean   | ❌   | **0.8.0+**：默认 `true`。`true` 时框架在调 hook 前自动 emit `ReasoningPush`（如果 LLM 响应带非空 `reasoning_content`，或 `content` 内含 `<thinking>` 等标签）。`false` 把 reasoning emit 完全交给 hook 自己负责（hook 可读 `ctx.llmResponse.choices[0].message.reasoning_content` 并用 `buildReasoningPush` + 自己 dispatch）。legacy 路径忽略此项始终自动 emit。 |
| `reasoningChunkBytes` | number \| null | ❌ | **Deprecated in 0.8.0**：旧 reasoning 专用字节切配置。保留为 `multipart.maxChunkBytes` 的兼容别名；`null` 仅在未显式配置 `multipart` 时禁用 generic multipart。不会再产生 `chunkIndex` / `totalChunks` reasoning wire fields。 |

### 鉴权策略

三档独立可选：

- **裸跑**（`clientToken` 和 `tokenSigningKey` 都不配）：任意请求直通。HTTPS 已加密传输，单租户自部署不需要应用层身份校验。适合个人 demo / 本地测试。
- **弱鉴权**（配 `clientToken`）：客户端固定带 `X-Client-Token: <token>` 头，比对失败返回 `401 INVALID_CLIENT_TOKEN`。token 会随前端 bundle 发出去，devtools 一开就能拿到 —— 只防 URL 直接被脚本小子打。
- **强鉴权**（配 `tokenSigningKey`）：客户端带 `Authorization: Bearer <JWT>`，HMAC-SHA256 签名校验 + 过期时间检查。生产部署推荐。

两个可以同时配（先校验 Bearer，再校验 X-Client-Token）。

### CORS

handler 默认就**对所有响应**（包括 200 / 400 / 401 / 500）叠 `Access-Control-Allow-*` 头，并在入口处短路 `OPTIONS` 预检请求 → `204 No Content`。浏览器从任何来源调用 Worker 都直接 work，不用自己写 middleware。

```js
createInstantHandler({
  vapid: { ... },
  // 默认 allowOrigin: '*'，省略这一项即可
  cors: { allowOrigin: 'https://app.example.com' },  // 锁定来源；自动附 Vary: Origin
});
```

固定开放的 headers / methods：

| Header                              | 值                                       |
|-------------------------------------|------------------------------------------|
| `Access-Control-Allow-Origin`       | `*`（默认）或 `cors.allowOrigin`         |
| `Access-Control-Allow-Methods`      | `POST, OPTIONS`                          |
| `Access-Control-Allow-Headers`      | `Content-Type, Authorization, X-Client-Token` |
| `Access-Control-Max-Age`            | `86400`                                  |
| `Vary`                              | `Origin`（仅当 `allowOrigin !== '*'`）   |

## API

### `createInstantHandler(options) → (request: Request, env?, ctx?) => Promise<Response>`

返回标准 Web Fetch API handler。直接挂到 Cloudflare Workers / Deno Deploy / Vercel Edge / Bun，或用下方四个 adapter 接到 Node / Netlify。
SSE 模式下 LLM + push 全程由 stream 生命周期托管，runtime 不会在响应仍在产出时回收 isolate；
纯 Web Push 模式下若运行时提供 `waitUntil`（请求 context 或 `options.waitUntil`），主回复链路会注册到它上面。

```js
import { createInstantHandler } from '@rei-standard/amsg-instant';

const handler = createInstantHandler({
  vapid: {
    email: 'mailto:you@example.com',
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  },
  clientToken: process.env.AMSG_CLIENT_TOKEN,   // 可选
});
```

### HTTP 协议

#### 传输模式协商（0.9.0+）

| 请求头                          | 响应                              | 适用场景                                            |
|---------------------------------|-----------------------------------|-----------------------------------------------------|
| 缺省 / 任意其他 Accept           | `Content-Type: text/event-stream` | **默认**。每条 payload 走 SSE 流式直推，同时默认发送 Web Push backup；由 SW dedupe 防重复，断流/写入失败时也继续 fallback Web Push |
| `Accept: application/json`      | `Content-Type: application/json`  | 显式 opt-out 回到 0.8.x 纯 Web Push 行为；HTTP 状态码 + JSON body 错误语义都保留 |

`pushSubscription` 在两种模式下都**必填**——SSE 模式下用作断流 / 写入失败时的 fallback 通道。

SSE wire format：

```
: keepalive            ← 默认 start 后立即发一次，之后每 1000ms 一行（可配，最小 250ms）

event: payload         ← 每条 push，data 是与 Web Push 通道一字节相同的 JSON
data: {"messageKind":"reasoning","sessionId":"sess_...",...}

event: payload
data: {"messageKind":"content","messageId":"msg_...","message":"hello","messageIndex":1,"totalMessages":2,...}

event: payload
data: {"messageKind":"content","messageId":"msg_...","message":"second","messageIndex":2,"totalMessages":2,...}

event: done            ← 流正常结束的最终信号；客户端可用 stream EOF 兜底
data: {}
```

业务错误（LLM 调用失败、未知异常等）在流已开后通过 `event: error\ndata: <完整 ErrorPush>` 投递，HTTP 状态始终是 200——SSE 模式下不能再靠 HTTP 状态码表达错误。`HookError` 例外：诊断 ErrorPush 已经作为 `event: payload` 送出，不重复发 `event: error`。

> 客户端实现见 [`@rei-standard/amsg-client`](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md) 的 `consumeInstantStream()`。验证非 SSE 响应（含错误页 / 非 2xx）必须先看 `Content-Type` + status，再进 stream parser。

#### SSE backup push（0.9.0+）

正式环境推荐保持默认链路：SSE 正常流式返回，每条 payload enqueue 成功后也发一份 Web Push backup。这份 backup 不是“断了才发”，而是默认常开；重复的部分交给 `@rei-standard/amsg-sw` 的 delivery dedupe 解决。

| 配置 | 默认值 | 行为 | 生产建议 |
|------|--------|------|----------|
| `backupPush` | `'on'` | SSE payload enqueue 成功后，立即发送同 `messageId` 的 Web Push backup | 固定开启；`off` / `delayed` 会被拒绝，避免正式部署误入已知可能丢 payload 的模式 |
| `keepaliveMs` | `1000` | SSE 空闲 keepalive 间隔，最小 250ms | 保持默认 |
| `immediateKeepalive` | `true` | stream start 后立即发送第一条 keepalive | 保持默认 |

显式写出来可以长这样；省略 `sse` 时也是这组默认值：

```js
createInstantHandler({
  vapid: { ... },
  sse: {
    backupPush: 'on',
    keepaliveMs: 1_000,
    immediateKeepalive: true,
  }
});
```

同一业务 payload 在 SSE 与 Web Push backup 中共用完全相同的 `messageId`。直接 Web Push、Blob envelope（会携带原 payload 的 `messageId` / `id` / `dedupeKey`）和 generic multipart 还原后的 payload 都能被 `@rei-standard/amsg-sw` 的 dedupe gate 识别。

新增 `onEvent` 事件：

- `sse_payload_enqueued`
- `sse_payload_enqueue_failed`
- `sse_stream_aborted`
- `sse_stream_canceled`
- `backup_push_scheduled`
- `backup_push_sent`
- `backup_push_failed`
- `fallback_push_sent`
- `fallback_push_failed`

#### 请求

```http
POST /instant
Authorization: Bearer <jwt>     ← 仅当 tokenSigningKey 配置时检查
X-Client-Token: <token>         ← 仅当 clientToken 配置时检查
Accept: application/json        ← 可选；显式走纯 Web Push 路径（0.9.0+）
Content-Type: application/json

{
  "contactName": "...",
  "completePrompt": "...",
  ...
}
```

**payload 字段**：

```ts
{
  contactName: string;
  avatarUrl?: string | null;        // 0.7.1+ / 0.8.0+：不合法值（data: URI / 长度 > 2KB / 非字符串）软清空 + console.warn，整次推送不再 fail

  // === 提示词，二选一恰好一个（0.5.0+）===
  completePrompt?: string;         // 简单推送场景：单 user 消息
  messages?: Array<{               // 多轮 / 带 system role：原样转发给 LLM
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | unknown[];   // 数组形态留给多模态，元素不强校验
  }>;

  apiUrl: string;                  // OpenAI 兼容端点；详见下方"apiUrl 规范化"
  apiKey: string;
  primaryModel: string;
  maxTokens?: number;
  temperature?: number;            // 0.5.0+：透传给 LLM；completePrompt 路径未传默认 0.8
  messageSubtype?: string;         // SW 端分类标签，取值由业务决定

  pushSubscription: {              // Web Push 标准订阅
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  metadata?: Record<string, any>;  // 透传到 push payload
}
```

`completePrompt` 和 `messages` 必须**恰好提供一个**；同时给或都不给都会返回 `400 INVALID_PAYLOAD_FORMAT`。`messages` 数组不能为空，每条 `role` 必须是 `system / user / assistant / tool`。handler **不会**对 `messages` 做任何自动注入或重排——上游传什么就发什么。

`firstSendTime` 和 `recurrenceType` 在 `amsg-instant` 上是**非法字段**，会直接返回 `INVALID_PAYLOAD_FORMAT`。

#### `messages` 模式 curl 示例

```bash
curl -X POST https://instant.example.com/instant \
  -H "Content-Type: application/json" \
  -d '{
    "contactName": "Rei",
    "messages": [
      { "role": "system", "content": "你是 Rei，回复要简短自然。" },
      { "role": "user", "content": "今天会下雨吗？" },
      { "role": "assistant", "content": "看了下，下午有阵雨。" },
      { "role": "user", "content": "那提醒我一下带伞" }
    ],
    "apiUrl": "https://api.openai.com/v1/chat/completions",
    "apiKey": "sk-...",
    "primaryModel": "gpt-4o-mini",
    "temperature": 0.7,
    "pushSubscription": { "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." } }
  }'
```

对比 `completePrompt` 模式（简单推送，handler 内部包成单条 `{role:'user', content}`）：

```bash
curl -X POST https://instant.example.com/instant \
  -H "Content-Type: application/json" \
  -d '{
    "contactName": "Rei",
    "completePrompt": "你是 Rei，用一句话提醒用户带伞",
    "apiUrl": "https://api.openai.com/v1/chat/completions",
    "apiKey": "sk-...",
    "primaryModel": "gpt-4o-mini",
    "pushSubscription": { "endpoint": "...", "keys": { "p256dh": "...", "auth": "..." } }
  }'
```

#### `apiUrl` 规范化（0.4.0+）

为了让用户不必死记 OpenAI 路径全名，Worker 会按下表规则补全 `apiUrl`。规则幂等：跑两次 = 跑一次，所以传完整 URL 也不会被改坏。

| 输入                                                          | 输出                                                           |
|---------------------------------------------------------------|----------------------------------------------------------------|
| `https://api.openai.com`                                      | `https://api.openai.com/v1/chat/completions`                   |
| `https://api.openai.com/`                                     | `https://api.openai.com/v1/chat/completions`                   |
| `https://api.openai.com/v1`                                   | `https://api.openai.com/v1/chat/completions`（**不会重复加 v1**） |
| `https://api.openai.com/v1/`                                  | `https://api.openai.com/v1/chat/completions`                   |
| `https://api.openai.com/v1/chat/completions`                  | 原样返回                                                       |
| `https://my.proxy.com/openai/v2`                              | `https://my.proxy.com/openai/v2/chat/completions`              |
| `https://api.anthropic.com/v1/messages`（其他自定义路径）      | 原样返回，不动                                                  |

如果想绕开这个规则（比如代理路径很奇怪），传完整 `…/chat/completions` 即可。

**响应**（SSE 默认模式，0.9.0+）：见上面 [传输模式协商](#传输模式协商090) 的 wire format。

**响应**（`Accept: application/json` opt-out 模式 / 0.8.x 行为）：

```json
{
  "success": true,
  "data": {
    "messagesSent": 3,
    "sentAt": "2026-05-16T12:34:56.789Z"
  }
}
```

```json
{ "success": false, "error": { "code": "LLM_CALL_FAILED", "message": "..." } }
```

### 错误码

所有错误响应统一走 envelope `{ success: false, error: { code, message } }`，SDK 消费者只需读 `body.error.code` 分支。

| Code                                          | HTTP | 起 | 说明 |
|-----------------------------------------------|------|----|------|
| `METHOD_NOT_ALLOWED`                          | 405  | 0.1 | 非 POST（`/blob/:key` GET 例外，见下） |
| `UNAUTHORIZED`                                | 401  | 0.1 | `tokenSigningKey` 校验失败 |
| `INVALID_CLIENT_TOKEN`                        | 401  | 0.1 | `clientToken` 校验失败（缺头或不匹配） |
| `INVALID_PAYLOAD_FORMAT`                      | 400  | 0.1 | body 不是合法 JSON 或字段缺失/非法 |
| `VAPID_CONFIG_ERROR`                          | 500  | 0.1 | VAPID 配置缺失 |
| `LLM_CALL_FAILED`                             | 502  | 0.1 | 上游 LLM 请求失败 |
| `PUSH_SEND_FAILED`                            | 502  | 0.1 | Web Push 派送失败 |
| `COMPLETE_PROMPT_NOT_SUPPORTED_ON_HOOK_PATH`  | 400  | 0.7 | 配了 `onLLMOutput` 之后 `/instant` 或 `/continue` 还传 `completePrompt`；hook 路径只接受 `messages` 数组 |
| `HOOK_THREW`                                  | 500  | 0.7 | `onLLMOutput` 抛错或返了非法 decision（`null` / 不识别的 `decision` 值 / `pushPayloads` 不是数组或为空 / 单个 push 不可 JSON-serialize）。同时会推一条诊断 `ErrorPush`（`{ messageKind:'error', code:'HOOK_THREW', message, iteration? }`） |
| `PAYLOAD_TOO_LARGE`                           | 500  | 0.7 | hook 返的 `pushPayloads` 中某个 push UTF-8 字节超 `maxInlineBytes`，且没有 BlobStore、generic multipart 也被禁用或超过 multipart 上限。配上 BlobStore 会优先走 envelope；没配 BlobStore 时默认走 generic multipart |
| `CONTINUE_NOT_AVAILABLE`                      | 400  | 0.7 | 往没配 `onLLMOutput` 的 handler POST `/continue`。`/continue` 是 agentic loop 的续跑端点，没钩子就没东西可续，直接拒掉避免误报成 `HOOK_THREW` |
| `INTERNAL_ERROR`                              | 500  | 0.1 | 其他未分类内部错误 |

**`LOOP_EXCEEDED` 不是错误码** —— hook 反复返 `decision:'continue'` 超 `maxLoopIterations` 时，worker 返 HTTP **200** + body `{ success: true, data: { status: 'loop_exceeded', sessionId, iteration } }`，并向 SW 推一条 `{ messageKind:'error', code:'LOOP_EXCEEDED', message, iteration }` 诊断 `ErrorPush`。HTTP 层是正常完成，不会让客户端误重试。

**`/blob/:key` 端点的 error envelope 不同** —— 它走 plain `{ error: 'invalid_key' | 'blob_not_found_or_expired' | 'blob_store_not_configured' | 'blob_read_failed' }`，因为这条路径是给 SW 直 fetch 用的、跟主 SDK 的 wrap envelope 不在一条契约上。

## 推送 payload 字段（SW 端契约）

字段形状与 `amsg-server` scheduled / instant 路径一致，`@rei-standard/amsg-sw` 零修改可用，通过 `source` 区分来源。

```js
{
  title: `来自 ${contactName}`,
  message: '...',                                  // 分句后的第 i 句
  contactName,
  messageId: 'msg_<uuid>_instant_<i>',
  messageIndex: 1,                                 // 1-based
  totalMessages: 3,
  messageType: 'instant',
  messageSubtype: 'chat',
  taskId: null,                                    // instant 无 taskId
  timestamp: '2026-05-16T12:34:56.789Z',
  source: 'instant',
  avatarUrl,
  metadata
}
```

---

## Agentic Loop（0.7.0+）

v0.7 在 v0.6 之上**追加**了一个 hook 路径：配置 `onLLMOutput` 后，handler 把"一次请求 = 一次 LLM 调用 + 一条 push"扩展成"一次请求 = 多轮 LLM 调用 + 由 hook 决定如何推送 / 是否续跑 / 是否截断把控制权给客户端"。

**两条路径互不干扰**：

- **不配 `onLLMOutput`** → 原 v0.6 单次 LLM + 分句 + 串行 push（默认 1500 ms 间隔，13 字段 payload）。字节级与 v0.6 一致。
- **配了 `onLLMOutput`** → 进 agentic loop，每轮 LLM 输出后调 hook 做 decision；hook 返什么就执行什么。切分完全由 hook 自己负责（`pushPayloads` 数组），见 [切分由 caller 负责](#切分由-caller-负责080-起)。

### hook 签名

```ts
onLLMOutput(ctx: SessionContext): LLMOutputDecision | Promise<LLMOutputDecision>
```

`SessionContext` 字段（**不包含**凭据 `apiKey` / `pushSubscription` / `vapid` 等 —— hook 拿不到，也没必要拿）：

| 字段 | 含义 |
|---|---|
| `sessionId` | 该会话的稳定 ID。`/instant` 不传时自动生成 UUID v4；`/continue` 必须带回来 |
| `charId?` | 调用方业务字段，透传 |
| `messages` | 当前对话 history。已 append 本轮 LLM 整对象 `choices[0].message`（含 `tool_calls` / `reasoning_content` / `refusal`），**不是只塞 `{role, content}`** —— 后者会让下一轮把 tool result 发回 OpenAI 时因为缺 `tool_calls` 被拒 |
| `llmResponse` | 完整 LLM API response 对象（含 `usage` / `reasoning_content` 等） |
| `llmOutputText` | `choices[0].message.content`。**可能是空串**（纯 `tool_calls` 响应合法） |
| `iteration` | 0-indexed 当前轮号 |
| `metadata` | 调用方传入的 metadata，透传 |
| `contactName`, `avatarUrl?` | 给想自己构造 default-style payload 的 hook 用 |

### Decision 四选一

```ts
type LLMOutputDecision =
  | { decision: 'finish';       pushPayloads: PushPayload[] }   // 推送 N 条 push，结束链路
  | { decision: 'tool-request'; pushPayloads: PushPayload[] }   // 推送 N 条 push，等 /continue
  | { decision: 'continue';     nextHistory: ChatMessage[] }    // worker 内部再来一轮 LLM，不推送
  | { decision: 'skip-push' }                                   // 直接结束链路、不推送（罕见）
```

**没有单数 `pushPayload` 字段了。** 1 条就 `[push]`，3 条就 `[a, b, c]`。空数组 `[]` 非法（直接 `HookError`）。

lib 给每个 push 自动补这 3 个机械字段（hook 自己设 `messageId` 会被尊重，其余 2 个无论 hook 写什么都被覆盖）：

| 字段            | 自动补充行为                                                                 |
|-----------------|-----------------------------------------------------------------------------|
| `messageId`     | hook 未设 → lib 用 `msg_<uuid>` 填上（0.9.0 起；之前是 `msg_<uuid>_chunk_<i>`，chunk 位置已在下两个字段，重复编码到 ID 反而误导）；hook 已设 → 保留 |
| `messageIndex`  | 永远覆盖：1-based 数组下标（i + 1）                                          |
| `totalMessages` | 永远覆盖：`pushPayloads.length`                                              |

剩下所有字段（`messageKind` / `notification` / `metadata` / kind 特定字段（e.g. tool_request 的 toolCalls / reasoning 的 reasoningContent / error 的 code） / 等）都是 per-push，caller 完全控制。每个 push 必须 **JSON-safe**（无循环引用 / BigInt / function 字段），否则被当作 hook 契约违反走 `HookError` / `HOOK_THREW` 路径。

### 切分由 caller 负责（0.8.0 起）

0.8.0 起 lib 不再接收 `splitPattern` 这类公共旋钮，也没有新的 handler 级 `splitFn` 参数。新方法是：hook 里调用你自己的 split 函数，然后返回 `pushPayloads: PushPayload[]`。数组里装的就是 lib 会原样依次发的 N 条 push。常见 caller 会自己实现：

- 一些 caller 的分句逻辑混合多种启发式：换行、自定义 sentinel、跨语言断句、tag-level 边界等，用单个正则表达力不够
- 按 inline 业务标签（自定义占位符 / markup 片段）独立成段
- 切完空段 `filter`、按业务规则前后 `merge` / `split` 二阶段
- per-chunk 显示文本和载荷文本可以不一样：`notification.body` 是 OS banner（受长度 / 字符集限制、可能需要纯文本预览），`message` 字段给客户端 app 用完整原文做后处理

如果想要 0.7 时代「默认 `/([。！？!?]+)/` 句切」行为，自己写一个本地函数：

```js
function splitForPush(text) {
  const segments = text.split(/([。！？!?]+)/)
    .reduce((acc, part, i, arr) => {
      if (i % 2 === 0 && part.trim()) acc.push(part.trim() + (arr[i + 1] || ''));
      return acc;
    }, [])
    .filter((s) => s.length > 0);
  return segments.length > 0 ? segments : [text];
}

const segments = splitForPush(ctx.llmOutputText);

return {
  decision: 'finish',
  pushPayloads: segments.map((message) => ({
    messageKind: 'content',
    sessionId: ctx.sessionId,
    message,
    notification: { title: `来自 ${ctx.contactName}`, body: message },
  })),
};
```

请求 body 上的 `splitPattern` / `reasoningSplitPattern` / `errorSplitPattern` 在 0.8.0 里直接 400；push 上带 `splitPattern` 抛 `HookError`。迁移时把旧正则逻辑搬进 hook 内的自定义 split 函数，再返回一组 `pushPayloads`。

#### 通用保护切分工具 `segmentTextWithProtectedBlocks`

对于含有不可切碎内容（例如 markdown 代码块、自定义标记）的场景，你可以使用包提供的 `segmentTextWithProtectedBlocks` 帮助构造。它**不是业务解析器**，也不预设任何业务标签，而是纯粹基于正则帮你保护不想被普通 `splitText` 切断的文本片段。

```js
import { segmentTextWithProtectedBlocks } from '@rei-standard/amsg-instant';

const segments = segmentTextWithProtectedBlocks(ctx.llmOutputText, {
  // 基础文本怎么切
  splitText: (text) => text.split('\n'),
  // 对截取后的基础文本进行预处理（可选）
  sanitizeText: (text) => text.trim(),
  
  // 遇到这些 pattern 匹配到的片段不切碎，原样作为一个独立块保留
  protectedPatterns: [
    { 
      pattern: /```[\s\S]*?```/, 
      preview: '[Code Block]', // OS 通知栏看到的替代文字
    },
    {
      pattern: /<think>[\s\S]*?<\/think>/,
      preview: (raw) => '[Thought Process]', // 支持固定字符串或函数
      meta: { type: 'think-block' } // 可选元数据，输出时会附加到 segment 上
    }
  ]
});

// 输出的片段数组形如：
// [
//   { raw: '文本第一段', sanitized: '文本第一段', protect: false },
//   { raw: '```js\nconst a = 1;\n```', sanitized: '[Code Block]', protect: true },
//   { raw: '后续文本', sanitized: '后续文本', protect: false }
// ]

return {
  decision: 'finish',
  pushPayloads: segments.map((seg) => ({
    messageKind: 'content',
    sessionId: ctx.sessionId,
    message: seg.raw,
    // 保护段可以在通知栏显示短 preview，但 payload 原样发给客户端渲染
    notification: { title: `来自 ${ctx.contactName}`, body: seg.sanitized },
    metadata: seg.meta
  })),
};
```

#### 例 1：单 push

```js
return {
  decision: 'finish',
  pushPayloads: [{
    messageKind: 'content',
    sessionId: ctx.sessionId,
    message: 'Hello',
    notification: { title: 'Assistant', body: 'Hello' },
  }],
};
```

#### 例 2：3 chunk content + 不同 notification.body（banner 跟 message 显示文本不一样）

```js
return {
  decision: 'finish',
  pushPayloads: [
    {
      messageKind: 'content',
      sessionId: ctx.sessionId,
      message: 'Greetings, traveler.',
      notification: { title: 'Quest Master', body: 'Greetings, traveler.' },
    },
    {
      messageKind: 'content',
      sessionId: ctx.sessionId,
      message: '<thinking>plotting next move</thinking>',           // internal markup for client app
      notification: { title: 'Quest Master', body: '…' },           // condensed banner preview
    },
    {
      messageKind: 'content',
      sessionId: ctx.sessionId,
      message: 'The path forward is yours to choose.',
      notification: { title: 'Quest Master', body: 'The path forward is yours to choose.' },
    },
  ],
};
```

#### 例 3：tool-request 混 content + 多 toolCalls

```js
return {
  decision: 'tool-request',
  pushPayloads: [
    {
      messageKind: 'content',
      sessionId: ctx.sessionId,
      message: 'Let me check both at once.',
      notification: { title: 'Assistant', body: 'Let me check both at once.' },
    },
    {
      messageKind: 'tool_request',
      sessionId: ctx.sessionId,
      message: '',
      toolCalls: [
        { id: 'tc_1', type: 'function', function: { name: 'lookup_user',   arguments: '{"id":"u_42"}' } },
        { id: 'tc_2', type: 'function', function: { name: 'fetch_weather', arguments: '{"city":"Seattle"}' } },
      ],
      // 无 notification → 不弹 OS 横幅
    },
  ],
};
```

decision 跟 push 内容的 `messageKind` 分布完全解耦——lib 不检查「`tool-request` decision 是不是必须含 `tool_request` push」之类的搭配，hook 想怎么组合就怎么组合。

### `decision: 'continue'` + `nextHistory` 的脚枪

`nextHistory` **完全替换**下一轮的 messages 数组。如果你从零拼 `nextHistory` 而忘了带上刚由 worker append 进 `ctx.messages` 的 assistant 消息，那下一轮 LLM 看到的 history 就是 `user → user`，**OpenAI 会因为 tool result 引用了一个不存在的 assistant 轮直接拒掉请求**。

**默认安全写法**：

```js
onLLMOutput(ctx) {
  return {
    decision: 'continue',
    nextHistory: [...ctx.messages, toolResultMessage],
  };
}
```

只在你**真的想丢掉 assistant 上下文**时才从零构造。

### `maxLoopIterations`

防的是**单次 worker 调用内 hook 反复返回 `{decision:'continue'}`** 的失控循环。默认 10，超限后 worker 直接：

1. emit `loop_exceeded` 事件
2. 用 `sendPushWithMaybeBlob` 推一条 `{ messageKind:'error', code:'LOOP_EXCEEDED', message, sessionId, iteration }` 诊断 `ErrorPush`
3. HTTP **200** + body `{ status: 'loop_exceeded', sessionId, iteration }` —— 注意**不是 5xx**，worker 已经完成了"推一条诊断给 SW"的合约，不该让客户端把它当可重试失败

**保护范围**：仅限单次 worker 调用内的 in-loop counter。跨请求的 `/continue` 洪水攻击（恶意客户端反复打 `/continue` 一直传 `iteration:0`）由部署方的 auth / rate-limit 负责，**不是这个守卫的活**。

### sessionId 重投递 dedup（SW 端必看）

worker **不去重**同一 `sessionId` 的并发 `/continue`。浏览器 push 投递自身就可能给同一条 push 重投（网络重试、focus-change replay、唤醒，**甚至在 SW 上一次 handler 已经跑完之后**），所以两个 `/continue` POST 完全可能背靠背落到 worker，连恶意客户端都不需要。后果是：2× LLM 费用 + UI 上 2× 重复气泡。

**包不管这件事；SW 必须自己 dedup**。Blob 路径是非破坏性多次消费（TTL 默认 60 s），所以 SW 可以**先 fetch 拿真 body、再用 `(sessionId, iteration)` claim** 一个 IndexedDB 记录、写入失败说明已被处理 → 直接吞掉本次投递：

```js
self.addEventListener('push', (e) => e.waitUntil((async () => {
  let data = e.data.json();
  if (data?._blob) {                                          // 1. envelope
    const res = await fetch(data.url);
    if (!res.ok) return;                                       // TTL 已过期/失败，不展示
    data = await res.json();
  }
  if (data.messageKind !== 'tool_request') return handle(data);

  // 2. fetch 之后 dedup —— claim 永久保留，靠 sweeper 清旧
  const claimKey = `${data.sessionId}:${data.iteration}`;
  const db = await openIdempotencyDB();
  const claimed = await db.add('claims', { key: claimKey, at: Date.now() }).catch(() => null);
  if (!claimed) return;                                        // 重复投递 / 重发，吞掉

  const result = await runToolLocally(data);
  await fetch('/continue', { method: 'POST', body: JSON.stringify({
    ...data, messages: [...data.messages, result], iteration: data.iteration + 1,
  }) });
  // 不删 claim —— 它的存在就是"已消费"的证据
})()));

async function sweepOldClaims() {                              // SW activate / 周期跑
  const db = await openIdempotencyDB();
  const cutoff = Date.now() - 60 * 60 * 1000;                  // 1h 容忍合理重投递窗
  const tx = db.transaction('claims', 'readwrite');
  for await (const cursor of tx.store.iterate()) {
    if (cursor.value.at < cutoff) await cursor.delete();
  }
}
```

⚠️ **`try/finally delete` 是 racey 的**：在 handler 跑完后删 claim，push 重投递时 dedup 失效。必须 claim 永久保留，sweeper 清旧的。IndexedDB `add` 在重复 key 时直接抛错，**天然原子**。

业务能容忍重复 push（纯展示重复气泡也行）就跳过整段。

### `/continue` 端点契约

POST body（结构与 `/instant` 入口相同 + `sessionId` + `iteration`）：

```ts
{
  sessionId: string;
  messages: ChatMessage[];                  // 完整 history（含 tool result 作为最后一条 user/tool 消息）
  pushSubscription: PushSubscriptionInfo;
  apiUrl: string; apiKey: string; primaryModel: string;
  maxTokens?: number; temperature?: number;
  metadata?: Record<string, unknown>;       // 非 plain object 直接 400
  charId?: string; avatarUrl?: string; contactName: string;
  iteration: number;                        // = ctx.iteration + 1，0 ≤ iteration < maxLoopIterations
}
```

- 鉴权链：**完整复用** `/instant` 的 Bearer（配了 `tokenSigningKey` 时）+ clientToken（配了 `clientToken` 时），顺序一致。否则在鉴权模式下 `/continue` 留后门。
- `completePrompt` 永远不接受（`/continue` 是 v0.7 新端点，跟 v0.6 没关系）。
- 越界 `iteration`（< 0 / 非整数 / ≥ `maxLoopIterations`）**直接 400 fail-fast**：设计前提是客户端是正常实现，传 999 说明 client 状态坏了，少跑一次多余 LLM 比让 in-loop counter 跑满再吐 LOOP_EXCEEDED 友好。不假设防恶意 client（那是 auth / rate-limit 的事）。

### 生命周期 hooks `onBeforeLoop` / `onAfterLoop`（0.9.0+）

在 `onLLMOutput` 这个"per-turn 决策 hook"之外，0.9.0 加了一对**链路级** hook，给"主 LLM loop 跑的同时并行一些副任务（外部 webhook、统计上报、索引刷新…），结束后把结果作为额外 push 追加"这类需求一个干净的口子，不用把副任务塞进 `onLLMOutput` 里跟决策逻辑挤在一起。

```ts
createInstantHandler({
  vapid,
  onLLMOutput,                         // 0.7.0+ 老 hook，不变
  onBeforeLoop?: (ctx: {
    requestBody: unknown;              // 原始请求 body，框架不解析自定义字段
    sessionId: string;
    metadata: Record<string, unknown>;
  }) => unknown | Promise<unknown>,    // 返回值会被 opaque 透传给 onAfterLoop
  onAfterLoop?: (ctx: {
    deliver: (payload: unknown) => Promise<void>;
    sessionId: string;
    metadata: Record<string, unknown>;
    requestBody: unknown;
    pending: unknown;                  // = onBeforeLoop 的返回值
  }) => Promise<void>,
});
```

约定：`onBeforeLoop` 在主 loop 启动前调用，**同步启动副任务、立刻返回 handle 对象**。框架只 `await` 函数返回——不会替你 await 副任务本身。返回值原样进 `onAfterLoop` 的 `pending`。

典型用法：

```js
onBeforeLoop: ({ requestBody }) => ({
  // 这些 promise 立刻就在跑了，跟主 LLM loop 并行
  lookup: runBackgroundLookup(requestBody),
  metrics: pushToAnalytics(requestBody),
}),

onAfterLoop: async ({ pending, deliver, sessionId }) => {
  const { lookup } = pending;
  const result = await lookup;                   // 主 loop 这时已经结束了
  if (result) {
    await deliver({
      messageKind: 'status_update',
      sessionId,
      data: result,
    });                                          // 作为额外一条 push 追加到本次链路
  }
},
```

两个 hook 在 SSE 与纯 Push 两种传输模式下**都生效**，`deliver` 抹平差异：

- SSE 模式：走当前 SSE controller `enqueue` `event: payload`，失败时 fallback Web Push
- 纯 Push 模式：直接 `sendPushWithMaybeBlob`

所以 hook 作者不用关心调用方走了哪条传输路径。

### 事件分类（0.7.0+）

事件统一用**直接 type 名**做 discriminator（不再混 `error+code` 二级嵌套）：

- **进度**：`llm_start` / `llm_done` / `final_pushed` / `tool_request_pushed` / `continue_received` / `blob_written`
- **软失败**（链路可继续 / 自愈）：`blob_put_failed` / `blob_orphaned` / `diagnostic_push_failed` / `payload_too_large`
- **硬错误**（worker 中止链路）：`hook_threw` / `loop_exceeded` / `llm_call_failed`

**push payload（SW 收到的 wire format）统一走 `ErrorPush`** —— 0.8.0 起错误诊断 push 使用 `{ messageKind:'error', code, message, iteration? }`。旧的 `{type:'error', code:'...'}` envelope 已移除，不要在新 SW 代码里按 `type === 'error'` 分支。

---

## Generic multipart transport（0.8.0+）

> **0.8.0 BREAKING**：旧 reasoning 专用 `chunkIndex` / `totalChunks` wire format 已移除。`reasoning`、`tool_request`、`content`、`error`、`status_update` 或任何自定义 `messageKind`，只要是 JSON-safe payload，超限时都走同一套 generic `_multipart` transport。应用层不应该再监听或拼接 reasoning 半片。

发送优先级很简单：

1. payload UTF-8 JSON 字节数 `<= maxInlineBytes`：直接 Web Push。
2. 超限且配置了 `blobStore.adapter`：写 BlobStore，推 `{ _blob:true, key, url, messageKind?, type? }` envelope。
3. 超限、没有 BlobStore、`multipart.enabled !== false`：推 `_multipart` 分片。
4. 超限、没有 BlobStore、multipart 禁用或超过上限：抛 `PayloadTooLargeError`。

### 配置

```js
createInstantHandler({
  vapid: { ... },
  onLLMOutput: hook,
  multipart: {
    enabled: true,
    maxChunkBytes: 1800,
    ttlMs: 60_000,
    maxChunks: 128,
    maxTotalBytes: 256_000,
  },
});
```

`reasoningChunkBytes` 还保留为迁移期别名：

```js
createInstantHandler({
  vapid: { ... },
  reasoningChunkBytes: 1600, // 等价于 multipart.maxChunkBytes: 1600
});
```

`reasoningChunkBytes: null` 只在没有显式传 `multipart` 时禁用 generic multipart。想要可靠承载超大 payload，更推荐配 BlobStore；它仍然优先于 multipart。

### Wire format

原始业务 payload 是完整 JSON，比如：

```json
{
  "messageKind": "reasoning",
  "messageType": "instant",
  "source": "instant",
  "messageId": "msg_<uuid>_iter_0_reasoning",
  "sessionId": "sess_abc",
  "timestamp": "2026-05-20T12:00:00Z",
  "reasoningContent": "long reasoning..."
}
```

Web Push 上实际发出的每片是：

```json
{
  "messageKind": "_multipart",
  "multipart": {
    "version": 1,
    "id": "mp_<uuid>",
    "index": 1,
    "total": 4,
    "encoding": "json-utf8-base64url",
    "originalMessageKind": "reasoning",
    "createdAt": 1710000000000,
    "ttlMs": 60000
  },
  "chunk": "base64url..."
}
```

`chunk` 是原始 JSON 的 UTF-8 byte slice 再 base64url，不按 JS string 切，所以不会切坏中文或 surrogate pair。SW 收齐后按 `index` 排序拼 bytes，decode JSON，再把恢复出的原始 payload 递归交回普通分发逻辑。

### 迁移说明

- 应用级 SW 可以删除自定义 reasoning 拼接逻辑。`@rei-standard/amsg-sw` 会透明重组，client 只收到完整 `messageKind: 'reasoning'` payload。
- 不要再依赖 `chunkIndex` / `totalChunks` 判断 reasoning 是否完整；0.8.0+ 版本不会再发这些字段。
- `_multipart` 是保留的 transport kind，不触发业务事件、不弹通知。
- `content` multipart 收齐后照常 `postMessage` + `showNotification`；`tool_request` / `reasoning` / `error` 仍默认只 `postMessage` 不通知。
- 发送端会 emit `multipart_built` / `multipart_sent` 事件用于可观测性。旧 `reasoning_chunked` 事件不再表示 wire 行为。

---

## BlobStore（0.7.0+）

### 为什么需要它

Web Push（RFC 8030 / 8291）单 record 密文上限 4096 B，扣 header + GCM tag + padding 后明文理论上限约 **3993 B**。各推送服务实际的"安全线"通常更低：

| 通道 | 实测/经验安全线 | 出处 |
|---|---|---|
| Mozilla autopush（Firefox desktop） | ~4028 B | 社区实测 |
| Firefox-on-Android 受限通道 | 3070 B | Firefox 错误信息 |
| `web-push-php` `MAX_COMPATIBILITY_PAYLOAD_LENGTH` | **2820 B** | web-push-php README |
| RFC 兼容推荐线 | 3052 B | web-push-libs README |
| APNs Web Push | ~4096 B | Apple 文档 |

包默认 `maxInlineBytes = 2600`，相对 `web-push-php` 跨服务安全线留 ~220 B margin。**字节比对用 UTF-8 byteLength（`new TextEncoder().encode(s).byteLength`），不是 JS `.length`** —— 后者是 UTF-16 code unit，CJK 字符 `.length = 1` 但 UTF-8 占 3 字节，混用会让中文 payload 误走直传被 413 拒收。

agentic loop 模式下 payload 大小分布（经验值）：

| 场景 | 常态 | p90 | p99 |
|---|---|---|---|
| 纯文本 / 副作用 push，无 reasoning | 0.5–1.5 KB | 2 KB | 约 3000 B |
| 副作用 push + reasoning chain | 1–2.5 KB | 约 3000 B | 4–5 KB（撞线） |
| tool-request push（带本轮 LLM 原文） | 0.8–1.8 KB | 2.5 KB | 3.5 KB |
| tool-request + reasoning | 1.5 KB–约 3000 B | 4 KB（临界） | 5–6 KB（超） |

→ **90 % 场景直传安全**，但开 reasoning / 长输出的 p90-p99 会超。0.8.0 阶段引入 [generic multipart transport](#generic-multipart-transport080) 后，没有 BlobStore 时也能透明拆分任意 JSON-safe payload；`BlobStore` 仍是更可靠方案，且优先级高于 multipart：超限 payload 写到外部存储，push 只推 ~200 B envelope `{ _blob:true, key, url, messageKind?, type? }`，SW / client 再按 envelope 约定读取真 body。

### 何时启用 / 何时跳过

| 场景 | 推荐 |
|---|---|
| 不配 `onLLMOutput`（v0.6 legacy 路径） | **不需要配** —— 分句拆出来每段都 < 1 KB |
| agentic loop，只用 reasoning，不带长 ContentPush | 可以先不配 —— 默认 generic multipart 会兜底；生产更推荐 BlobStore |
| agentic loop，ContentPush 偶尔很长（代码块 / 长答案） | 推荐配 |
| 显式关闭 `multipart` 或 `reasoningChunkBytes: null` | **强烈推荐** —— 大 payload 兜底走 envelope |
| 任何 tool-request 流程 | 推荐配（toolCalls + narration 偶尔会撞线） |
| 一次推完整 history | **必须配** —— 必超 |

**不配 BlobStore + 超限的行为**：默认走 generic multipart；如果 `multipart.enabled:false` 或超过 `maxTotalBytes` / `maxChunks`，才抛 `PayloadTooLargeError`。调用方据此决定要不要上 BlobStore。

### 包内自带 6 个 adapter

按部署平台分组。把对应的 client 实例传进去就完事，包本身不引任何额外依赖（client SDK 由调用方自己 install）。

**Cloudflare Workers**

```js
// 推荐 — D1，免费档 10 万 row/day 写入
import { createD1BlobStore } from '@rei-standard/amsg-instant/blob/d1';
const adapter = createD1BlobStore(env.DB, { table: 'amsg_transient_blobs' });

// KV — 仅当 D1 不可用时；免费档写入 1k/day，高频会爆
import { createKVBlobStore } from '@rei-standard/amsg-instant/blob/kv';
const adapter = createKVBlobStore(env.BLOB_KV);
```

**Vercel / 任何 serverless（Upstash Redis）**

```js
// 也覆盖 Vercel KV —— 它就是 Upstash 套壳，client API 一致
import { Redis } from '@upstash/redis';   // 或 import { kv } from '@vercel/kv';
import { createUpstashBlobStore } from '@rei-standard/amsg-instant/blob/upstash';
const adapter = createUpstashBlobStore(Redis.fromEnv());   // 或直接传 kv
```

**Netlify Functions / Edge**

```js
import { getStore } from '@netlify/blobs';
import { createNetlifyBlobStore } from '@rei-standard/amsg-instant/blob/netlify';
const adapter = createNetlifyBlobStore(getStore('amsg-blobs'));
// Netlify Blobs 没有原生 TTL — adapter 内部用 {body, expiresAt} 包一层；
// 生产记得挂个 Netlify Scheduled Function 周期清理过期 row，模板见 src/blob-store/netlify.js
```

**Postgres（Neon / Supabase / Vercel Postgres / 自建）**

```js
import { Pool } from 'pg';   // 或 @neondatabase/serverless / @vercel/postgres
import { createPostgresBlobStore } from '@rei-standard/amsg-instant/blob/postgres';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = createPostgresBlobStore(pool);
// 需要自建表 + 挂 cron sweeper，schema/SQL 见下方"SQL schema 模板"小节
```

**调试 / 单实例长跑（Memory）**

```js
import { createMemoryBlobStore } from '@rei-standard/amsg-instant/blob/memory';
const adapter = createMemoryBlobStore({ maxEntries: 100 });
// ⚠️ DO NOT use 在任何 serverless（CF Workers / Vercel / Netlify / Lambda）
// —— isolates/instances 之间不共享内存，SW fetch 会命中错 isolate 拿到 404。
// 满容 fail-fast 不做 LRU，避免静默踢掉还在 in-flight 的 envelope key。
```

传给 handler：

```js
createInstantHandler({
  vapid,
  onLLMOutput,
  blobStore: {
    adapter,
    maxInlineBytes: 2600,   // 可省，默认 2600
    ttlSeconds: 60,         // 可省，默认 60
  },
});
```

### 自定义 adapter（任何后端）

实现 `BlobStoreAdapter` 两个方法即可（**`read` 必须是非破坏性 SELECT**，多次读返同样 body —— 让 SW 在 push 重投递时能 fetch 之后再 dedup）：

```ts
interface BlobStoreAdapter {
  put(key: string, body: string, ttlSeconds: number): Promise<void>;
  read(key: string): Promise<string | null>;
}
```

模板（Postgres / Redis 各 ~30 行）：

```ts
function createPostgresBlobStore(pool) {
  return {
    async put(key, body, ttl) {
      await pool.query(
        'INSERT INTO amsg_transient_blobs(key, body, expires_at) VALUES ($1, $2, $3)',
        [key, body, Date.now() + ttl * 1000],
      );
    },
    async read(key) {
      const { rows } = await pool.query(
        'SELECT body FROM amsg_transient_blobs WHERE key=$1 AND expires_at>$2',
        [key, Date.now()],
      );
      return rows[0]?.body ?? null;
    },
  };
}

function createRedisBlobStore(redis) {
  return {
    async put(key, body, ttl) { await redis.set(`amsg:${key}`, body, { EX: ttl }); },
    async read(key) { return redis.get(`amsg:${key}`); },
  };
}
```

### SQL schema 模板 + 强制 cron sweeper

调用方自建（包不替你建表）：

```sql
CREATE TABLE IF NOT EXISTS amsg_transient_blobs (
  key TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  expires_at INTEGER NOT NULL  -- ms timestamp
);
CREATE INDEX IF NOT EXISTS idx_amsg_blobs_expires ON amsg_transient_blobs(expires_at);
```

**production 必须挂 cron sweeper** —— 非破坏性 `read` 不删行，过期未消费的 row 会无限堆积：

```ts
// wrangler.toml
[triggers]
crons = ["*/15 * * * *"]

// worker
export default {
  async scheduled(_event, env) {
    await env.DB.prepare('DELETE FROM amsg_transient_blobs WHERE expires_at < ?')
      .bind(Date.now()).run();
  },
};
```

Redis / Upstash 等带原生 TTL 的后端不用挂；KV 同理。

### Node 反代部署注意

`request.url` 在 nginx / Caddy 反代下默认是内网 host，envelope blobUrl 会推导错。outer router 里用 `X-Forwarded-Proto` / `X-Forwarded-Host` 重建公网 URL 后再传 Request 进来。

---

## Migrating from v0.6

**绝大多数 v0.6 用户什么都不用改**。包升到 0.8.0 后：

- 不配 `onLLMOutput` → 跑 legacy 路径，字节级与 v0.6 一致（同 13 字段 payload、同 1500 ms 间隔、同 `onEvent` 事件）。legacy 路径内部仍按 `/([。！？!?]+)/` 默认句切，**只是**请求 body 上的 `splitPattern` 公共旋钮在 0.8.0 里被移除了（详见 0.8 迁移指南）。
- `messageSubtype`、`metadata` 等所有 v0.6 字段保持原样
- 想自己拼 ContentPush（v0.6 时代会去 monkey-patch `buildInstantPushPayload` 的场景）现在直接用 `buildContentPush(...)` —— 它由 `@rei-standard/amsg-shared` 实现、并从 `@rei-standard/amsg-instant` 原样 re-export，不用额外加依赖

只在你**想用 agentic loop** 的时候才动配置：把 `onLLMOutput` 加进 `createInstantHandler` 入参，里头自己决定 finish / tool-request / continue / skip-push。其他都不需要碰。

---

## Subpath mount

handler 假设独占 URL 根空间。`/continue` 是精确路径匹配，`/blob/${key}` envelope 是 root-anchored（从入站 `request.url` 推导成 `https://host/blob/...`）。如果你想把 amsg 挂到 `/amsg/*` 子前缀下，outer router 必须**同时**做两件事：

```js
if (url.pathname.startsWith('/amsg/')) {
  // /amsg/instant, /amsg/continue: 剥前缀
  const inner = new Request(
    url.origin + url.pathname.slice('/amsg'.length) + url.search,
    request,
  );
  return amsgHandler(inner, env, ctx);
}
if (url.pathname.startsWith('/blob/')) {
  // envelope blobUrl 是 https://host/blob/${key} —— SW fetch 时回到 root，
  // 没法被前缀隔离。outer router 直接路由到 amsg handler，不重写 URL。
  return amsgHandler(request, env, ctx);
}
```

**代价**：`/blob/*` 在 root 被 amsg 永久占用，部署方想给别的服务用这个 path 会冲突。不配 `blobStore` 则只需要 `/amsg/*` 这一条。

不引入 `blobUrlBuilder` 这种回调是有意为之 —— 它只能修 envelope URL 一边，不修路由（`url.pathname === '/continue'` 仍是精确匹配），不如承认双前缀这条限制，配置项越少出错面越小。

---

## 部署示例

### Cloudflare Workers（推荐）

等待 LLM 的 subrequest 时间不计 CPU 配额，多数生产负载在免费层即可跑。

```js
// worker.js
import { createCloudflareWorker } from '@rei-standard/amsg-instant/adapters/cloudflare';

export default createCloudflareWorker((env) => ({
  vapid: {
    email: 'mailto:you@example.com',
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  },
  clientToken: env.AMSG_CLIENT_TOKEN,   // 可选
}));
```

`createCloudflareWorker` 会接住 Workers 的第三个参数 `ctx`。直接把
`createInstantHandler(...)` 挂成 Worker module `fetch` 也支持同样的 `(request, env, ctx)`
形态。

SSE 默认模式下，handler 在 `ReadableStream.start()` 内部把 LLM 调用与每条
payload 的 Web Push backup / fallback 全部驱动完，才关闭流——runtime 把这整段
看作"响应仍在产出"，不会施加 wall-clock 上限。即便客户端中途断开（页面切后台、
iOS Safari 杀掉 SSE socket），剩余 LLM 输出与 fallback HTTP push 仍会跑完。
`ctx.waitUntil` 在这里只是收尾兜底，不承载主回复链路；纯 Web Push 模式（`Accept:
application/json`）的主回复链路会注册到 `ctx.waitUntil`，仍受 runtime 的
`waitUntil` / CPU / wall 上限约束。

```toml
# wrangler.toml
name = "amsg-instant"
main = "worker.js"
compatibility_date = "2024-01-01"
# 0.3.0 起不再需要 compatibility_flags = ["nodejs_compat"]
# 所有 crypto 都走 globalThis.crypto.subtle（Workers 原生支持）

# Secrets — set via:
#   wrangler secret put VAPID_PUBLIC_KEY
#   wrangler secret put VAPID_PRIVATE_KEY
#   wrangler secret put AMSG_CLIENT_TOKEN   # 可选
```

### Node / Express

```js
import express from 'express';
import { createInstantHandler } from '@rei-standard/amsg-instant';
import { toNodeHandler } from '@rei-standard/amsg-instant/adapters/node';

const app = express();

const instantHandler = createInstantHandler({
  vapid: {
    email: 'mailto:you@example.com',
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  },
  clientToken: process.env.AMSG_CLIENT_TOKEN,
});

// 注意：这条路由不要挂 express.json()，处理器自己读 raw body
app.post('/instant', toNodeHandler(instantHandler));
app.listen(3000);
```

Node / Express 本身没有标准 `waitUntil`。如果你的宿主环境额外提供了生命周期钩子，
可以用 `toNodeHandler(instantHandler, { waitUntil })`，或在需要按请求动态取 context 时
用 `{ getRuntime(req, res) { return { waitUntil }; } }`。

### Netlify Functions

> Netlify Functions 默认仍是 Node 18，0.3.0 起 `adapters/node` 在请求入口处自动检测并 polyfill `globalThis.crypto`，无需 caller 做任何事。如果想原生 Web Crypto，把 Function 切到 Netlify Edge 即可。

```js
// netlify/functions/instant.js
import { createInstantHandler } from '@rei-standard/amsg-instant';
import { toNetlifyHandler } from '@rei-standard/amsg-instant/adapters/netlify';

const handler = createInstantHandler({
  vapid: {
    email: 'mailto:you@example.com',
    publicKey: Netlify.env.get('VAPID_PUBLIC_KEY'),
    privateKey: Netlify.env.get('VAPID_PRIVATE_KEY'),
  },
  clientToken: Netlify.env.get('AMSG_CLIENT_TOKEN'),
});

export default toNetlifyHandler(handler);
export const config = { path: '/api/v1/instant' };
```

`toNetlifyHandler` 会把 Netlify 的第二个 `context` 参数透传给 handler；当平台提供
`context.waitUntil` 时，主回复链路会自动挂进去。

### Vercel Functions（Edge Runtime）

```js
// api/instant.js
import { createInstantHandler } from '@rei-standard/amsg-instant';
import { toVercelEdgeHandler } from '@rei-standard/amsg-instant/adapters/vercel';

export const config = { runtime: 'edge' };

const handler = createInstantHandler({
  vapid: {
    email: 'mailto:you@example.com',
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  },
  clientToken: process.env.AMSG_CLIENT_TOKEN,
});

export default toVercelEdgeHandler(handler);
```

`toVercelEdgeHandler` 会透传第二个 context 参数，适配暴露 `context.waitUntil` 的运行时形态。
如果你使用 Vercel 的 `@vercel/functions` helper，则直接把它传给
`createInstantHandler({ ..., waitUntil })` 即可，库本身不会强依赖这个包。

## 浏览器端调用

使用 `@rei-standard/amsg-client` 的 `sendInstant()`，并把 `instantEncryption: false` 打开：

```js
import { ReiClient } from '@rei-standard/amsg-client';

const client = new ReiClient({
  baseUrl: 'https://instant.example.com',   // amsg-instant Worker URL
  instantEncryption: false,
  instantClientToken: 'shared-secret-xyz',  // 可选；Worker 端配了再填
});

// init() 在明文模式下是 no-op，调用与否都可
await client.sendInstant({
  contactName: 'Rei',
  completePrompt: '你是 Rei，用一句话提醒用户带伞',
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '...',
  primaryModel: 'gpt-4o-mini',
  pushSubscription: subscription.toJSON(),
});
```

## 导出

主入口：

- `createInstantHandler(options)`
- `validateInstantPayload(payload)`
- `processInstantMessage(payload, ctx)`
- `normalizeAiApiUrl(apiUrl)` — 0.4.0 新增，幂等地补全 `/v1/chat/completions`
- `sendWebPush({ subscription, payload, vapid, ttl?, fetch? })` — 0.3.0 新增，纯 Web Crypto 实现
- `buildVapidJwt({ audience, subject, publicKey, privateKey })` / `verifyVapidJwt(jwt, publicKey)` — 0.3.0 新增
- `buildMultipartPushPayloads(payload, { maxChunkBytes?, id?, ttlMs? })` — 0.8.0 新增，构造 generic `_multipart` transport payloads

子路径：

- `@rei-standard/amsg-instant/adapters/cloudflare` — `createCloudflareWorker(optionsBuilder)`
- `@rei-standard/amsg-instant/adapters/node`       — `toNodeHandler(fetchHandler, options?)`
- `@rei-standard/amsg-instant/adapters/netlify`    — `toNetlifyHandler(fetchHandler)`
- `@rei-standard/amsg-instant/adapters/vercel`     — `toVercelEdgeHandler(fetchHandler)` / `toVercelNodeHandler`

## 相关链接

- [Root README](https://github.com/Tosd0/ReiStandard/blob/main/README.md)
- [amsg-server README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/README.md)
- [amsg-client README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md)
- [amsg-sw README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md)
- [API 技术规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)
