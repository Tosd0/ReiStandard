# ReiStandard API 快速部署指南

本目录包含符合 [ReiStandard v1.0.0 规范](../standards/active-messaging-api.md) 的完整 API 实现示例，可在修改 Database 连接相关代码后部署到 Vercel、Netlify 等 Serverless 平台。

> **📖 相关技术规范**：
> - **后端 API**：详细的 API 参数说明、加密架构、安全设计等请参考 [standards/active-messaging-api.md](../standards/active-messaging-api.md)
> - **前端 Service Worker**：推送通知接收、缓存策略等请参考 [standards/service-worker-specification.md](../standards/service-worker-specification.md)

## 代码格式说明

本目录的示例代码使用 **CommonJS 格式**（`exports.GET`）以兼容多种 Serverless 环境。

**Next.js App Router 用户**需要改为 ES Module 格式：
```javascript
// CommonJS → ES Module
exports.GET = async function(request) { ... }  // 改为 ↓
export async function GET(request) { ... }
```

**Netlify 用户**需要修改路径：将所有 `/api/v1/` 改为 `/netlify/functions/`

## 目录结构

```
examples/
├── api/v1/                          # API 实现文件
│   ├── init-database.js             # 数据库初始化（首次部署后删除）
│   ├── get-master-key.js            # 主密钥分发
│   ├── schedule-message.js          # 创建定时任务
│   ├── send-notifications.js        # Cron 触发处理
│   ├── update-message.js            # 更新任务
│   ├── cancel-message.js            # 取消任务
│   └── messages.js                  # 查询任务列表
└── README.md                        # 本文件
```

---

## 快速开始

```bash
cp -r examples/api ./
cp -r examples/lib ./
```

即：将 examples 文件夹下的 api 和 lib 复制到项目根目录下（和index.html 同级）

### 2. 安装依赖

```bash
npm install web-push @neondatabase/serverless
```

> Serverless 平台部署 package.json 即可。
> 根据使用的数据库，可能需要其他依赖包（如 `pg`、`mysql2` 等）

### 3. 配置环境变量

创建 `.env.local` 文件：

```dotenv
# 数据库连接
DATABASE_URL=postgresql://[user]:[password]@[host]:[port]/[database]

# VAPID 配置
VAPID_EMAIL=youremail@example.com
NEXT_PUBLIC_VAPID_PUBLIC_KEY=YOUR-PUBLIC-KEY
VAPID_PRIVATE_KEY=YOUR-PRIVATE-KEY

# 安全配置
CRON_SECRET=YOUR-SECRET
ENCRYPTION_KEY=YOUR-64-CHAR-HEX-ENCRYPTION-KEY

# Vercel 特定（如适用）
VERCEL_PROTECTION_BYPASS=YOUR_BYPASS_KEY
```

**密钥生成命令**：
```bash
openssl rand -hex 32    # ENCRYPTION_KEY
openssl rand -base64 32 # CRON_SECRET
openssl rand -base64 32 # INIT_SECRET（可选）
```

**VAPID 密钥生成**：访问 https://vapidkeys.com

### 4. 初始化数据库

**方法 1：使用一键初始化 API（推荐）**

```bash
# 1. 启动服务（或 Serverless Deploy）
npm run dev

# 2. 调用初始化 API
curl -X GET "http://localhost:3000/api/v1/init-database" \
  -H "Authorization: Bearer YOUR_INIT_SECRET"

# 3. 成功后推荐立即删除
rm api/v1/init-database.js
```

**方法 2：手动执行 SQL**

