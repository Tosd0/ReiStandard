# 主动消息API端点标准 (Active Messaging API Specification)

> 文档维护与变更规则请以仓库主说明为准：
> https://github.com/Tosd0/ReiStandard/blob/main/README.md

## 版本信息

- **版本号**: v1.2.2
- **最后更新**: 2026-02-23
- **状态**: Stable

## 概述

本标准定义主动消息 API 的端点、请求/响应结构、错误码和加密要求。

- 这是 **权威规范**，用于字段和行为定义。
- 如果你是接入方，优先走 Package-First 路径。

## 快速开始（Package-First）

推荐接入顺序：

1. 服务端：`@rei-standard/amsg-server`
2. 浏览器端：`@rei-standard/amsg-client`
3. Service Worker：`@rei-standard/amsg-sw`

安装：

```bash
npm install @rei-standard/amsg-server @rei-standard/amsg-client @rei-standard/amsg-sw web-push

# 数据库驱动二选一
npm install @neondatabase/serverless
# 或
npm install pg
```

包文档（绝对链接）：

- https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/README.md
- https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md
- https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md

## 手动接入（备用）

若不使用 SDK 包，请按以下文档准备环境变量、部署与测试：

- 手动部署：https://github.com/Tosd0/ReiStandard/blob/main/examples/README.md
- 本地测试：https://github.com/Tosd0/ReiStandard/blob/main/docs/TEST_README.md
- 生产监控：https://github.com/Tosd0/ReiStandard/blob/main/docs/VERCEL_TEST_DEPLOY.md

> 说明：本文件后续章节只保留规范定义与必要示例；完整接入代码请优先看 package README。

---

## 1. POST /api/v1/schedule-message

### 1.1 端点信息
- **URL路径**: `/api/v1/schedule-message`
- **请求方法**: `POST`
- **功能描述**: 创建定时消息任务
- **认证要求**: 必需（`X-User-Id` + `X-Payload-Encrypted` + `X-Encryption-Version`）

### 1.2 请求头 (Request Headers)

| 头部字段 | 必需 | 类型 | 说明 |
|---------|------|------|------|
| Content-Type | 是 | string | 必须为 `application/json` |
| X-Payload-Encrypted | 是 | string | 固定值：`true`（标识请求体已加密） |
| X-Encryption-Version | 是 | string | 加密协议版本，当前为 `1` |
| X-User-Id | 是 | string | UUID v4 用户唯一标识符（用于服务器端密钥派生和数据隔离） |

### 1.3 请求体 (Request Body)

**重要**：请求体必须经过 AES-256-GCM 加密后发送。请求体格式分为两部分：

1. **加密后的请求体结构**（实际发送的 JSON）：
   ```json
   {
     "iv": "Base64编码的初始化向量",
     "authTag": "Base64编码的认证标签",
     "encryptedData": "Base64编码的加密数据"
   }
   ```

2. **加密前的原始业务数据**（下文详述）

#### 原始业务数据 - 必需字段

| 字段名 | 类型 | 必需 | 说明 |
|-------|------|------|------|
| contactName | string | 是 | 角色/联系人名称，最大长度 255 字符 |
| messageType | string | 是 | 消息类型，枚举值：`fixed`(固定消息)、`prompted`(用户提示词消息)、`auto`(完全自动消息)、`instant`(即时消息) |
| firstSendTime | string | 是 | 首次发送时间，ISO 8601 格式（UTC时区）例：`2025-01-15T10:00:00Z` |
| pushSubscription | object | 是 | 浏览器推送订阅信息对象 |

#### 原始业务数据 - 可选字段（核心）

| 字段名 | 类型 | 必需 | 默认值 | 说明 |
|-------|------|------|--------|------|
| userMessage | string | 条件必需* | null | 固定消息内容（仅用于 `fixed` 类型） |
| recurrenceType | string | 否 | `"none"` | 重复类型，枚举值：`none`(一次性)、`daily`(每日)、`weekly`(每周) |

*条件必需：当 `messageType` 为 `fixed` 时必需

#### 原始业务数据 - 可选字段（AI配置）

| 字段名 | 类型 | 必需 | 默认值 | 说明 |
|-------|------|------|--------|------|
| apiUrl | string | 条件必需* | null | AI API 端点 URL，支持 OpenAI 兼容接口 |
| apiKey | string | 条件必需* | null | AI API 密钥 |
| primaryModel | string | 条件必需* | null | AI 模型名称，例：`claude-4-sonnet` |
| completePrompt | string | 条件必需* | null | 前端在创建任务时构建的完整 prompt（包含角色设定、历史记录、时间信息、用户提示词等） |

*条件必需：当 `messageType` 为 `prompted` 或 `auto` 时必需

#### 可选字段（扩展功能）

| 字段名 | 类型 | 必需 | 默认值 | 说明 |
|-------|------|------|--------|------|
| avatarUrl | string | 否 | null | 角色头像 URL（用于推送通知图标），支持相对路径和绝对路径 |
| uuid | string | 否 | 自动生成 | 用户唯一标识符，用于跨设备查询和管理任务 |
| messageSubtype | string | 否 | `"chat"` | 消息子类型，枚举值：`chat`(聊天)、`forum`(论坛)、`moment`(朋友圈)，为未来功能扩展预留 |
| metadata | object | 否 | {} | 自定义元数据对象，用于存储额外信息 |

#### pushSubscription 对象结构

```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/...",
  "expirationTime": null,
  "keys": {
    "p256dh": "BASE64_ENCODED_KEY",
    "auth": "BASE64_ENCODED_KEY"
  }
}
```

### 1.4 消息类型说明 (Message Types)

本标准定义四种消息类型，满足不同场景需求：

#### fixed - 固定消息
- **用途**: 发送预先定义的固定文本，无需AI生成
- **必需字段**: `userMessage`
- **是否调用AI**: 否
- **示例**: "别忘了今天下午的会议！"

#### prompted - 用户提示词消息
- **用途**: 用户提供具体的回复方向/要求，AI根据提示词生成消息
- **必需字段**: `completePrompt`（前端构建，包含用户提示词）
- **是否调用AI**: 是
- **特点**: `completePrompt` 中包含**用户的明确指示**
- **示例 prompt 结构**:
  ```
  【角色设定】...
  【历史对话】...
  【当前时间】...
  【用户提示】提醒我开会并询问是否需要准备材料  ← 用户的明确要求
  【任务】根据用户提示发送消息
  ```

#### auto - 自动消息
- **用途**: AI完全自主决定消息内容，无用户提示
- **必需字段**: `completePrompt`（前端构建，不含用户提示词）
- **是否调用AI**: 是
- **特点**: `completePrompt` 中**不包含**用户指示，AI根据角色设定、历史记录、时间等自主发挥
- **示例 prompt 结构**:
  ```
  【角色设定】...
  【历史对话】用户：明天要早起（示例）
  【当前时间】2025-10-12 09:00（早）
  【天气】晴天，15°C
  【任务】根据当前时间和历史记录，贴合人设，生成此角色在这个时间、参照这个对话历史会发送的主动消息。  ← 无具体指示
  ```

#### instant - 即时消息
- **用途**: 立即发送的消息，不等待定时触发。**在发送消息后可以退出后台，就算被杀后台也不会中断请求**，优化用户体验
- **必需字段**: 根据消息内容类型而定（可配合 `userMessage`、`completePrompt` 等）
- **是否调用AI**: 取决于是否提供 AI 配置
- **触发方式**: `schedule-message` 端点**立即触发发送**，不需要等待 cronjob
- **recurrenceType**: 固定为 `none`（即时消息发送后立即销毁）
- **配置要求**: 可选项，不想使用可以不配置
- **特点**:
  - 发送完成后任务立即删除
  - 可以包含固定消息或 AI 生成消息
  - 通过 UUID 识别任务
- **与普通一次性消息的区别**:
  - **普通一次性消息**（`recurrenceType: none`）: 创建后进入定时队列，等待 cronjob 在指定时间触发
  - **instant 消息**: 创建后**立即触发**，无需等待 cronjob，适用于需要即时响应的场景

##### ⚠️ instant 消息的前端实现最佳实践（重要）

使用 instant 消息类型时，需在前端实现前台/后台检测逻辑，以提供最佳用户体验：

**核心原则**:
1. **后台状态**: 用户切换到其他应用或锁屏时，通过 Service Worker 显示系统通知
2. **前台状态**: 用户正在使用应用时，直接在 UI 中渲染消息，**不弹系统通知**
3. **渲染一致性**: 前台收到的消息渲染效果必须与实时收到的消息**完全一致**

**实现要求**:

```javascript
// Service Worker 中的实现（完整示例见 service-worker-specification.md 第 4.1.1 节）
self.addEventListener('push', async event => {
  const notificationData = event.data.json();

  // 检测用户是否在前台
  const allClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  });

  const visibleClients = allClients.filter(client => {
    return client.visibilityState === 'visible' && client.focused;
  });

  if (visibleClients.length > 0) {
    // 前台：发送消息到页面，不弹系统通知
    visibleClients.forEach(client => {
      client.postMessage({
        type: 'PUSH_MESSAGE_RECEIVED',
        data: notificationData
      });
    });
  } else {
    // 后台：显示系统通知
    await self.registration.showNotification(notificationData.title, options);
  }
});
```

```javascript
// 前端页面中的实现
navigator.serviceWorker.addEventListener('message', event => {
  if (event.data.type === 'PUSH_MESSAGE_RECEIVED') {
    const messageData = event.data.data;

    // 直接在 UI 中渲染消息（与实时消息完全相同的渲染逻辑）
    // 注意：renderMessageInUI 为伪代码，需根据应用的 UI 框架自行实现
    renderMessageInUI(messageData);

    // 可选：播放提示音（需自行实现）
    playNotificationSound();
  }
});
```

**详细实现指南**:
- 完整的代码示例和实现细节请参考 [Service Worker 标准规范](./service-worker-specification.md)
- 包含两种实现方法：visibilityState 检测（推荐）和心跳机制（备用）
- 提供完整的前端页面配合代码示例

**核心区别总结**:
| 类型 | 是否用AI | 前端构建 completePrompt | 是否含用户提示词 | 触发方式 | recurrenceType |
|------|---------|----------------------|---------------|---------|----------------|
| fixed | ❌ | ❌ | ❌ | 定时触发 | 可配置 |
| prompted | ✅ | ✅ | ✅（completePrompt 中） | 定时触发 | 可配置 |
| auto | ✅ | ✅ | ❌ | 定时触发 | 可配置 |
| instant | 可选 | 可选 | 可选 | **立即触发** | 固定为 none |

### 1.5 请求示例

**注意**：以下示例展示的是**加密前的原始业务数据**。实际发送时，需要将这些数据加密后再发送（参见 6.2.1 节）。

#### 示例 1: 固定消息（不需要AI）

**加密前的原始数据**:
```json
{
  "contactName": "Rei",
  "messageType": "fixed",
  "userMessage": "别忘了今天下午的会议！",
  "firstSendTime": "2025-01-15T14:00:00Z",
  "recurrenceType": "none",
  "pushSubscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/xxxxx",
    "keys": {
      "p256dh": "BEl2...kR4=",
      "auth": "k8J...3Q="
    }
  }
}
```

