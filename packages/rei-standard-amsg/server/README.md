# @rei-standard/amsg-server

`@rei-standard/amsg-server` 是 ReiStandard 主动消息标准的服务端 SDK 包，提供标准路由处理器和数据库适配层。


## 安装

```bash
npm install @rei-standard/amsg-server web-push

# 数据库驱动二选一
npm install @neondatabase/serverless
# 或
npm install pg
```

## 快速使用

```js
import { createReiServer } from '@rei-standard/amsg-server';

const rei = await createReiServer({
  db: {
    driver: 'neon',
    connectionString: process.env.DATABASE_URL
  },
  cronSecret: process.env.CRON_SECRET,
  vapid: {
    email: process.env.VAPID_EMAIL,
    publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY
  }
});

// 例：映射路由
// GET /api/v1/init-database -> rei.handlers.initDatabase.GET
// POST /api/v1/schedule-message -> rei.handlers.scheduleMessage.POST
```

推荐初始化顺序：

1. `initDatabase.GET`
2. `initMasterKey.POST`
3. 客户端携带 UUID v4 `X-User-Id` 调用 `getUserKey.GET`

## 导出 API（Exports）

核心导出：

- `createReiServer`
- `createAdapter`
- `deriveUserEncryptionKey`
- `decryptPayload`
- `encryptForStorage`
- `decryptFromStorage`
- `validateScheduleMessagePayload`
- `isValidISO8601`
- `isValidUrl`
- `isValidUUID`
- `isValidUUIDv4`

`createReiServer()` 返回对象中的标准 handlers：

- `initDatabase.GET`
- `initMasterKey.POST`
- `getUserKey.GET`
- `scheduleMessage.POST`
- `sendNotifications.POST`
- `updateMessage.PUT`
- `cancelMessage.DELETE`
- `messages.GET`

## 模块格式与类型（ESM/CJS/Types）

- ESM：`import { createReiServer } from '@rei-standard/amsg-server'`
- CJS：`const { createReiServer } = require('@rei-standard/amsg-server')`
- 类型：包内提供 `types` 入口（`dist/index.d.ts`）

## 运行环境与要求

- Node.js `>=20`
- 必须安装 `web-push`
- 必须安装至少一个数据库驱动（`@neondatabase/serverless` 或 `pg`）
- 生产环境需配置 VAPID 三元组与 `CRON_SECRET`

## 相关链接（绝对 URL）

- [SDK Workspace 总览](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/README.md)
- [Client 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md)
- [SW 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md)
- [API 技术规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)
- [Service Worker 规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/service-worker-specification.md)