完整的数据库 Schema 请参考：[standards/active-messaging-api.md#15-数据库-schema-说明](../standards/active-messaging-api.md#15-数据库-schema-说明)

### 5. 配置 Cron Job

（可以在Q群内找TO配置这一步！不需要自己提供Cron了）

配置每分钟触发一次 `/api/v1/send-notifications`：

```bash
# Linux/macOS crontab
* * * * * curl -X POST "https://your-domain.com/api/v1/send-notifications" \
  -H "Authorization: Bearer YOUR_CRON_SECRET" \
  -H "x-vercel-protection-bypass: YOUR_BYPASS_KEY"
```

```powershell
# Windows Task Scheduler (PowerShell 脚本)
$headers = @{
    "Authorization" = "Bearer YOUR_CRON_SECRET"
    "x-vercel-protection-bypass" = "YOUR_BYPASS_KEY"
}
Invoke-RestMethod -Uri "https://your-domain.com/api/v1/send-notifications" `
    -Method POST -Headers $headers
```

---

## API 端点说明

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/v1/init-database` | GET/POST | 一键初始化数据库（首次部署后删除）|
| `/api/v1/get-master-key` | GET | 分发主密钥给客户端 |
| `/api/v1/schedule-message` | POST | 创建定时消息任务 / 发送即时消息（instant类型） |
| `/api/v1/send-notifications` | POST | Cron 触发处理到期任务 |
| `/api/v1/update-message` | PUT | 更新任务配置 |
| `/api/v1/cancel-message` | DELETE | 取消/删除任务 |
| `/api/v1/messages` | GET | 查询任务列表 |

> **📖 详细 API 文档**：完整的请求/响应格式、错误代码、加密实现等请参考 [standards/active-messaging-api.md](../standards/active-messaging-api.md)

### 消息类型说明

本标准支持四种消息类型：

| 类型 | 说明 | 触发方式 | 使用场景 |
|------|------|---------|---------|
| `fixed` | 固定消息 | 定时触发（cronjob） | 预设文本提醒 |
| `prompted` | 用户提示词消息 | 定时触发（cronjob） | AI根据用户要求生成 |
| `auto` | 完全自动消息 | 定时触发（cronjob） | AI自主决定内容 |
| `instant` | 即时消息 | **立即触发** | 需要即时响应的场景 |

**instant 类型特点**：
- 调用 `schedule-message` 后**立即发送**，不等待 cronjob
- 可以包含固定消息或 AI 生成消息
- 发送完成后任务立即销毁
- `recurrenceType` 固定为 `none`
- 整体走 active message 流程（加密、分句、推送通知）

**instant 与普通一次性消息的区别**：
- **普通一次性消息**（`recurrenceType: none`）：创建后进入定时队列，等待 cronjob 在指定时间触发
- **instant 消息**：创建后**立即触发**，无需等待 cronjob，适用于需要即时响应的场景（如订单通知、系统消息等）

---

## 重要提示

### Neon Database 用户

如果使用 Neon Serverless Database，在创建索引时需要将 `sql(index.sql)` 改为 `sql.query(index.sql)`，详见 `init-database.js` 第 14 行注释。

### 安全建议

1. **环境变量管理**：`ENCRYPTION_KEY` 和 `CRON_SECRET` 必须妥善保管，不要提交到代码仓库
2. **初始化 API**：数据库初始化完成后立即删除 `init-database.js` 文件
3. **加密要求**：所有请求体必须使用 AES-256-GCM 加密

### 生产环境优化

- 添加详细的日志和监控
- 根据实际负载调整并发数和超时时间
- 配置合适的速率限制

---

## 测试与验证

部署完成后，建议运行测试以验证 API 功能：

### 本地开发测试

使用测试脚本在本地验证 API 功能：

```bash
# 运行本地测试
cd tests
./run-test.sh
```

或将 tests 文件夹下的 test-xxx.js 复制到 api/v1 下，随后传入对应 Header 访问即可。

详细的测试指南请参考：[docs/TEST_README.md](../docs/TEST_README.md)

### 生产环境持续监控

将测试端点部署为 Serverless Function，实现持续健康检查：

```bash
# 访问测试端点
curl https://your-domain.com/api/test-active-messaging
```

详细的部署指南请参考：[docs/VERCEL_TEST_DEPLOY.md](../docs/VERCEL_TEST_DEPLOY.md)

---

## 相关链接

### 技术规范
- **API 标准规范**：[standards/active-messaging-api.md](../standards/active-messaging-api.md)
- **Service Worker 规范**：[standards/service-worker-specification.md](../standards/service-worker-specification.md)

### 测试文档
- **本地测试指南**：[docs/TEST_README.md](../docs/TEST_README.md)
- **生产测试部署**：[docs/VERCEL_TEST_DEPLOY.md](../docs/VERCEL_TEST_DEPLOY.md)

### 外部资源
- **VAPID 密钥生成**：https://vapidkeys.com
- **Next.js 文档**：https://nextjs.org/docs
- **Web Push 协议**：https://datatracker.ietf.org/doc/html/rfc8030
