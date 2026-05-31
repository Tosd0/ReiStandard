# @rei-standard/amsg-sw

`@rei-standard/amsg-sw` 是 ReiStandard 主动消息标准的 Service Worker 插件包，目标是让推送展示和离线重试“开箱即用”。


## v2.1.0 — 按 kind 分发的客户端事件

2.1.0 跟随 `@rei-standard/amsg-shared` 的三轴 push schema：每条 push 现在通过 `payload.messageKind`（`content` / `reasoning` / `tool_request` / `error`）区分内容类型。SW 在收到 push 后会做两件事：

1. **永远** 通过 `postMessage` 把 payload 广播给所有受控窗口（包括 `includeUncontrolled: true` 的未受控窗口）。
2. **仅当** `messageKind === 'content'` 或 payload 没有 `messageKind`（2.0.x 老 payload 的回退路径）时，才调用 `showNotification`。`reasoning` / `tool_request` / `error` 三种 kind 一律不弹通知——业务在 app 内通过 postMessage 通道自行渲染。

### 新增导出 `REI_SW_EVENT`

事件名由 SW 在每次广播时打在 `e.data.event` 上：

| 常量 | 字符串值 | 触发条件 |
|------|---------|---------|
| `REI_SW_EVENT.CONTENT_RECEIVED`      | `'rei-amsg-content-received'`      | `payload.messageKind === 'content'` |
| `REI_SW_EVENT.REASONING_RECEIVED`    | `'rei-amsg-reasoning-received'`    | `payload.messageKind === 'reasoning'` |
| `REI_SW_EVENT.TOOL_REQUEST_RECEIVED` | `'rei-amsg-tool-request-received'` | `payload.messageKind === 'tool_request'` |
| `REI_SW_EVENT.ERROR_RECEIVED`        | `'rei-amsg-error-received'`        | `payload.messageKind === 'error'` |
| `REI_SW_EVENT.MULTIPART_EXPIRED`     | `'rei-amsg-multipart-expired'`     | `_multipart` 分片 TTL 到期仍未收齐 |
| `REI_SW_EVENT.UNKNOWN_RECEIVED`      | `'rei-amsg-unknown-received'`      | 缺 `messageKind`（2.0.x 老 payload / blob envelope） |

### 客户端订阅示例

```js
navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data?.type !== 'REI_AMSG_PUSH') return;
  switch (e.data.event) {
    case 'rei-amsg-content-received':      /* 渲染 app 内消息 */ break;
    case 'rei-amsg-reasoning-received':    /* 渲染思考中 UI */ break;
    case 'rei-amsg-tool-request-received': /* 弹出工具执行确认 */ break;
    case 'rei-amsg-error-received':        /* 显示错误 toast */ break;
    case 'rei-amsg-multipart-expired':     /* 观测 transport 缺片 */ break;
    case 'rei-amsg-unknown-received':      /* 2.0.x 老 payload 的兼容路径 */ break;
  }
});
```

### 通知显示策略 (Notification Rendering)

默认情况下：
- `content` 和老式 payload：自动弹系统通知。
- `reasoning` / `tool_request` / `error`：不弹通知，只触发 client 事件。

通过 `payload.notification.show`，你可以显式覆盖这个默认行为。此字段由服务端或产生 payload 时指定：

- `"auto"` 或不传：保持默认行为。
- `"always"`：强制弹系统通知，无视 `messageKind`。
- `"when-hidden"`：仅当没有 `visibilityState === "visible"` 的客户端时才弹系统通知。如果应用在前台，则静默。
- `false`：强制不弹通知，即使是 `content`。适合完全交给应用自行接管或自绘弹窗的场景。

当设置了弹通知时，通知文案完全由 `payload.notification` 决定（支持 `title`, `body`, `icon`, `badge`, `tag`, `renotify`, `requireInteraction`, `silent`, `data` 等字段）。如果缺省，会后备到 payload 根级属性。

> **APNs / iOS Web Push 提醒**
> 如果业务大量发送后台 push 却长期不展示可见通知，iOS Web Push 的送达可能被系统策略影响。生产环境建议对后台消息使用 `notification.show = "always"` 或 `"when-hidden"`，再配合 `tag` 折叠与 `silent: true` 降低打扰。

#### 场景示例

**1. tool_request 需要用户处理**
某些 Agent loop 跑到 `tool_request` 时需要用户在界面上确认或执行。由于默认 `tool_request` 不弹通知，用户如果在后台可能会漏掉：