**实际发送的加密请求**:
```bash
POST /api/v1/schedule-message HTTP/1.1
Host: your-domain.com
Content-Type: application/json
X-Payload-Encrypted: true
X-Encryption-Version: 1
X-User-Id: 550e8400-e29b-41d4-a716-446655440000

{
  "iv": "cmFuZG9tSVYxNmJ5dGVz",
  "authTag": "YXV0aFRhZzE2Ynl0ZXM=",
  "encryptedData": "ZW5jcnlwdGVkRGF0YUhlcmVCYXNlNjRFbmNvZGVk..."
}
```

#### 示例 2: 用户提示词消息（prompted）

**加密前的原始数据**:
```json
{
  "contactName": "Rei",
  "messageType": "prompted",
  "firstSendTime": "2025-01-15T14:00:00Z",
  "recurrenceType": "none",
  "pushSubscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/xxxxx",
    "keys": {
      "p256dh": "BEl2...kR4=",
      "auth": "k8J...3Q="
    }
  },
  "apiUrl": "https://api.openai.com/v1/chat/completions",
  "apiKey": "sk-xxxxxxxxxxxxxxxx",
  "primaryModel": "claude-4-sonnet",
  "completePrompt": "【角色】你是Rei，性格...\n【历史对话】\n用户: 明天下午提醒我开会\nRei: 好的，我会提醒你的！\n【当前时间】2025-10-12 14:00\n【用户提示】提醒我开会并询问是否需要准备材料\n【任务】根据用户提示发送消息",
  "avatarUrl": "https://example.com/avatar.png",
  "uuid": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### 示例 3: 完全自动消息（auto）

**加密前的原始数据**:
```json
{
  "contactName": "Rei",
  "messageType": "auto",
  "firstSendTime": "2025-01-15T09:00:00Z",
  "recurrenceType": "daily",
  "pushSubscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/xxxxx",
    "keys": {
      "p256dh": "BEl2...kR4=",
      "auth": "k8J...3Q="
    }
  },
  "apiUrl": "https://api.openai.com/v1/chat/completions",
  "apiKey": "sk-xxxxxxxxxxxxxxxx",
  "primaryModel": "claude-4-sonnet",
  "completePrompt": "【角色】你是Rei，性格温柔体贴。\n【历史对话】\n用户：明天要早起去上学\n【当前时间】2025-10-12 09:00（早）\n【天气】晴天，15°C\n【任务】根据当前时间和历史记录，贴合人设，生成此角色在这个时间、参照这个对话历史会发送的主动消息。",
  "avatarUrl": "https://example.com/rei-avatar.png",
  "uuid": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### 示例 4: 即时消息（instant）- 固定内容

**加密前的原始数据**:
```json
{
  "contactName": "系统助手",
  "messageType": "instant",
  "userMessage": "您的订单已经发货，请注意查收！",
  "firstSendTime": "2025-01-15T14:00:00Z",
  "recurrenceType": "none",
  "pushSubscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/xxxxx",
    "keys": {
      "p256dh": "BEl2...kR4=",
      "auth": "k8J...3Q="
    }
  },
  "uuid": "550e8400-e29b-41d4-a716-446655440001"
}
```

**说明**: 
- `messageType` 为 `instant` 时，消息将在调用 API 后立即发送
- 不需要等待 cronjob 触发
- `firstSendTime` 字段在 instant 类型中仅用于记录，实际发送时间为立即
- 发送完成后任务立即删除，不保留在数据库中

#### 示例 5: 即时消息（instant）- AI 生成内容

**加密前的原始数据**:
```json
{
  "contactName": "Rei",
  "messageType": "instant",
  "firstSendTime": "2025-01-15T14:00:00Z",
  "recurrenceType": "none",
  "pushSubscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/xxxxx",
    "keys": {
      "p256dh": "BEl2...kR4=",
      "auth": "k8J...3Q="
    }
  },
  "apiUrl": "https://api.openai.com/v1/chat/completions",
  "apiKey": "sk-xxxxxxxxxxxxxxxx",
  "primaryModel": "claude-4-sonnet",
  "completePrompt": "【角色】你是Rei，性格温柔体贴。\n【任务】立即回复用户的问候，表达关心。",
  "avatarUrl": "https://example.com/rei-avatar.png",
  "uuid": "550e8400-e29b-41d4-a716-446655440002"
}
```

**说明**: 
- instant 类型也支持 AI 生成内容
- 调用 API 后立即生成并发送消息
- 整体走 active message 的流程（加密、分句、推送通知）

#### 示例 6: 扩展功能（论坛消息）

**加密前的原始数据**:
```json
{
  "contactName": "社区管理员",
  "messageType": "fixed",
  "userMessage": "您关注的话题有新回复了！",
  "firstSendTime": "2025-01-15T20:00:00Z",
  "recurrenceType": "none",
  "pushSubscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/xxxxx",
    "keys": {
      "p256dh": "BEl2...kR4=",
      "auth": "k8J...3Q="
    }
  },
  "messageSubtype": "forum",
  "avatarUrl": "/icons/admin-avatar.png",
  "metadata": {
    "topicId": "12345",
    "forumSection": "技术讨论"
  }
}
```

**说明**：所有示例在实际使用时都需要按照 6.2.1 节的方法进行加密后发送。

### 1.5 参数验证规则

#### 基础验证
```javascript
// 必需参数检查
if (!contactName || !messageType || !firstSendTime || !pushSubscription) {
    return 400 Bad Request
}

// 消息类型验证
if (!['fixed', 'prompted', 'auto', 'instant'].includes(messageType)) {
    return 400 Bad Request
}

// 重复类型验证
if (recurrenceType && !['none', 'daily', 'weekly'].includes(recurrenceType)) {
    return 400 Bad Request
}

// 时间格式验证
if (!isValidISO8601(firstSendTime)) {
    return 400 Bad Request
}

// 确保发送时间在未来
if (new Date(firstSendTime) <= new Date()) {
    return 400 Bad Request
}
```

#### 消息类型特定验证
```javascript
// fixed 类型必须提供 userMessage
if (messageType === 'fixed') {
    if (!userMessage) {
        return 400 Bad Request
    }
}

// prompted 和 auto 类型必须提供 AI 配置
if (messageType === 'prompted' || messageType === 'auto') {
    if (!completePrompt || !apiUrl || !apiKey || !primaryModel) {
        return 400 Bad Request
    }
}

// instant 类型验证
if (messageType === 'instant') {
    // instant 类型 recurrenceType 必须为 none
    if (recurrenceType && recurrenceType !== 'none') {
        return 400 Bad Request
    }
    
    // instant 类型可以是固定消息或 AI 消息
    // 如果有 AI 配置，则使用 AI 生成；否则必须提供 userMessage
    const hasAiConfig = completePrompt && apiUrl && apiKey && primaryModel;
    const hasUserMessage = userMessage;
    
    if (!hasAiConfig && !hasUserMessage) {
        return 400 Bad Request // 必须提供 userMessage 或完整的 AI 配置
    }
}
```

#### 扩展字段验证
```javascript
// messageSubtype 验证
if (messageSubtype && !['chat', 'forum', 'moment'].includes(messageSubtype)) {
    return 400 Bad Request
}

// avatarUrl 格式验证
if (avatarUrl && !isValidUrl(avatarUrl)) {
    return 400 Bad Request
}

// uuid 格式验证（如果提供）
if (uuid && !isValidUUID(uuid)) {
    return 400 Bad Request
}
```

### 1.6 特殊处理：instant 类型的即时触发

当 `messageType` 为 `instant` 时，`schedule-message` 端点会执行特殊的处理逻辑：

1. **存入数据库**: 将任务存入数据库（与普通任务相同）
2. **立即触发发送**: 存储完成后，立即调用 `send-notifications` 的核心处理函数，通过 UUID 识别并处理这一条消息
3. **整体流程**: 遵循完整的 active message 流程（参数验证、存储、AI 调用、消息分句、推送通知）
4. **任务标识**: 通过 UUID 识别本次发送任务
5. **生命周期**: 发送完成后任务立即删除（`recurrenceType` 固定为 `none`）
6. **错误处理**: 如果发送失败，任务进入失败状态，不会重试（或按配置重试）

**处理流程对比**:

| 步骤 | 普通类型 (fixed/prompted/auto) | instant 类型 |
|------|-------------------------------|--------------|
| 1. 参数验证 | ✅ | ✅ |
| 2. 加密敏感字段 | ✅ | ✅ |
| 3. 存入数据库 | ✅ 存入待处理队列 | ✅ 存入数据库 |
| 4. 触发处理 | 等待 cronjob 定时触发 | **立即调用** send-notifications 核心函数 |
| 5. 生成消息内容 | 在 send-notifications 中执行 | 在 send-notifications 中执行 |
| 6. 发送推送通知 | 在 send-notifications 中执行 | 在 send-notifications 中执行 |
| 7. 更新任务状态 | 更新或删除数据库记录 | 删除数据库记录（recurrenceType = none） |

**实现建议**:
- 在 `schedule-message` 端点中检测到 `messageType === 'instant'` 时：
  1. 将任务存入数据库（与普通任务相同）
  2. 立即调用 `send-notifications` 中提取的核心处理函数
  3. 通过 UUID 参数指定只处理这一条消息
- 将 `send-notifications` 的消息处理逻辑提取为可复用函数，支持：
  - 处理所有待处理任务（cronjob 调用）
  - 处理指定 UUID 的单个任务（instant 调用）
- **所有 AI 调用逻辑集中在 `send-notifications` 中**，保持职责分离

### 1.7 成功响应 (Success Response)

#### 普通类型响应 (fixed/prompted/auto)

**状态码**: `201 Created`

**响应体结构**:
```json
{
  "success": true,
  "data": {
    "id": 12345,
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "contactName": "Rei",
    "nextSendAt": "2025-01-15T09:00:00Z",
    "status": "pending",
    "createdAt": "2025-01-14T08:30:00Z"
  }
}
```

**字段说明**:
- `id`: 任务在数据库中的唯一标识符
- `uuid`: 用户级别的唯一标识符（用于跨设备查询）
- `contactName`: 角色名称（返回确认）
- `nextSendAt`: 下次发送时间（ISO 8601格式）
- `status`: 任务状态（`pending`表示待处理）
- `createdAt`: 任务创建时间

#### instant 类型响应

**状态码**: `200 OK`

**响应体结构**:
```json
{
  "success": true,
  "data": {
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "contactName": "Rei",
    "messagesSent": 3,
    "sentAt": "2025-01-15T09:00:00Z",
    "status": "sent"
  }
}
```

**字段说明**:
- `uuid`: 用户级别的唯一标识符
- `contactName`: 角色名称（返回确认）
- `messagesSent`: 发送的消息条数（分句后的数量）
- `sentAt`: 实际发送时间
- `status`: 固定为 `sent`（表示已发送）

### 1.8 错误响应 (Error Response)

#### 400 Bad Request - 参数错误

```json
{
  "success": false,
  "error": {
    "code": "INVALID_PARAMETERS",
    "message": "缺少必需参数",
    "details": {
      "missingFields": ["contactName", "pushSubscription"]
    }
  }
}
```

**常见错误代码**:

