# @rei-standard/amsg-client

`@rei-standard/amsg-client` 是 ReiStandard 主动消息标准的浏览器端 SDK 包。

## 文档导航

- [SDK 总览](../README.md)
- [主 README](../../../README.md)
- [Service Worker 规范](../../../standards/service-worker-specification.md)

## 安装

```bash
npm install @rei-standard/amsg-client
```

## 使用

```js
import { ReiClient } from '@rei-standard/amsg-client';

const client = new ReiClient({
  baseUrl: '/api/v1',
  userId: '550e8400-e29b-41d4-a716-446655440000'
});

await client.init();
```

主要能力：

- `init()` 自动调用 `/get-user-key` 获取用户专属密钥（客户端不再持有系统主密钥）
- 自动处理 `schedule-message` / `update-message` 的加密请求
- 自动处理 `messages` 的解密响应
- Push 订阅辅助方法

## 相关包

- 服务端 SDK：[`@rei-standard/amsg-server`](../server/README.md)
- Service Worker SDK：[`@rei-standard/amsg-sw`](../sw/README.md)