```json
{
  "messageKind": "tool_request",
  "sessionId": "...",
  "toolCalls": [],
  "notification": {
    "show": "when-hidden",
    "title": "需要继续处理",
    "body": "点开应用继续完成工具调用"
  }
}
```

**2. Content 消息完全由前端接管**
应用层想在页面前台做非常定制的 Toast，不想弹系统级别通知：

```json
{
  "messageKind": "content",
  "message": "...",
  "notification": {
    "show": false
  }
}
```

> **注意：对于 multipart 传输**
> 当 payload 通过 `_multipart` 分片时，未收齐前不仅不派发业务事件，也**绝不**弹系统通知。收齐并还原为原始 payload 后，再按原始 payload 的 `notification.show` 策略执行判定。

### Delivery dedupe（通知前去重）

`installReiSW()` 默认启用包级 dedupe。所有业务 payload 不管来自 Web Push、multipart 还原、blob envelope，还是页面通过 `postMessage` 桥接进 SW，都会先经过同一个 gate：

```
dedupe -> notification.show 策略 -> showNotification / postMessage / onBusinessPayload
```

第一次到达的 payload 会正常走 `notification.show` 策略、窗口广播和 `onBusinessPayload`。重复 payload **不会**再次广播，也**不会**再次调用 `onBusinessPayload`；如果第一次到达时因为前台可见等原因没有展示系统通知，而后到的 Web Push backup 已经满足 `notification.show` 条件，SW 会只补一次系统通知，然后把结果放进 `onDuplicate(info)`。这层去重发生在业务落地前面，不依赖业务层 inbox 自己兜底。

默认 key 按顺序读取：

1. `payload.messageId`
2. `payload.id`
3. `payload.dedupeKey`

没有 key 时不去重，保持旧 payload 兼容。multipart 会先还原成原始 payload 再取 key；blob envelope 如果携带 `messageId` / `id` / `dedupeKey`，也会被同一套 gate 覆盖。

```js
installReiSW(self, {
  dedupe: {
    enabled: true,              // 默认 true
    ttlMs: 10 * 60_000,         // 默认 10 分钟
    dbName: 'rei_amsg_sw_dedupe_v1', // 想隔离另一套去重数据就改这个；每个 dbName 是独立 IDB instance
    key: (payload) => payload.messageId,
  },
  onDuplicate: async (info) => {
    // { key, source, messageKind, firstSeenAt, existingSource,
    //   existingMessageKind, existingNotificationShown, duplicateNotificationShown }
  },
});
```

实现使用 IndexedDB 的 `add()` + keyPath 做原子 claim：第一次 add 成功才放行；几乎同时到达的同 key payload，后到者会命中 `ConstraintError` 并作为 duplicate 返回。TTL 清理是懒清理，不需要 KV / D1 / Durable Object。

### 页面 -> SW 业务投递

SSE 默认先进页面主线程。若要让 SSE payload 和 Web Push backup 共用 SW 的 dedupe / notification / `onBusinessPayload` 管线，页面可以把 payload 转交给 SW：

```js
const registration = await navigator.serviceWorker.ready;
const channel = new MessageChannel();

channel.port1.onmessage = (event) => {
  // 成功：{ ok: true, duplicate?: boolean, key?: string, requestId?: string }
  // 失败：{ ok: false, error: string, key?: string, requestId?: string }
};

registration.active?.postMessage({
  type: 'REI_AMSG_DELIVER',
  source: 'sse',
  requestId: crypto.randomUUID(),
  payload,
}, [channel.port2]);
```

Web Push `push` event 和 `REI_AMSG_DELIVER` 最终都会进入同一个内部 pipeline。SSE 先到时，后来的 Web Push backup 会被 dedupe；Web Push 先到时，后来的 SSE bridge 也会被 dedupe。若首包已经落过业务但没弹通知，重复包只负责按当前 `notification.show` 策略补通知，不会重复触发业务回调。

### 生产推荐链路：SSE + Web Push backup + SW dedupe

0.9.0 / 2.2.0 起，正式环境推荐把“双路投递、包层去重”当作默认责任边界。`amsg-instant` 固定 `backupPush:'on'`，所以 Worker 不需要等断线才发 backup；client 收到 SSE 后应立刻桥接给 SW；SW 负责统一去重、补通知和业务落地。

