# @rei-standard/amsg-instant

**零运行时依赖**的无状态明文一次性即时推送处理器：整个生命周期 = 一次 HTTP 函数调用（解析 → 调 LLM → 分句 → 发 Web Push → 返回 200）。无数据库、无 cron、无租户初始化。从 0.3.0 起 RFC 8291 (`aes128gcm`) payload 加密和 RFC 8292 VAPID JWT 由内置实现完成，不再需要 `web-push` / Node `crypto`。

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
| `blobStore`         | object    | ❌   | **0.7.0+**：可选 blob 后端。push payload UTF-8 字节超过 `maxInlineBytes`（默认 2600）时自动把 body 写进 store、改推 200 B envelope。见 [BlobStore](#blobstore070) |
| `maxLoopIterations` | number    | ❌   | **0.7.0+**：单次 worker 调用内 `decision:'continue'` 的硬上限，默认 10。仅防本进程内 hook 反复 continue 失控；跨请求的 `/continue` 洪水攻击由上游 auth/rate-limit 处理 |
| `autoEmitReasoning` | boolean   | ❌   | **0.8.0+**：默认 `true`。`true` 时框架在调 hook 前自动 emit `ReasoningPush`（如果 LLM 响应带非空 `reasoning_content`）。`false` 把 reasoning emit 完全交给 hook 自己负责（hook 可读 `ctx.llmResponse.choices[0].message.reasoning_content` 并用 `buildReasoningPush` + 自己 dispatch）。legacy 路径忽略此项始终自动 emit。 |
| `reasoningChunkBytes` | number \| null | ❌ | **0.8.0-next.2+**：`ReasoningPush.reasoningContent` 的 UTF-8 字节上限。默认 `2000` — reasoning 超 2 KB 时框架按 codepoint 边界切成 N 份带 `chunkIndex` / `totalChunks` 投递，SW 拼接还原。设 `null` 禁用字节切（超限走 BlobStore 或抛 `PAYLOAD_TOO_LARGE`）。构造期校验范围 `[500, maxInlineBytes - 600]`，不合法抛 `TypeError`。详见 [Reasoning chunking](#reasoning-chunking080-next2)。 |

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

### `createInstantHandler(options) → (request: Request) => Promise<Response>`

返回标准 Web Fetch API handler。直接挂到 Cloudflare Workers / Deno Deploy / Vercel Edge / Bun，或用下方四个 adapter 接到 Node / Netlify。

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

**请求**：

```http
POST /instant
Authorization: Bearer <jwt>     ← 仅当 tokenSigningKey 配置时检查
X-Client-Token: <token>         ← 仅当 clientToken 配置时检查
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
  avatarUrl?: string | null;        // 0.7.1+ / 0.8.0-next.1+：不合法值（data: URI / 长度 > 2KB / 非字符串）软清空 + console.warn，整次推送不再 fail

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

  // === 分句正则（按 messageKind 独立配置），可选 ===
  splitPattern?: string | string[] | null;            // content / tool_request：默认 /([。！？!?]+)/，null/[] 关闭
  reasoningSplitPattern?: string | string[] | null;   // 0.8.0-next.2+，reasoning：默认不切；传了就按这个切
  errorSplitPattern?: string | string[] | null;       // 0.8.0-next.2+，error：默认不切；传了就按这个切

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

#### `splitPattern` 系列：按 `messageKind` 独立的分句正则（0.6.0+ / 0.8.0-next.2+）

LLM 返回的整段文本默认按 `/([。！？!?]+)/` 切成多条推送（每条之间间隔 1.5s，看起来像真人一句句打字）。三个字段各管一类 push 的切分：

| 字段                      | 控制的 `messageKind`           | 默认（字段省略时）         |
|---------------------------|--------------------------------|----------------------------|
| `splitPattern`            | `content` / `tool_request`     | `/([。！？!?]+)/`（开）    |
| `reasoningSplitPattern`   | `reasoning`                    | **不切**                   |
| `errorSplitPattern`       | `error`                        | **不切**                   |

```jsonc
// 单正则：按换行切
{ "splitPattern": "([\\n]+)" }

// 数组：级联——先按段落切，每段再按句号切
{ "splitPattern": ["(\\n\\n+)", "([。！？!?]+)"] }

// reasoning 长文本想切气泡：默认不切，得显式传
{ "reasoningSplitPattern": "([。！？!?]+)" }

// 关闭 content 的默认切分（整段一条 push）
{ "splitPattern": null }
```

**`ToolRequestPush` 切片特殊处理**：`toolCalls` 是原子数组不切。`message` 切成 N 段时前 N-1 段降级为 `messageKind: 'content'`（不带 `toolCalls`），最后一段保留 `tool_request` + 完整 `toolCalls`，保证 narration 全显示完再启动 tool 执行。

**通用约定**：

- 传**正则 source**，不要带两边的 `/.../` 也不要带尾部 flag（`/foo/i` 会被当字面量斜杠 + 字面量 `i` 匹配）。需要大小写不敏感请用 `[Aa]` 这种字符类替代。
- 想保留分隔符（默认就是把句号回贴到前一段），把分隔符包进 `(...)` 捕获组。库不会自动包——传 `"\\n+"` 而不是 `"(\\n+)"` 会得到首尾相连、分隔符丢失的奇怪结果。
- 数组语义是**级联**（split → split → split），不是"任一匹配就切"。需要后者请用 `|` 自己合一条正则。
- 上限：每项 ≤ 200 字符，数组 ≤ 10 项；非法或无法 `new RegExp(...)` 通过 → `400 INVALID_PAYLOAD_FORMAT`。
- **`undefined` vs `null` / `[]` 语义不同**：
  - `splitPattern`：`undefined` = 用默认正则；`null` / `[]` = 关闭切分。
  - `reasoningSplitPattern` / `errorSplitPattern`：`undefined` = 不切（保守默认）；`null` / `[]` 也是不切（显式关闭，效果一样）。这俩 kind 默认 off，是因为它们历史上就没切片 UX，引入 default-on 会改老 caller 行为。

##### Per-push override：`pushPayload.splitPattern`（0.8.0-next.3+）

在 hook 模式下，`onLLMOutput` 返回的 `pushPayload` 自身可以带一个 `splitPattern` 字段，作用域只限**这一个 push**。它优先于请求级的 `splitPattern` / `reasoningSplitPattern` / `errorSplitPattern`，规则比请求级简单一些：

- **字段名永远是 `splitPattern`**，不分 kind——因为 push 自己的 `messageKind` 已经定了。`reasoning` push 想切片，写 `pushPayload.splitPattern: '(...)'` 即可（无需 `reasoningSplitPattern`）。
- **优先级 / 语义区分 `undefined` vs `null`**：
  - 写 `splitPattern: null`（或 `[]`）= **显式关切**（这一个 push 不切，请求级被盖住）。
  - 写 `splitPattern: '(...)'` / `splitPattern: ['(\\n+)', '(...)']` = **显式开切**（用这套正则切，请求级被盖住）。
  - `splitPattern: undefined` 或字段缺省 = **没意见**，回退到请求级 `splitPattern` / `reasoningSplitPattern` / `errorSplitPattern`。
- **校验**：与请求级共享 `validateSplitPattern`——形状或正则非法 → 抛 `HookError`，message 形如 `pushPayload.splitPattern invalid: <原因>`，明确点位是 push 上的字段（不会跟请求级混）。
- **wire 不带这个字段**：库会在交付前把它从 chunks 里 strip 掉，SW 永远收不到 `splitPattern`。strip 一次性完成——`splitHookPushPayload` 每个 push 跑一次，N-段切片 / ToolRequestPush 的 prefix 降级段都从已剥离的 parent spread，不会被二次切。

```js
onLLMOutput: async (ctx) => ({
  decision: 'finish',
  pushPayload: {
    ...buildContentPush({ /* ... */ }),
    splitPattern: null, // 这一段不切——即使请求级的 splitPattern 是开着的
  },
});
```

什么时候用：hook 想让某一类 push（比如「短促回复」「错误提示」）整段送出，而其他 push 仍按请求级配置切分。如果你想全局关闭，仍然直接在请求 body 上传 `splitPattern: null` 更省事。

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

**响应**（成功）：

```json
{
  "success": true,
  "data": {
    "messagesSent": 3,
    "sentAt": "2026-05-16T12:34:56.789Z"
  }
}
```

**响应**（失败）：

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
| `HOOK_THREW`                                  | 500  | 0.7 | `onLLMOutput` 抛错或返了非法 decision（`null` / 不识别的 `decision` 值 / `pushPayload` 不可 JSON-serialize）。同时会推一条诊断 push（payload `{type:'error', code:'HOOK_THREW',...}`） |
| `PAYLOAD_TOO_LARGE`                           | 500  | 0.7 | hook 返的 `pushPayload` UTF-8 字节超 `maxInlineBytes` 且没配 `blobStore`。配上 BlobStore 自动走 envelope 转发 |
| `CONTINUE_NOT_AVAILABLE`                      | 400  | 0.7 | 往没配 `onLLMOutput` 的 handler POST `/continue`。`/continue` 是 agentic loop 的续跑端点，没钩子就没东西可续，直接拒掉避免误报成 `HOOK_THREW` |
| `INTERNAL_ERROR`                              | 500  | 0.1 | 其他未分类内部错误 |

**`LOOP_EXCEEDED` 不是错误码** —— hook 反复返 `decision:'continue'` 超 `maxLoopIterations` 时，worker 返 HTTP **200** + body `{ success: true, data: { status: 'loop_exceeded', sessionId, iteration } }`，并向 SW 推一条 `{type:'error', code:'LOOP_EXCEEDED',...}` 诊断 envelope。HTTP 层是正常完成，不会让客户端误重试。

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
- **配了 `onLLMOutput`** → 进 agentic loop，每轮 LLM 输出后调 hook 做 decision；hook 返什么就执行什么。`splitPattern` 在这条路径下不会被读，启动期会 `console.warn` 提示。

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
  | { decision: 'finish';       pushPayload: unknown }      // 推送 final，结束链路
  | { decision: 'tool-request'; pushPayload: unknown }      // 推送 tool-request，等 /continue
  | { decision: 'continue';     nextHistory: ChatMessage[] } // worker 内部再来一轮 LLM，不推送
  | { decision: 'skip-push' }                                // 直接结束链路、不推送（罕见）
```

`pushPayload` 必须 **JSON-safe**（无循环引用 / BigInt / function 字段），否则被当作 hook 契约违反走 `HookError` / `HOOK_THREW` 路径。

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
2. 用 `sendPushWithMaybeBlob` 推一条 `{ type:'error', code:'LOOP_EXCEEDED', sessionId, iteration }` envelope
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
  if (data.type !== 'tool-request') return handle(data);

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

### 事件分类（0.7.0+）

事件统一用**直接 type 名**做 discriminator（不再混 `error+code` 二级嵌套）：

- **进度**：`llm_start` / `llm_done` / `final_pushed` / `tool_request_pushed` / `continue_received` / `blob_written`
- **软失败**（链路可继续 / 自愈）：`blob_put_failed` / `blob_orphaned` / `diagnostic_push_failed` / `payload_too_large`
- **硬错误**（worker 中止链路）：`hook_threw` / `loop_exceeded` / `llm_call_failed`

**push payload（SW 收到的 wire format）仍用 `{type:'error', code:'...'}`** —— SW 路由按"先看大类、再看 code"更顺手，跟事件分类是独立两层。

---

## Reasoning chunking（0.8.0-next.2+）

reasoning-heavy LLM（DeepSeek-R1 / GLM-4.5 / Qwen3-Thinking 等）经常输出 3-10 KB `reasoning_content`，远超 Web Push 单 payload ~2.6 KB 安全线。next.2 内置 transparent 字节切分：framework 在产出 `ReasoningPush` 时自动按 UTF-8 codepoint 边界切成 N 份带 `chunkIndex` / `totalChunks` 投递，SW 拼回完整字符串。**绝大多数 reasoning-heavy 部署不再需要 BlobStore。**

### 两层 cascade

```
reasoningContent
        │
        ▼
Layer 1 — 语义切（reasoningSplitPattern，默认 OFF）
  • 按 regex 切成 M 段，每段带 messageIndex 1..M / totalMessages M
        │
        ▼  对每个 Layer-1 段独立量字节
Layer 2 — 字节切（reasoningChunkBytes，默认 ON，2000 B）
  • 段字节 ≤ 阈值：单 push（不写 chunkIndex / totalChunks）
  • 段字节 > 阈值：codepoint 边界切成 N 份，每片带 chunkIndex 1..N / totalChunks N
        │
        ▼
serial dispatch via sendPushWithMaybeBlob
  • 同段 Layer-2 chunk 间间隔 100 ms（transport-only）
  • Layer-1 段间间隔 1500 ms（typing-bubble UX）
```

### 默认配置 = 透明

零配置就 work：

```js
createInstantHandler({
  vapid: { ... },
  onLLMOutput: hook,
  // reasoningChunkBytes 默认 2000 — 不需要配
});
```

- 短 reasoning（< 2000 B）：单 push，wire 跟 next.1 byte-for-byte 一致。
- 长 reasoning（> 2000 B）：自动切分，老 SW 拿到不带 `chunkIndex` 的单 push 走老路径；新 SW 看到 `chunkIndex` / `totalChunks` 走累积拼接。

### 显式禁用 byte chunking

```js
createInstantHandler({
  vapid: { ... },
  onLLMOutput: hook,
  reasoningChunkBytes: null,  // 关闭 Layer 2
  blobStore: { adapter: ... }, // 大 reasoning 走 envelope，没配 blobStore 会抛 PAYLOAD_TOO_LARGE
});
```

`reasoningSplitPattern` 和 `reasoningChunkBytes` 是**两个独立开关**：
- `reasoningSplitPattern: null` 只关 Layer 1（句切），不影响 Layer 2 字节切。
- `reasoningChunkBytes: null` 只关 Layer 2（字节切），不影响 Layer 1 句切。

### Wire format

#### 单 chunk（≤ 阈值，无 Layer 1） — 跟 next.1 完全一致

```json
{
  "messageKind": "reasoning",
  "messageType": "instant",
  "source": "instant",
  "messageId": "msg_<uuid>_iter_0_reasoning",
  "sessionId": "sess_abc",
  "timestamp": "2026-05-20T12:00:00Z",
  "reasoningContent": "short reasoning…"
}
```

#### Pure Layer 2（无句切，大 reasoning）

```json
// Chunk 1 of 3
{
  "messageKind": "reasoning",
  "messageId": "msg_<uuid>_iter_0_reasoning_chunk_1",
  "sessionId": "sess_abc",
  "chunkIndex": 1,
  "totalChunks": 3,
  "reasoningContent": "first 2000 bytes…"
}
```

#### Cascade（Layer 1 + Layer 2）

```json
// Layer-1 段 2/3，Layer-2 chunk 1/3
{
  "messageKind": "reasoning",
  "messageId": "msg_<uuid>_iter_0_reasoning_chunk_1",
  "sessionId": "sess_abc",
  "messageIndex": 2,
  "totalMessages": 3,
  "chunkIndex": 1,
  "totalChunks": 3,
  "reasoningContent": "first 2000 bytes of sentence 2…"
}
```

### SW 端拼接合约

```js
// 伪代码 — 在 SW 的 'push' 事件 handler 里
const buffers = new Map();   // sessionId → { [messageIndex]: { chunks: Map<chunkIndex,text>, total: number } }

function onReasoningPush(p) {
  // Single-shot — neither axis present. 直接消费。
  if (p.chunkIndex === undefined && p.messageIndex === undefined) {
    return deliverComplete(p.sessionId, p.reasoningContent);
  }

  // 按 (sessionId, messageIndex) 分桶 — messageIndex 不存在视作 0。
  const segIdx = p.messageIndex ?? 0;
  const segTotal = p.totalMessages ?? 1;
  const chunkIdx = p.chunkIndex ?? 1;
  const chunkTotal = p.totalChunks ?? 1;

  const bySession = buffers.get(p.sessionId) ?? new Map();
  buffers.set(p.sessionId, bySession);
  const seg = bySession.get(segIdx) ?? { chunks: new Map(), total: chunkTotal };
  seg.chunks.set(chunkIdx, p.reasoningContent);
  bySession.set(segIdx, seg);

  // 检查所有 segIdx 1..segTotal 都到齐 + 每段 chunks 1..total 都到齐 → 拼接消费。
  if (bySession.size === segTotal &&
      [...bySession.values()].every(s => s.chunks.size === s.total)) {
    const full = [...bySession.entries()]
      .sort(([a],[b]) => a - b)
      .map(([_, s]) => [...s.chunks.entries()].sort(([a],[b]) => a - b).map(([_, t]) => t).join(''))
      .join('');
    deliverComplete(p.sessionId, full);
    buffers.delete(p.sessionId);
  }
}
```

**关键不变量**：
- `chunkIndex` / `totalChunks` 仅在 byte 切实际发生（N > 1）时出现，单 chunk 一律省略。
- `messageIndex` / `totalMessages` 仅在 `reasoningSplitPattern` 实际切了（M > 1）时出现。
- Web Push 到达顺序**不保证**，SW 必须按 `chunkIndex` 排序。
- 跨 sessionId 不要混。每个 LLM round 一个 sessionId。

### 事件

framework 在 Layer 2 实际触发时 fire 一次 `reasoning_chunked`：

```js
onEvent: (e) => {
  if (e.type === 'reasoning_chunked') {
    console.log(`session=${e.sessionId} bytes=${e.totalBytes} chunks=${e.totalChunks} iter=${e.iteration}`);
  }
}
```

Layer 1 单独的句切不 fire 此事件（用户自己配的，可观测性走业务日志）。

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
| 纯文本 / 副作用 push，无 reasoning | 0.5–1.5 KB | 2 KB | 3 KB |
| 副作用 push + reasoning chain | 1–2.5 KB | 3 KB | 4–5 KB（撞线） |
| tool-request push（带本轮 LLM 原文） | 0.8–1.8 KB | 2.5 KB | 3.5 KB |
| tool-request + reasoning | 1.5–3 KB | 4 KB（临界） | 5–6 KB（超） |

→ **90 % 场景直传安全**，但开 reasoning / 长输出的 p90-p99 会超。0.8.0-next.2 引入 [reasoning byte chunking](#reasoning-chunking080-next2) 后，reasoning 超限的场景默认自动切分不再依赖 BlobStore；`BlobStore` 主要是 ContentPush / ToolRequestPush 超限的兜底（以及 reasoning byte chunking 被显式关闭时的 fallback）：超限 payload 写到外部存储，push 只推 ~200 B envelope `{ _blob:true, key, url, type? }`，SW 端 `GET ${url}` 拿真 body。

### 何时启用 / 何时跳过

| 场景 | 推荐 |
|---|---|
| 不配 `onLLMOutput`（v0.6 legacy 路径） | **不需要配** —— 分句拆出来每段都 < 1 KB |
| agentic loop，只用 reasoning，不带长 ContentPush | **不需要配** —— next.2 起 reasoning 自动 byte chunking，2 KB / chunk |
| agentic loop，ContentPush 偶尔很长（代码块 / 长答案） | 推荐配 |
| 显式关闭 `reasoningChunkBytes: null` | **强烈推荐** —— 大 reasoning 兜底走 envelope |
| 任何 tool-request 流程 | 推荐配（toolCalls + narration 偶尔会撞线） |
| 一次推完整 history | **必须配** —— 必超 |

**不配 + 超限的行为**：抛 `PayloadTooLargeError` + emit `payload_too_large`，不静默截断。调用方据此决定要不要上 BlobStore。

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

**绝大多数 v0.6 用户什么都不用改**。包升到 0.7.0 后：

- 不配 `onLLMOutput` → 跑 legacy 路径，字节级与 v0.6 一致（同 13 字段 payload、同 1500 ms 间隔、同 `splitPattern`、同 `onEvent` 事件）
- `splitPattern` 数组、`messageSubtype`、`metadata` 等所有 v0.6 字段保持原样
- `buildInstantPushPayload` 现在是 public helper —— 你的 v0.6 测试如果之前 monkey-patch 过它，现在可以直接 import

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
- `splitMessageIntoSentences(text)`
- `processInstantMessage(payload, ctx)`
- `normalizeAiApiUrl(apiUrl)` — 0.4.0 新增，幂等地补全 `/v1/chat/completions`
- `sendWebPush({ subscription, payload, vapid, ttl?, fetch? })` — 0.3.0 新增，纯 Web Crypto 实现
- `buildVapidJwt({ audience, subject, publicKey, privateKey })` / `verifyVapidJwt(jwt, publicKey)` — 0.3.0 新增

子路径：

- `@rei-standard/amsg-instant/adapters/cloudflare` — `createCloudflareWorker(optionsBuilder)`
- `@rei-standard/amsg-instant/adapters/node`       — `toNodeHandler(fetchHandler)`
- `@rei-standard/amsg-instant/adapters/netlify`    — `toNetlifyHandler(fetchHandler)`
- `@rei-standard/amsg-instant/adapters/vercel`     — `toVercelEdgeHandler(fetchHandler)` / `toVercelNodeHandler`

## 相关链接

- [Root README](https://github.com/Tosd0/ReiStandard/blob/main/README.md)
- [amsg-server README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/README.md)
- [amsg-client README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md)
- [amsg-sw README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md)
- [API 技术规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)
