# 生产环境测试端点部署指南

将 `tests/test-vercel-function.js` 部署为 Serverless 测试端点，用于持续健康检查。

## 相关文档

- 本地测试主指南：https://github.com/Tosd0/ReiStandard/blob/main/docs/TEST_README.md
- 手动接入部署：https://github.com/Tosd0/ReiStandard/blob/main/examples/README.md

## 环境变量

本文件不重复定义语义，直接复用：

- `API_BASE_URL`
- `CRON_SECRET`
- `TEST_USER_ID`

说明见：
https://github.com/Tosd0/ReiStandard/blob/main/docs/TEST_README.md

额外可选：

- `INIT_SECRET`（如果你希望初始化接口有额外保护）

## 部署方式一：集成到现有项目

### 1. 添加测试端点

```bash
cp tests/test-vercel-function.js /api/test-active-messaging.js
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

```json
{
  "version": 2,
  "env": {
    "API_BASE_URL": "https://your-actual-api-domain.vercel.app",
    "CRON_SECRET": "@cron-secret"
  }
}
```

### 4. 设置 Secret

```bash
vercel secrets add cron-secret "your_cron_secret"
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
2. 轮询间隔：5 分钟
3. 告警条件：`summary.failed > 0`

## 故障排查

1. `500 Configuration error`：环境变量缺失。
2. `401`：`CRON_SECRET` 与 API 端不一致。
3. 测试通过率波动：优先检查数据库连通与 VAPID 配置。
