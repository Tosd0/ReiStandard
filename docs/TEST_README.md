# 主动消息 API 本地测试指南

本指南用于本地或预发环境验证主动消息 API 的可用性。

## 相关文档

- 部署手动接入：https://github.com/Tosd0/ReiStandard/blob/main/examples/README.md
- 生产监控部署：https://github.com/Tosd0/ReiStandard/blob/main/docs/VERCEL_TEST_DEPLOY.md
- API 技术规范：https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md

## 测试覆盖

- `GET /api/v1/get-user-key`
- `POST /api/v1/schedule-message`（fixed/prompted/auto/instant）
- `GET /api/v1/messages`
- `PUT /api/v1/update-message`
- `DELETE /api/v1/cancel-message`
- `POST /api/v1/send-notifications`
- AES-256-GCM 请求/响应链路
- 参数验证与失败场景

## 环境变量说明（主说明）

必须配置：

- `API_BASE_URL`：被测主动消息 API 地址（不是 AI API 地址）
- `CRON_SECRET`：用于 `/send-notifications` 认证

可选配置：

- `TEST_USER_ID`：不填则自动生成 UUID v4

> 生产监控文档复用本节定义，不再重复解释：
> https://github.com/Tosd0/ReiStandard/blob/main/docs/VERCEL_TEST_DEPLOY.md

## 使用方式

### 方式 A：脚本一键（推荐）

```bash
cd tests
cp ../examples/.env.test.example .env.test
# 编辑 .env.test 后执行
./run-test.sh
```

### 方式 B：命令行临时变量

```bash
cd tests
API_BASE_URL=https://your-domain.com \
CRON_SECRET=your_secret \
node test-active-messaging-api.js
```

### 方式 C：PowerShell

```powershell
$env:API_BASE_URL="https://your-domain.com"
$env:CRON_SECRET="your_secret"
node tests/test-active-messaging-api.js
```

## 常见问题

1. `401 UNAUTHORIZED`：`CRON_SECRET` 不匹配。
2. `503 MASTER_KEY_NOT_INITIALIZED`：先调用 `init-master-key`。
3. `INVALID_USER_ID_FORMAT`：`TEST_USER_ID` 不是 UUID v4。
4. 测试中断未清理：用 `cancel-message` 删除残留任务。

## 下一步

- 需要持续健康检查时，继续看：
  https://github.com/Tosd0/ReiStandard/blob/main/docs/VERCEL_TEST_DEPLOY.md
