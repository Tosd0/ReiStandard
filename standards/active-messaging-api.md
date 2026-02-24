# 主动消息 API 技术规范（v2.0.0）

> 状态：当前生效（Active）
> 
> 版本日期：2026-02-24

## 1. 目标与范围

本规范定义 ReiStandard 主动消息 API 的服务端行为，重点覆盖：

- 一体化初始化（`init-tenant`）
- 租户鉴权（`tenantToken` / `cronToken`）
- 端到端加密所需的关键约束
- 多租户与单租户共用的最小化初始化流程

本规范适用于 `packages/rei-standard-amsg/server` 与 `examples/` 的同构实现。

## 2. 核心变更（相对 v1）

1. 初始化由两步改为一步：`POST /api/v1/init-tenant`。
2. 删除旧初始化端点：
   - `GET /api/v1/init-database`
   - `POST /api/v1/init-master-key`
3. `X-User-Id` 不再承载租户身份，仅作为业务用户标识。
4. 租户身份统一由 Bearer token 承载并验签：
   - `tenantToken`：业务端点
   - `cronToken`：仅 cron 发送端点
5. 租户敏感配置（数据库连接、masterKey）加密后存入 Blob。

## 3. 角色与职责

### 3.1 管理员（每个部署一次）

管理员负责部署并配置以下环境变量：

- `VAPID_EMAIL`
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `TENANT_CONFIG_KEK`
- `TENANT_TOKEN_SIGNING_KEY`
- `INIT_SECRET`（可选）
- `PUBLIC_BASE_URL`（可选，用于生成 `cronWebhookUrl`）

### 3.2 租户（每个租户一次）

租户只需提交自己的数据库连接串到 `init-tenant`。

系统自动完成：

- DB 连通与建表
- 生成 masterKey
- 写入 Blob（使用 KEK 加密）
- 签发 `tenantToken` 与 `cronToken`

## 4. 安全模型与边界

### 4.1 防伪造能力

- 泄漏 `X-User-Id` 不足以伪造租户请求。
- 调用必须携带可验签 token（`tenantToken` 或 `cronToken`）。
- `cronToken` 权限最小化，仅用于 `send-notifications`。

### 4.2 明确信任边界

本规范防护目标是“外部调用者伪造租户请求”。

本规范不保证“项目管理员绝对无法解密租户数据”。在无常驻独立密钥服务的 serverless 场景中，函数运行时必须可获得解密材料。

## 5. 鉴权规则

### 5.1 Header

业务端点统一使用：

```http
Authorization: Bearer <tenantToken>
```

### 5.2 Cron 调用

`POST /api/v1/send-notifications` 支持两种方式：

1. Header：`Authorization: Bearer <cronToken>`
2. Query：`/api/v1/send-notifications?token=<cronToken>`

### 5.3 失败响应

无 token、token 过期、签名错误、token 类型不匹配，均返回：

- HTTP `401`
- `error.code = INVALID_TENANT_AUTH`

## 6. API 端点清单

| 方法 | 路径 | 描述 | 鉴权 |
|---|---|---|---|
| `POST` | `/api/v1/init-tenant` | 一体化初始化租户 | `X-Init-Secret`（可选） |
| `GET` | `/api/v1/get-user-key` | 派生用户密钥 | `tenantToken` |
| `POST` | `/api/v1/schedule-message` | 创建任务/即时消息 | `tenantToken` |
| `PUT` | `/api/v1/update-message?id={uuid}` | 更新任务 | `tenantToken` |
| `DELETE` | `/api/v1/cancel-message?id={uuid}` | 取消任务 | `tenantToken` |
| `GET` | `/api/v1/messages` | 查询任务列表 | `tenantToken` |
| `POST` | `/api/v1/send-notifications` | cron 触发发送 | `cronToken` |

## 7. 一体化初始化接口

### 7.1 请求

`POST /api/v1/init-tenant`

Headers:

- `Content-Type: application/json`
- `X-Init-Secret: <INIT_SECRET>`（仅当服务端配置了 `INIT_SECRET` 时需要）

