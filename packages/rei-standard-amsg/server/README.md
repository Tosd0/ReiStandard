# @rei-standard/amsg-server

`@rei-standard/amsg-server` 是 ReiStandard 主动消息标准的服务端 SDK（v2.0.1），提供 Blob 租户配置、租户 token 鉴权和标准路由处理器。

## v2.0.1 变更摘要

- 初始化流程合并为 `POST /api/v1/init-tenant`
- 移除旧端点：`init-database`、`init-master-key`
- 业务端点统一使用 `Authorization: Bearer <tenantToken>`
- `send-notifications` 支持 `cronToken`（Header 或 query token）

## 安装

```bash
npm install @rei-standard/amsg-server web-push @netlify/blobs

# 数据库驱动二选一
npm install @neondatabase/serverless
# 或
npm install pg
```

## 快速使用

```js
import { createReiServer } from '@rei-standard/amsg-server';

const rei = await createReiServer({
  vapid: {
    email: process.env.VAPID_EMAIL,
    publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY
  },
  tenant: {
    blobNamespace: 'rei-tenants',
    kek: process.env.TENANT_CONFIG_KEK,
    tokenSigningKey: process.env.TENANT_TOKEN_SIGNING_KEY,
    initSecret: process.env.INIT_SECRET,
    publicBaseUrl: process.env.PUBLIC_BASE_URL
  }
});

// 映射路由
// POST /api/v1/init-tenant          -> rei.handlers.initTenant.POST
// GET  /api/v1/get-user-key         -> rei.handlers.getUserKey.GET
// POST /api/v1/schedule-message     -> rei.handlers.scheduleMessage.POST
// POST /api/v1/send-notifications   -> rei.handlers.sendNotifications.POST
// PUT  /api/v1/update-message       -> rei.handlers.updateMessage.PUT
// DELETE /api/v1/cancel-message     -> rei.handlers.cancelMessage.DELETE
// GET  /api/v1/messages             -> rei.handlers.messages.GET
```

## 关于 `messageType: 'instant'`

> **Note**：新代码的 instant 消息请用 [@rei-standard/amsg-instant](../instant/README.md)，跳过本端点的"建任务 → 处理 → 删任务" DB 来回。本端点的 `instant` 分支为兼容保留，行为不变、不会有运行时警告。

## AI 接口 `apiUrl` 约束

当 `messageType` 为 `prompted` / `auto`，或 `instant` 使用 AI 配置时：

- `apiUrl` 必须是完整聊天端点（例如：`https://api.openai.com/v1/chat/completions`）。
- SDK 会自动做最小规范化：去首尾空白、去路径尾部多余 `/`。
- SDK **不会**自动补全 `/v1`、`/chat/completions` 等路径。
- `maxTokens` 为可选字段：传了就映射为 `max_tokens`；不传则不指定（由上游模型默认策略决定）。

如果上游返回 `405 Method Not Allowed`，通常表示 `apiUrl` 指向了基础域名而非聊天端点，请优先检查配置值。

## 提示词字段（`completePrompt` vs `messages`，2.2.0+）

AI 配置消息的提示词可以用两种形态之一，**互斥二选一**：

- `completePrompt: string` —— 简单场景：内部包成单条 `{role:'user', content}` 后发给 LLM。
- `messages: Array<{ role: 'system'|'user'|'assistant'|'tool', content: string | unknown[] }>` —— 多轮 / 带 system role：**原样**转发给 LLM，不做任何 role 注入或重排。和上游主聊天路径调用 LLM 的 body 字节级一致。

两个字段同时给 → `400 INVALID_PARAMETERS`；都不给且没 `userMessage`（仅 instant 类型允许 fallback）也是 400。`messages` 数组必须非空，role 必须是上面四种之一。

可选 `temperature?: number` 透传给 LLM：`completePrompt` 路径未传时默认 0.8（保持旧行为）；`messages` 路径未传时**不发**，让上游主路径自己决定。

## 导出（新增）

- `validateLlmMessagesArray(messages)` — 同步预校验 messages 数组，返回 `string | null`（错误信息 / 通过）。和 `@rei-standard/amsg-instant` 的校验规则字节级一致。

## 一体化初始化流程

1. 管理员配置环境变量（VAPID + tenant secrets）
2. 租户调用 `POST /api/v1/init-tenant` 提交自己的 `databaseUrl`
3. 服务端自动完成：建表 + 生成 masterKey + 写入 Blob + 返回 `tenantToken`/`cronToken`
4. 前端使用 `tenantToken`，cron 使用 `cronToken`

## 端点鉴权

- `get-user-key`、`schedule-message`、`update-message`、`cancel-message`、`messages`
  - `Authorization: Bearer <tenantToken>`
- `send-notifications`
  - `Authorization: Bearer <cronToken>` 或 `?token=<cronToken>`

## 导出 API（Exports）

- `createReiServer`
- `createAdapter`
- `createTenantToken`
- `verifyTenantToken`
- `deriveUserEncryptionKey`
- `decryptPayload`
- `encryptForStorage`
- `decryptFromStorage`
- `validateScheduleMessagePayload`
- `isValidISO8601`
- `isValidUrl`
- `isValidUUID`
- `isValidUUIDv4`

## 运行环境与要求

- Node.js `>=20`
- 必须安装 `web-push`
- 必须安装 `@netlify/blobs`
- 必须安装至少一个数据库驱动（`@neondatabase/serverless` 或 `pg`）
- 必须配置：
  - `VAPID_EMAIL`
  - `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
  - `VAPID_PRIVATE_KEY`
  - `TENANT_CONFIG_KEK`
  - `TENANT_TOKEN_SIGNING_KEY`
- 可选配置：
  - `INIT_SECRET`（配置后 `init-tenant` 必须带 `X-Init-Secret`）

## 相关链接（绝对 URL）

- [SDK Workspace 总览](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/README.md)
- [Client 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md)
- [SW 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md)
- [API 技术规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)
- [Service Worker 规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/service-worker-specification.md)
