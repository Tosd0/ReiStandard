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
  avatarUrl?: string | null;
  completePrompt: string;          // 必填（amsg-instant 不支持 fixed/auto）
  apiUrl: string;                  // OpenAI 兼容端点；详见下方"apiUrl 规范化"
  apiKey: string;
  primaryModel: string;
  maxTokens?: number;
  messageSubtype?: string;         // SW 端分类标签，取值由业务决定
  pushSubscription: {              // Web Push 标准订阅
    endpoint: string;
    keys: { p256dh: string; auth: string };
  };
  metadata?: Record<string, any>;  // 透传到 push payload
}
```

`firstSendTime` 和 `recurrenceType` 在 `amsg-instant` 上是**非法字段**，会直接返回 `INVALID_PAYLOAD_FORMAT`。

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

| Code                              | HTTP | 说明 |
|-----------------------------------|------|------|
| `METHOD_NOT_ALLOWED`              | 405  | 非 POST |
| `UNAUTHORIZED`                    | 401  | tokenSigningKey 校验失败 |
| `INVALID_CLIENT_TOKEN`            | 401  | clientToken 校验失败（缺头或不匹配） |
| `INVALID_PAYLOAD_FORMAT`          | 400  | body 不是合法 JSON 或字段缺失/非法 |
| `VAPID_CONFIG_ERROR`              | 500  | VAPID 配置缺失 |
| `LLM_CALL_FAILED`                 | 502  | 上游 LLM 请求失败 |
| `PUSH_SEND_FAILED`                | 502  | Web Push 派送失败 |

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
