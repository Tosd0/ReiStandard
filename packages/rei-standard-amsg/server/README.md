# @rei-standard/amsg-server

`@rei-standard/amsg-server` 是 ReiStandard 主动消息标准的服务端 SDK 包。

## 文档导航

- [SDK 总览](../README.md)
- [主 README](../../../README.md)
- [API 技术规范](../../../standards/active-messaging-api.md)

## 安装

```bash
npm install @rei-standard/amsg-server web-push

# 数据库驱动二选一
npm install @neondatabase/serverless
# 或
npm install pg
```

## 使用

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
```

导出的标准 handler：

- `rei.handlers.initDatabase`
- `rei.handlers.initMasterKey`
- `rei.handlers.getUserKey`
- `rei.handlers.scheduleMessage`
- `rei.handlers.sendNotifications`
- `rei.handlers.updateMessage`
- `rei.handlers.cancelMessage`
- `rei.handlers.messages`

推荐初始化顺序：

1. 调用 `initDatabase.GET`（幂等创建表）
2. 调用 `initMasterKey.POST`（一次性初始化系统密钥）
3. 客户端携带 UUID v4 `X-User-Id` 调用 `getUserKey.GET`

## 相关包

- 浏览器 SDK：[`@rei-standard/amsg-client`](../client/README.md)
- Service Worker SDK：[`@rei-standard/amsg-sw`](../sw/README.md)
