# ReiStandard 手动接入部署指南（备用）

> 这份文档仅用于 **不使用 SDK 包** 的手动接入。优先推荐 Package-First：
> - https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/README.md
> - https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md
> - https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md

## 目录结构

```text
examples/
├── api/v1/                          # API 手动实现文件
│   ├── init-database.js             # 数据库初始化（建议首次后删除）
│   ├── init-master-key.js           # 系统主密钥一次性初始化
│   ├── get-user-key.js              # 用户密钥分发
│   ├── schedule-message.js          # 创建任务 / 即时消息
│   ├── send-notifications.js        # Cron 触发处理
│   ├── update-message.js            # 更新任务
│   ├── cancel-message.js            # 取消任务
│   └── messages.js                  # 查询任务列表
└── README.md
```

## 手动接入步骤

### 1. 复制示例代码

```bash
cp -r examples/api ./
cp -r examples/lib ./
```

### 2. 安装依赖

```bash
npm install web-push @neondatabase/serverless
# 或使用 pg
# npm install web-push pg
```

### 3. 配置环境变量

```dotenv
DATABASE_URL=postgresql://[user]:[password]@[host]:[port]/[database]
VAPID_EMAIL=youremail@example.com
NEXT_PUBLIC_VAPID_PUBLIC_KEY=YOUR-PUBLIC-KEY
VAPID_PRIVATE_KEY=YOUR-PRIVATE-KEY
CRON_SECRET=YOUR-SECRET
VERCEL_PROTECTION_BYPASS=YOUR_BYPASS_KEY
```

`CRON_SECRET` 生成：

```bash
openssl rand -base64 32
```

### 4. 初始化数据库与主密钥

```bash
curl -X GET "http://localhost:3000/api/v1/init-database"
curl -X POST "http://localhost:3000/api/v1/init-master-key"
```

### 5. 配置 Cron 调度

```bash
* * * * * curl -X POST "https://your-domain.com/api/v1/send-notifications" \
  -H "Authorization: Bearer YOUR_CRON_SECRET" \
  -H "x-vercel-protection-bypass: YOUR_BYPASS_KEY"
```

## 端点清单

| 端点 | 方法 | 功能 |
|------|------|------|
| `/api/v1/init-database` | GET | 幂等初始化数据库 |
| `/api/v1/init-master-key` | POST | 初始化系统主密钥 |
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
