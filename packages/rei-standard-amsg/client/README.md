# @rei-standard/amsg-client

`@rei-standard/amsg-client` 是 ReiStandard 主动消息标准的浏览器端 SDK 包，负责加密请求、解密响应、Push 订阅，以及 **送达协调**。

## v2.5.0 — `deliver()`：平台无关的送达 primitive

新增 `client.deliver(payload, opts)`，把"发出去"和"业务上是否真送达"分离开。它是新代码的**首选入口**。

旧的 `sendInstant()` / `consumeInstantStream()` 仍然保留可用，但被降级为**低级 transport**——只在你已经自己接好了送达校验时才用，否则会出现「HTTP 200 / SSE 不报错 ≠ 消息真送到」的陷阱（详见下方[为什么需要 `deliver()`](#为什么需要-deliver)）。

> 与 `@rei-standard/amsg-instant` 0.9.0+ 配合最直接，但 `deliver()` 本身**不绑死任何后端 / 平台**——它接收一个普通的 `Promise<ObservedDeliveryReceipt>` 作为"观察通道"信号源，**谁都能接**（Service Worker 广播、Electron IPC、原生桥、轮询、自定义 long-poll……）。

---

## 目录

- [快速使用](#快速使用)
- [`deliver()` 标准用法](#deliver-标准用法)
- [为什么需要 `deliver()`](#为什么需要-deliver)
- [`DeliverOptions` 全字段](#deliveroptions-全字段)
- [五种 `outcome` 含义](#五种-outcome-含义)
- [接观察通道的几种典型形态](#接观察通道的几种典型形态)
- [低级 API（`sendInstant` / `consumeInstantStream`）](#低级-apisendinstant--consumeinstantstream)
- [发送即时消息（加密 vs 明文）](#发送即时消息加密-vs-明文)
- [`messages` 多轮 / `splitPattern` 自定义分句](#messages-多轮--splitpattern-自定义分句)
- [本地软清空与可选 `maxPayloadBytes`](#本地软清空与可选-maxpayloadbytes)
- [其他工具：scheduleMessage / listMessages / subscribePush…](#其他工具)
- [模块格式与环境](#模块格式与环境)

---

## 安装

```bash
npm install @rei-standard/amsg-client
```

## 快速使用

```js
import { ReiClient } from '@rei-standard/amsg-client';

const client = new ReiClient({
  baseUrl: '/api/v1',
  userId: '550e8400-e29b-41d4-a716-446655440000',
});

await client.init();
```

发送即时消息（**推荐**走 `deliver()`，下一节展开）：

```js
const result = await client.deliver(payload, {
  delivery: { mode: 'observed', observed: observationPromise },
  timeoutMs: 300_000,
});
if (result.ok) {
  // result.outcome === 'delivered' —— 真送达
}
```

订 Web Push（如果你的接入方案需要走 push 通道）：

```js
await navigator.serviceWorker.register('/service-worker.js');
const registration = await navigator.serviceWorker.ready;
const subscription = await client.subscribePush(window.__VAPID_PUBLIC_KEY__, registration);

await client.scheduleMessage({
  contactName: 'Rei',
  messageType: 'fixed',
  userMessage: '下班记得带伞～',
  firstSendTime: new Date(Date.now() + 60 * 1000).toISOString(),
  recurrenceType: 'none',
  pushSubscription: subscription.toJSON(),
});
```

---

## `deliver()` 标准用法

```js
import { ReiClient } from '@rei-standard/amsg-client';

const client = new ReiClient({ baseUrl: 'https://instant.example.com', instantEncryption: false });

// 1. 准备「观察通道」Promise —— 任何能告诉你"消息已经进库 / 上屏 / 上通知中心"的来源都行。
//    形状要求：resolve 时给一个 { messageId?, sessionId?, channel? }；至少含其中一个 ID。
const observationPromise = waitForReceipt({ /* 业务上下文 */ });

// 2. 发出消息并等送达裁决
const abort = new AbortController();
const result = await client.deliver(payload, {
  delivery: { mode: 'observed', observed: observationPromise },
  timeoutMs: 300_000,                       // 整体预算
  onChunk: (chunk) => routeChunk(chunk),    // 可选：SSE 每帧 UI 钩子；抛错被吞，不影响 outcome
  signal: abort.signal,                     // 可选：caller 主动取消
});

// 3. 五值 outcome —— 每一个都对应**明确**的业务动作
switch (result.outcome) {
  case 'delivered':
    // 真送达。result.detail.receipt 是你自己 resolve 的那份。
    break;
  case 'cancelled':
    // 用户主动 abort，期间无延迟送达。安静返回，不弹错。
    break;
  case 'timeout':
    if (result.detail.observationChannelStalled) {
      // ⚠ 重要分支：transport 干净结束但观察通道没接力。
      // 多半是 SW / IPC / native 推送处理那一侧挂了 / 卡了。
      // 不要当发送失败，提示"已发送，本机推送通道暂未确认"即可。
    } else {
      // 整体预算耗完，啥信号都没等到。可重试。
    }
    break;
  case 'send-failed':
    // transport 自己挂了（带 detail.transportError），并且没有观察到送达。
    // 这才是「真的发送失败」。
    showError(result.detail.transportError);
    break;
  case 'completed-unconfirmed':
    // 仅 transport-only 模式才出现。下面专门讲。
    break;
}
```

`result.detail` 永远有，里面带 `waitedMs` / `transportEnded` / `transportError` / `transportResponse`（JSON 模式）/ `chunkHandlerError` / `cancelledByCaller` / `observationChannelStalled` / `receipt`，按需取诊断信息。

---

## 为什么需要 `deliver()`

如果你的后端是 `@rei-standard/amsg-instant` 0.9.0+，**它默认强制开启 Web Push always-on backup**：同一条业务消息**总是**同时走两条通道下去——

1. SSE 流式直送（前台收到走 `event: payload`）
2. Web Push 备份（即使 SSE 成功 enqueue，也照样发一份，由 SW 端按 `messageId` 去重）

这种双通道语义让旧的两条单一信号路径都不再可靠：

| 旧 API | 看到的信号 | 实际意味着 |
| --- | --- | --- |
| `sendInstant()` 返回 `200` | dispatch 成功 | ❌ **不等于**消费者真收到（push backup 仍可能没到） |
| `consumeInstantStream()` reject | SSE 这条路断了 | ❌ **不等于**消息没送达（push backup 可能已到） |

最朴素的 naive 代码 `try { await consumeInstantStream() } catch { fail() }` 在这套语义下**必然出错**——iOS 把后台 fetch 杀掉时，SSE reject，用户看到「失败」，但其实 push backup 已经把消息送进去了，过一会儿冒出来。计费、UI 文案、重试逻辑全部错乱。

`deliver()` 的解法：

- **transport 只是辅助**——它的成败用来收紧延迟，不用来判送达
- **送达由"观察通道"决定**——caller 提供一个 `Promise<ObservedDeliveryReceipt>`，等业务上"真到了"才 resolve。这条 Promise 怎么实现库不关心，**真正平台无关**
- **race 四路 + grace + 严格 outcome**——返回值告诉你到底是 delivered / cancelled / timeout / send-failed / completed-unconfirmed 的哪一个，不再让 caller 自己脑补

---

## `DeliverOptions` 全字段

```ts
interface DeliverOptions {
  delivery:
    | { mode: 'observed'; observed: Promise<ObservedDeliveryReceipt> }
    | { mode: 'transport-only' };

  timeoutMs: number;                                       // 总预算（含 transport + grace）
  onChunk?: (payload: unknown) => Promise<void> | void;    // 可选 SSE 每帧钩子，抛错被吞
  postTransportGraceMs?: number;                           // transport 结束后等观察的 grace
                                                            // 默认 = min(remaining, max(5000, timeoutMs * 0.1))
                                                            // cancel 路径下生效的是 grace / 2
  signal?: AbortSignal;                                    // 已 aborted → 立即 cancelled，不发 fetch
                                                            // listener 在每个终态会被卸载，长生命周期 signal 反复
                                                            // 调用不会累积
  headers?: Record<string, string>;                        // 额外请求头；可覆盖 Content-Type，但不能覆盖
                                                            // X-User-Id / X-Payload-Encrypted / X-Encryption-Version
                                                            // / X-Client-Token / Authorization
  authorization?: string;                                  // 透传成 Authorization header（与 sendInstant 对齐）
  endpointPath?: string;                                   // 默认 '/instant'，可改 '/continue' 续跑
}

interface ObservedDeliveryReceipt {
  messageId?: string;        // 至少一个非空字符串
  sessionId?: string;        // ↑
  channel?: string;          // 'sw' / 'ipc' / 'native' / 'poll' / 任意诊断 label
}
```

### `delivery.mode` 必须显式选

| mode | 何时用 | outcome 取值 |
| --- | --- | --- |
| `'observed'` | **99% 用户用这个**。有任何能确认"消息真到了"的 out-of-band 通道 | `delivered` / `cancelled` / `timeout` / `send-failed` |
| `'transport-only'` | 没有 out-of-band 通道（amsg-instant 0.9+ 默认场景几乎不会用到；某些自定义后端 / 调试场景才会） | `completed-unconfirmed` / `cancelled` / `timeout` / `send-failed` |

> 库**不允许**「传一个永不 resolve 的 Promise 假装在 observed 模式」的写法——那等于教人写错代码。模式必须显式声明。

### `postTransportGraceMs`

transport 结束后（无论干净结束还是 error）等观察通道的额外窗口。默认公式：

```
default = min(remainingBudget, max(5000ms, timeoutMs * 0.1))
```

- 5 秒下限保住极短 timeout 下 grace 不被砍到 0
- 10% 比例让 30s / 300s / 多分钟级 timeout 都有合理 grace
- caller 显式传时仍会被 `remainingBudget` cap，不会超出 `timeoutMs` 总预算

cancel 路径用的是 `grace / 2`（abort 后只给一半时间等延迟送达，剩下半给清理）。

---

## 五种 `outcome` 含义

| outcome | `ok` | 何时出现 | 推荐 caller 行为 |
| --- | --- | --- | --- |
| `'delivered'` | ✅ true | observed 模式 + 收到匹配 receipt（任何路径，包括 abort 后 grace 内仍到） | 正常成功路径 |
| `'cancelled'` | ❌ false | caller `signal.abort()` 触发，且 grace 内没观察到送达 | 安静返回，不弹错（这是用户主动） |
| `'timeout'` | ❌ false | 总预算耗完；**或** observed 模式 transport 干净结束但 observation 没接力 | 可重试；如带 `observationChannelStalled` 标记则提示「已发送、本机推送通道暂未确认」 |
| `'send-failed'` | ❌ false | transport 自己挂了（`detail.transportError` 有值）+ 没观察到送达 | 这才是真发送失败，给 `detail.transportError` 报错 |
| `'completed-unconfirmed'` | ❌ false | **仅 transport-only 模式**，transport 干净结束，无真相信号 | best-effort 乐观，caller 自决怎么判 |

特别注意两个细分：

- **`outcome:'timeout'` + `detail.observationChannelStalled:true`** —— transport 都好好结束了，是观察那一侧（SW / IPC / native push handler）没把信号给到 `observed`。多半是观察那侧的实现有问题，不是发送失败。文案应该跟普通 timeout 区分。
- **`outcome:'delivered'` + `detail.cancelledByCaller:true`** —— 用户切走 / 关页面后，消息在 grace 内仍然送达了（实战常见：iOS Safari 切 tab，几百 ms 后 push 才到）。不算 cancelled。

---

## 接观察通道的几种典型形态

`deliver()` 不绑死任何平台。这一节给几个常见形态的 reference 写法——**库里都不内置，全是 caller 自己几行胶水**。

### Service Worker 广播

如果你的 SW 是 `@rei-standard/amsg-sw` 或类似实现，会在落库后 `postMessage` 一份 `{ type: 'REI_AMSG_PUSH', event: 'DELIVER', payload }`。把它包成 Promise：

```js
function waitForSwReceipt(messageId, signal) {
  return new Promise((resolve, reject) => {
    function handler(e) {
      if (e.data?.type !== 'REI_AMSG_PUSH') return;
      const p = e.data.payload;
      if (p?.messageId === messageId) {
        navigator.serviceWorker.removeEventListener('message', handler);
        resolve({ messageId: p.messageId, sessionId: p.sessionId, channel: 'sw' });
      }
    }
    navigator.serviceWorker.addEventListener('message', handler);
    signal?.addEventListener('abort', () => {
      navigator.serviceWorker.removeEventListener('message', handler);
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}

await client.deliver(payload, {
  delivery: { mode: 'observed', observed: waitForSwReceipt(payload.messageId, abort.signal) },
  timeoutMs: 300_000,
});
```

### Electron / Tauri IPC

```js
function waitForIpcReceipt(messageId) {
  return new Promise((resolve) => {
    const off = window.ipcBridge.on('amsg:received', (p) => {
      if (p.messageId !== messageId) return;
      off();
      resolve({ messageId: p.messageId, channel: 'ipc' });
    });
  });
}
```

### 原生 push 桥（React Native / native WebView）

```js
function waitForNativeReceipt(messageId) {
  return new Promise((resolve) => {
    const sub = NativeEventEmitter.addListener('amsg-received', (p) => {
      if (p.messageId !== messageId) return;
      sub.remove();
      resolve({ messageId: p.messageId, channel: 'native' });
    });
  });
}
```

### 纯轮询 fallback

```js
function pollReceipt(messageId, signal) {
  return new Promise((resolve, reject) => {
    const t = setInterval(async () => {
      if (signal.aborted) { clearInterval(t); reject(new DOMException('aborted', 'AbortError')); return; }
      const found = await db.findReceipt(messageId);
      if (found) { clearInterval(t); resolve({ messageId, channel: 'poll' }); }
    }, 1000);
  });
}
```

`deliver()` 对这些一视同仁，只看 `Promise` 何时 resolve 出什么。

---

## 低级 API：`sendInstant` / `consumeInstantStream`

这两个 API 仍然保留，但**只在以下情况推荐**：

- 你已经在更上层自己接好了送达确认（典型：业务库直接同步落库后就算完成，根本没有"观察通道"概念）
- 你只需要 SSE 每帧的 UI 钩子，不需要 outcome 裁决
- 临时调试 / one-off 脚本

不在这些情况下，**用 `deliver()`**。

### `sendInstant(payload, endpointPath?, opts?)`

POST JSON 到 instant endpoint，原样返回 worker 的 `{ success, data?, error? }`。

> ⚠ **HTTP 200 ≠ delivery confirmation**，当 worker 配了 backup Web Push 时（amsg-instant 0.9.0+ 默认）。`200` 只说明 dispatch 成功，不说明消费者真收到。要正确判断送达，用 `deliver()`。

可选 `opts.expectsBackupPush`：
- 设 `true` —— 本实例此方法首次调用时 `console.warn` 一次，提醒上述陷阱（migration 期审计有用）
- 设 `false` —— 显式表示「我知道这点」，永久静音
- 不传 —— 不警告

### `consumeInstantStream(payload, endpointPath?, options)`

POST 并按 SSE 帧解析 `event: payload` / `event: done` / `event: error`，分发到 `options.onPayload`。

```js
try {
  await client.consumeInstantStream(payload, '/instant', {
    onPayload: async (push) => routePush(push),
    onError: (err) => log.warn('stream error', err),
    onDone:  () => stopSpinner(),
    signal:  abort.signal,
  });
} catch (err) {
  // ⚠ reject ≠ delivery failure（详见上面）
}
```

> ⚠ **rejection ≠ delivery failure**，当 worker 配了 backup Web Push 时。SSE 可能因为 iOS 杀后台 fetch、网络抖动、worker 5xx 而 reject，但 backup push 仍然把消息送到了。把 reject 当成「发送失败」会导致**虚报失败 + 消息晚到时用户困惑**。要正确判断送达，用 `deliver()`。

`opts.expectsBackupPush` 与 `sendInstant` 一致。

---

## 发送即时消息（加密 vs 明文）

`deliver()` 与 `sendInstant` 共享同一套 transport 配置，由构造器决定：

### 加密模式（默认；兼容 amsg-server / amsg-instant 0.1.x）

```js
const client = new ReiClient({
  baseUrl: '/api/v1',
  customBaseUrls: { instant: 'https://instant.example.com' },
  userId: '550e8400-e29b-41d4-a716-446655440000',
});

await client.init();

await client.deliver({
  contactName: 'Rei',
  completePrompt: '你是 Rei，用一句话提醒用户带伞',
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '...',
  primaryModel: 'gpt-4o-mini',
  pushSubscription: subscription.toJSON(),
}, {
  delivery: { mode: 'observed', observed: observationPromise },
  timeoutMs: 300_000,
});
```

> `customBaseUrls` 是按端点名（如 `instant`）覆盖 `baseUrl` 的通用机制；后续其他端点也可以用同一字段独立指定。

### 明文模式（配 amsg-instant 0.2.x+ / 单租户自部署）

```js
const client = new ReiClient({
  baseUrl: 'https://instant.example.com',
  instantEncryption: false,
  instantClientToken: 'shared-secret-xyz',
});

// init() 在明文模式下是 no-op，调不调都行
```

> ⚠ **`instantClientToken` 是弱共享密钥**：它会随前端 bundle 发出去，devtools 一开就能看到。只防 URL 直怼，不防有心人。要真正鉴权，用 amsg-instant 的 `tokenSigningKey`（HMAC JWT，配后端签发短期 token）。

> ⚠ **双模式陷阱**：`instantEncryption: false` 时 `init()` 变 no-op，`scheduleMessage` / `listMessages` / `updateMessage` 这类**仍走加密**的方法会因 `userKey` 没初始化抛 "Not initialised"。同一前端两类方法都要用，请改回 `instantEncryption: true`（默认）。

---

## `messages` 多轮 / `splitPattern` 自定义分句

`deliver()` / `sendInstant` / `consumeInstantStream` 都是 **payload-agnostic 透传**——这些字段写进 payload 就行，client 不校验，所有错误从 Worker / Server 端返回。

`messages`（OpenAI 格式数组）：

```js
await client.deliver({
  contactName: 'Rei',
  messages: [
    { role: 'system', content: '你是 Rei，回复要简短自然。' },
    { role: 'user', content: '今天会下雨吗？' },
    { role: 'assistant', content: '看了下，下午有阵雨。' },
    { role: 'user', content: '那提醒我一下带伞' },
  ],
  apiUrl: '...',
  apiKey: '...',
  primaryModel: 'gpt-4o-mini',
  pushSubscription: subscription.toJSON(),
}, { delivery: ..., timeoutMs: 300_000 });
```

`completePrompt` 和 `messages` **必须恰好二选一**，同时给会被远端返回 `400 INVALID_PAYLOAD_FORMAT`。

`splitPattern`（自定义分句正则，`string | string[]`）：

```js
splitPattern: '([\\n]+)',                   // 按换行
splitPattern: ['(\\n\\n+)', '([。！？!?]+)'], // 数组级联：先段落、再句号
```

**两个常见坑**：

- 传**正则 source**，不要带 `/.../` 也不要尾 flag。`'/foo/i'` 会被当字面斜杠 + 字面 `i`，不是大小写不敏感的 `foo`。要大小写不敏感请用 `[Aa]` 字符类。
- 想让分隔符回贴到前一段（默认行为），把分隔符包进 `(...)` 捕获组。库**不会自动包**——传 `'\\n+'` 而不是 `'(\\n+)'` 会得到首尾相连、分隔符丢失的奇怪结果。

---

## 本地软清空与可选 `maxPayloadBytes`

`scheduleMessage` / `sendInstant` / `consumeInstantStream` / `deliver` / `updateMessage` 在发请求**之前**会保留 `avatarUrl` 软清空保护。请求体大小默认不限制；要本地护栏可在构造器显式传 `maxPayloadBytes`：

```js
const client = new ReiClient({
  baseUrl: '/api/v1',
  userId,
  maxPayloadBytes: 256_000, // 默认 null / 不限制
});
```

| 触发条件 | 处理方式 |
| --- | --- |
| `payload.avatarUrl` 是 `data:` URI / 长度 > 2048 字符 / 非字符串 | `console.warn` + 在 payload 上把 `avatarUrl` 置为 `null`（`updateMessage` 从 patch 里删除字段，保留服务端原头像），请求照发 |
| `maxPayloadBytes` 配了，且 `JSON.stringify(payload)` UTF-8 字节数超过该值 | 抛 `Error` with `.code === 'PAYLOAD_TOO_LARGE_LOCAL'`，`.details = { method, actualBytes, limitBytes }` |

头像是装饰字段，单个不合规 URL 不再让整次调用挂掉。要拦错请监听 `console.warn`。

```js
try {
  await client.deliver(payload, { delivery, timeoutMs: 300_000 });
} catch (err) {
  if (err.code === 'PAYLOAD_TOO_LARGE_LOCAL') {
    // err.details = { method: 'deliver', actualBytes: 87320, limitBytes: 256000 }
  } else { throw err; }
}
```

---

## 其他工具

`ReiClient` 还有这些方法（与 2.4.x 相比无字节变化）：

- `scheduleMessage(payload)` —— 排定 fixed / prompted / auto / instant 任务，加密走 amsg-server
- `updateMessage(uuid, updates)` —— 改任务字段
- `cancelMessage(uuid)` —— 取消任务
- `listMessages(opts)` —— 拉当前 user 的任务列表
- `subscribePush(vapidPublicKey, registration)` —— 标准 Push API 订阅封装

以及从 `@rei-standard/amsg-shared` re-export 的运行时常量 / builder / type guard：

- `MESSAGE_KIND` / `MESSAGE_TYPE` / `PUSH_SOURCE`
- `buildContentPush` / `buildReasoningPush` / `buildToolRequestPush` / `buildErrorPush`
- `isContentPush` / `isReasoningPush` / `isToolRequestPush` / `isErrorPush`

这些在 SW / app 端处理 push 时用得上，单独装 `@rei-standard/amsg-shared` 没必要。

---

## 模块格式与环境

- ESM：`import { ReiClient } from '@rei-standard/amsg-client'`
- CJS：`const { ReiClient } = require('@rei-standard/amsg-client')`
- 类型：包内提供 `types` 入口（`dist/index.d.ts`）
- 浏览器环境（需 `fetch`、`crypto.subtle`、`ReadableStream`、`AbortController`）
- Push 订阅需可用 Service Worker 与 Push API
- `userId` 必须是 UUID v4（明文 instant 模式 `instantEncryption: false` 下可省）

## 相关链接

- [SDK Workspace 总览](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/README.md)
- [Server 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/README.md)
- [Instant 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/instant/README.md)
- [SW 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md)
- [Service Worker 规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/service-worker-specification.md)
- [API 技术规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)
