# @rei-standard/amsg-sw

`@rei-standard/amsg-sw` 是 ReiStandard 主动消息标准的 Service Worker 插件包，目标是让推送展示和离线重试“开箱即用”。


## 功能概览

- 处理 `push` 事件：自动解析 payload 并展示通知
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
  defaultBadge: '/badge-72x72.png'
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
- `REI_SW_MESSAGE_TYPE`

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
