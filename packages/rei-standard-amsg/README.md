# ReiStandard AMSG SDK Workspace

主动消息能力的 SDK 工作区，4 个可发布的 npm 包。

| Package | 版本 | 用途 |
|---------|------|------|
| [`@rei-standard/amsg-instant`](./instant/README.md) | `0.6.1` | 一次性即时推送 handler（无 DB / 无 cron / 无租户） |
| [`@rei-standard/amsg-server`](./server/README.md) | `2.3.1` | 定时 + 周期消息：Blob 租户配置、token 鉴权、标准 handlers |
| [`@rei-standard/amsg-client`](./client/README.md) | `2.2.3` | 浏览器 SDK：加密、请求封装、Push 订阅 |
| [`@rei-standard/amsg-sw`](./sw/README.md) | `2.0.1` | Service Worker：推送展示、离线队列、后台重试 |

**服务端选哪个**：只发"按钮触发 → 立刻推" 用 `amsg-instant`；要定时 / 周期任务 用 `amsg-server`；两种都要就都装，共用同一套 VAPID + masterKey。

**接入顺序**：服务端 → `amsg-sw` → `amsg-client`。

## 链接

- [Root README](../../README.md)
- [API 规范](../../standards/active-messaging-api.md)
- [Service Worker 规范](../../standards/service-worker-specification.md)
- [手动接入示例](../../examples/README.md)（备用路径，滞后于最新 SDK 字段）
