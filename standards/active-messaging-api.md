# 主动消息 API 技术规范（v2.4）

> 状态：当前生效（Active）
>
> 版本日期：2026-05-19
>
> 对齐实现（**prerelease**，仓库 `publish-workspaces.mjs` 自动按 prerelease 版本号路由到 `next` dist-tag，不进 `latest`）：`@rei-standard/amsg-shared` 0.1.0-next.0、`@rei-standard/amsg-server` 2.4.0-next.0、`@rei-standard/amsg-instant` 0.8.0-next.0、`@rei-standard/amsg-client` 2.3.0-next.0、`@rei-standard/amsg-sw` 2.1.0-next.0。安装：`npm install @rei-standard/amsg-shared@next`（其余同理）。规范条款在 prerelease 期不再改，`next` 窗口是给下游集成方端到端验证用的；契约通过后会发对应正式 minor（去掉 `-next.N` 后缀）。
>
> 本轮是一次跨包协调的 minor 升级：push wire shape 统一到 `@rei-standard/amsg-shared` 的 `AmsgPush` 判别联合（以 `messageKind` 为字面量类型判别器），同时移除旧的 `{ type: 'error', code: '...' }` 错误信封。包间依赖一律使用精确版本（不带 `^`），所有 `dependencies` 字段都钉死在对应的 `*-next.0`。

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
6. 推荐在 Netlify 使用 Scheduled Function 触发调度聚合端点，再按租户触发后台发送；同时保留外部 cron 兼容模式。

**v2.x 后续增量**（端点与鉴权未变，均为 payload 层向后兼容扩展）：

- `messages` 数组提示词（互斥替代 `completePrompt`），见 §6.1。`amsg-server` 2.2.0+ 与 `amsg-instant` 0.5.0+ 实装。
- `splitPattern` 自定义分句正则，见 §6.1。`amsg-server` 2.3.0+ 与 `amsg-instant` 0.6.0+ 实装。
- `avatarUrl` 软清空策略（不合法值仅 `console.warn` 并置空，不再 400 整个任务），见 §6.2。`amsg-server` 2.3.3+ / 2.4.0-next.1+、`amsg-instant` 0.7.1+ / 0.8.0-next.1+、`amsg-client` 2.2.4+ / 2.3.0-next.1+ 实装；2.3.1 ~ 2.3.2 / 0.6.1 ~ 0.7.0 / 2.2.3 ~ 2.3.0-next.0 走老版"严格 400"。
- **三轴 push schema 统一**（`messageKind` 判别联合 + 自动 `ReasoningPush`），见 §6.3 / §6.4。`@rei-standard/amsg-shared` 0.1.0-next.0、`amsg-server` 2.4.0-next.0、`amsg-instant` 0.8.0-next.0、`amsg-sw` 2.1.0-next.0、`amsg-client` 2.3.0-next.0 协同实装（`next` dist-tag 预发布）。旧 `{ type: 'error', code: '...' }` 错误信封同步移除。

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

> 规范强制要求：**每个 tenant 必须使用独立的 `databaseUrl`（独立数据库 URL）**。  
> 不允许多个 tenant 共享同一个数据库 URL，否则会导致租户数据串扰、任务误处理等不可预料错误。

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

### 5.2 Cron 调用（兼容模式）

`POST /api/v1/send-notifications` 支持两种方式：

1. Header：`Authorization: Bearer <cronToken>`
2. Query：`/api/v1/send-notifications?token=<cronToken>`

### 5.3 Netlify Scheduled Function（推荐模式）

在 Netlify 平台，推荐使用 Scheduled Function 每分钟触发一次聚合调度，再按租户触发后台发送。

Scheduled Function 示例：

```ts
export const config = {
  schedule: '* * * * *'
};
```

推荐流程：

1. Scheduled Function 触发 `/api/v1/send-notifications-scheduled`。
2. `send-notifications-scheduled` 读取 Blob 租户索引（见 8.2）。
3. 循环触发后台发送端点（推荐复用 `/api/v1/send-notifications?token=...`，也可实现为 `background` 别名端点）。

说明：

- 该模式是推荐实现，不替代第 5.2 节 cron 兼容模式。
- 若同时启用两种模式，必须确保不会重复发送（例如仅保留一个入口，或做幂等保护）。

### 5.4 双轨兼容策略（可同时启用）

兼容模式（外部 cron）与推荐模式（Netlify Scheduled）允许同时存在，推荐按“主备”设计：

1. 主路径：`send-notifications-scheduled`。
2. 备路径：外部 cron 直接调用 `send-notifications`（仅故障切换时启用）。

