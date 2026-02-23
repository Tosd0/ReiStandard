# 生产环境测试端点部署指南

将测试端点本身部署为 Vercel Serverless Function，实现生产环境的持续健康检查和 API 监控。

> **📚 相关文档**：
> - **API 技术规范**：[standards/active-messaging-api.md](../standards/active-messaging-api.md)
> - **部署指南**：[examples/README.md](../examples/README.md)
> - **本地测试**：[TEST_README.md](./TEST_README.md)

---

## 部署方式一：集成到现有项目

### 1. 添加测试端点文件

将 `tests/test-vercel-function.js` 复制到你的项目 API 目录：

```bash
# 假设你的项目结构是：
# /api/v1/schedule-message.js
# /api/v1/send-notifications.js
# ...

# 复制测试文件到（路径仅为示例）：
cp tests/test-vercel-function.js /api/test-active-messaging.js
```

### 2. 配置环境变量

在 Vercel Dashboard 或 `.env` 文件中添加：

```env
# 必需配置
CRON_SECRET=your_cron_secret

# 可选配置
INIT_SECRET=your_init_secret
TEST_USER_ID=550e8400-e29b-41d4-a716-446655440000
API_BASE_URL=https://your-domain.vercel.app
```

**注意**:
- `API_BASE_URL` 指定要测试的主动消息 API 服务器地址（不是 AI API）
- 如果测试端点和 API 在同一域名下，可以省略此配置，会自动使用当前域名
- 测试时不会真正调用 AI API，只测试主动消息 API 的端点连通性

### 3. 部署并测试

```bash
# 部署到 Vercel
vercel --prod

# 或者推送到 Git（如果配置了自动部署）
git add api/test-active-messaging.js
git commit -m "Add API test endpoint"
git push
```

### 4. 访问测试端点

```bash
# 浏览器访问
https://your-domain.vercel.app/api/test-active-messaging

# 或使用 curl
curl https://your-domain.vercel.app/api/test-active-messaging
```

**响应示例**:
```json
{
  "summary": {
    "total": 6,
    "passed": 6,
    "failed": 0,
    "successRate": "100.0%"
  },
  "results": [
    {
      "test": "GET /api/v1/get-user-key",
      "passed": true,
      "status": 200,
      "message": "成功"
    },
    {
      "test": "POST /api/v1/schedule-message (fixed)",
      "passed": true,
      "status": 201,
      "taskId": 12345,
      "message": "成功"
    }
  ],
  "cleanup": {
    "attempted": 2,
    "successful": 2
  },
  "timestamp": "2025-10-13T12:00:00.000Z"
}
```

---

## 部署方式二：独立测试项目

如果你想单独部署一个测试项目（不影响主项目），可以创建一个最小化的 Vercel 项目：

### 1. 创建项目目录

```bash
mkdir active-messaging-test
cd active-messaging-test
```

### 2. 创建文件结构

```
active-messaging-test/
├── api/
│   └── test-active-messaging.js  # 复制 tests/test-vercel-function.js
├── .env                          # 环境变量配置
├── .gitignore
├── vercel.json                   # Vercel 配置
└── README.md
```

### 3. 创建 `vercel.json`

```json
{
  "version": 2,
  "env": {
    "API_BASE_URL": "https://your-actual-api-domain.vercel.app",
    "CRON_SECRET": "@cron-secret",
    "INIT_SECRET": "@init-secret"
  },
  "regions": ["hnd1"]
}
```

**说明**:
- `@cron-secret` 是 Vercel Secret（在 Dashboard 中添加）
- `API_BASE_URL` 指向你要测试的实际 API 地址

### 4. 创建 `.gitignore`

```
node_modules/
.env
.vercel
```

### 5. 部署

```bash
# 初始化 Git（如果需要）
git init
git add .
git commit -m "Initial commit"

# 部署到 Vercel
vercel

# 或关联 GitHub 仓库自动部署
# 推送到 GitHub 后在 Vercel Dashboard 导入项目
```

### 6. 设置 Vercel Secrets

```bash
# 添加敏感配置（不会出现在代码中）
vercel secrets add cron-secret "your_cron_secret"
vercel secrets add init-secret "your_init_secret"
```

---

## 使用场景

### 场景 1: 开发时快速测试

```bash
# 部署后，每次代码更新都可以快速验证
curl https://test-api.vercel.app/api/test-active-messaging | jq
```

### 场景 2: CI/CD 集成

在 GitHub Actions 中添加：

```yaml
name: API Health Check

on:
  push:
    branches: [main]
  schedule:
    - cron: '0 */6 * * *'  # 每 6 小时检查一次

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Run API Tests
        run: |
          RESPONSE=$(curl -s https://your-domain.vercel.app/api/test-active-messaging)
          SUCCESS_RATE=$(echo $RESPONSE | jq -r '.summary.successRate')

          if [ "$SUCCESS_RATE" != "100.0%" ]; then
            echo "❌ API 测试失败: $SUCCESS_RATE"
            exit 1
          else
            echo "✅ API 测试通过: $SUCCESS_RATE"
          fi
```

### 场景 3: 监控告警

配合监控服务（如 UptimeRobot、StatusCake）：

1. 添加 HTTP 监控
2. URL: `https://your-domain.vercel.app/api/test-active-messaging`
3. 检查间隔: 5 分钟
4. 告警规则: 当 `summary.failed > 0` 时发送通知

