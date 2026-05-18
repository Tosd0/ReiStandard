# @rei-standard/amsg-client

`@rei-standard/amsg-client` 是 ReiStandard 主动消息标准的浏览器端 SDK 包，负责加密请求、解密响应和 Push 订阅。


## 安装

```bash
npm install @rei-standard/amsg-client
```

## 快速使用

```js
import { ReiClient } from '@rei-standard/amsg-client';

const client = new ReiClient({
  baseUrl: '/api/v1',
  userId: '550e8400-e29b-41d4-a716-446655440000'
});

await client.init();

await navigator.serviceWorker.register('/service-worker.js');
const registration = await navigator.serviceWorker.ready;
const subscription = await client.subscribePush(
  window.__VAPID_PUBLIC_KEY__,
  registration
);

await client.scheduleMessage({
  contactName: 'Rei',
  messageType: 'fixed',
  userMessage: '下班记得带伞～',
  firstSendTime: new Date(Date.now() + 60 * 1000).toISOString(),
  recurrenceType: 'none',
  pushSubscription: subscription.toJSON()
});
```

## 发送即时消息

新代码用 `client.sendInstant(payload)`，走 [`@rei-standard/amsg-instant`](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/instant/README.md)。

### 加密模式（默认；兼容 amsg-server / amsg-instant 0.1.x）

```js
const client = new ReiClient({
  baseUrl: '/api/v1',
  customBaseUrls: {
    instant: 'https://instant.example.com',              // 不传则用 baseUrl
  },
  userId: '550e8400-e29b-41d4-a716-446655440000',
});

await client.init();

await client.sendInstant({
  contactName: 'Rei',
  completePrompt: '你是 Rei，用一句话提醒用户带伞',
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '...',
  primaryModel: 'gpt-4o-mini',
  pushSubscription: subscription.toJSON(),
});
```

> `customBaseUrls` 是按端点名（如 `instant`）覆盖 `baseUrl` 的通用机制；后续其他端点也可以用同一字段独立指定 base URL，不会再加新的命名字段。

### 明文模式（配 amsg-instant 0.2.x，单租户自部署）

```js
const client = new ReiClient({
  baseUrl: 'https://instant.example.com',   // amsg-instant Worker URL
  instantEncryption: false,
  instantClientToken: 'shared-secret-xyz',  // 可选；Worker 端配了再填
});

// init() 在明文模式下是 no-op，调用与否都跑得通
await client.sendInstant({
  contactName: 'Rei',
  completePrompt: '你是 Rei，用一句话提醒用户带伞',
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '...',
  primaryModel: 'gpt-4o-mini',
  pushSubscription: subscription.toJSON(),
});
```

> ⚠️ **`instantClientToken` 是弱共享密钥**：它会随前端 bundle 发出去，devtools 一开就能看到。它只防 URL 直接被脚本小子打，不防有心人。要真正的鉴权，用 amsg-instant 的 `tokenSigningKey`（HMAC JWT，配合后端签发短期 token）。

> ⚠️ **双模式陷阱**：`instantEncryption: false` 时 `init()` 变成 no-op，`scheduleMessage` / `listMessages` / `updateMessage` 这类**仍走加密**的方法会因 `userKey` 没初始化抛 "Not initialised"。如果同一前端既要 `sendInstant`（明文走 amsg-instant）又要 `scheduleMessage`（加密走 amsg-server），请改回 `instantEncryption: true`（默认）—— amsg-instant 0.1.x 与 amsg-server 用同一份 `userKey` 都吃得下。

旧路径 `scheduleMessage({ ...payload, messageType: 'instant' })` 仍然可用（兼容保留，多一次 DB 来回）。

### `messages` 模式（多轮上下文 / 带 system role，对接 amsg-instant 0.5.0+ / amsg-server 2.2.0+）

需要 system role、保留多轮历史、tool role 这些场景时，把 `completePrompt` 换成标准 OpenAI 格式的 `messages` 数组。client 本身**完全透传**，所以 SDK 端零额外配置：

```js
await client.sendInstant({
  contactName: 'Rei',
  messages: [
    { role: 'system', content: '你是 Rei，回复要简短自然。' },
    { role: 'user', content: '今天会下雨吗？' },
    { role: 'assistant', content: '看了下，下午有阵雨。' },
    { role: 'user', content: '那提醒我一下带伞' },
  ],
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '...',
  primaryModel: 'gpt-4o-mini',
  temperature: 0.7,                                  // 可选
  pushSubscription: subscription.toJSON(),
});
```

注意 `completePrompt` 和 `messages` **必须恰好二选一**——两者同时给会被 Worker / Server 端返回 `400 INVALID_PAYLOAD_FORMAT` / `INVALID_PARAMETERS`。`scheduleMessage` 也接受同样的 `messages` 字段（amsg-server 2.2.0+ 起持久化层一并支持），用法相同。

