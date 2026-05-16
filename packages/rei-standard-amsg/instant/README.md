# @rei-standard/amsg-instant

一次性即时消息的无状态处理器：整个生命周期 = 一次 HTTP 函数调用（解密 → 调 LLM → 分句 → 发 Web Push → 返回 200）。无数据库、无 cron、无租户初始化，唯一依赖是 `web-push`。

存在意义是把 amsg-client / amsg-server / amsg-sw 三端的加密协议与 push payload 契约锁在同一个版本号下：升级一个 `amsg-instant` 等于三端同步升级，下游不必自己复刻协议细节。

## 选哪个包？

| 用途                                 | 包                  |
|--------------------------------------|---------------------|
| 一次性即时推送（按钮触发 → 通知）    | **amsg-instant**    |
| 指定时间的定时消息                   | amsg-server         |
| 周期性消息（每日/每周）              | amsg-server         |
| 全都要                               | 两个都装，共用 VAPID + masterKey |

`amsg-server` 的 `instant` 分支保留兼容、行为不变；新代码请用本包。

## 安装

```bash
npm install @rei-standard/amsg-instant web-push
```

## 配置项

| 选项                | 类型      | 必填 | 说明 |
|---------------------|-----------|------|------|
| `vapid.email`       | string    | ✅   | VAPID 联系邮箱，自动补 `mailto:` 前缀 |
| `vapid.publicKey`   | string    | ✅   | VAPID 公钥 |
| `vapid.privateKey`  | string    | ✅   | VAPID 私钥 |
| `masterKey`         | string    | ✅   | 64 字符 hex（32 字节熵），用于派生用户加密密钥 |
| `tokenSigningKey`   | string    | ❌   | 提供则校验 `Authorization: Bearer <jwt>`；省略则放行 |
| `webpush`           | object    | ❌   | 注入 web-push 模块（测试用） |
| `fetch`             | function  | ❌   | 自定义 fetch（测试 / 自建代理用） |
| `onEvent`           | function  | ❌   | 事件钩子：`request` / `llm_done` / `push_sent` / `error` |

生成 masterKey：

```bash
openssl rand -hex 32
```

> **⚠️ 兼容性提醒**：如果你同时部署 `amsg-server`，`amsg-instant` 的 `masterKey` 必须和 `amsg-server` **同一租户**的 masterKey 一致（amsg-server 的 masterKey 在 Blob 里，初始化时由 `init-tenant` 返回；自部署单租户时把它原样喂给 amsg-instant 即可）。这样 `@rei-standard/amsg-client` 用同一个 `userKey` 加密一次，就能同时发到两个 endpoint。

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
  masterKey: process.env.AMSG_MASTER_KEY,
});
```

### HTTP 协议

**请求**：

```http
POST /instant
Authorization: Bearer <tenantToken>     ← 仅当 tokenSigningKey 配置时检查
Content-Type: application/json
X-User-Id: <uuid v4>
X-Payload-Encrypted: true
X-Encryption-Version: 1

{ "iv": "...", "authTag": "...", "encryptedData": "..." }
```

**解密后的 payload（与 `amsg-server` instant 分支字段命名一致）**：

```ts
{
  contactName: string;
  avatarUrl?: string | null;
  completePrompt: string;          // 必填（amsg-instant 不支持 fixed/auto）
  apiUrl: string;                  // OpenAI 兼容完整端点
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
| `ENCRYPTION_REQUIRED`             | 400  | 缺 `X-Payload-Encrypted: true` |
| `USER_ID_REQUIRED`                | 400  | 缺 `X-User-Id` |
| `INVALID_USER_ID_FORMAT`          | 400  | `X-User-Id` 不是 UUID v4 |
| `UNSUPPORTED_ENCRYPTION_VERSION`  | 400  | `X-Encryption-Version` ≠ `1` |
| `INVALID_PAYLOAD_FORMAT`          | 400  | envelope / payload 字段缺失或非法 |
| `DECRYPTION_FAILED`               | 400  | AES auth tag 校验失败等 |
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
  masterKey: env.AMSG_MASTER_KEY,
}));
```

```toml
# wrangler.toml
name = "amsg-instant"
main = "worker.js"
compatibility_date = "2026-01-01"
compatibility_flags = ["nodejs_compat"]

# Secrets — set via:
#   wrangler secret put VAPID_PUBLIC_KEY
#   wrangler secret put VAPID_PRIVATE_KEY
#   wrangler secret put AMSG_MASTER_KEY
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
  masterKey: process.env.AMSG_MASTER_KEY,
});

// 注意：这条路由不要挂 express.json()，处理器自己读 raw body
app.post('/instant', toNodeHandler(instantHandler));
app.listen(3000);
```

### Netlify Functions

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
  masterKey: Netlify.env.get('AMSG_MASTER_KEY'),
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
  masterKey: process.env.AMSG_MASTER_KEY,
});

export default toVercelEdgeHandler(handler);
```

## 浏览器端调用

使用 `@rei-standard/amsg-client` 的 `sendInstant()`：

```js
import { ReiClient } from '@rei-standard/amsg-client';

const client = new ReiClient({
  baseUrl: '/api/v1',                              // amsg-server 部署（取 userKey）
  customBaseUrls: {
    instant: 'https://instant.example.com',        // amsg-instant 部署
  },
  userId: '550e8400-e29b-41d4-a716-446655440000',
});

await client.init();

const result = await client.sendInstant({
  contactName: 'Rei',
  completePrompt: '你是 Rei，用一句话提醒用户带伞',
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '...',
  primaryModel: 'gpt-4o-mini',
  pushSubscription: subscription.toJSON(),
});

console.log(result); // { messagesSent: 3, sentAt: '...' }
```

## 导出

主入口：

- `createInstantHandler(options)`
- `deriveUserEncryptionKey(userId, masterKey)`
- `decryptPayload(envelope, userKey)`
- `isValidUUIDv4(s)`
- `validateInstantPayload(payload)`
- `splitMessageIntoSentences(text)`
- `processInstantMessage(payload, ctx)`

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