若同时常态启用两条路径，必须满足至少一项：

- 调度入口互斥（分布式锁或单实例保证）。
- 数据库侧领取任务时使用原子“claim”语义，避免同一任务被并发处理。

### 5.5 失败响应

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
| `POST` | `/api/v1/send-notifications-scheduled` | 每分钟聚合调度（推荐，可选） | 平台内部调度调用 |

### 6.1 AI 消息字段约束

当消息使用 AI（`messageType=prompted/auto`，或 `instant` 提供完整 AI 配置）时，下述字段约束统一适用于 `schedule-message`、`update-message`、`amsg-instant` handler。

**`apiUrl`（必填，字符串）** — 完整聊天端点 URL（例：`https://api.openai.com/v1/chat/completions`）。实现方可做最小规范化（去首尾空白、去路径尾部多余 `/`），但**不应**自动补全版本路径（`/v1`）或聊天路径（`/chat/completions`）。若上游返回 `405 Method Not Allowed`，应优先判定为 URL 指向错误端点。

**`completePrompt` 与 `messages`（互斥二选一）**

- `completePrompt?: string` — 简单场景。handler 内部包成单条 `{ role: 'user', content }` 再发给 LLM。
- `messages?: Array<{ role: 'system' | 'user' | 'assistant' | 'tool', content: string | unknown[] }>` — 多轮、带 system role 或 tool role 的场景。handler **原样**转发给 LLM，不做注入或重排；与主聊天路径调用 LLM 的 body 字节级一致。

约束：两者**必须恰好提供一个**。同时提供或都未提供 → `400 INVALID_PARAMETERS`（`amsg-server`）或 `400 INVALID_PAYLOAD_FORMAT`（`amsg-instant`）。`messages` 数组必须非空，role 必须是上述四种之一。

**`temperature`（可选数字）** — 透传给 LLM。`completePrompt` 路径未传时默认 `0.8`（保留旧行为）；`messages` 路径未传时不发，由上游主路径决定。

**`maxTokens`（可选正整数）** — 映射到上游 `max_tokens`；不传则不指定。

**`splitPattern`（可选，`string | string[] | null`）** — 自定义 LLM 返回文本的分句正则；默认 `/([。！？!?]+)/`。

字段写的是**正则 source 字符串**，不带 `/.../` 包裹、不带尾部 flag。库内部 `new RegExp(source)` 编译，**零 flags**。要替代常用 flag 效果请改写 pattern 本身：

| 想要的 flag | 写法 |
|---|---|
| `i` 大小写不敏感 | 用字符类，如 `[Aa]` |
| `s` 点匹配换行 | 用 `[\s\S]` 代替 `.` |
| `m` 多行 `^` / `$` | 用 `(?:^|\n)` / `(?:$|\n)` |
| `g` 全局 | 不需要，`String.prototype.split(regex)` 不依赖 `g` |

输入形态：

- `string` → 单条 pattern，替代默认正则。
- `string[]` → **级联**应用：先按数组首项切，每段再按下一项切，以此类推（适合"先按段落、再按句号"两步切）。要"任一匹配就切"请自行用 `|` 合成一条。
- 不传 / `null` / `[]` → 走默认，老库存任务无此字段时零迁移。
- `update-message` 显式传 `splitPattern: null` 可重置回默认；不传则保留原值。

**捕获组约定**：分隔符要不要保留是你定的。把分隔符放进 `(...)` 捕获组 → 回贴到前一段（默认 `/([。！？!?]+)/` 就是这么做的）；不放捕获组 → 分隔符被丢掉。库不会替你自动包。

**级联中的 no-match 兜底**：某一项 pattern 在某段上没匹配 → 该段原样传给下一项，不会被吃掉。

**输入大小限制**：每项 ≤ 200 字符、数组 ≤ 10 项、每项必须能 `new RegExp(...)` 通过。违规 → `400 INVALID_PARAMETERS`（schedule）/ `400 INVALID_UPDATE_DATA`（update）/ `400 INVALID_PAYLOAD_FORMAT`（amsg-instant）。

> 这些上限是**输入大小护栏**，不是 ReDoS 防御——6 字符的 `(a+)+$` 就能触发回溯爆炸。真正兜底的是 Worker / 运行时的 CPU 限额，加上 splitPattern 存在调用方自己的加密任务里、跑在调用方自己 LLM key 的输出上，自爆不跨租户。