Body:

```json
{
  "databaseUrl": "postgres://...",
  "driver": "neon"
}
```

`driver` 允许值：`neon`、`pg`。

### 7.2 成功响应

- 新建成功：HTTP `201`
- 幂等命中已有租户：HTTP `200`

```json
{
  "success": true,
  "data": {
    "tenantId": "uuid-v4",
    "tenantToken": "...",
    "cronToken": "...",
    "cronWebhookUrl": "https://.../api/v1/send-notifications?token=...",
    "masterKeyFingerprint": "16hex"
  }
}
```

## 8. 数据存储规范

### 8.1 Blob（租户配置）

租户配置存储于 Blob，至少包含：

- `tenantId`
- `db.driver`
- `db.connectionString`
- `masterKey`
- `createdAt`
- `updatedAt`

要求：

- 入 Blob 前必须使用 `TENANT_CONFIG_KEK` 进行加密。
- 运行时解密失败应视为租户配置失效。

### 8.2 数据库（业务任务）

数据库仅存业务任务表（如 `scheduled_messages`）。

- 不再保存 `system_config`。
- 不再在数据库持久化 masterKey。

## 9. 错误码（v2.0.0）

| HTTP | code | 含义 |
|---|---|---|
| 400 | `INVALID_JSON` | 请求体 JSON 不合法 |
| 400 | `INVALID_PARAMETERS` | 参数缺失或格式非法 |
| 400 | `INVALID_DRIVER` | 不支持的数据库驱动 |
| 400 | `INVALID_DATABASE_URL` | `databaseUrl` 缺失或为空 |
| 400 | `INVALID_USER_ID_FORMAT` | `X-User-Id` 非 UUID v4 |
| 400 | `ENCRYPTION_REQUIRED` | 未按规范提交加密请求体 |
| 400 | `UNSUPPORTED_ENCRYPTION_VERSION` | 不支持的加密版本 |
| 401 | `INVALID_INIT_AUTH` | 初始化鉴权失败（仅当服务端启用 `INIT_SECRET` 时） |
| 401 | `INVALID_TENANT_AUTH` | 租户 token 无效或缺失 |
| 404 | `TASK_NOT_FOUND` | 任务不存在 |
| 409 | `TASK_UUID_CONFLICT` | UUID 冲突 |
| 409 | `TASK_ALREADY_COMPLETED` | 任务已结束，不可更新 |
| 500 | `VAPID_CONFIG_ERROR` | VAPID 配置不完整 |
| 500 | `TENANT_MASTER_KEY_MISSING` | 租户主密钥缺失或配置异常 |
| 500 | `INTERNAL_SERVER_ERROR` | 未分类内部错误 |

## 10. 对接流程（标准）

### 10.1 管理员一次性流程

1. 部署服务。
2. 配置环境变量（见第 3.1 节）。
3. 提供租户初始化入口（页面或 API 文档）。

### 10.2 租户一次性流程

1. 调用 `POST /api/v1/init-tenant` 提交 `databaseUrl`。
2. 保存返回的 `tenantToken`、`cronWebhookUrl`。
3. 将 `cronWebhookUrl` 粘贴到 cron 平台。

### 10.3 日常调用流程

1. 前端调用业务端点时自动携带 `tenantToken`。
2. cron 周期调用 `send-notifications`。

## 11. 向后兼容声明

v2.0.0 为破坏性升级：

- 旧初始化端点已移除。
- 旧 `CRON_SECRET` 方案不再作为标准鉴权方案。
- 旧文档中关于 `system_config` 的描述全部失效。

## 12. 实现一致性要求（DoD）

实现方需满足以下条件：

1. 租户初始化为一步（`init-tenant`）。
2. 业务端点不可仅依赖 `X-User-Id` 调用成功。
3. `tenantToken` 与 `cronToken` 权限分离。
4. `packages` 与 `examples` 的接口行为一致。
5. 文档明确管理员一次性与租户一次性职责。