| 环节 | 包配置 / 调用 | 推荐值 | 责任 |
|------|---------------|--------|------|
| Worker 侧 SSE | `createInstantHandler({ sse })` | 可省略；等价于 `backupPush:'on'`, `keepaliveMs:1_000`, `immediateKeepalive:true` | SSE 正常流式返回，同时每条 payload 都发 Web Push backup |
| Client 侧 SSE → SW | `consumeInstantStream(..., { onPayload })` 内立刻 `postMessage({ type:'REI_AMSG_DELIVER', payload, source:'sse', requestId })` | 强烈推荐 | 让 SSE 与 Web Push 进入同一条 SW delivery / dedupe 管线 |
| SW 侧 dedupe | `installReiSW(self, { dedupe })` | 可省略；默认启用，key 为 `messageId` → `id` → `dedupeKey`，TTL 10 分钟 | 先到者触发业务，后到者不重复入库；必要时只补系统通知 |
| 通知策略 | `payload.notification.show` | 普通内容推荐 `'when-hidden'`；低打扰更新可加 `silent:true` + `tag` | 前台交给 UI，隐藏/关闭后由 Web Push backup 补通知 |

一个最小形态：

```js
installReiSW(self, {
  defaultIcon: './icons/icon-192.png',
  defaultBadge: './icons/icon-192.png',
  multipart: { enabled: true },
  onBusinessPayload: async (payload) => persistIncomingPayload(payload),
  onDuplicate: async (info) => traceDuplicate(info),
});
```

这样当前台页面还活着时，SSE bridge 先进入 SW，`notification.show:'when-hidden'` 不弹系统通知但会触发业务落地；如果页面随后隐藏或已关闭，Web Push backup 到达 SW 后会命中同一个 key，只补通知，不重复调用 `onBusinessPayload`。

### Blob envelope

当 `amsg-instant` 检测到 payload 超过 `maxInlineBytes` 时会改发 blob envelope `{ _blob: true, key, url, messageKind?, type?, messageId?, id?, dedupeKey? }`。SW **不会** 自动 fetch blob 内容（那是 client 的职责），但仍然会按 envelope 上的 `messageKind` 分发对应事件，让 client 知道有什么类型的内容即将到达，自己决定要不要拉取。Blob envelope 也只在 `messageKind === 'content'`（或缺失）时才渲染占位通知，与普通 push 行为一致。

### Generic multipart transport（2.1.0+）

2.1.0 移除了旧 reasoning 专用 `chunkIndex` / `totalChunks` wire format。现在 `_multipart` 是统一 transport kind，任何原始 payload 都可以被包起来：

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

SW 收到 `_multipart` 后会先写 IndexedDB，支持乱序、重复分片和 SW 重启恢复。未收齐时不 `postMessage`、不 `showNotification`。收齐后按 `index` 拼回原始 JSON payload，删除 pending，写短期 done 标记避免推送服务重投递造成二次业务事件，然后递归走普通 `messageKind` 分发。

配置：

```js
installReiSW(self, {
  defaultIcon: '/icon-192x192.png',
  defaultBadge: '/badge-72x72.png',
  multipart: {
    enabled: true,
    ttlMs: 60_000,
    maxTotalBytes: 256_000,
    maxChunks: 128,
    cleanupIntervalMs: 15 * 60_000
  },
  // （新增于 2.1.0）离线持久化等业务拦截钩子：
  onBusinessPayload: async (payload) => {
    // 收到完整 payload 时触发，由于内置在 event.waitUntil 中，能够确保离线写库完毕再允许 SW 休眠
    // await db.saveIncomingMessage(payload);
  }
});
```

TTL 到期仍未收齐时，SW 会清理 pending 并广播：

```js
{
  type: 'REI_AMSG_PUSH',
  event: 'rei-amsg-multipart-expired',
  payload: { id, received, total, originalMessageKind }
}
```

业务应用只订阅普通事件即可。`content` multipart 收齐后照常弹通知；`reasoning` / `tool_request` / `error` 仍默认不弹通知。

### 升级注意事项

- 想给 `reasoning` / `tool_request` / `error` 弹通知的业务：SW 默认不再为它们弹通知，但可以通过设置 `payload.notification.show = "always"` 或 `"when-hidden"` 来让 SW 在包层直接弹通知。无需再强求在 app 内自绘。
- 应用级 SW 可以删除旧 reasoning `chunkIndex` / `totalChunks` 拼接逻辑；2.1.0+ 版本只会把完整还原后的 reasoning payload 发给 client。
- 客户端代码继续兼容只有 `installReiSW` + `REI_SW_MESSAGE_TYPE`（队列）的 2.0.x 写法——新增导出不破坏既有 API。
- 想拿到 push 类型相关的 TS 类型：从 `@rei-standard/amsg-shared` 引 `AmsgPush` 等类型（本包通过 JSDoc 引用同一份类型）。