**高级监控示例** (使用 JSONPath):
```
监控路径: $.summary.passed
期望值: 6
不匹配时告警
```

### 场景 4: 手动验证（无需命令行）

```bash
# 浏览器直接访问，JSON 格式化插件会自动美化
https://your-domain.vercel.app/api/test-active-messaging

# 或使用在线工具
https://jsonformatter.org/
粘贴 API 响应查看详细结果
```

---

## 高级配置

### 1. 自定义测试用户 ID

```env
TEST_USER_ID=550e8400-e29b-41d4-a716-446655440000
```

好处: 可以在数据库中固定同一个测试用户，便于排查和清理

### 2. 测试不同环境

```bash
# 测试预览环境
API_BASE_URL=https://preview-branch.vercel.app vercel dev

# 测试生产环境
API_BASE_URL=https://production.vercel.app vercel dev
```

### 3. 添加认证（保护测试端点）

修改 `tests/test-vercel-function.js`:

```javascript
export default async function handler(req, res) {
  // 添加简单的 Token 认证
  const authToken = req.headers.authorization;
  const expectedToken = process.env.TEST_AUTH_TOKEN;

  if (expectedToken && authToken !== `Bearer ${expectedToken}`) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: '需要认证才能运行测试'
    });
  }

  // ... 原有测试逻辑
}
```

使用时:
```bash
curl -H "Authorization: Bearer your_test_token" \
  https://your-domain.vercel.app/api/test-active-messaging
```

### 4. 详细日志模式

添加查询参数启用详细日志（修改 `tests/test-vercel-function.js`）:

```javascript
export default async function handler(req, res) {
  const verbose = req.query.verbose === 'true';

  // 测试时输出更多信息
  if (verbose) {
    // 返回完整的请求/响应详情
  }
}
```

使用:
```bash
curl https://your-domain.vercel.app/api/test-active-messaging?verbose=true
```

---

## 本地调试

如果需要在本地调试测试端点：

```bash
# 安装 Vercel CLI
npm i -g vercel

# 进入项目目录
cd /path/to/your-project

# 启动本地开发服务器
vercel dev

# 访问测试端点
curl http://localhost:3000/api/test-active-messaging
```

**或者使用本地测试脚本**:

```bash
# 使用本地测试脚本（tests/test-active-messaging-api.js）
API_BASE_URL=http://localhost:3000 \
CRON_SECRET=your_secret \
node tests/test-active-messaging-api.js
```

---

## 故障排查

### 问题 1: `500 Configuration error: 缺少 CRON_SECRET`

**解决方案**:
```bash
# 检查环境变量是否正确设置
vercel env ls

# 如果缺少，添加环境变量
vercel env add CRON_SECRET production
```

### 问题 2: 测试通过但实际 API 不工作

**原因**: 测试端点可能使用了不同的配置

**解决方案**:
```bash
# 确保测试和实际 API 使用相同的环境变量
# 检查 vercel.json 中的 env 配置
```

### 问题 3: CORS 错误

**解决方案**: 测试端点已包含 CORS 头部，如果仍有问题：

```javascript
// 在 tests/test-vercel-function.js 中添加更多 CORS 配置
res.setHeader('Access-Control-Allow-Origin', 'https://your-frontend.com');
res.setHeader('Access-Control-Allow-Credentials', 'true');
```

---

## 安全建议

1. **不要在公开项目中提交敏感配置** - 使用 Vercel Secrets
2. **限制测试频率** - 避免被滥用（可添加 rate limiting）
3. **添加认证** - 如果测试端点暴露在公网
4. **定期清理测试数据** - 虽然测试会自动清理，但建议定期检查数据库

```sql
-- 定期清理测试数据（数据库层面）
DELETE FROM scheduled_messages
WHERE user_id = '550e8400-e29b-41d4-a716-446655440000'
  AND created_at < NOW() - INTERVAL '7 days';
```

---

## 对比：三种测试方式

| 特性 | 本地脚本 | Vercel Function | GitHub Actions |
|------|---------|----------------|----------------|
| 需要本地环境 | ✅ 需要 | ❌ 不需要 | ❌ 不需要 |
| 真实 Serverless 环境 | ❌ 否 | ✅ 是 | ❌ 否 |
| 一键测试 | ❌ 需要命令行 | ✅ 访问 URL | ⚠️ 需要配置 |
| 持续监控 | ❌ 否 | ✅ 容易集成 | ✅ 定时任务 |
| 调试便利性 | ✅ 好 | ⚠️ 一般 | ❌ 困难 |
| 适用场景 | 开发调试 | 生产验证 | CI/CD 流水线 |

**推荐组合**:
- 开发时: 使用本地脚本快速迭代
- 部署后: 使用 Vercel Function 验证生产环境
- 持续集成: 配合 GitHub Actions 自动化测试

---

## 示例项目

完整的示例项目可以参考：
```
https://github.com/your-org/active-messaging-test
```

包含：
- 完整的测试端点代码
- Vercel 配置文件
- GitHub Actions 配置
- 监控配置示例

---

## 总结

通过将测试部署为 Vercel Function，你可以：

1. ✅ 在真实 Serverless 环境中测试 API
2. ✅ 无需本地工具即可运行测试
3. ✅ 轻松集成到监控和 CI/CD 流程
4. ✅ 跨平台、跨设备访问测试结果

**下一步**: 根据你的需求选择部署方式，并参考使用场景配置自动化测试！