**加密相关错误**:
- `ENCRYPTION_REQUIRED`: 请求体必须加密（缺少 `X-Payload-Encrypted` 头部）
- `USER_ID_REQUIRED`: 缺少 `X-User-Id` 头部
- `INVALID_USER_ID_FORMAT`: `X-User-Id` 不是 UUID v4
- `MASTER_KEY_NOT_INITIALIZED`: 主密钥未初始化
- `DECRYPTION_FAILED`: 请求体解密失败（authTag 验证失败或密钥错误）
- `INVALID_ENCRYPTED_PAYLOAD`: 加密数据格式错误（缺少 iv/authTag/encryptedData 字段）
- `INVALID_PAYLOAD_FORMAT`: 解密后的数据不是有效 JSON
- `UNSUPPORTED_ENCRYPTION_VERSION`: 加密版本不支持（当前仅支持版本 1）

**业务参数错误**:
- `INVALID_PARAMETERS`: 缺少必需参数或参数格式错误
- `INVALID_MESSAGE_TYPE`: 无效的消息类型（必须为 `fixed`、`prompted`、`auto` 或 `instant`）
- `INVALID_TIMESTAMP`: 时间格式错误或时间不在未来
- `TASK_UUID_CONFLICT`: 提交的任务 UUID 已存在
- `VAPID_CONFIG_ERROR`: `instant` 消息发送前发现 VAPID 配置缺失
- `TASK_CREATE_FAILED`: 数据库存储任务失败
- `MESSAGE_SEND_FAILED`: `instant` 消息发送失败

#### 401 Unauthorized - 认证失败（仅在接入方额外增加鉴权时）

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "认证失败或令牌无效"
  }
}
```

#### 413 Payload Too Large - 请求体过大

```json
{
  "success": false,
  "error": {
    "code": "PAYLOAD_TOO_LARGE",
    "message": "请求体超过限制"
  }
}
```

#### 429 Too Many Requests - 请求频率限制

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "请求过于频繁，请稍后再试",
    "retryAfter": 60
  }
}
```

#### 500 Internal Server Error - 服务器内部错误

```json
{
  "success": false,
  "error": {
    "code": "INTERNAL_SERVER_ERROR",
    "message": "服务器内部错误，请稍后重试"
  }
}
```

#### 503 Service Unavailable - 主密钥未初始化

```json
{
  "success": false,
  "error": {
    "code": "MASTER_KEY_NOT_INITIALIZED",
    "message": "主密钥尚未初始化，请先调用 /api/v1/init-master-key"
  }
}
```

---

## 2. POST /api/v1/send-notifications

### 2.1 端点信息
- **URL路径**: `/api/v1/send-notifications`
- **请求方法**: `POST`
- **功能描述**: 由 Cron Job 触发，处理到期的定时消息任务
- **认证要求**: 必需（Cron Secret）

### 2.2 请求头 (Request Headers)

| 头部字段 | 必需 | 类型 | 说明 |
|---------|------|------|------|
| Authorization | 是 | string | Cron 密钥，格式：`Bearer {CRON_SECRET}` |

> 平台说明：若你在 Vercel 开启了 Deployment Protection，平台层可能额外要求 `x-vercel-protection-bypass`。该校验不属于 ReiStandard SDK 的接口规范。

### 2.3 请求体 (Request Body)

此端点不需要请求体。

### 2.4 请求示例

```bash
curl -X POST "https://your-domain.com/api/v1/send-notifications" \
  -H "Authorization: Bearer your_cron_secret_here"
```

### 2.5 认证验证逻辑

```javascript
const secret = (request.headers.authorization || request.headers.Authorization || '').trim();
if (`Bearer ${process.env.CRON_SECRET}` !== secret) {
    return 401 Unauthorized
}
```

### 2.6 核心处理流程

1. **鉴权验证**: 验证请求来源的合法性
2. **配置检查**: 验证 VAPID 配置是否完整
3. **主密钥检查**: 从 `system_config` 读取主密钥，不存在则返回 `MASTER_KEY_NOT_INITIALIZED`
4. **查询待处理任务**: 从数据库获取所有到期且状态为 `pending` 的任务
5. **并发处理任务**: 使用动态任务池（并发数: 8）处理多个任务
6. **AI API 调用**: 根据任务配置请求 AI 生成消息内容
7. **消息分句处理**: 将长消息拆分为多条短消息
8. **批量推送通知**: 逐条发送推送通知，消息间添加延迟
9. **更新任务状态**: 根据执行结果更新数据库任务状态

### 2.7 成功响应 (Success Response)

**状态码**: `200 OK`

**响应体结构**:
```json
{
  "success": true,
  "data": {
    "totalTasks": 15,
    "successCount": 13,
    "failedCount": 2,
    "processedAt": "2025-01-15T09:00:45Z",
    "executionTime": 8234,
    "details": {
      "deletedOnceOffTasks": 10,
      "updatedRecurringTasks": 3,
      "failedTasks": [
        {
          "taskId": 123,
          "reason": "API request timeout",
          "retryCount": 1,
          "nextRetryAt": "2025-01-15T09:02:00Z"
        },
        {
          "taskId": 456,
          "reason": "Push subscription expired",
          "retryCount": 3,
          "status": "permanently_failed"
        }
      ]
    }
  }
}
```

**字段说明**:
- `totalTasks`: 本次处理的任务总数
- `successCount`: 成功处理的任务数
- `failedCount`: 失败的任务数
- `processedAt`: 处理完成时间
- `executionTime`: 总执行时间（毫秒）
- `deletedOnceOffTasks`: 删除的一次性任务数量
- `updatedRecurringTasks`: 更新的循环任务数量
- `failedTasks`: 失败任务详情数组

### 2.8 错误响应 (Error Response)

#### 401 Unauthorized - 认证失败

```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Cron Secret 验证失败"
  }
}
```

#### 500 Internal Server Error - VAPID 配置缺失

```json
{
  "success": false,
  "error": {
    "code": "VAPID_CONFIG_ERROR",
    "message": "VAPID 配置缺失，无法发送推送通知",
    "details": {
      "missingKeys": ["VAPID_EMAIL", "NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY"]
    }
  }
}
```

#### 503 Service Unavailable - 主密钥未初始化

```json
{
  "success": false,
  "error": {
    "code": "MASTER_KEY_NOT_INITIALIZED",
    "message": "主密钥尚未初始化，请先调用 /api/v1/init-master-key"
  }
}
```

> 说明：单条任务的处理失败会记录在成功响应 `data.details.failedTasks` 中，而不是让端点整体返回 500。

### 2.9 重试机制

对于失败的任务，系统将自动执行重试：

- **最大重试次数**: 3 次
- **重试间隔**: 线性递增（2分钟、4分钟、6分钟）
- **永久失败**: 达到最大重试次数后，任务状态标记为 `failed`

```javascript
// 伪代码示例
if (retryCount >= 3) {
    // 标记为永久失败
    updateTask(taskId, {
        status: 'failed',
        failureReason: errorMessage
    });
} else {
    // 计算下次重试时间
    const nextRetryTime = new Date(Date.now() + (retryCount + 1) * 2 * 60 * 1000);
    updateTask(taskId, {
        nextSendAt: nextRetryTime,
        retryCount: retryCount + 1
    });
}
```

---

## 3. PUT /api/v1/update-message

### 3.1 端点信息
- **URL路径**: `/api/v1/update-message?id={uuid}`
- **请求方法**: `PUT`
- **功能描述**: 更新已存在的定时任务的上下文或配置（进阶功能）
- **认证要求**: 必需（`X-User-Id` + `X-Payload-Encrypted` + `X-Encryption-Version`）

### 3.2 查询参数

| 参数名 | 类型 | 必需 | 说明 |
|-------|------|------|------|
| id | string | 是 | UUID |

### 3.3 请求头 (Request Headers)

| 头部字段 | 必需 | 类型 | 说明 |
|---------|------|------|------|
| Content-Type | 是 | string | 必须为 `application/json` |
| X-User-Id | 是 | string | UUID v4 用户唯一标识符 |
| X-Payload-Encrypted | 是 | string | 固定值：`true` |
| X-Encryption-Version | 是 | string | 固定值：`1` |

### 3.4 请求体 (Request Body)

请求体必须先加密后再发送，实际请求体结构为：

```json
{
  "iv": "Base64编码的初始化向量",
  "authTag": "Base64编码的认证标签",
  "encryptedData": "Base64编码的加密数据"
}
```

加密前原始更新数据中，所有字段均为可选，只需传递需要更新的字段：

| 字段名 | 类型 | 说明 |
|-------|------|------|
| completePrompt | string | 更新后的完整 prompt 内容（包含角色名、人设等完整信息） |
| userMessage | string | 更新后的用户消息内容 |
| nextSendAt | string | 更新发送时间（ISO 8601 格式） |
| recurrenceType | string | 更新重复类型（`none`、`daily`、`weekly`） |
| avatarUrl | string | 更新头像 URL |
| metadata | object | 更新自定义元数据 |

### 3.5 请求示例

**加密前原始数据示例**：
```json
{
  "completePrompt": "【角色】你是Rei，更新后的性格设定...\n【历史对话】...\n【任务】...",
  "nextSendAt": "2025-10-13T09:00:00Z"
}
```

**实际发送（加密后）**：
```bash
curl -X PUT "https://your-domain.com/api/v1/update-message?id=550e8400-e29b-41d4-a716-446655440000" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: 550e8400-e29b-41d4-a716-446655440000" \
  -H "X-Payload-Encrypted: true" \
  -H "X-Encryption-Version: 1" \
  -d '{"iv":"...","authTag":"...","encryptedData":"..."}'
```

### 3.6 成功响应 (Success Response)

**状态码**: `200 OK`

```json
{
  "success": true,
  "data": {
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "updatedFields": ["completePrompt", "nextSendAt"],
    "updatedAt": "2025-01-15T10:30:00Z"
  }
}
```

### 3.7 错误响应 (Error Response)

| 场景 | HTTP 状态码 | 错误代码 |
|------|-------------|----------|
| 缺少查询参数 `id` | 400 | `TASK_ID_REQUIRED` |
| 缺少 `X-User-Id` | 400 | `USER_ID_REQUIRED` |
| `X-User-Id` 非 UUID v4 | 400 | `INVALID_USER_ID_FORMAT` |
| 缺少加密头部 | 400 | `ENCRYPTION_REQUIRED` |
| 加密版本错误 | 400 | `UNSUPPORTED_ENCRYPTION_VERSION` |
| 请求体不是合法加密结构 | 400 | `INVALID_ENCRYPTED_PAYLOAD` |
| 解密失败 | 400 | `DECRYPTION_FAILED` |
| 更新数据格式错误 | 400 | `INVALID_UPDATE_DATA` |
| 任务不存在 | 404 | `TASK_NOT_FOUND` |
| 任务非 pending（已完成/失败） | 409 | `TASK_ALREADY_COMPLETED` |
| 并发冲突导致更新失败 | 409 | `UPDATE_CONFLICT` |
| 主密钥未初始化 | 503 | `MASTER_KEY_NOT_INITIALIZED` |

#### 400 Bad Request - 更新数据格式错误示例

```json
{
  "success": false,
  "error": {
    "code": "INVALID_UPDATE_DATA",
    "message": "更新数据格式错误",
    "details": {
      "invalidFields": ["nextSendAt"]
    }
  }
}
```

#### 409 Conflict - 任务已完成示例

