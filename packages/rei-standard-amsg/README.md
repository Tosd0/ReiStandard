# ReiStandard AMSG SDK Workspace

`packages/rei-standard-amsg` 是主动消息能力的 SDK 工作区，包含 3 个可发布 npm 包。

## 包总览

| Package | 版本 | 用途 | 文档 |
|---------|------|------|------|
| `@rei-standard/amsg-server` | `2.0.0-pre1` | 服务端标准 handlers、Blob 租户配置与 token 鉴权 | [server README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/README.md) |
| `@rei-standard/amsg-client` | `2.0.0-pre1` | 浏览器端加密、请求封装、Push 订阅 | [client README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md) |
| `@rei-standard/amsg-sw` | `2.0.0-pre1` | SW 推送展示、离线队列、后台重试 | [sw README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md) |

## 推荐接入顺序

1. 先接入 `@rei-standard/amsg-server`，挂载标准 API。
2. 再接入 `@rei-standard/amsg-sw`，完成通知展示与离线能力。
3. 最后接入 `@rei-standard/amsg-client`，完成前端加密与任务创建。

## 相关文档

- [Root README](https://github.com/Tosd0/ReiStandard/blob/main/README.md)
- [API 规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)
- [Service Worker 规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/service-worker-specification.md)
- [手动接入示例](https://github.com/Tosd0/ReiStandard/blob/main/examples/README.md)
