# ReiStandard AMSG SDK Workspace

`packages/rei-standard-amsg` 是主动消息能力的 SDK 工作区，包含 3 个可发布 npm 包。

## 包总览

| Package | 版本 | 用途 | 文档 |
|---------|------|------|------|
| `@rei-standard/amsg-server` | `2.0.1` | 服务端 handlers + Blob 租户配置 + token 鉴权 | [server README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/README.md) |
| `@rei-standard/amsg-instant` | `0.1.0` | 一次性即时推送 handler | [instant README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/instant/README.md) |
| `@rei-standard/amsg-client` | `2.0.1` | 浏览器端加密、请求封装、Push 订阅 | [client README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md) |
| `@rei-standard/amsg-sw` | `2.0.1` | SW 推送展示、离线队列、后台重试 | [sw README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md) |

服务端选哪个：

| 用途                                 | 包                  |
|--------------------------------------|---------------------|
| 一次性即时推送                       | `amsg-instant`      |
| 定时 / 周期消息                      | `amsg-server`       |
| 全都要                               | 两个都装，共用 VAPID + masterKey |

## 推荐接入顺序

1. 先挂服务端（`amsg-server` / `amsg-instant`，按需）
2. 再接 `amsg-sw`
3. 最后接 `amsg-client`

## 相关文档

- [Root README](https://github.com/Tosd0/ReiStandard/blob/main/README.md)
- [API 规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)
- [Service Worker 规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/service-worker-specification.md)
- [手动接入示例](https://github.com/Tosd0/ReiStandard/blob/main/examples/README.md)