```json
{
  "success": false,
  "error": {
    "code": "TASK_ALREADY_COMPLETED",
    "message": "任务已完成或已失败，无法更新"
  }
}
```

#### 503 Service Unavailable - 主密钥未初始化

```json
{
  "success": false,
  "error": {
    "code": "MASTER_KEY_NOT_INITIALIZED",
    "message": "主密钥尚未初始化，请先调用 /api/v1/init-master-key"
  }
}
```

---

## 4. DELETE /api/v1/cancel-message

### 4.1 端点信息
- **URL路径**: `/api/v1/cancel-message?id={uuid}`
- **请求方法**: `DELETE`
- **功能描述**: 取消/删除已存在的定时任务（进阶功能）
- **认证要求**: 必需（`X-User-Id`）

### 4.2 查询参数

| 参数名 | 类型 | 必需 | 说明 |
|-------|------|------|------|
| id | string | 是 | UUID |

### 4.3 请求头 (Request Headers)

| 头部字段 | 必需 | 类型 | 说明 |
|---------|------|------|------|
| X-User-Id | 是 | string | UUID v4 用户唯一标识符（用于数据隔离） |

### 4.4 请求示例

```bash
curl -X DELETE "https://your-domain.com/api/v1/cancel-message?id=550e8400-e29b-41d4-a716-446655440000" \
  -H "X-User-Id: 550e8400-e29b-41d4-a716-446655440000"
```

### 4.5 成功响应 (Success Response)

**状态码**: `200 OK`

```json
{
  "success": true,
  "data": {
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "message": "任务已成功取消",
    "deletedAt": "2025-01-15T10:45:00Z"
  }
}
```

### 4.6 错误响应 (Error Response)

| 场景 | HTTP 状态码 | 错误代码 |
|------|-------------|----------|
| 缺少查询参数 `id` | 400 | `TASK_ID_REQUIRED` |
| 缺少 `X-User-Id` | 400 | `USER_ID_REQUIRED` |
| `X-User-Id` 非 UUID v4 | 400 | `INVALID_USER_ID_FORMAT` |
| 任务不存在 | 404 | `TASK_NOT_FOUND` |

#### 400 Bad Request - 参数错误

```json
{
  "success": false,
  "error": {
    "code": "TASK_ID_REQUIRED",
    "message": "缺少任务ID"
  }
}
```

#### 404 Not Found - 任务不存在

```json
{
  "success": false,
  "error": {
    "code": "TASK_NOT_FOUND",
    "message": "指定的任务不存在或已被删除"
  }
}
```

---

## 5. GET /api/v1/messages (扩展功能)

### 5.1 端点信息
- **URL路径**: `/api/v1/messages`
- **请求方法**: `GET`
- **功能描述**: 查询用户的定时任务列表
- **认证要求**: 必需（通过 `X-User-Id` 请求头进行用户隔离）

### 5.2 请求头 (Request Headers)

| 头部字段 | 必需 | 类型 | 说明 |
|---------|------|------|------|
| X-User-Id | 是 | string | UUID v4 用户唯一标识符（用于数据隔离，服务器将只返回该用户的任务） |
| X-Response-Encrypted | 否 | string | 建议值 `true`，表示客户端期望收到加密响应体 |
| X-Encryption-Version | 否 | string | 建议值 `1` |

### 5.3 查询参数 (Query Parameters)

| 参数名 | 类型 | 必需 | 默认值 | 说明 |
|-------|------|------|--------|------|
| status | string | 否 | `all` | 任务状态筛选：`pending`、`sent`、`failed`、`all` |
| limit | integer | 否 | 20 | 每页返回数量（最大 100） |
| offset | integer | 否 | 0 | 分页偏移量 |

### 5.4 请求示例

```bash
curl -X GET "https://your-domain.com/api/v1/messages?status=pending&limit=10" \
  -H "X-User-Id: 550e8400-e29b-41d4-a716-446655440000"
```

### 5.5 成功响应 (Success Response)

**状态码**: `200 OK`

```json
{
  "success": true,
  "encrypted": true,
  "version": 1,
  "data": {
    "iv": "Base64编码的初始化向量",
    "authTag": "Base64编码的认证标签",
    "encryptedData": "Base64编码的加密数据"
  }
}
```

客户端使用 `userKey` 解密后可得到如下结构：

```json
{
  "tasks": [
    {
      "id": 12345,
      "uuid": "550e8400-e29b-41d4-a716-446655440000",
      "contactName": "Rei",
      "messageType": "auto",
      "messageSubtype": "chat",
      "nextSendAt": "2025-10-13T09:00:00Z",
      "recurrenceType": "daily",
      "status": "pending",
      "retryCount": 0,
      "createdAt": "2025-01-15T08:30:00Z",
      "updatedAt": "2025-01-15T08:30:00Z"
    }
  ],
  "pagination": {
    "total": 25,
    "limit": 10,
    "offset": 0,
    "hasMore": true
  }
}
```

### 5.6 错误响应 (Error Response)

| 场景 | HTTP 状态码 | 错误代码 |
|------|-------------|----------|
| 缺少 `X-User-Id` | 400 | `USER_ID_REQUIRED` |
| `X-User-Id` 非 UUID v4 | 400 | `INVALID_USER_ID_FORMAT` |
| `limit` 非正整数 | 400 | `INVALID_PARAMETERS` |
| `offset` 非负整数 | 400 | `INVALID_PARAMETERS` |
| 主密钥未初始化 | 503 | `MASTER_KEY_NOT_INITIALIZED` |

#### 400 Bad Request - 缺少 User ID

```json
{
  "success": false,
  "error": {
    "code": "USER_ID_REQUIRED",
    "message": "必须提供 X-User-Id 请求头"
  }
}
```

#### 503 Service Unavailable - 主密钥未初始化

```json
{
  "success": false,
  "error": {
    "code": "MASTER_KEY_NOT_INITIALIZED",
    "message": "主密钥尚未初始化，请先调用 /api/v1/init-master-key"
  }
}
```

---

## 6. 通用规范

### 6.1 认证与授权

本标准认证策略的核心目标为**用户隔离**（确保用户只能操作自己的任务）。

#### 6.1.1 Cron Job 认证

用于保护 `/api/v1/send-notifications` 端点。

- **认证方式**: Bearer Token
- **Token 存储**: 环境变量 `CRON_SECRET`
- **传递方式**: `Authorization` 头部，格式：`Bearer {CRON_SECRET}`

```javascript
exports.POST = async function(request) {
    const authHeader = request.headers.get('authorization') || '';
    const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;

    if (authHeader.trim() !== expectedAuth) {
        return NextResponse.json(
            { success: false, error: { code: 'UNAUTHORIZED' } },
            { status: 401 }
        );
    }
    // 继续处理...
}
```

#### 6.1.2 用户标识符（User ID）

**核心原则**：
- 客户端生成并管理 User ID（使用 UUID v4）
- 所有用户侧业务请求必须携带 User ID（`X-User-Id` 头部）
- 服务器根据 User ID 进行数据隔离

**User ID 生成**（客户端）:
```javascript
// 首次访问时生成 User ID
function getOrCreateUserId() {
    let userId = localStorage.getItem('user_id');

    if (!userId) {
        // 生成 UUID v4
        userId = crypto.randomUUID(); // 浏览器原生 API
        localStorage.setItem('user_id', userId);
    }

    return userId;
}

// 使用示例
const userId = getOrCreateUserId(); // 如：'550e8400-e29b-41d4-a716-446655440000'
```

#### 6.1.3 权限验证逻辑

**核心思路**：服务器仅根据 `X-User-Id` 进行数据过滤，确保用户只能访问自己的任务。

**1. 创建任务**:
```javascript
exports.POST = async function(request) {
    const userId = request.headers.get('x-user-id');

    if (!userId) {
        return NextResponse.json(
            { success: false, error: { code: 'USER_ID_REQUIRED' } },
            { status: 400 }
        );
    }

    if (!isValidUUIDv4(userId)) {
        return NextResponse.json(
            { success: false, error: { code: 'INVALID_USER_ID_FORMAT' } },
            { status: 400 }
        );
    }

    const masterKey = await getMasterKeyFromDb();
    const userKey = deriveUserEncryptionKey(userId, masterKey);
    const payload = decryptPayload(encryptedBody, userKey);

    // 加密敏感字段存储到 encrypted_payload
    const encryptedPayload = encryptForStorage(JSON.stringify(payload), userKey);

    // 创建任务，仅存储索引字段 + 加密的 payload
    await sql`
        INSERT INTO scheduled_messages (
          user_id, uuid, encrypted_payload, message_type, next_send_at, status
        )
        VALUES (
          ${userId}, ${payload.uuid}, ${encryptedPayload}, 
          ${payload.messageType}, ${payload.firstSendTime}, 'pending'
        )
    `;
}
```

**2. 查询任务**:
```javascript
exports.GET = async function(request) {
    const userId = request.headers.get('x-user-id');

    if (!userId) {
        return NextResponse.json(
            { success: false, error: { code: 'USER_ID_REQUIRED' } },
            { status: 400 }
        );
    }

    // 查询该用户的任务
    const tasks = await sql`
        SELECT * FROM scheduled_messages
        WHERE user_id = ${userId}
    `;

    return NextResponse.json({ success: true, data: { tasks } });
}
```

**3. 更新任务**:
```javascript
exports.PUT = async function(request) {
    const userId = request.headers.get('x-user-id');
    const taskUuid = new URL(request.url).searchParams.get('id');

    const result = await sql`
        UPDATE scheduled_messages
        SET ... = ...
        WHERE uuid = ${taskUuid} AND user_id = ${userId}
    `;

    if (result.count === 0) {
        return NextResponse.json(
            { success: false, error: { code: 'TASK_NOT_FOUND' } },
            { status: 404 }
        );
    }
}
```

**4. 删除任务**:
```javascript
exports.DELETE = async function(request) {
    const userId = request.headers.get('x-user-id');
    const taskUuid = new URL(request.url).searchParams.get('id');

    const result = await sql`
        DELETE FROM scheduled_messages
        WHERE uuid = ${taskUuid} AND user_id = ${userId}
    `;

    if (result.count === 0) {
        return NextResponse.json(
            { success: false, error: { code: 'TASK_NOT_FOUND' } },
            { status: 404 }
        );
    }
}
```

#### 6.1.4 安全说明

**安全级别**：
- **数据隔离**：用户 A 无法查询/修改用户 B 的任务
- **客户端管理**：User ID 由客户端生成和存储
- **泄漏风险**：如果 User ID 泄漏或被伪造，他人可以访问该用户的任务（User ID 与 其他聊天记录同存放于 localStorage，与其有同样的安全级别，通常不会单独泄漏。）

### 6.2 数据安全

本标准强制要求对所有请求体进行端到端加密，确保数据在传输和存储过程中的安全性。

#### 6.2.1 请求体加密（强制）

所有对 `/api/v1/schedule-message` 和 `/api/v1/update-message?id={uuid}` 端点的请求必须对请求体进行加密。

**加密算法**: AES-256-GCM

**密钥管理架构**:
- **服务器端**：主密钥 `masterKey`（64字符十六进制）存储在数据库 `system_config` 表（`key='master_key'`）
- **客户端**：用户专属密钥存储在 **IndexedDB 加密表**中
- **密钥隔离**：每个用户使用独立的加密密钥，通过 `SHA256(masterKey + userId)` 派生
- **安全性**：用户 A 无法解密用户 B 的数据

