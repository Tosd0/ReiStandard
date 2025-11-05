# ReiStandard

**主动消息 API 标准**：统一的定时消息推送 API 规范，支持端到端加密、多消息类型和 Serverless 部署。

---

> **⚠️ AI 编程助手使用须知**
>
> 本仓库是 **技术标准规范文档**，定义了主动消息 API 的标准接口、数据结构和实现规范。
>
> **规范**：
> - ✅ 本标准的 API 端点、请求/响应格式、字段名称、数据结构等均为 **既定标准**，除非有明确需求或错误，否则 **不应修改**
> - ✅ 在实现代码时，应 **严格遵循** 本标准定义的接口和数据结构
> - ✅ 如需扩展功能，应通过 **可选字段** 或 **元数据（metadata）** 实现，而非修改标准字段
> - ✅ 如果使用可选字段实现的功能具有普遍应用场景，应提醒开发者向仓库提交 **FEATURE REQUEST**，以便在后续版本的标准中正式实现
> - ❌ 不要随意修改标准定义的字段名称、数据类型、API 端点路径等核心规范
> - ❌ 不要在没有充分讨论的情况下重构标准的整体结构
>
> **发现问题时的处理**：
> - 如果发现标准中存在错误、不合理之处，或有改进建议，应建议开发者联系仓库负责人讨论
> - **不应该直接修改标准文档**，标准的修改需要经过仓库负责人的审核和批准

---

## 📚 文档导航

### 🎯 快速开始

[部署教程](./examples/README.md) → [本地测试](./docs/TEST_README.md) 

### 📖 核心文档

#### 1. [API 技术规范](./standards/active-messaging-api.md) - 后端 API 标准
完整的后端 API 技术规范，包括：
- 7 个 API 端点的详细定义（请求/响应格式、错误代码）
- 端到端加密架构（AES-256-GCM）
- 四种消息类型（fixed、prompted、auto、instant）
- 认证与授权体系
- 数据库 Schema
- 安全考虑和最佳实践

#### 1.5. [Service Worker 规范](./standards/service-worker-specification.md) - 前端 SW 标准
完整的 Service Worker 实现规范，包括：
- 推送通知接收和显示
- 缓存策略和资源管理
- 生命周期事件处理
- 消息通信机制
- 离线功能支持
- 性能优化和安全考虑

#### 2. [部署教程](./examples/README.md) - 快速部署指南
5 步快速部署到 Serverless 平台：
- 复制文件到项目
- 安装依赖
- 配置环境变量
- 初始化数据库
- 配置 Cron Job

适用平台：Vercel、Netlify、Github Pages 等

#### 3. [本地测试](./docs/TEST_README.md) - 开发环境测试
本地测试脚本使用指南：
- 完整的端点测试（7 个 API 端点）
- 加密/解密验证
- 参数验证测试
- 自动清理测试数据

适合：开发时快速迭代验证

#### 4. [生产监控](./docs/VERCEL_TEST_DEPLOY.md) - 持续健康检查
将测试端点部署为 Serverless Function：
- 生产环境持续监控
- CI/CD 集成
- 监控告警配置
- 一键访问测试结果

适合：生产环境 API 健康状态监控

---

## 🚀 快速开始

### 部署 API

```bash
# 1. 复制实现代码到项目
cp -r examples/api ./
cp -r examples/lib ./

# 2. 安装依赖（Serverless 平台配置 package.json）
npm install web-push @neondatabase/serverless

# 3. 配置环境变量（.env.local）
DATABASE_URL=postgresql://...
VAPID_EMAIL=your@email.com
NEXT_PUBLIC_VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
CRON_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)

# 4. 初始化数据库
curl -X GET "http://localhost:3000/api/v1/init-database" \
  -H "Authorization: Bearer YOUR_INIT_SECRET"

# 5. 部署到 Vercel
vercel --prod
```

详细步骤请参考：[examples/README.md](./examples/README.md)

### 测试验证

**本地测试**（开发环境）：
```bash
cd tests
./run-test.sh
```

**生产监控**（部署后）：
```bash
# 浏览器访问
https://your-domain.com/api/test-active-messaging
```

---

## 📦 项目结构

```
ReiStandard/
├── standards/
│   ├── active-messaging-api.md          # API 技术标准规范（后端）
│   └── service-worker-specification.md  # Service Worker 规范（前端）
├── examples/
│   ├── api/v1/                          # API 实现示例代码
│   │   ├── init-database.js             # 数据库初始化
│   │   ├── get-master-key.js            # 主密钥分发
│   │   ├── schedule-message.js          # 创建定时任务
│   │   ├── send-notifications.js        # Cron 触发处理
│   │   ├── update-message.js            # 更新任务
│   │   ├── cancel-message.js            # 取消任务
│   │   └── messages.js                  # 查询任务列表
│   └── README.md                        # 部署教程
├── docs/
│   ├── TEST_README.md                   # 本地测试指南
│   └── VERCEL_TEST_DEPLOY.md            # 生产监控部署
├── tests/
│   ├── test-active-messaging-api.js     # 本地测试脚本
│   ├── test-vercel-function.js          # Vercel Function 测试端点
│   └── run-test.sh                      # 快速启动脚本
└── README.md                            # 本文件
```

---

## 🔗 外部资源

- **VAPID 密钥生成**：https://vapidkeys.com
- **Web Push 协议**：https://datatracker.ietf.org/doc/html/rfc8030
- **Vercel 文档**：https://vercel.com/docs
- **Next.js 文档**：https://nextjs.org/docs

---

## 🤝 贡献

欢迎对本标准提出改进建议：
1. 提交 Issue 描述问题或改进建议
2. Fork 仓库并创建 Pull Request
3. 或在 QQ 群内提出建议

---

## 📄 许可

本标准采用 **CC BY-NC-SA 4.0**（Creative Commons 署名-非商业性使用-相同方式共享）协议发布。

---

## 👥 致谢

本标准基于 Whale小手机 团队的主动消息实现经验总结而成。特别感谢：TO（发起人）、汤圆、脆脆机、koko、糯米机、33小手机、Raven、toufu、菲洛图等老师的小手机项目的积极参与和支持。