# ReiStandard AMSG SDK Workspace

主动消息能力的 SDK 工作区，5 个可发布的 npm 包。

| Package | 版本 | 用途 |
|---------|------|------|
| [`@rei-standard/amsg-shared`](./shared/README.md) | `0.2.0` | 推送 schema、builders、类型守卫 |
| [`@rei-standard/amsg-instant`](./instant/README.md) | `0.9.0` | 一次性即时推送 handler（SSE 默认传输 / always-on Web Push backup） |
| [`@rei-standard/amsg-server`](./server/README.md) | `2.5.0` | 定时 + 周期消息：Blob 租户配置、token 鉴权、标准 handlers |
| [`@rei-standard/amsg-client`](./client/README.md) | `2.4.0` | 浏览器 SDK：加密、请求封装、Push 订阅、SSE consumer |
| [`@rei-standard/amsg-sw`](./sw/README.md) | `2.2.0` | Service Worker：推送展示、离线队列、delivery dedupe |

**服务端选哪个**：只发"按钮触发 → 立刻推" 用 `amsg-instant`；要定时 / 周期任务 用 `amsg-server`；两种都要就都装，共用同一套 VAPID + masterKey。

**接入顺序**：服务端 → `amsg-sw` → `amsg-client`。

## 链接

- [Root README](../../README.md)
- [API 规范](../../standards/active-messaging-api.md)
- [Service Worker 规范](../../standards/service-worker-specification.md)
- [手动接入示例](../../examples/README.md)（备用路径，滞后于最新 SDK 字段）