**实现流程**:

1. **客户端密钥管理（IndexedDB 存储）**

```javascript
// 初始化 IndexedDB
import { openDB } from 'idb';

async function initEncryptionKeyStore() {
    const db = await openDB('SecureKeyStore', 1, {
        upgrade(db) {
            // 创建加密密钥表
            if (!db.objectStoreNames.contains('encryptionKeys')) {
                db.createObjectStore('encryptionKeys');
            }
        }
    });
    return db;
}

// 获取或创建用户专属密钥
async function getOrCreateUserEncryptionKey(userId) {
    const db = await initEncryptionKeyStore();

    // 尝试从 IndexedDB 获取
    let userKey = await db.get('encryptionKeys', userId);

    if (!userKey) {
        // 首次使用：从服务器获取用户专属密钥
        const response = await fetch('/api/v1/get-user-key', {
            headers: {
                'X-User-Id': userId
            }
        });

        if (!response.ok) {
            throw new Error('Failed to get user key');
        }

        const { data } = await response.json();
        userKey = data.userKey;

        // 存储到 IndexedDB（持久化，页面刷新后仍然可用）
        await db.put('encryptionKeys', userKey, userId);
    }

    return userKey;
}
```

2. **客户端加密请求体**

```javascript
// 加密函数（支持浏览器环境）
async function encryptPayload(plainPayload, encryptionKey) {
    const plaintext = JSON.stringify(plainPayload);

    // 生成随机 IV（12字节，GCM 推荐长度）
    const iv = crypto.getRandomValues(new Uint8Array(12));

    // 导入密钥
    const keyBuffer = new Uint8Array(encryptionKey.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBuffer,
        { name: 'AES-GCM' },
        false,
        ['encrypt']
    );

    // 加密数据
    const encryptedBuffer = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        cryptoKey,
        new TextEncoder().encode(plaintext)
    );

    // 提取 authTag（最后 16 字节）
    const encryptedArray = new Uint8Array(encryptedBuffer);
    const ciphertext = encryptedArray.slice(0, -16);
    const authTag = encryptedArray.slice(-16);

    // 返回 Base64 编码结果
    return {
        iv: btoa(String.fromCharCode(...iv)),
        authTag: btoa(String.fromCharCode(...authTag)),
        encryptedData: btoa(String.fromCharCode(...ciphertext))
    };
}

// 发送加密请求
async function sendEncryptedRequest(payload, userId) {
    // 获取用户专属密钥（从 IndexedDB）
    const userKey = await getOrCreateUserEncryptionKey(userId);

    // 加密请求体
    const encrypted = await encryptPayload(payload, userKey);

    // 发送请求
    return fetch('/api/v1/schedule-message', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Payload-Encrypted': 'true',
            'X-Encryption-Version': '1',
            'X-User-Id': userId  // 必需：用于服务器端密钥派生和数据隔离
        },
        body: JSON.stringify(encrypted)
    });
}

// 使用示例
const userId = getOrCreateUserId();  // 从 localStorage 获取或创建
const originalPayload = {
    contactName: "Rei",
    messageType: "prompted",
    firstSendTime: "2025-01-15T14:00:00Z",
    apiKey: "sk-xxxxxxxx",      // 敏感数据
    completePrompt: "...",       // 敏感数据
    pushSubscription: { /* ... */ }
};

await sendEncryptedRequest(originalPayload, userId);
```

3. **服务器端用户密钥分发**

```javascript
// GET /api/v1/get-user-key
// 仅在用户首次登录时调用一次（客户端缓存到 IndexedDB）
exports.GET = async function(request) {
    const userId = request.headers.get('x-user-id');

    if (!userId) {
        return NextResponse.json(
            { success: false, error: { code: 'USER_ID_REQUIRED', message: '缺少用户标识符' } },
            { status: 400 }
        );
    }

    if (!isValidUUIDv4(userId)) {
        return NextResponse.json(
            { success: false, error: { code: 'INVALID_USER_ID_FORMAT', message: 'X-User-Id 必须是 UUID v4 格式' } },
            { status: 400 }
        );
    }

    const masterKey = await getMasterKeyFromDb();
    if (!masterKey) {
        return NextResponse.json(
            { success: false, error: { code: 'MASTER_KEY_NOT_INITIALIZED', message: '主密钥尚未初始化，请先调用 /api/v1/init-master-key' } },
            { status: 503 }
        );
    }

    // 返回用户专属密钥（由服务器内部派生）
    return NextResponse.json({
        success: true,
        data: {
            userKey: deriveUserEncryptionKey(userId, masterKey),
            version: 1
        }
    });
}
```

4. **服务器解密请求体（最小负担）**

```javascript
// Node.js 服务器端
import { createHash, createDecipheriv } from 'crypto';

// 派生用户专属密钥（与客户端逻辑一致）
function deriveUserEncryptionKey(userId, masterKey) {
    return createHash('sha256')
        .update(masterKey + userId)
        .digest('hex')
        .slice(0, 64); // 32字节 = 64位hex
}

function decryptPayload(encryptedPayload, encryptionKey) {
    const { iv, authTag, encryptedData } = encryptedPayload;

    const decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(encryptionKey, 'hex'),
        Buffer.from(iv, 'base64')
    );

    decipher.setAuthTag(Buffer.from(authTag, 'base64'));

    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedData, 'base64')),
        decipher.final()  // authTag 验证失败会抛出错误
    ]);

    return JSON.parse(decrypted.toString('utf8'));
}

// 在 API 路由中使用
exports.POST = async function(request) {
    const isEncrypted = request.headers.get('x-payload-encrypted') === 'true';
    const userId = request.headers.get('x-user-id');

    // 验证加密要求
    if (!isEncrypted) {
        return NextResponse.json(
            { success: false, error: { code: 'ENCRYPTION_REQUIRED', message: '请求体必须加密' } },
            { status: 400 }
        );
    }

    // 验证用户 ID 是否提供
    if (!userId) {
        return NextResponse.json(
            { success: false, error: { code: 'USER_ID_REQUIRED', message: '缺少用户标识符' } },
            { status: 400 }
        );
    }

    // 验证 UUID v4
    if (!isValidUUIDv4(userId)) {
        return NextResponse.json(
            { success: false, error: { code: 'INVALID_USER_ID_FORMAT', message: 'X-User-Id 必须是 UUID v4 格式' } },
            { status: 400 }
        );
    }

    const masterKey = await getMasterKeyFromDb();
    if (!masterKey) {
        return NextResponse.json(
            { success: false, error: { code: 'MASTER_KEY_NOT_INITIALIZED', message: '主密钥尚未初始化，请先调用 /api/v1/init-master-key' } },
            { status: 503 }
        );
    }

    try {
        // 派生用户专属密钥（仅一次 SHA-256 计算，< 1ms）
        const userKey = deriveUserEncryptionKey(userId, masterKey);

        // 解密请求体
        const encryptedBody = await request.json();
        const payload = decryptPayload(encryptedBody, userKey);

        // 继续处理业务逻辑...
        // payload 现在包含原始的业务数据

    } catch (error) {
        if (error.message.includes('auth') || error.message.includes('Unsupported state')) {
            return NextResponse.json(
                { success: false, error: { code: 'DECRYPTION_FAILED', message: '请求体解密失败' } },
                { status: 400 }
            );
        }
        throw error;
    }
}
```

**错误处理**:

| 错误场景 | HTTP 状态码 | 错误代码 | 说明 |
|---------|------------|---------|------|
| 缺少加密头部 `X-Payload-Encrypted` | 400 | `ENCRYPTION_REQUIRED` | 请求体必须加密 |
| 缺少 `X-User-Id` 头部 | 400 | `USER_ID_REQUIRED` | 缺少用户标识符 |
| `X-User-Id` 非 UUID v4 | 400 | `INVALID_USER_ID_FORMAT` | 用户标识符格式无效 |
| 主密钥未初始化 | 503 | `MASTER_KEY_NOT_INITIALIZED` | 需先调用 `/api/v1/init-master-key` |
| 解密失败（authTag 验证失败） | 400 | `DECRYPTION_FAILED` | 数据被篡改或密钥错误 |
| 缺少加密字段（iv/authTag/encryptedData） | 400 | `INVALID_ENCRYPTED_PAYLOAD` | 加密数据格式错误 |
| 解密后 JSON 解析失败 | 400 | `INVALID_PAYLOAD_FORMAT` | 解密后的数据不是有效 JSON |
| 加密版本不支持 | 400 | `UNSUPPORTED_ENCRYPTION_VERSION` | 当前仅支持版本 1 |

#### 6.2.2 数据库全字段加密（强制）

**核心设计**：本标准采用**全字段加密**架构，所有敏感业务数据统一加密后存储在 `encrypted_payload` 字段中。

**加密字段**（存储在 `encrypted_payload` 中）：
- `contactName`: 角色名称
- `avatarUrl`: 头像 URL
- `messageSubtype`: 消息子类型
- `userMessage`: 固定消息内容
- `recurrenceType`: 重复类型
- `apiUrl`: AI API 地址
- `apiKey`: AI API 密钥（高度敏感）
- `primaryModel`: AI 模型名称
- `completePrompt`: 完整 prompt（包含角色设定、历史记录等）
- `pushSubscription`: 推送订阅信息（包含密钥）
- `metadata`: 自定义元数据

**明文索引字段**（用于查询优化）：
- `user_id`: 用户标识
- `uuid`: 跨设备查询标识符
- `message_type`: 消息类型（`fixed`, `prompted`, `auto`, `instant`）
- `next_send_at`: 下次发送时间
- `status`: 任务状态
- `retry_count`: 重试次数

**存储格式**: `iv:authTag:encryptedData`（十六进制编码）

```javascript
// 数据库存储加密示例
function encryptForStorage(text, encryptionKey) {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv);
    const encrypted = cipher.update(text, 'utf8', 'hex') + cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decryptFromStorage(encryptedText, encryptionKey) {
    const [ivHex, authTagHex, encryptedDataHex] = encryptedText.split(':');
    const decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(encryptionKey, 'hex'),
        Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return decipher.update(encryptedDataHex, 'hex', 'utf8') + decipher.final('utf8');
}
```

**解密时机**:
- **处理任务时解密**：在 `send-notifications` 中处理任务时，解密完整 payload 以获取所有配置信息
- **查询任务时解密**：在 `/api/v1/messages` 端点返回任务列表时，解密 payload 以组装完整响应
- **更新任务时解密**：在 `/api/v1/update-message` 端点更新任务时，先解密现有数据，合并更新，再重新加密
- **日志保护**：日志中**不输出**明文敏感数据（如 API key）

**安全优势**：
- 在仅泄露 `scheduled_messages` 数据且主密钥未泄露时，敏感字段仍保持密文
- 用户间数据完全隔离（每个用户独立密钥）
- 查询性能优化（索引字段为明文，支持高效查询）
- 降低安全风险（无需对每个字段单独加密/解密）
- 若 `system_config` 中主密钥或数据库凭据泄露，则所有用户数据都可能被解密（高危边界）

#### 6.2.3 密钥分发与管理

