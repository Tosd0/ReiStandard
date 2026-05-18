# ReiStandard

**主动消息 API 标准**：让纯前端项目（小手机类）也能可靠地推定时 / 即时消息。端到端加密、Serverless 部署、三包接入。一个数据库就能持续跑，全程免费。

## 📦 包

| 包 | 版本 | 用途 |
|---|---|---|
| [`@rei-standard/amsg-instant`](./packages/rei-standard-amsg/instant/README.md) | `0.6.1` | 一次性即时推送（无 DB、无 cron、无租户） |
| [`@rei-standard/amsg-server`](./packages/rei-standard-amsg/server/README.md) | `2.3.1` | 定时 / 周期消息，多租户 Blob 配置 + token 鉴权 |
| [`@rei-standard/amsg-client`](./packages/rei-standard-amsg/client/README.md) | `2.2.3` | 浏览器 SDK：加密、请求封装、Push 订阅 |
| [`@rei-standard/amsg-sw`](./packages/rei-standard-amsg/sw/README.md) | `2.0.1` | Service Worker：推送展示、离线队列 |

**怎么挑服务端包**：只发"按钮点了就立刻推一条" → `amsg-instant`；要定时或周期任务 → `amsg-server`；两种都要就都装，共用同一套 VAPID 与 masterKey。

## 🚀 接入

1. 服务端：按你选的包打开它的 README，里面有环境变量、`createReiServer` / `createInstantHandler` 用法、各平台 (Netlify / Vercel / Cloudflare / Node) 的适配器。
2. 浏览器：装 `amsg-client` 和 `amsg-sw`，按 [Service Worker 规范第 0 章](./standards/service-worker-specification.md#0-快速接入路径推荐使用-sdk-包) 的最小示例接。

```bash
# 服务端选其一（或都装）
npm install @rei-standard/amsg-server
npm install @rei-standard/amsg-instant

# 浏览器
npm install @rei-standard/amsg-client @rei-standard/amsg-sw
```

数据库驱动按 `amsg-server` README 提示二选一（`@neondatabase/serverless` 或 `pg`）。

## 🗂 仓库布局

```text
ReiStandard/
├── standards/                   # 权威规范文本（端点、字段、错误码）
├── packages/rei-standard-amsg/  # 4 个发布到 npm 的 SDK 包
│   ├── server/                  # 定时 / 周期消息（多租户 Blob + token）
│   ├── instant/                 # 一次性即时推送（无 DB / 无 cron）
│   ├── client/                  # 浏览器 SDK（加密、请求封装、Push 订阅）
│   └── sw/                      # Service Worker（推送展示、离线队列）
├── examples/                    # 手动接入示例（不用 SDK 包时的备用路径）
└── docs/                        # 本地测试、生产监控
```

## 📖 文档

- [API 技术规范](./standards/active-messaging-api.md) — 端点、字段、错误码、鉴权
- [Service Worker 规范](./standards/service-worker-specification.md) — SW 行为、消息协议、兼容性
- [手动接入示例](./examples/README.md) — 不用 SDK 包的备用路径（**滞后于最新 SDK 字段**，新接入请用包）
- [本地测试](./docs/TEST_README.md) · [生产监控](./docs/VERCEL_TEST_DEPLOY.md)

## ⚠️ 文档维护原则

本仓库是技术标准仓库。字段名、端点路径、数据结构、错误代码一旦定下来，除非修 bug 或经过评审，不应随意更改。发现问题请提 Issue 或在群里讨论。

## 📄 许可

CC BY-NC-SA 4.0（署名 - 非商业 - 相同方式共享）。

## 👥 致谢

本标准基于 Whale 小手机、糯米机 的主动消息实现经验。特别感谢：汤圆、脆脆机、koko、糯米机、33 小手机、Raven、toufu、菲洛图等老师的小手机项目的积极参与和支持。
