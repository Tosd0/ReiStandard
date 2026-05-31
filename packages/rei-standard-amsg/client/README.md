# @rei-standard/amsg-client

`@rei-standard/amsg-client` 是 ReiStandard 主动消息标准的浏览器端 SDK 包，负责加密请求、解密响应和 Push 订阅。

## v2.4.0 — SSE consumer

新增 `consumeInstantStream(payload, endpointPath?, options)`：消费 amsg-instant 0.9.0+ 的 SSE 默认响应，按 frame 解析 `event: payload` / `event: done` / `event: error` 分发到 `options.onPayload`。前台场景下 push 不再绕 push service → SW → IDB → main thread 整条链路，延迟少一个数量级。详见下方 [SSE 流消费](#sse-流消费-consumeinstantstream240配合-amsg-instant-090)。请求体默认不再由 client 做本地体积限制；需要本地护栏时可在构造器传 `maxPayloadBytes`。

## v2.3.0 — Shared push types

The client now re-exports `@rei-standard/amsg-shared` 的类型、运行时常量（`MESSAGE_KIND` / `MESSAGE_TYPE` / `PUSH_SOURCE`）、推送 builder（`buildContentPush` 等）和类型守卫（`isContentPush` 等）。调用方可以直接 `import { MessageKind, buildContentPush, isContentPush } from '@rei-standard/amsg-client'`，无需单独再装一个 `@rei-standard/amsg-shared` 依赖。client 本身在运行时不消费这些导出 —— 它们是给同时调 `ReiClient` 又在 Service Worker / 客户端处理推送的 app 用的便利出口。

```js
// app.js — 用 ReiClient 发即时消息
import { ReiClient } from '@rei-standard/amsg-client';

const client = new ReiClient({
  baseUrl: 'https://instant.example.com',
  instantEncryption: false,
});
await client.sendInstant({
  contactName: 'Rei',
  completePrompt: '你是 Rei，用一句话提醒用户带伞',
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '...',
  primaryModel: 'gpt-4o-mini',
  pushSubscription: subscription.toJSON(),
});

// service-worker.js — 用 isContentPush 在收到推送时收窄类型
import { isContentPush } from '@rei-standard/amsg-client';

self.addEventListener('push', (event) => {
  const payload = event.data?.json();
  if (isContentPush(payload)) {
    // payload 已被收窄为 ContentPush —— 安全读取 payload.message
    event.waitUntil(
      self.registration.showNotification(payload.contactName ?? 'Rei', {
        body: payload.message,
      })
    );
  }
});
```

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

**两个常见坑**：

- 传**正则 source**，不要带 `/.../` 也不要尾 flag。`'/foo/i'` 会被当字面量斜杠 + 字面量 `i`，不是大小写不敏感的 `foo`。大小写不敏感请用 `[Aa]` 字符类替代。
- 想让分隔符回贴到前一段（默认行为），把分隔符包进 `(...)` 捕获组。库**不会自动包**——传 `'\\n+'` 而不是 `'(\\n+)'` 会得到首尾相连、分隔符丢失的奇怪结果。

### SSE 流消费 `consumeInstantStream`（2.4.0+，配合 amsg-instant 0.9.0+）

`sendInstant()` 只在显式 `Accept: application/json` opt-out 模式下使用。amsg-instant 0.9.0 起默认走 SSE 流式传输——每条 push 通过 `event: payload` 直接打到主线程，前台延迟从约 1–3s（push service → SW → IDB → window）降到次百毫秒。Web Push backup 同时**常开 always-on**（即使 SSE enqueue 成功也照样发一份），用 SW / client 端按 `messageId` 做 dedupe 把两路收敛回一次。前台场景应该改用 `consumeInstantStream()`。

```js
const abort = new AbortController();

try {
  await client.consumeInstantStream(payload, '/instant', {
    onPayload: async (push) => {
      // 跟 SW 收到的 wire format 字节级一致：含 messageKind / sessionId / messageId
      // 等。按 messageKind 分轨写 IDB / 渲染 / 更新 UI 状态机即可。
      await routePushToIDB(push);
    },
    onError: (err) => log.warn('stream error', err),  // 通知性，不抑制 throw
    onDone:  () => stopSpinner(),
    signal:  abort.signal,
  });
} catch (err) {
  // 网络 / 协议 / abort / onPayload 抛错都会到这里
  showError(err);
}
```

请求体跟 `sendInstant()` 完全一样——包括必须的 `pushSubscription`。两条投递路径同时跑：

1. **SSE 直送**（首选）——payload 走 `event: payload` 直接到 `onPayload`。
2. **Web Push always-on backup**——成功 enqueue 的 payload 也会通过 `pushSubscription` 发一份；SSE 写失败 / 客户端断开 / enqueue throw 时也走这条路兜底。

同一 `messageId` 两路都到，由 SW 的 dedupe gate 或客户端按 ID 幂等去重收敛成一次业务投递与一次（必要时的）通知。

#### 错误语义

任何失败——`fetch` 网络异常、非 2xx 响应、非 `text/event-stream` `Content-Type`、SSE `event: error` 帧、`onPayload` 回调抛错、`signal` abort——都会让返回的 Promise reject。`onError` 是**通知性 side-channel**（fire 后照常 throw），不要把它当 try/catch 替代。

#### 端点 / transport 配置

`endpointPath` 默认 `'/instant'`，按需传 `'/continue'` 续跑 tool result。加密 / 明文两种 transport 与 `sendInstant()` 共享构造器配置（`instantEncryption` / `instantClientToken`），调用方无感。

### 本地软清空：`avatarUrl` 与可选 payload 体积上限（2.2.4+ / 2.4.0+）

`scheduleMessage` / `sendInstant` / `consumeInstantStream` / `updateMessage` 在发请求**之前**会保留 `avatarUrl` 软清空保护。请求体大小默认不限制；如果你希望在 SDK 本地先挡住过大的请求，可以在构造器显式传 `maxPayloadBytes`：

```js
const client = new ReiClient({
  baseUrl: '/api/v1',
  userId,
  maxPayloadBytes: 256_000, // 可选；默认 null / 不限制
});
```

| 触发条件 | 处理方式 | 触发原因（背景说明，不在 message 里） |
| --- | --- | --- |
| `payload.avatarUrl` 以 `data:` 开头（含 `data:image/...;base64,...`） | `console.warn` + 在 payload 上把 `avatarUrl` 置为 `null`，请求照发（`updateMessage` 从 patch 里删除该字段，保留服务端原头像） | base64 内嵌头像把单个 push payload 撑到几十 KB，远端 Web Push 服务直接返回 4KB 超限 / 网关 `413`。 |
| `payload.avatarUrl` 长度 > 2048 字符 | 同上 | 同上。建议用 CDN 缩略图 URL。 |
| `payload.avatarUrl` 不是字符串 | 同上 | 类型错误。 |
| 已配置 `maxPayloadBytes`，且 `JSON.stringify(payload)` UTF-8 字节数超过该值 | 抛出 `Error.code === 'PAYLOAD_TOO_LARGE_LOCAL'`，错误对象带 `.details = { method, actualBytes, limitBytes }` | 只在调用方主动需要本地请求体护栏时启用。Web Push 单条回复超限由 `amsg-instant` 的 BlobStore / multipart 输出链路处理，不靠 client 限制请求体。 |

头像是装饰字段，单个不合规 URL 不再让整次调度 / 推送挂掉；想拦到错误请监听 `console.warn`，或在调用前自己用 `validateAvatarUrl` 预检（server / instant 包都有导出）。未配置 `maxPayloadBytes` 时不会产生 `PAYLOAD_TOO_LARGE_LOCAL`；配置后照常用 try/catch 捕获：

```js
try {
  await client.sendInstant(payload);
} catch (err) {
  if (err.code === 'PAYLOAD_TOO_LARGE_LOCAL') {
    // err.details = { method: 'sendInstant', actualBytes: 87320, limitBytes: 256000 }
  } else {
    throw err;
  }
}
```

服务端（`@rei-standard/amsg-instant` 0.7.1+ / 0.8.0+，`@rei-standard/amsg-server` 2.3.3+ / 2.4.0+）有同样的软清空二道防线，client 这一道主要省一次远端往返。

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