`amsg-server` 与 `amsg-instant` 两端独立实现但行为字节级一致；预校验工具：`validateLlmMessagesArray(messages)`、`validateSplitPattern(value)`。

### 6.2 `avatarUrl` 软清空策略

`avatarUrl` 字段（`schedule-message` / `update-message` / `amsg-instant` payload，可选）的合法规则：

- 必须是字符串，且 `new URL(...)` 能解析。
- **不接受** `data:` 开头的 URI（不区分大小写）—— base64 内嵌图片会把 push payload 撑到几十 KB，触发下游 Web Push 4KB 硬上限或网关 `413 Payload Too Large`。
- **不接受** 长度 > 2048 字符的 URL。
- `undefined` / `null` 视为"未传"，零行为变化。

**处理方式（amsg-server 2.3.3+ / 2.4.0-next.1+，amsg-instant 0.7.1+ / 0.8.0-next.1+，amsg-client 2.2.4+ / 2.3.0-next.1+）**：头像是装饰性字段，单独一个不合法 URL 不应该把整条推送 fail 掉。所以服务端 / 客户端遇到上面任何不合法情形，**不返回 4xx**，而是：

1. 把 `avatarUrl` 在 payload 上**置为 `null`**（schedule / instant 路径）；`update-message` 路径则**从 patch 里删掉**该字段，已存储的旧头像保持不变。
2. 在控制台 `console.warn` 出原因（含建议，如"请改为公网可访问的 https:// 图片 URL"）。
3. 继续处理 payload 其它字段。

老版本（`amsg-server` 2.3.1 ~ 2.3.2 / 2.4.0-next.0、`amsg-instant` 0.6.1 ~ 0.7.0 / 0.8.0-next.0、`amsg-client` 2.2.3 / 2.3.0-next.0）走严格 400：
- `amsg-server.schedule-message` → `400 INVALID_PARAMETERS`
- `amsg-server.update-message` → `400 INVALID_UPDATE_DATA`
- `amsg-instant` → `400 INVALID_PAYLOAD_FORMAT`
- `amsg-client` 本地预校验抛 `Error` 的 `.code === 'INVALID_AVATAR_URL_LOCAL'`（2.2.4+ 已移除，改为本地 `console.warn` + 置空）。

预校验工具：`validateAvatarUrl(value)`（`amsg-server` 与 `amsg-instant` 同步导出）—— 返回错误描述字符串或 `null`，**纯函数**，不副作用；上层调用方按软清空策略处理。

### 6.3 推送 wire shape：三轴判别联合

自 v2.4 起，所有 amsg 包推出的 Web Push payload 统一遵循 `@rei-standard/amsg-shared` 定义的 `AmsgPush` 判别联合。每条推送由三个**正交**的维度描述：

| 轴 | 字段 | 取值 | 由谁定 |
|---|---|---|---|
| Dispatch | `messageType` | `instant` / `fixed` / `prompted` / `auto` | 包（固定枚举） |
| Business | `messageSubtype` | 任意字符串 | 调用方（自由命名） |
| Content | `messageKind` | `content` / `reasoning` / `tool_request` / `error` | 包（固定枚举） |

外加 `source: 'instant' | 'scheduled'` —— 路由来源（`amsg-instant` 输出恒为 `'instant'`；`amsg-server` 任何输出恒为 `'scheduled'`）。`messageType: 'instant'` 必配 `source: 'instant'`；其余三种 `messageType` 必配 `source: 'scheduled'`。

`messageKind` 是**字面量类型判别器**：TS 端 `switch (push.messageKind)` 即可窄化到具体子类型；JS 端用 `isContentPush` / `isReasoningPush` / `isToolRequestPush` / `isErrorPush` 守卫函数。

#### 6.3.1 所有 push 共有字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `messageKind` | `'content' \| 'reasoning' \| 'tool_request' \| 'error'` | 判别器 |
| `messageType` | `'instant' \| 'fixed' \| 'prompted' \| 'auto'` | Dispatch 轴 |
| `source` | `'instant' \| 'scheduled'` | 路由来源 |
| `messageId` | `string` | 每条推送唯一，格式由 producer 自定 |
| `sessionId` | `string` | **同一 LLM 轮次内共享**（含自动发出的 ReasoningPush + 后续 ContentPush burst）；agentic-loop 跨 iteration 复用同一 id |
| `timestamp` | `string` (ISO 8601) | producer 端时钟 |
| `messageSubtype` | `string?` | 业务命名空间，producer 默认填 `'chat'` |
| `metadata` | `object?` | **调用方透传**；包不得写入此字段 |

