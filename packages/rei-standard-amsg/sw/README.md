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

### Blob envelope

当 `amsg-instant` 检测到 payload 超过 `maxInlineBytes` 时会改发 blob envelope `{ _blob: true, key, url, messageKind?, type? }`。SW **不会** 自动 fetch blob 内容（那是 client 的职责），但仍然会按 envelope 上的 `messageKind` 分发对应事件，让 client 知道有什么类型的内容即将到达，自己决定要不要拉取。Blob envelope 也只在 `messageKind === 'content'`（或缺失）时才渲染占位通知，与普通 push 行为一致。

### Generic multipart transport（next）

next 阶段移除了旧 reasoning 专用 `chunkIndex` / `totalChunks` wire format。现在 `_multipart` 是统一 transport kind，任何原始 payload 都可以被包起来：

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
  // （新增于 2.1.0-next.3）离线持久化等业务拦截钩子：
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

- 想给 `reasoning` / `tool_request` / `error` 也弹通知的业务：必须自行在 app 内监听上面的 postMessage 事件、调 `Notification` 或 `registration.showNotification`。SW 默认不再为它们弹通知。
- 应用级 SW 可以删除旧 reasoning `chunkIndex` / `totalChunks` 拼接逻辑；next 版本只会把完整还原后的 reasoning payload 发给 client。
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
