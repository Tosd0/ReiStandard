# @rei-standard/amsg-server

`@rei-standard/amsg-server` 是 ReiStandard 主动消息标准的服务端 SDK（v2.0.0-pre1），提供 Blob 租户配置、租户 token 鉴权和标准路由处理器。

## v2.0.0-pre1 变更摘要

- 初始化流程合并为 `POST /api/v1/init-tenant`
- 移除旧端点：`init-database`、`init-master-key`
- 业务端点统一使用 `Authorization: Bearer <tenantToken>`
- `send-notifications` 支持 `cronToken`（Header 或 query token）

## 安装

```bash
npm install @rei-standard/amsg-server web-push @netlify/blobs

# 数据库驱动二选一
npm install @neondatabase/serverless
# 或
npm install pg
```

## 快速使用

```js
import { createReiServer } from '@rei-standard/amsg-server';

const rei = await createReiServer({
  vapid: {
    email: process.env.VAPID_EMAIL,
    publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY
  },
  tenant: {
    blobNamespace: 'rei-tenants',
    kek: process.env.TENANT_CONFIG_KEK,
    tokenSigningKey: process.env.TENANT_TOKEN_SIGNING_KEY,
    initSecret: process.env.INIT_SECRET,
    publicBaseUrl: process.env.PUBLIC_BASE_URL
  }
});

// 映射路由
// POST /api/v1/init-tenant          -> rei.handlers.initTenant.POST
// GET  /api/v1/get-user-key         -> rei.handlers.getUserKey.GET
// POST /api/v1/schedule-message     -> rei.handlers.scheduleMessage.POST
// POST /api/v1/send-notifications   -> rei.handlers.sendNotifications.POST
// PUT  /api/v1/update-message       -> rei.handlers.updateMessage.PUT
// DELETE /api/v1/cancel-message     -> rei.handlers.cancelMessage.DELETE
// GET  /api/v1/messages             -> rei.handlers.messages.GET
```

## 一体化初始化流程

1. 管理员配置环境变量（VAPID + tenant secrets）
2. 租户调用 `POST /api/v1/init-tenant` 提交自己的 `databaseUrl`
3. 服务端自动完成：建表 + 生成 masterKey + 写入 Blob + 返回 `tenantToken`/`cronToken`
4. 前端使用 `tenantToken`，cron 使用 `cronToken`

## 端点鉴权

- `get-user-key`、`schedule-message`、`update-message`、`cancel-message`、`messages`
  - `Authorization: Bearer <tenantToken>`
- `send-notifications`
  - `Authorization: Bearer <cronToken>` 或 `?token=<cronToken>`

## 导出 API（Exports）

- `createReiServer`
- `createAdapter`
- `createTenantToken`
- `verifyTenantToken`
- `deriveUserEncryptionKey`
- `decryptPayload`
- `encryptForStorage`
- `decryptFromStorage`
- `validateScheduleMessagePayload`
- `isValidISO8601`
- `isValidUrl`
- `isValidUUID`
- `isValidUUIDv4`

## 运行环境与要求

- Node.js `>=20`
- 必须安装 `web-push`
- 必须安装 `@netlify/blobs`
- 必须安装至少一个数据库驱动（`@neondatabase/serverless` 或 `pg`）
- 必须配置：
  - `VAPID_EMAIL`
  - `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
  - `VAPID_PRIVATE_KEY`
  - `TENANT_CONFIG_KEK`
  - `TENANT_TOKEN_SIGNING_KEY`
- 可选配置：
  - `INIT_SECRET`（配置后 `init-tenant` 必须带 `X-Init-Secret`）

## 相关链接（绝对 URL）

- [SDK Workspace 总览](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/README.md)
- [Client 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md)
- [SW 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md)
- [API 技术规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)
- [Service Worker 规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/service-worker-specification.md)