#### 6.3.2 `ContentPush`（`messageKind: 'content'`）

最终面向用户的文本片段。

| 字段 | 类型 | 说明 |
|---|---|---|
| `message` | `string` | 要展示的句子/段落 |
| `messageIndex` | `number?` | 1-based 段索引，单条不带 |
| `totalMessages` | `number?` | 总段数，单条不带 |
| `title` | `string?` | 通知标题 |
| `contactName` | `string?` | 发送者显示名 |
| `avatarUrl` | `string \| null?` | 仅 `https:`，`data:` 入口拦截 |
| `taskId` | `string \| null?` | 调度任务 ID（仅 server 路径） |

#### 6.3.3 `ReasoningPush`（`messageKind: 'reasoning'`）

LLM 思考过程，从 `choices[0].message.reasoning_content` 提升而来。

| 字段 | 类型 | 说明 |
|---|---|---|
| `reasoningContent` | `string` | 推理文本 |
| `title` | `string?` | |
| `contactName` | `string?` | |
| `avatarUrl` | `string \| null?` | |

**不带** `messageIndex` / `totalMessages` —— 推理是一轮 LLM 一条，不是分句 burst。这两个字段在类型上故意缺席。

#### 6.3.4 `ToolRequestPush`（`messageKind: 'tool_request'`）

由 agentic-loop 钩子返回 `{ decision: 'tool-request', pushPayload }` 触发。

| 字段 | 类型 | 说明 |
|---|---|---|
| `toolCalls` | `Array<object>` | OpenAI `choices[0].message.tool_calls` 形状透传 |
| `title` | `string?` | |
| `contactName` | `string?` | |
| `message` | `string?` | 可选人类可读标签 |

客户端执行工具后通过 `/continue` 恢复。

#### 6.3.5 `ErrorPush`（`messageKind: 'error'`）

生产端诊断错误。

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | `string` | producer 定义的稳定码，例如 `HOOK_THREW` / `LOOP_EXCEEDED` |
| `message` | `string` | 人类可读描述 |
| `iteration` | `number?` | agentic-loop 迭代序号（如适用） |

**v2.4 移除：旧的 `{ type: 'error', code: '...' }` 错误信封**（0.7.x `amsg-instant` 用于 `HOOK_THREW` / `LOOP_EXCEEDED`）已删除。错误推送统一走 `ErrorPush` 形状，顶层不再有 `type: 'error'` 字段——不要在新代码里找这个字段。

完整字段表、builders、类型守卫与常量见 [`../packages/rei-standard-amsg/shared/README.md`](../packages/rei-standard-amsg/shared/README.md)。

### 6.4 `ReasoningPush` 自动发出不变量

LLM 驱动路径（`amsg-instant` 的 legacy 路径与 agentic-loop 钩子路径、`amsg-server` 的 `prompted` / `auto` 路径、`amsg-server` 的 in-server `instant` 路径）在 LLM 返回 `choices[0].message.reasoning_content` 非空时，必须**先**发一条独立的 `ReasoningPush`，**再**发后续的 `ContentPush` burst。两者共享同一个 `sessionId`，客户端可以靠 `sessionId` 把"思考中"UI 拼到真正回复上。

具体规则：

1. **触发条件**：`choices[0].message.reasoning_content` 是非空字符串。空串、`null`、`undefined` 均不触发。
2. **顺序**：`ReasoningPush` 必须先于该 LLM 轮的任何 `ContentPush` 发出（client 端可据此切换"思考中" UI）。
3. **`sessionId` 共享**：
   - 同一 LLM 轮：`ReasoningPush` + 该轮所有 `ContentPush` 共用一个 `sessionId`。
   - Agentic loop：同一 `/instant` 请求的所有 iteration 共用一个 `sessionId`（不是每轮重新 mint）。
   - `amsg-server` 端：调度行用 `sess_task_<task.id>`（跨重试稳定）；无 task id 时 mint `sess_<uuid>`。
4. **钩子路径 opt-out**：`amsg-instant` 的 `createInstantHandler({ autoEmitReasoning: false })` 让钩子作者拿回完整控制权——此时框架不发自动 ReasoningPush，钩子自行读 `ctx.llmResponse.choices[0].message.reasoning_content` 并用 `buildReasoningPush(...)` 自建。legacy（非钩子）路径**始终**自动发，无 opt-out。
5. **非 LLM 路径不触发**：`fixed` 任务与 `userMessage` 显式路径不产 LLM 响应，自然不发 ReasoningPush。
6. **`messageIndex` / `totalMessages` 不带**：ReasoningPush 不参与分句 burst 计数；server 端的 `messagesSent` 也只数 ContentPush。

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