**密钥隔离架构**:
- 每个用户使用**独立的加密密钥**，通过 `SHA256(masterKey + userId)` 派生
- 客户端将用户专属密钥存储在 **IndexedDB 加密表**中（持久化，页面刷新后仍然可用）
- 服务器将主密钥持久化在数据库 `system_config` 表，每次请求时动态派生用户密钥（< 1ms，对 Serverless Function 负担极小）

**相关 API 端点**:
- `POST /api/v1/init-master-key`：首次初始化主密钥（仅首次返回明文）
- `GET /api/v1/get-user-key`：分发用户专属密钥（`userKey`）

此端点用于分发用户专属密钥，客户端仅在**首次登录**或 **IndexedDB 中无密钥**时调用一次。

**端点定义**:
- **URL路径**: `/api/v1/get-user-key`
- **请求方法**: `GET`
- **功能描述**: 向用户返回用户专属密钥（`userKey`）
- **认证要求**: 需要 User ID（通过 `X-User-Id` 请求头）

**请求示例**:
```bash
curl -X GET "https://your-domain.com/api/v1/get-user-key" \
  -H "X-User-Id: 550e8400-e29b-41d4-a716-446655440000"
```

**成功响应** (200 OK):
```json
{
  "success": true,
  "data": {
    "userKey": "0123456789abcdef...",
    "version": 1
  }
}
```

**错误响应** (400 Bad Request - 缺少 User ID):
```json
{
  "success": false,
  "error": {
    "code": "USER_ID_REQUIRED",
    "message": "缺少用户标识符"
  }
}
```

**错误响应** (400 Bad Request - UUID 格式错误):
```json
{
  "success": false,
  "error": {
    "code": "INVALID_USER_ID_FORMAT",
    "message": "X-User-Id 必须是 UUID v4 格式"
  }
}
```

**错误响应** (503 Service Unavailable - 主密钥未初始化):
```json
{
  "success": false,
  "error": {
    "code": "MASTER_KEY_NOT_INITIALIZED",
    "message": "主密钥尚未初始化，请先调用 /api/v1/init-master-key"
  }
}
```

**客户端密钥管理最佳实践**:
1. 首次部署后先调用 `/api/v1/init-database`（幂等）
2. 调用 `/api/v1/init-master-key` 初始化主密钥并离线保存
3. 用户首次登录后，调用 `/api/v1/get-user-key` 获取 `userKey`
4. 将 `userKey` 存储到 **IndexedDB** 中
5. 页面刷新后直接从 IndexedDB 读取，无需重新请求服务器

**服务器端密钥派生**:
- 每次收到加密请求时，从 `X-User-Id` 头部获取用户 ID
- 从数据库读取主密钥 `masterKey`
- 使用 `SHA256(masterKey + userId)` 派生该用户的专属密钥
- 使用派生的密钥解密请求体

**安全保障**:
- 用户 A 无法解密用户 B 的数据（即使获得了自己的专属密钥）
- 攻击者无法通过自己的账号解密他人的数据
- `userKey` 泄露影响范围可限制在单个用户
- 防止重放攻击：即使截获加密请求，也无法用其他用户的身份解密
- `masterKey` 泄露属于全局风险，需由接入方自行承担并采取额外防护

#### 6.2.4 HTTPS 强制
- 所有 API 端点必须使用 HTTPS
- 拒绝 HTTP 请求或自动重定向到 HTTPS
- HTTPS 配合请求体加密实现双重安全保护

### 6.3 速率限制

推荐的速率限制配置：

| 端点 | 限制 | 时间窗口 |
|-----|------|---------|
| `/api/v1/schedule-message` | 30 次 | 每小时每用户 |
| `/api/v1/send-notifications` | 无限制* | - |
| `/api/v1/update-message` | 100 次 | 每小时每用户 |
| `/api/v1/cancel-message` | 30 次 | 每小时每用户 |
| `/api/v1/messages` | 50 次 | 每小时每用户 |

*仅允许来自 Cron Job 的认证请求

超出限制时返回：
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "请求频率超出限制",
    "retryAfter": 3600
  }
}
```
HTTP 状态码：`429 Too Many Requests`

### 6.4 CORS 配置

推荐的 CORS 头部配置：

```
Access-Control-Allow-Origin: https://your-app-domain.com
Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-User-Id, X-Payload-Encrypted, X-Encryption-Version, X-Response-Encrypted
Access-Control-Max-Age: 86400
```

### 6.5 请求大小限制

| 端点 | 最大请求体大小 |
|-----|--------------|
| `/api/v1/schedule-message` | 1 MB |
| `/api/v1/update-message` | 1 MB |

超出限制返回 `413 Payload Too Large`

### 6.6 超时配置

| 操作类型 | 超时时间 |
|---------|---------|
| 数据库查询 | 10 秒 |
| AI API 调用 | 300 秒 |
| 推送通知发送 | 30 秒 |
| 总请求超时 | 360 秒 |

### 6.7 版本控制

- API 版本通过 URL 路径控制（如 `/api/v1/`）

### 6.8 错误处理统一格式

所有错误响应遵循统一格式：

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "人类可读的错误描述",
    "details": {
      // 可选的详细错误信息
    }
  }
}
```

### 6.9 时间格式标准

- **统一格式**: ISO 8601
- **时区**: UTC
- **示例**: `2025-01-15T10:00:00Z`
- **解析**: 支持带毫秒和不带毫秒

### 6.10 字符编码

- **请求和响应**: UTF-8
- **Content-Type 头部**: `application/json; charset=utf-8`

---

## 7. 推送通知负载标准

本节定义服务器发送给客户端的推送通知数据格式，客户端 Service Worker 需要按照此格式解析和显示通知。

