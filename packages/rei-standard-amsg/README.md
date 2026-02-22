# ReiStandard AMSG SDK Workspace

`packages/rei-standard-amsg` 目录是 ReiStandard 主动消息能力的 SDK 工作区，包含 3 个可发布包。

## 包总览

| Package | 当前版本 | 说明 | 文档 |
|---------|----------|------|------|
| `@rei-standard/amsg-server` | `1.1.0` | 主动消息 API 服务端 SDK（标准 handler + DB adapter） | [server/README.md](./server/README.md) |
| `@rei-standard/amsg-client` | `1.1.0` | 浏览器端 SDK（加密、请求封装、Push 订阅） | [client/README.md](./client/README.md) |
| `@rei-standard/amsg-sw` | `1.1.0` | Service Worker 插件（推送展示、离线队列） | [sw/README.md](./sw/README.md) |

## 使用示例

```js
import { createReiServer } from '@rei-standard/amsg-server';
import { ReiClient } from '@rei-standard/amsg-client';
import { installReiSW } from '@rei-standard/amsg-sw';
```

## Workspace 命令

在仓库根目录执行：

```bash
npm run build
npm run test
```

## 相关文档

- [主 README](../../README.md)
- [API 技术规范](../../standards/active-messaging-api.md)
- [Service Worker 规范](../../standards/service-worker-specification.md)
- [部署教程](../../examples/README.md)
