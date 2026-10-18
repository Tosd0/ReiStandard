# 生产环境测试端点部署指南

将 `tests/test-vercel-function.js` 部署为 Serverless 健康检查端点。

## 相关文档

- 本地测试：https://github.com/Tosd0/ReiStandard/blob/main/docs/TEST_README.md
- 手动接入：https://github.com/Tosd0/ReiStandard/blob/main/examples/README.md

## 环境变量

- 必需：`TENANT_DATABASE_URL`
- 可选：
  - `INIT_SECRET`（服务端启用初始化鉴权时再配置）
  - `TEST_USER_ID`

说明：测试端点会先调用 `init-tenant`，然后依次完成 `get-user-key`、`schedule-message`、`send-notifications` 验证。注意 `tests/test-vercel-function.js` 仍按 v2.0.1 契约在 `schedule-message` 请求体内传 `pushSubscription`；若被测服务端为 `@rei-standard/amsg-server` 3.0.0+，需在 `get-user-key` 之后先调 `PUT /api/v1/push-subscription` 登记用户级订阅，并从 `schedule-message` 请求体中去掉 `pushSubscription`。

## 部署方式一：集成到现有项目

### 1. 添加测试端点

```bash
cp tests/test-vercel-function.js api/test-active-messaging.js
```

### 2. 部署

```bash
vercel --prod
```

### 3. 验证

```bash
curl https://your-domain.vercel.app/api/test-active-messaging
```

## 部署方式二：独立测试项目

### 1. 新建最小项目

```bash
mkdir active-messaging-test
cd active-messaging-test
```

### 2. 目录结构

```text
active-messaging-test/
├── api/
│   └── test-active-messaging.js
├── vercel.json
└── .gitignore
```

### 3. 示例 `vercel.json`

环境变量不写进 `vercel.json`（旧的 `"env"` + `@secret` 引用语法已被 Vercel 下线），`vercel.json` 只留函数配置：

```json
{
  "functions": {
    "api/test-active-messaging.js": {
      "maxDuration": 300
    }
  }
}
```

### 4. 设置环境变量

用 CLI 添加（命令会交互式询问值），或在 Vercel 控制台 Project → Settings → Environment Variables 里配置：

```bash
vercel env add TENANT_DATABASE_URL production
```

如果服务端启用了初始化鉴权，再额外配置：

```bash
vercel env add INIT_SECRET production
```

## CI/CD 集成（示例）

```yaml
name: API Health Check
on:
  schedule:
    - cron: '0 */6 * * *'
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Check API
        run: |
          RESPONSE=$(curl -s https://your-domain.vercel.app/api/test-active-messaging)
          FAILED=$(echo "$RESPONSE" | jq -r '.summary.failed')
          if [ "$FAILED" != "0" ]; then
            exit 1
          fi
```

## 告警建议

1. 监控 URL：`/api/test-active-messaging`
2. 轮询间隔：5~10 分钟
3. 告警条件：`summary.failed > 0`

## 故障排查

1. `init-tenant` 子步骤返回 `400 INVALID_PARAMETERS`（外层 HTTP 仍为 `200`，`summary.failed > 0`）：缺失 `TENANT_DATABASE_URL`。
2. `401 INVALID_INIT_AUTH`：服务端启用了 `INIT_SECRET` 且当前值不一致。
3. `401 INVALID_TENANT_AUTH`：token 签发/验签配置异常。
4. `400 PUSH_SUBSCRIPTION_NOT_ACCEPTED` / `409 PUSH_SUBSCRIPTION_MISSING`：服务端已升至 3.0.0+，需改为先调用 `PUT /api/v1/push-subscription` 登记订阅且不在 `schedule-message` 中传 `pushSubscription`。