## 功能概览

- 处理 `push` 事件：按 `messageKind` 三轴 schema 分发到客户端 + 仅 `content` 走 `showNotification`
- 透明重组 `_multipart` transport：应用层只收到完整原始 payload
- 处理 `message` 事件：支持离线请求入队与主动冲刷队列
- 处理 `sync` 事件：在网络恢复后自动重试队列请求
- 使用 IndexedDB 存储待发送请求，避免页面关闭后丢失

> 注意：插件默认**不内置** `notificationclick` 逻辑，点击跳转策略由业务自行实现。

## 安装

```bash
npm install @rei-standard/amsg-sw
```

## 快速使用

```js
import { installReiSW } from '@rei-standard/amsg-sw';

installReiSW(self, {
  defaultIcon: '/icon-192x192.png',
  defaultBadge: '/badge-72x72.png',
  multipart: { enabled: true },
  onBusinessPayload: async (payload) => {
    // 这里可安全地进行应用级别的离线数据库存储
  }
});

// 业务侧自行实现点击跳转
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});
```

离线入队（可选）：

```js
import { REI_SW_MESSAGE_TYPE } from '@rei-standard/amsg-sw';

export async function enqueueRequestToSW(requestPayload) {
  const registration = await navigator.serviceWorker.ready;
  if (!registration.active) {
    throw new Error('No active service worker');
  }

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      const result = event.data || {};
      if (result.ok) {
        resolve(result);
      } else {
        reject(new Error(result.error || 'Queue request failed'));
      }
    };

    registration.active.postMessage(
      {
        type: REI_SW_MESSAGE_TYPE.ENQUEUE_REQUEST,
        request: requestPayload
      },
      [channel.port2]
    );
  });
}
```

## 消息协议

- `REI_SW_MESSAGE_TYPE.ENQUEUE_REQUEST`：添加请求到 outbox，并立即尝试发送
- `REI_SW_MESSAGE_TYPE.FLUSH_QUEUE`：主动触发一次队列发送
- `REI_SW_MESSAGE_TYPE.QUEUE_RESULT`：SW 返回入队结果（`ok` / `error` / `queueId`）

`request` 结构示例：

```json
{
  "url": "/api/v1/schedule-message",
  "method": "POST",
  "headers": {
    "content-type": "application/json",
    "x-user-id": "550e8400-e29b-41d4-a716-446655440000",
    "x-payload-encrypted": "true",
    "x-encryption-version": "1"
  },
  "body": {
    "iv": "...",
    "authTag": "...",
    "encryptedData": "..."
  }
}
```

## 导出 API（Exports）

- `installReiSW`
- `REI_SW_EVENT` — 2.1.0 新增，按 kind 分发的客户端事件名
- `REI_AMSG_POSTMESSAGE_TYPE` — 2.1.0 新增，SW → client 广播信封的 `type` 字段（恒为 `'REI_AMSG_PUSH'`）
- `REI_SW_MESSAGE_TYPE`

`REI_SW_EVENT` 包含（详见上文 v2.1.0 章节）：

- `CONTENT_RECEIVED`
- `REASONING_RECEIVED`
- `TOOL_REQUEST_RECEIVED`
- `ERROR_RECEIVED`
- `MULTIPART_EXPIRED`
- `UNKNOWN_RECEIVED`

`REI_SW_MESSAGE_TYPE` 包含：

- `ENQUEUE_REQUEST`
- `FLUSH_QUEUE`
- `QUEUE_RESULT`

## 模块格式与类型（ESM/CJS/Types）

- ESM：`import { installReiSW } from '@rei-standard/amsg-sw'`
- CJS：`const { installReiSW } = require('@rei-standard/amsg-sw')`
- 类型：包内提供 `types` 入口（`dist/index.d.ts`）

## 运行环境与要求

- Service Worker 环境
- 需支持 `indexedDB`
- Background Sync 不可用时会降级为手动冲刷队列
- 建议项目可对 SW 文件做模块打包（支持包名 import）

## 常见坑

1. 本包不会自动添加 `notificationclick`，必须业务侧实现。
2. SW 文件如果不能解析包名 import，需要改走手动接入模板。
3. 请求入队 body 必须可序列化（JSON）。

## 相关链接（绝对 URL）

- [SDK Workspace 总览](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/README.md)
- [Server 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/README.md)
- [Client 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md)
- [Service Worker 规范（第 0 章）](https://github.com/Tosd0/ReiStandard/blob/main/standards/service-worker-specification.md)
