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