### `splitPattern` 自定义分句正则（对接 amsg-instant 0.6.0+ / amsg-server 2.3.0+）

LLM 返回的整段文本默认按 `/([。！？!?]+)/` 切成多条推送。要换成别的正则（按换行、按段落、自定义符号……）就在 payload 里加 `splitPattern`：

```js
// 单正则：按换行切
await client.sendInstant({
  contactName: 'Rei',
  completePrompt: '...',
  splitPattern: '([\\n]+)',
  // 其余字段同上
});

// 数组级联：先按段落，每段再按句号
await client.sendInstant({
  contactName: 'Rei',
  completePrompt: '...',
  splitPattern: ['(\\n\\n+)', '([。！？!?]+)'],
});
```

`splitPattern` 类型是 `string | string[]`。`scheduleMessage` 也支持，`updateMessage` 可显式传 `splitPattern: null` 重置回默认。client SDK 完全透传不校验，所有错误在 Worker / Server 端返回（每项 ≤ 200 字符、数组 ≤ 10 项、必须能 `new RegExp()` 通过）。

**两个常见 footgun**：

- 传**正则 source**，不要带 `/.../` 也不要尾 flag。`'/foo/i'` 会被当字面量斜杠 + 字面量 `i`，不是大小写不敏感的 `foo`。大小写不敏感请用 `[Aa]` 字符类替代。
- 想让分隔符回贴到前一段（默认行为），把分隔符包进 `(...)` 捕获组。库**不会自动包**——传 `'\\n+'` 而不是 `'(\\n+)'` 会得到首尾相连、分隔符丢失的奇怪结果。

### 本地预校验：`avatarUrl` 与 payload 体积（2.2.3+）

`scheduleMessage` / `sendInstant` / `updateMessage` 在发请求**之前**会在本地做两项预检，避免一次远端往返才拿到 `413` 或 Web Push 4KB 上限报错：

| 触发条件 | 抛出 `Error.code` | 触发原因（背景说明，不在 message 里） |
| --- | --- | --- |
| `payload.avatarUrl` 以 `data:` 开头（含 `data:image/...;base64,...`） | `INVALID_AVATAR_URL_LOCAL` | base64 内嵌头像把单个 push payload 撑到几十 KB，远端 Web Push 服务直接返回 4KB 超限 / 网关 `413`。 |
| `payload.avatarUrl` 长度 > 2048 字符 | `INVALID_AVATAR_URL_LOCAL` | 同上。建议用 CDN 缩略图 URL。 |
| `payload.avatarUrl` 不是字符串 | `INVALID_AVATAR_URL_LOCAL` | 类型错误。 |
| `JSON.stringify(payload)` UTF-8 字节数 > 3072 | `PAYLOAD_TOO_LARGE_LOCAL` | 远端网关 / Web Push 4KB 硬上限的本地兜底。错误对象带 `.details = { method, actualBytes, limitBytes }` 方便定位。 |

```js
try {
  await client.sendInstant(payload);
} catch (err) {
  if (err.code === 'INVALID_AVATAR_URL_LOCAL') {
    // err.message 形如「头像不支持传入 data: URI，请改为公网可访问的 https:// 图片 URL」
  } else if (err.code === 'PAYLOAD_TOO_LARGE_LOCAL') {
    // err.details = { method: 'sendInstant', actualBytes: 8732, limitBytes: 3072 }
  } else {
    throw err;
  }
}
```

服务端（`@rei-standard/amsg-instant` 0.6.1+ / `@rei-standard/amsg-server` 2.3.1+）有等价的二道防线，业务可以放心依赖 client 这一道做 UX 提示。

## 导出 API（Exports）

- `ReiClient`

`ReiClient` 主要方法：

- `init()`
- `scheduleMessage(payload)`
- `sendInstant(payload)`
- `updateMessage(uuid, updates)`
- `cancelMessage(uuid)`
- `listMessages(opts)`
- `subscribePush(vapidPublicKey, registration)`

## 模块格式与类型（ESM/CJS/Types）

- ESM：`import { ReiClient } from '@rei-standard/amsg-client'`
- CJS：`const { ReiClient } = require('@rei-standard/amsg-client')`
- 类型：包内提供 `types` 入口（`dist/index.d.ts`）

## 运行环境与要求

- 浏览器环境（需 `fetch`、`crypto.subtle`）
- Push 订阅需可用 Service Worker 与 Push API
- 需要可用的 `baseUrl`（示例：`/api/v1`；明文 instant 模式下可直接是 Worker URL）
- `userId` 必须是 UUID v4（明文 instant 模式 `instantEncryption: false` 下可省）

## 相关链接（绝对 URL）

- [SDK Workspace 总览](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/README.md)
- [Server 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/README.md)
- [SW 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md)
- [Service Worker 规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/service-worker-specification.md)
- [API 技术规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)
