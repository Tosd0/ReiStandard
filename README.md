# ReiStandard

**主动消息 API 标准**：本仓库含纯前端项目（小手机）统一的定时/即时消息推送接口与实现规范，支持端到端加密、Serverless 部署与三包接入。最小只需要一个数据库就能持续跑，全程免费！

> **v2.0.1 初始化变更（重要）**：初始化已从 `init-database + init-master-key` 合并为 `POST /api/v1/init-tenant` 一步完成。业务端点统一使用 `tenantToken` / `cronToken` 鉴权。

## 📦 Package-First（推荐）

| Package | 版本 | 说明 | 文档 |
|---------|------|------|------|
| `@rei-standard/amsg-server` | `2.0.1` | 服务端 SDK（Blob 租户化 + 标准 handlers） | [packages/rei-standard-amsg/server/README.md](./packages/rei-standard-amsg/server/README.md) |
| `@rei-standard/amsg-instant` | `0.1.0` | 一次性即时推送 handler | [packages/rei-standard-amsg/instant/README.md](./packages/rei-standard-amsg/instant/README.md) |
| `@rei-standard/amsg-client` | `2.0.1` | 浏览器 SDK（加密、请求封装、Push 订阅） | [packages/rei-standard-amsg/client/README.md](./packages/rei-standard-amsg/client/README.md) |
| `@rei-standard/amsg-sw` | `2.0.1` | Service Worker SDK（推送展示、离线队列） | [packages/rei-standard-amsg/sw/README.md](./packages/rei-standard-amsg/sw/README.md) |

服务端选哪个：一次性消息用 `amsg-instant`，定时 / 周期消息用 `amsg-server`，两个都装也行（共用 VAPID + masterKey）。详见 [SDK 总览](./packages/rei-standard-amsg/README.md)。

快速引用：

```js
import { createReiServer } from '@rei-standard/amsg-server';
import { createInstantHandler } from '@rei-standard/amsg-instant';
import { ReiClient } from '@rei-standard/amsg-client';
import { installReiSW } from '@rei-standard/amsg-sw';
```

## 🚩 一体化初始化（v2.0.1）

### 管理员一次性步骤（每个部署一次）

1. 部署项目到 Netlify（或兼容的 Serverless 平台）。
2. 配置以下环境变量：
   - `VAPID_EMAIL`
   - `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
   - `VAPID_PRIVATE_KEY`
   - `TENANT_CONFIG_KEK`
   - `TENANT_TOKEN_SIGNING_KEY`
   - `INIT_SECRET`（可选，配置后 `init-tenant` 需带 `X-Init-Secret`）
   
   `.env` 示例：
   
   ```dotenv
   VAPID_EMAIL=youremail@example.com
   NEXT_PUBLIC_VAPID_PUBLIC_KEY=YOUR-PUBLIC-KEY
   VAPID_PRIVATE_KEY=YOUR-PRIVATE-KEY
   TENANT_CONFIG_KEK=YOUR-KEK-SECRET
   TENANT_TOKEN_SIGNING_KEY=YOUR-TOKEN-SIGNING-KEY
   # 可选：配置后 init-tenant 必须带 X-Init-Secret
   INIT_SECRET=YOUR-INIT-SECRET
   PUBLIC_BASE_URL=https://your-domain.com
   VERCEL_PROTECTION_BYPASS=YOUR_BYPASS_KEY
   ```

   建议生成方式（用于 `TENANT_CONFIG_KEK` / `TENANT_TOKEN_SIGNING_KEY`，以及可选的 `INIT_SECRET`）：

   ```bash
   openssl rand -base64 32
   ```

   部署配置示例可参考：`examples/vercel.json.example`
3. 发布后即可接收租户初始化请求。

### 租户一次性步骤（每个租户一次）

1. 调用 `POST /api/v1/init-tenant` 并提交自己的 `databaseUrl`。
2. 服务端自动完成：连库校验 + 建表 + 生成 masterKey + 写入 Blob + 发放 token。
3. 获取 `tenantToken`（业务请求）与 `cronToken`（定时触发）。

### 日常调用（自动鉴权）

1. 前端调用业务端点时携带 `Authorization: Bearer <tenantToken>`。
2. Cron 调用 `/api/v1/send-notifications` 时携带 `cronToken`（Header 或 query token）。

## 📚 文档分层规则（Source of Truth）

1. `packages/*/README.md`：主入口，负责安装、使用、导出、格式兼容（npmjs 场景优先）。
2. `standards/*.md`：权威规范，定义字段、端点、行为与边界。
3. `examples/` 与 `docs/`：手动接入、测试与监控（备用路径）。

## 🚀 5 分钟接入路径

1. 先看 [Service Worker 规范第 0 章（SDK 快速接入）](./standards/service-worker-specification.md)。
2. 按 [SDK 总览](./packages/rei-standard-amsg/README.md) 打开对应包文档。
3. 按包 README 完成 server / client / sw 三段接入。

安装命令：

```bash
npm install @rei-standard/amsg-server @rei-standard/amsg-client @rei-standard/amsg-sw web-push

# 数据库驱动二选一
npm install @neondatabase/serverless
# 或
npm install pg
```

## 🧰 手动接入（备用）

当你不使用 SDK 包时，请走以下文档：

1. [examples/README.md](./examples/README.md)（手动部署步骤）
2. [docs/TEST_README.md](./docs/TEST_README.md)（本地测试）
3. [docs/VERCEL_TEST_DEPLOY.md](./docs/VERCEL_TEST_DEPLOY.md)（生产监控）

## 📖 核心文档

1. [SDK 总览](./packages/rei-standard-amsg/README.md)
2. [API 技术规范](./standards/active-messaging-api.md)
3. [Service Worker 规范](./standards/service-worker-specification.md)
4. [手动部署指南](./examples/README.md)
5. [本地测试](./docs/TEST_README.md)
6. [生产监控](./docs/VERCEL_TEST_DEPLOY.md)

## 📝 TODO

- [ ] `@rei-standard/amsg-server` 增加可插拔 `tenantStore` 抽象（默认 `Netlify Blob`，并支持自定义存储实现），降低平台强依赖。

---

> **⚠️ 文档维护说明（主声明）**
>
> 本仓库是技术标准仓库，除非修复错误或经过评审，不应随意更改既定字段、端点路径、数据结构与错误代码。
> 如发现问题或改进建议，请提 Issue 或与维护者讨论后再变更标准文本。

## 📦 项目结构

```text
ReiStandard/
├── standards/                         # 规范定义（权威）
├── packages/rei-standard-amsg/        # 三个 npm SDK 包
├── examples/                          # 手动接入示例（备用）
├── docs/                              # 测试与监控文档
├── tests/                             # 测试脚本
└── README.md                          # 本文件
```

## 🔗 外部资源

- [VAPID 密钥生成](https://vapidkeys.com)
- [Web Push RFC 8030](https://datatracker.ietf.org/doc/html/rfc8030)
- [Service Worker API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)

## 🤝 贡献

1. 提交 Issue 描述问题或建议。
2. Fork 并发起 Pull Request。
3. 或在 QQ 群内提出建议

## 📄 许可

本标准采用 **CC BY-NC-SA 4.0**（Creative Commons 署名-非商业性使用-相同方式共享）协议发布。

---

## 👥 致谢

本标准基于 Whale小手机 团队的主动消息实现经验总结而成。特别感谢：TO（发起人）、汤圆、脆脆机、koko、糯米机、33小手机、Raven、toufu、菲洛图等老师的小手机项目的积极参与和支持。
