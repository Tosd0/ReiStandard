# 主动消息 API 本地测试指南

本指南用于本地或预发环境验证多租户 Blob 一体化初始化与排程流程。

> 注意：`tests/test-active-messaging-api.js` 脚本本身仍按 v2.0.1 契约编写（在 `POST /api/v1/schedule-message` 请求体里内嵌 `pushSubscription`）。针对 `@rei-standard/amsg-server` 3.0.0 部署测试时，需先用派生出的 `userKey` 加密调用 `PUT /api/v1/push-subscription` 登记用户级订阅，并在 `schedule-message` 请求体中去掉 `pushSubscription` 字段。

## 相关文档

- 手动接入：https://github.com/Tosd0/ReiStandard/blob/main/examples/README.md
- 生产监控：https://github.com/Tosd0/ReiStandard/blob/main/docs/VERCEL_TEST_DEPLOY.md
- 技术规范：https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md

## 测试覆盖

- `POST /api/v1/init-tenant`
- `GET /api/v1/get-user-key`
- `PUT /api/v1/push-subscription`（server 3.0.0 排程前置步骤）
- `POST /api/v1/schedule-message`
- `GET /api/v1/messages`
- `POST /api/v1/send-notifications`

## 环境变量

必须：

- `API_BASE_URL`：被测 API 地址（例如 `https://your-domain.com`）
- `TENANT_DATABASE_URL`：测试租户数据库连接串

可选：

- `INIT_SECRET`：`init-tenant` 鉴权密钥（服务端配置了才需要）
- `TEST_USER_ID`：测试用户 UUID v4（不填自动生成）
- `VERCEL_PROTECTION_BYPASS`：Vercel 保护绕过头

## 使用方式

### 方式 A：脚本一键（推荐）

```bash
cd tests
cp .env.test.example .env.test
# 编辑 .env.test 后执行
./run-test.sh
```

### 方式 B：命令行临时变量

```bash
cd tests
API_BASE_URL=https://your-domain.com \
TENANT_DATABASE_URL=postgres://... \
node test-active-messaging-api.js
```

### 方式 C：PowerShell

```powershell
$env:API_BASE_URL="https://your-domain.com"
$env:TENANT_DATABASE_URL="postgres://..."
node tests/test-active-messaging-api.js
```

## 常见问题

1. `401 INVALID_INIT_AUTH`：服务端启用了 `INIT_SECRET` 且请求未携带/不匹配。
2. `401 INVALID_TENANT_AUTH`：`tenantToken/cronToken` 缺失或无效。
3. `INVALID_USER_ID_FORMAT`：`TEST_USER_ID` 不是 UUID v4。
4. `400 PUSH_SUBSCRIPTION_NOT_ACCEPTED`：服务端为 3.0.0+，但 `schedule-message` 请求体仍带了 `pushSubscription`。
5. `409 PUSH_SUBSCRIPTION_MISSING`：调用 `schedule-message` 前尚未通过 `PUT /api/v1/push-subscription` 为该用户登记推送订阅。
6. `VAPID_CONFIG_ERROR`：检查 VAPID 三个环境变量。
