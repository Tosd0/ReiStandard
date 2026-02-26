# ReiStandard 手动接入部署指南（v2.0.1 Blob 一体化初始化）

> 本文档用于不使用 SDK 包时的手动接入。优先推荐 Package-First。

## 目录结构

```text
examples/
├── api/v1/
│   ├── init-tenant.js               # 一体化租户初始化
│   ├── get-user-key.js              # 用户密钥分发（需 tenantToken）
│   ├── schedule-message.js          # 创建任务 / 即时消息（需 tenantToken）
│   ├── send-notifications.js        # Cron 触发处理（需 cronToken）
│   ├── update-message.js            # 更新任务（需 tenantToken）
│   ├── cancel-message.js            # 取消任务（需 tenantToken）
│   └── messages.js                  # 查询任务列表（需 tenantToken）
└── lib/
    ├── blob-tenant-store.js         # Blob 租户配置存储
    ├── tenant-token.js              # tenant/cron token 签发与校验
    └── tenant-context.js            # 租户初始化与请求解析
```

## 管理员一次性步骤（每个部署一次）

### 1. 复制示例代码

```bash
cp -r examples/api ./
cp -r examples/lib ./
```

### 2. 安装依赖

```bash
npm install web-push @netlify/blobs @neondatabase/serverless
# 如需 pg
# npm install pg
```

### 3. 配置环境变量

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

建议生成方式：

```bash
openssl rand -base64 32
```

可分别用于：`TENANT_CONFIG_KEK`、`TENANT_TOKEN_SIGNING_KEY`，`INIT_SECRET` 为可选增强项。

## 租户一次性步骤（每个租户一次）

租户提交自己的数据库连接串到 `init-tenant`：

```bash
curl -X POST "https://your-domain.com/api/v1/init-tenant" \
  -H "Content-Type: application/json" \
  -d '{
    "driver": "neon",
    "databaseUrl": "postgresql://user:pass@host/db"
  }'
```

如果你配置了 `INIT_SECRET`，再加上：

```bash
-H "X-Init-Secret: YOUR-INIT-SECRET"
```

成功响应包含：

- `tenantId`
- `tenantToken`
- `cronToken`
- `cronWebhookUrl`
- `masterKeyFingerprint`

## 日常调用

### 前端业务请求（tenantToken）

- `get-user-key`
- `schedule-message`
- `update-message`
- `cancel-message`
- `messages`

统一携带：

```http
Authorization: Bearer <tenantToken>
```

### Cron 调度（cronToken）

可直接使用初始化返回的 `cronWebhookUrl`，或手动调用：

```bash
curl -X POST "https://your-domain.com/api/v1/send-notifications" \
  -H "Authorization: Bearer YOUR_CRON_TOKEN"
```

## 端点清单

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/v1/init-tenant` | POST | 一体化初始化租户 |
| `/api/v1/get-user-key` | GET | 获取用户密钥 |
| `/api/v1/schedule-message` | POST | 创建任务/即时消息 |
| `/api/v1/send-notifications` | POST | Cron 触发发送 |
| `/api/v1/update-message` | PUT | 更新任务 |
| `/api/v1/cancel-message` | DELETE | 取消任务 |
| `/api/v1/messages` | GET | 查询任务 |

## 测试与监控

- 本地测试：https://github.com/Tosd0/ReiStandard/blob/main/docs/TEST_README.md
- 生产监控：https://github.com/Tosd0/ReiStandard/blob/main/docs/VERCEL_TEST_DEPLOY.md

## 规范参考

- API 技术规范：https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md
- Service Worker 规范：https://github.com/Tosd0/ReiStandard/blob/main/standards/service-worker-specification.md
