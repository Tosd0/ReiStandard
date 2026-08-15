# ReiStandard AMSG SDK Workspace

主动消息能力的 SDK 工作区，5 个可发布的 npm 包。

| Package | 用途 |
|---------|------|
| [`@rei-standard/amsg-shared`](./shared/README.md) | 推送 schema、builders、类型守卫 |
| [`@rei-standard/amsg-server`](./server/README.md) | 服务端：定时 + 周期 + 即时消息、服务端收件箱、fire-time hooks |
| [`@rei-standard/amsg-client`](./client/README.md) | 浏览器 SDK：加密、请求封装、Push 订阅、收件箱补拉 |
| [`@rei-standard/amsg-sw`](./sw/README.md) | Service Worker：推送展示、离线队列、delivery dedupe |
| [`@rei-standard/amsg-instant`](./instant/README.md) | 无数据库的一次性即时推送 handler（维护态） |

各包当前版本以其 `package.json` / npm 为准（仓库处于 changesets pre 模式时，`next` dist-tag 为最新预发布）。

## 新接入怎么走

**服务端用 `amsg-server` 的单用户线**（一个 Cloudflare Worker + D1）：即时、定时、周期三种消息都在里面，还带服务端收件箱——每条 payload 发出去之前先落一行，客户端上线补拉，一条不少。

接入顺序：**服务端 → `amsg-sw` → `amsg-client`**，三步做完还有第四步：

1. 部署 worker（见 [server README 的快速使用（单用户线）](./server/README.md#快速使用单用户线)）
2. 页面装 Service Worker（`installReiSW`），订 Web Push 并 `putPushSubscription()` 登记
3. 客户端发消息 / 排任务
4. **应用启动时拉一次收件箱**（`getOutbox()` → 处理 → `ackOutbox()`）——到了客户端不会弹通知的内容（思考过程、工具请求、错误）只落收件箱、不发推送，少了这步就等于没有。见 [client README 的「上线补一次收件箱」](./client/README.md#上线补一次收件箱)

`amsg-instant` 是无后端场景的产物，现在是维护态：没有数据库也就没有收件箱，push 漏掉的内容补不回来。已经在用的部署照常工作，新接入不从它起步。

## 链接

- [Root README](../../README.md)
- [API 规范](../../standards/active-messaging-api.md)
- [Service Worker 规范](../../standards/service-worker-specification.md)
- [手动接入示例](../../examples/README.md)（备用路径，滞后于最新 SDK 字段）