### 8.2 Blob（租户调度索引，推荐）

当实现第 5.3 节推荐模式时，`init-tenant` 完成后应同步写入租户调度索引。

索引最小字段：

- `tenantId`
- `cronToken`
- `updatedAt`

要求：

- `cronToken` 在索引中不得明文存储，必须与租户配置相同级别加密后再入 Blob。
- `tenantId` 与 `cronToken` 必须同源（同一次租户初始化签发），避免索引错配。
- `send-notifications-scheduled` 读取索引后，应按 `tenantId` 循环触发后台发送，并记录失败租户用于重试。

### 8.3 数据库（业务任务）

数据库仅存业务任务表（如 `scheduled_messages`）。

- 不再保存 `system_config`。
- 不再在数据库持久化 masterKey。
- 每个 tenant 必须绑定独立数据库 URL，禁止复用同一连接串。

## 9. 错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | `INVALID_JSON` | 请求体 JSON 不合法 |
| 400 | `INVALID_PARAMETERS` | 参数缺失或格式非法（`schedule-message` 与 `init-tenant` 路径） |
| 400 | `INVALID_UPDATE_DATA` | `update-message` 字段非法（含 §6.1 / §6.2 校验） |
| 400 | `INVALID_PAYLOAD_FORMAT` | `amsg-instant` payload 格式非法（含 §6.1 / §6.2 校验） |
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

1. 调用 `POST /api/v1/init-tenant` 提交 `databaseUrl`（必须是该 tenant 独占的数据库 URL）。
2. 保存返回的 `tenantToken`、`cronWebhookUrl`。
3. 支持三种接入方式：
   - 仅兼容模式：将 `cronWebhookUrl` 粘贴到外部 cron 平台。
   - 仅推荐模式：由 `init-tenant` 同步写入 Blob 租户调度索引。
   - 双轨兼容（主备）：两者同时配置，但需满足第 5.4 节防重入要求。

### 10.3 日常调用流程

1. 前端调用业务端点时自动携带 `tenantToken`。
2. 调度触发可单轨或双轨：
   - 兼容模式：外部 cron 周期调用 `send-notifications`。
   - 推荐模式：Netlify Scheduled Function 每分钟调用 `send-notifications-scheduled`，后者循环触发后台发送。
   - 双轨兼容：两条路径同时保留，按第 5.4 节做互斥/幂等。

## 11. 向后兼容声明

v2.0.1（破坏性）：

- 旧初始化端点已移除。
- 旧 `CRON_SECRET` 方案不再作为标准鉴权方案。
- 旧文档中关于 `system_config` 的描述全部失效。
- 调度层新增"推荐模式"不影响旧 cron 兼容模式，旧 cron 接入仍可继续使用。

v2.x 后续增量（向后兼容，无需迁移）：

- `messages` 数组（2.2.0+）：未使用此字段的调用方零修改。
- `splitPattern`（2.3.0+）：未传时走默认正则，老库存任务字段缺失也按默认处理。
- `avatarUrl` 严格校验（2.3.1 ~ 2.3.2）：之前传 `data:` URI 当 avatarUrl 实际上一直推不出来（触发下游 4KB / 413），收紧到入口立即报错而已；从未推成功的调用者无感升级。
- `avatarUrl` 软清空（server 2.3.3+ / 2.4.0-next.1+，instant 0.7.1+ / 0.8.0-next.1+，client 2.2.4+ / 2.3.0-next.1+）：把"严格 400"放宽为"`console.warn` + 置空 + 继续"。整条推送不再因为一个装饰性字段挂掉；之前依赖 400 报错的调用方只需改成观察 `console.warn`。详见 §6.2。

## 12. 实现一致性要求（DoD）

实现方需满足以下条件：

1. 租户初始化为一步（`init-tenant`）。
2. 业务端点不可仅依赖 `X-User-Id` 调用成功。
3. `tenantToken` 与 `cronToken` 权限分离。
4. `amsg-server` 与 `amsg-instant` 在共有字段（§6.1 / §6.2）上行为字节级一致。`examples/` 是教学示例，可能滞后于最新 SDK 字段，不在一致性约束内。
5. 文档明确管理员一次性与租户一次性职责。
6. 若实现推荐调度模式，必须实现 Blob 租户调度索引，并对索引中的 `cronToken` 加密存储。
7. 若同时启用兼容模式与推荐模式，必须实现调度防重入机制（入口互斥或任务原子领取）。