> **🔗 相关规范**：Service Worker 如何接收和处理推送通知请参考：[service-worker-specification.md#4-推送通知处理](./service-worker-specification.md#4-推送通知处理核心功能)

### 7.1 通知Payload结构

发送给浏览器的推送通知数据格式：

```json
{
  "title": "来自 Rei",
  "message": "早上好！今天的天气很不错呢。",
  "contactName": "Rei",
  "messageId": "msg_1705308000_abc123",
  "messageIndex": 1,
  "totalMessages": 3,
  "messageType": "auto",
  "messageSubtype": "chat",
  "taskId": 12345,
  "timestamp": "2025-01-15T09:00:00Z",
  "source": "scheduled",
  "avatarUrl": "https://example.com/avatar.png",
  "metadata": {
    "custom_field": "custom_value"
  }
}
```

### 7.2 字段说明

| 字段名 | 类型 | 必需 | 说明 |
|-------|------|------|------|
| title | string | 是 | 通知标题（通常显示为"来自 {角色名}"） |
| message | string | 是 | 消息内容（单条消息） |
| contactName | string | 是 | 角色/联系人名称 |
| messageId | string | 是 | 消息唯一标识符 |
| messageIndex | integer | 是 | 当前消息序号（从1开始） |
| totalMessages | integer | 是 | 消息总数 |
| messageType | string | 是 | 消息类型（`fixed`、`prompted`、`auto`、`instant`） |
| messageSubtype | string | 否 | 消息子类型（`chat`、`forum`、`moment`） |
| taskId | integer | 是 | 任务ID |
| timestamp | string | 是 | 消息时间戳（ISO 8601） |
| source | string | 是 | 消息来源（`scheduled` 或 `instant`，instant 类型时为 `'instant'`） |
| avatarUrl | string | 否 | 头像URL |
| metadata | object | 否 | 自定义元数据 |

---

## 8. 扩展功能规划

### 8.1 消息历史记录更新

**功能描述**: 允许在用户继续聊天后，自动更新定时任务的上下文。

**实现方式**:
- 在每次 AI 回复后，调用 `PUT /api/v1/update-message?id={uuid}`
- 更新 `completePrompt` 字段为最新上下文
- 需要前端缓存任务ID和角色名称的映射关系

### 8.2 UUID 查询支持

**功能描述**: 使用用户唯一标识符查询和管理跨设备的任务。

**实现方式**:
- 在创建任务时分配或接收 UUID
- 当前版本通过 `PUT /api/v1/update-message?id={uuid}` 与 `DELETE /api/v1/cancel-message?id={uuid}` 按 UUID 管理任务
- 如需按 UUID 精确查询，可先调用 `/api/v1/messages` 后在客户端按 `uuid` 过滤

### 8.3 多类型消息支持

**功能描述**: 扩展支持聊天、论坛、朋友圈等多种消息类型。

**实现方式**:
- 使用 `messageSubtype` 字段区分消息类型
- 前端根据 `messageSubtype` 路由到不同的渲染逻辑
- 后端存储时保留完整类型信息

### 8.4 AI主动规划

**功能描述**: AI 在对话中自主决定是否需要发送定时消息。

**实现方式**:
- AI 返回特殊格式的响应（JSON）
- 前端解析后自动调用 `POST /api/v1/schedule-message`
- 示例格式：
```json
{
  // ...
  "scheduledMessage": {
    "contactName": "Rei",
    "messageType": "auto",
    "firstSendTime": "2025-10-13T09:00:00Z",
    "completePrompt": "${window.promptBuilder.buildAutoMessagePrompt}"
  }
}
```

### 8.5 消息头像自定义

**功能描述**: 为推送通知设置自定义头像。

**实现方式**:
- 在创建任务时提供 `avatarUrl` 字段
- 支持相对路径（服务器资源）和绝对路径（图床URL）
- Service Worker 在显示通知时使用 `icon` 属性

---

## 9. 性能优化建议

### 9.1 数据库索引

必需的数据库索引配置：

```sql
-- 主查询索引（移除 contact_name，因为该字段已加密）
CREATE INDEX idx_pending_tasks_optimized
ON scheduled_messages (status, next_send_at, id, retry_count)
WHERE status = 'pending';

-- 清理查询索引
CREATE INDEX idx_cleanup_completed
ON scheduled_messages (status, updated_at)
WHERE status IN ('sent', 'failed');

-- 失败重试索引
CREATE INDEX idx_failed_retry
ON scheduled_messages (status, retry_count, next_send_at)
WHERE status = 'failed' AND retry_count < 3;

-- 用户任务查询索引（用于查询特定用户的所有任务）
CREATE INDEX idx_user_id
ON scheduled_messages (user_id);

-- UUID 唯一索引（防止重复 UUID）
CREATE UNIQUE INDEX uidx_uuid
ON scheduled_messages (uuid)
WHERE uuid IS NOT NULL;
```

### 9.2 并发处理

- **并发上限**: 8个任务并发处理
- **任务队列**: 使用动态任务池（Dynamic Task Pool）
- **隔离处理**: 单个任务失败不影响其他任务

### 9.3 定期清理

- **清理周期**: 每天清理一次
- **清理规则**: 删除 7 天前且状态为 `sent` 或 `failed` 的任务
- **触发方式**: 在 `send-notifications` 端点处理结束后触发

### 9.4 缓存策略

推荐的缓存配置：

| 数据类型 | 缓存时长 | 缓存层 | 说明 |
|---------|---------|--------|------|
| VAPID 公钥 | 永久 | Serverless 内存 | 启动时加载 |
| 主密钥（masterKey） | 短期 | Serverless 内存 | 从 `system_config` 读取后可短时缓存 |
| 用户专属密钥 | 无需缓存 | - | 每次请求动态派生（< 1ms） |
| 数据库连接 | 会话期间 | 连接池 | 复用连接 |

**注意**：用户专属密钥无需在服务器端缓存，每次请求时通过 SHA-256 动态派生即可，性能开销极低。

---

## 10. 部署考虑

### 10.1 架构原则

- **Serverless 优先**：使用 Serverless Functions 减少运维复杂度
- **成本控制**：最大化利用云平台免费额度
- **数据隔离**：通过 `user_id` 实现多用户数据隔离

### 10.2 资源估算

| 资源类型 | 推荐配置 | 说明 |
|----------|----------|------|
| 数据库 | 0.5GB 存储 | 云数据库（如 Neon、Supabase） |
| Serverless 调用 | 43,200+ 次/月 | 每分钟 Cron 触发 |
| Cron 服务 | 外部 Cron | 或使用平台内置 Cron |

### 10.3 平台适配

不同 Serverless 平台的 API 路径格式：

| 平台 | API 路径格式 | 说明 |
|------|-------------|------|
| Vercel | `/api/v1/*` | 默认路径 |
| Netlify | `/netlify/functions/*` | 需要调整路径 |
| Cloudflare Workers | `/api/v1/*` | 需要配置 Workers 路由 |

> **完整部署指南**：环境变量配置、密钥生成、Cron 设置等详细步骤请参考 [examples/README.md](../examples/README.md)

---

## 11. 浏览器兼容性

### 11.1 必需API支持

| API | 用途 | 最低版本要求 |
|-----|------|------------|
| Service Worker | 后台推送 | Chrome 40+, Firefox 44+, Safari 11.1+ |
| Push API | 推送通知 | Chrome 42+, Firefox 44+, Safari 16+ |
| Notification API | 显示通知 | Chrome 22+, Firefox 22+, Safari 7+ |
| IndexedDB | 离线存储 | Chrome 24+, Firefox 16+, Safari 10+ |

### 11.2 平台特殊要求

| 平台 | 特殊要求 |
|-----|---------|
| iOS | 必须使用 PWA（添加到主屏幕） |
| Android | 原生支持，无特殊要求 |
| Desktop | 原生支持，推荐安装 PWA |

### 11.3 推荐浏览器

- Chrome/Edge (Chromium): 完全支持
- Firefox: 完全支持
- Safari: 部分支持（需 iOS 16.4+ 或 macOS 13+）

---

## 12. 安全考虑

### 12.1 SQL注入防护

- 使用参数化查询或 ORM
- 永不拼接用户输入到 SQL 语句
- 示例（安全）：
```javascript
await sql`SELECT * FROM scheduled_messages WHERE id = ${userId}`;
```

### 12.2 XSS防护

- 对所有用户输入进行转义
- 使用 Content-Security-Policy 头部
- 推荐 CSP 配置：
```
Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self' https:;
```

### 12.3 CSRF防护

- 对状态改变的请求（POST、PUT、DELETE）使用 CSRF Token
- 验证 Origin 和 Referer 头部

### 12.4 数据保护

- 所有数据（API Key、用户消息、Prompt）使用 AES-256-GCM 加密存储
- 永不在响应或日志中返回明文敏感信息
- 主密钥存储在数据库 `system_config` 表（`key='master_key'`）
- 每个用户使用独立的加密密钥（详见 6.2 节）
- 风险边界：若数据库凭据或 `masterKey` 泄露，不承诺可抵抗此级别攻击

### 12.5 数据库安全

- 不使用 SUPERUSER 账户（如 `postgres`）
- 为应用创建专用数据库用户
- 最小权限原则：只授予必需的权限

```sql
-- 示例：创建专用用户
CREATE USER app_user WITH PASSWORD 'secure_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_messages TO app_user;
```

---

## 13. 测试与验证

本节提供完整的测试清单，用于验证 API 实现的正确性。

> **🧪 自动化测试工具**：
> - **本地开发测试**：使用测试脚本快速验证功能，详见 [docs/TEST_README.md](../docs/TEST_README.md)
> - **生产环境监控**：部署测试端点进行持续健康检查，详见 [docs/VERCEL_TEST_DEPLOY.md](../docs/VERCEL_TEST_DEPLOY.md)

### 13.1 端点测试清单

#### POST /api/v1/schedule-message

- [ ] 成功创建加密的固定消息任务
- [ ] 成功创建加密的 AI 消息任务
- [ ] 缺少加密头部时返回 400（`ENCRYPTION_REQUIRED`）
- [ ] 缺少 `X-User-Id` 时返回 400（`USER_ID_REQUIRED`）
- [ ] `X-User-Id` 非 UUID v4 时返回 400（`INVALID_USER_ID_FORMAT`）
- [ ] 主密钥未初始化时返回 503（`MASTER_KEY_NOT_INITIALIZED`）
- [ ] 解密失败时返回 400（`DECRYPTION_FAILED`）
- [ ] 缺少必需参数时返回 400
- [ ] 无效的 `messageType` 返回 400
- [ ] 无效的时间格式返回 400
- [ ] 过去的时间返回 400
- [ ] 无效的 `pushSubscription` 格式返回 400
- [ ] 响应包含正确的任务 ID 和创建时间

#### POST /api/v1/init-master-key

- [ ] 首次调用返回 201（包含 `masterKey`、`fingerprint`、`version`）
- [ ] 二次调用返回 409（`MASTER_KEY_ALREADY_INITIALIZED`）

#### GET /api/v1/get-user-key

- [ ] 提供有效的 User ID 成功获取用户密钥
- [ ] 缺少 `X-User-Id` 请求头返回 400
- [ ] `X-User-Id` 非 UUID v4 返回 400（`INVALID_USER_ID_FORMAT`）
- [ ] 主密钥未初始化时返回 503（`MASTER_KEY_NOT_INITIALIZED`）
- [ ] 响应包含正确的 userKey 和 version

#### POST /api/v1/send-notifications

- [ ] 正确的 Cron Secret 允许访问
- [ ] 错误的 Cron Secret 返回 401
- [ ] 缺失 VAPID 配置返回 500（`VAPID_CONFIG_ERROR`）
- [ ] 主密钥未初始化返回 503（`MASTER_KEY_NOT_INITIALIZED`）
- [ ] 成功处理到期任务
- [ ] 正确更新一次性任务（删除）
- [ ] 正确更新循环任务（计算下次时间）
- [ ] 失败任务正确重试（最多3次）
- [ ] 达到最大重试次数后标记为永久失败
- [ ] 响应包含处理统计信息

#### PUT /api/v1/update-message

- [ ] 成功更新任务字段
- [ ] 缺少 `id` 查询参数返回 400（`TASK_ID_REQUIRED`）
- [ ] 缺少 `X-User-Id` 返回 400（`USER_ID_REQUIRED`）
- [ ] `X-User-Id` 非 UUID v4 返回 400（`INVALID_USER_ID_FORMAT`）
- [ ] 缺少加密头部返回 400（`ENCRYPTION_REQUIRED`）
- [ ] 加密版本不正确返回 400（`UNSUPPORTED_ENCRYPTION_VERSION`）
- [ ] 主密钥未初始化返回 503（`MASTER_KEY_NOT_INITIALIZED`）
- [ ] 请求体加密结构错误返回 400（`INVALID_ENCRYPTED_PAYLOAD`）
- [ ] 解密失败返回 400（`DECRYPTION_FAILED`）
- [ ] 不存在的 UUID 返回 404
- [ ] 无效的更新数据返回 400
- [ ] 已完成的任务无法更新（返回 409）
- [ ] 并发冲突返回 409（`UPDATE_CONFLICT`）

#### DELETE /api/v1/cancel-message

- [ ] 成功删除任务
- [ ] 缺少 `id` 查询参数返回 400（`TASK_ID_REQUIRED`）
- [ ] 缺少 `X-User-Id` 返回 400（`USER_ID_REQUIRED`）
- [ ] `X-User-Id` 非 UUID v4 返回 400（`INVALID_USER_ID_FORMAT`）
- [ ] 不存在的 UUID 返回 404

#### GET /api/v1/messages

- [ ] 提供有效 `X-User-Id` 返回 200，且响应体为加密结构（`encrypted: true`）
- [ ] 缺少 `X-User-Id` 返回 400（`USER_ID_REQUIRED`）
- [ ] `X-User-Id` 非 UUID v4 返回 400（`INVALID_USER_ID_FORMAT`）
- [ ] 非法 `limit/offset` 返回 400（`INVALID_PARAMETERS`）
- [ ] 主密钥未初始化返回 503（`MASTER_KEY_NOT_INITIALIZED`）

### 13.2 集成测试场景

1. **完整流程测试**
   - 创建任务 → 等待到期 → Cron 触发 → 发送通知 → 验证推送

2. **重试机制测试**
   - 创建任务 → AI API 失败 → 验证重试 → 验证最终失败

3. **循环任务测试**
   - 创建每日任务 → 第一次执行 → 验证下次时间 → 第二次执行

---

## 14. 故障排查

### 14.1 常见问题

#### 问题：Cron Job 无法触发 `/send-notifications`

**可能原因**:
- Cron Secret 错误
- VAPID 配置缺失
- 服务器网络问题

**解决方案**:
1. 验证环境变量 `CRON_SECRET` 是否正确
2. 检查 `VAPID_EMAIL`、`NEXT_PUBLIC_VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY`
3. 手动执行 curl 命令测试

#### 问题：推送通知未收到

**可能原因**:
- 浏览器未授予通知权限
- Push Subscription 过期
- Service Worker 未注册

**解决方案**:
1. 检查浏览器通知权限
2. 重新订阅推送服务
3. 验证 Service Worker 状态

#### 问题：AI API 调用失败

**可能原因**:
- API Key 错误或过期
- API URL 格式错误
- 网络超时
- API 速率限制

**解决方案**:
1. 看 Serverless Logs 后台对症下药

#### 问题：数据库连接失败

**可能原因**:
- `DATABASE_URL` 错误
- 数据库服务器不可达
- 连接池耗尽

**解决方案**:
1. 验证 `DATABASE_URL` 格式
2. 检查数据库服务器状态
3. 增加连接池大小

### 14.2 日志记录建议

推荐的日志级别和内容：

```javascript
// 创建任务
console.log('[schedule-message] New task created:', {
    taskId: task.id,
    contactName: task.contactName,
    nextSendAt: task.nextSendAt
});

// 处理任务
console.log('[send-notifications] Processing task:', {
    taskId: task.id,
    contactName: task.contactName,
    retryCount: task.retryCount
});

// 推送通知
console.log('[push] Notification sent:', {
    taskId: task.id,
    messageIndex: i + 1,
    totalMessages: messages.length
});

// 错误处理
console.error('[error] Task processing failed:', {
    taskId: task.id,
    errorType: error.name,
    errorMessage: error.message,
    retryCount: task.retryCount
});
```

---

## 15. 数据库 Schema 说明

### 15.1 完整 Schema:

```sql
CREATE TABLE IF NOT EXISTS scheduled_messages (
    id SERIAL PRIMARY KEY,

    -- 用户标识（用于加密密钥派生和数据隔离）
    user_id VARCHAR(255) NOT NULL,

    -- 跨设备查询标识符
    uuid VARCHAR(36),  -- UUID v4 格式，可选，用于跨设备查询和管理

    -- 🔐 核心：全字段加密存储
    -- 包含所有敏感数据：contactName, avatarUrl, messageSubtype, userMessage,
    -- recurrenceType, apiUrl, apiKey, primaryModel, completePrompt, 
    -- pushSubscription, metadata
    encrypted_payload TEXT NOT NULL,

    -- 📌 索引字段（明文，用于查询优化）
    message_type VARCHAR(50) NOT NULL CHECK (message_type IN ('fixed', 'prompted', 'auto', 'instant')),
    next_send_at TIMESTAMP WITH TIME ZONE NOT NULL,

    -- 状态管理
    status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    retry_count INTEGER DEFAULT 0,

    -- 时间戳
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 主查询索引（用于 Cron Job 查找待处理任务）
CREATE INDEX idx_pending_tasks_optimized
ON scheduled_messages (status, next_send_at, id, retry_count)
WHERE status = 'pending';

-- 清理查询索引（用于定期清理已完成或失败的任务）
CREATE INDEX idx_cleanup_completed
ON scheduled_messages (status, updated_at)
WHERE status IN ('sent', 'failed');

-- 失败重试索引（用于查找需要重试的失败任务）
CREATE INDEX idx_failed_retry
ON scheduled_messages (status, retry_count, next_send_at)
WHERE status = 'failed' AND retry_count < 3;

-- 用户任务查询索引（用于查询特定用户的所有任务）
CREATE INDEX idx_user_id ON scheduled_messages (user_id);

-- UUID 唯一索引（防止重复 UUID）
CREATE UNIQUE INDEX uidx_uuid
ON scheduled_messages (uuid)
WHERE uuid IS NOT NULL;
```

### 15.2 全字段加密架构说明

**核心设计**：所有敏感数据统一存储在 `encrypted_payload` 字段中，仅保留少量索引字段用于查询优化。

**明文索引字段**（用于查询）：
- `user_id`: 用户标识
- `uuid`: 跨设备查询标识符
- `message_type`: 消息类型（`fixed`, `prompted`, `auto`, `instant`）
- `next_send_at`: 下次发送时间
- `status`: 任务状态
- `retry_count`: 重试次数

**加密字段**（存储在 `encrypted_payload` 中的 JSON 对象）：
```json
{
  "contactName": "角色名称",
  "avatarUrl": "头像URL",
  "messageSubtype": "chat/forum/moment",
  "userMessage": "固定消息内容（仅 fixed 类型）",
  "recurrenceType": "none/daily/weekly",
  "apiUrl": "AI API 地址",
  "apiKey": "AI API 密钥",
  "primaryModel": "AI 模型名称",
  "completePrompt": "完整 prompt",
  "pushSubscription": { /* 推送订阅对象 */ },
  "metadata": { /* 自定义元数据 */ }
}
```

### 15.3 加密实现细节

**加密方法**：
- 算法：AES-256-GCM
- 格式：`iv:authTag:encryptedData`（十六进制编码）
- 密钥：用户专属密钥（通过 `SHA256(masterKey + userId)` 派生）

**存储流程**：
1. 客户端发送加密的请求体到 API
2. 服务器解密请求体，验证参数
3. 将完整的业务数据对象序列化为 JSON
4. 使用用户专属密钥加密整个 JSON 字符串
5. 存储加密后的字符串到 `encrypted_payload` 字段

**查询流程**：
1. 查询数据库时只返回索引字段 + `encrypted_payload`
2. 派生用户专属密钥
3. 解密 `encrypted_payload` 获取完整数据
4. 组装响应并返回给客户端

**安全优势**：
- 在仅泄露 `scheduled_messages` 且主密钥未泄露时，敏感字段仍为密文
- 用户间数据隔离（每个用户独立密钥）
- 查询性能优化（索引字段为明文）
- 若主密钥或数据库凭据泄露，所有用户数据都可能受影响（需由接入方承担该风险）

详细加密实现参见 §6.2 节。

---

## 16. 变更日志

### v1.2.2 (2026-02-23)

#### 改进优化

- 客户端密钥获取端点统一为 `GET /api/v1/get-user-key`
- 客户端不再接收 `masterKey`，改为直接接收 `userKey`
- 新增 `POST /api/v1/init-master-key`（一次性初始化主密钥）
- 文档示例、测试清单与部署说明已同步到 `userKey` 方案

---

### v1.1.0 (2025-11-05)

#### 新增功能

**instant 即时消息类型**
- 新增 `instant` 消息类型，创建后立即发送，无需等待 cronjob 触发
- 用途：在发送消息后可以退出后台，就算被杀后台也不会中断请求，优化用户体验
- 支持固定消息和 AI 生成消息，走完整的 active message 流程（加密、分句、推送通知）
- `recurrenceType` 固定为 `none`，发送完成后任务自动删除
- 返回响应包含 `messagesSent`、`sentAt`、`retriesUsed` 字段

**全字段加密架构**
- 所有敏感字段统一加密存储到 `encrypted_payload` 字段
- 仅保留索引字段为明文：`message_type`, `next_send_at`, `status`, `retry_count`
- 数据库表结构从 16 列优化为 10 列

**统一消息处理模块**
- 新增 `lib/message-processor.js`，提供 `processSingleMessage()` 和 `processMessagesByUuid()` 函数
- 统一处理固定消息和 AI 消息的发送逻辑
- 支持消息分句（按句号、问号、感叹号分割）和批量推送（消息间延迟 1.5 秒）

#### 改进优化

- 数据库索引优化：移除已加密字段（`contact_name`）的索引
- API 端点支持全字段加密的存储和解密返回
- 初始化脚本增强：添加关键列存在性验证
- 所有示例代码版本标识更新为 v1.1.0

#### 破坏性变更

- 数据库 Schema 变更：需要将旧表的 16 个字段合并加密为 `encrypted_payload`
- instant 类型的响应格式与普通类型不同（包含 `messagesSent`、`sentAt` 等字段）

---

### v1.0.0 (2025-10-13) - 初始版本

**API 设计**:
- 定义核心 API 端点：`schedule-message`、`send-notifications`
- 定义进阶 API 端点：`update-message`、`cancel-message`
- 定义扩展 API 端点：`messages`（查询）
- 定义请求/响应格式、错误处理、认证方式

**消息类型统一**:
- 将 `guided` 重命名为 `prompted`（更清晰的语义）
- 统一 `prompted` 和 `auto` 都使用 `completePrompt`
- 简化 API：移除 `useCompletePrompt` 字段，通过 `messageType` 判断
- 移除 `userPrompt` 字段，统一使用前端构建的 `completePrompt`

**认证与授权体系**:
- **简化认证**：使用客户端生成的 UUID 作为 User ID（存储在 localStorage）
- **用户隔离**：确保用户只能操作自己的任务（通过 `user_id` 字段过滤）
- **权限验证逻辑**：详细定义创建/查询/更新/删除任务的权限检查
- 新增请求头：`X-User-Id`（用户唯一标识符）
- 新增错误代码：`USER_ID_REQUIRED`、`INVALID_USER_ID_FORMAT` 等
- 客户端 User ID 管理最佳实践（localStorage 存储、自动生成）

**端到端加密（重要安全特性）**:
- **强制要求**对所有请求体进行 AES-256-GCM 加密
- **用户密钥隔离**：每个用户使用独立的加密密钥，通过 `SHA256(masterKey + userId)` 派生
- **客户端密钥存储**：用户专属密钥存储在 IndexedDB 加密表中（持久化）
- **最小服务器负担**：服务器仅做一次 SHA-256 计算（< 1ms），Serverless 理念
- 定义完整的加密/解密实现流程（客户端 IndexedDB + 服务器端动态派生）
- 新增 API 端点：`GET /api/v1/get-user-key`（用户密钥分发）
- 新增加密相关请求头：`X-Payload-Encrypted`、`X-Encryption-Version`、`X-User-Id`
- 新增加密相关错误代码：`ENCRYPTION_REQUIRED`、`USER_ID_REQUIRED`、`DECRYPTION_FAILED` 等
- 要求数据库敏感字段加密存储（API Key、Prompt、用户消息等）
- 详细说明 Base64 编码的必要性和优势
- 防止重放攻击：用户 A 无法解密用户 B 的数据

**标准定义**:
- 定义推送通知负载标准
- 定义消息分句规则和发送时序
- 定义扩展字段：`avatarUrl`、`uuid`、`messageSubtype`、`metadata`
- 定义性能优化建议和部署要求
- 定义安全规范和测试清单

**安全增强**:
- 端到端加密保护所有敏感数据传输
- 双重安全：HTTPS + 请求体加密
- 防止中间人攻击、数据篡改和未授权访问

---

## 17. 附录

### 17.1 API 请求示例

以下示例展示关键 API 端点的请求格式（加密请求体已略）：

```bash
# 初始化主密钥（仅首次成功返回 masterKey）
curl -X POST "https://your-domain.com/api/v1/init-master-key"

# 获取用户专属密钥（客户端初始化时调用）
curl -X GET "https://your-domain.com/api/v1/get-user-key" \
  -H "X-User-Id: 550e8400-e29b-41d4-a716-446655440000"

# 创建定时任务（加密）
curl -X POST "https://your-domain.com/api/v1/schedule-message" \
  -H "Content-Type: application/json" \
  -H "X-Payload-Encrypted: true" \
  -H "X-Encryption-Version: 1" \
  -H "X-User-Id: 550e8400-e29b-41d4-a716-446655440000" \
  -d '{"iv": "...", "authTag": "...", "encryptedData": "..."}'

# Cron 触发通知
curl -X POST "https://your-domain.com/api/v1/send-notifications" \
  -H "Authorization: Bearer YOUR_CRON_SECRET"

# 查询任务列表
curl -X GET "https://your-domain.com/api/v1/messages?status=pending" \
  -H "X-User-Id: 550e8400-e29b-41d4-a716-446655440000"
```

> **完整示例和部署指导**：请参考 [examples/README.md](../examples/README.md)

### 17.2 相关资源

#### 项目文档

- **Service Worker 规范**: [service-worker-specification.md](./service-worker-specification.md) - 前端推送通知实现
- **部署指南**: [examples/README.md](../examples/README.md) - API 快速部署教程
- **本地测试**: [docs/TEST_README.md](../docs/TEST_README.md) - 开发环境测试脚本
- **生产测试**: [docs/VERCEL_TEST_DEPLOY.md](../docs/VERCEL_TEST_DEPLOY.md) - 持续监控部署

#### 外部资源

- **VAPID 密钥生成**: https://vapidkeys.com
- **Web Push Protocol**: https://datatracker.ietf.org/doc/html/rfc8030
- **Service Worker API**: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
- **Push API**: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- **IndexedDB**: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API

---

## 18. 许可与贡献

### 18.1 许可证

本标准文档采用 **CC BY-NC-SA 4.0**（Creative Commons 署名-非商业性使用-相同方式共享）协议发布。

### 18.2 贡献指南

欢迎对本标准提出改进建议：

1. 提交 Issue 描述问题或改进建议
2. Fork 仓库并创建 Pull Request
3. 遵循现有的文档格式和结构
4. 清晰描述变更的原因和影响

或在 QQ 群内提出相关建议。

### 18.3 致谢

本标准基于 Whale小手机 团队的主动消息实现经验总结而成。发起人为 TO，在此感谢所有在此期间提供建议意见，以及支持本标准推进、积极落实本标准的各位老师。截至发布，共有 汤圆、脆脆机、koko、糯米机（排名不分先后）四位老师的参与，特别感谢几位老师！
