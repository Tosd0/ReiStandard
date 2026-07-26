# @rei-standard/amsg-server

`@rei-standard/amsg-server` 是 ReiStandard 主动消息标准的服务端 SDK：Blob 租户配置、`tenantToken` / `cronToken` 鉴权、标准路由处理器。API 规范见 [API 技术规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)。

## v2.0.1 变更摘要

- 初始化流程合并为 `POST /api/v1/init-tenant`
- 移除旧端点：`init-database`、`init-master-key`
- 业务端点统一使用 `Authorization: Bearer <tenantToken>`
- `send-notifications` 支持 `cronToken`（Header 或 query token）

2.2+ 的字段增量（`messages` 数组、`splitPattern`、`avatarUrl` 软清空策略）在规范的 [§6.1](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md#61-ai-消息字段约束) / [§6.2](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md#62-avatarurl-软清空策略)。其中 `splitPattern` 是 server 调度任务的持久化配置；`amsg-instant` 0.8.0 起改为 hook 内自定义 split 函数 + `pushPayloads`。

## 安装

```bash
npm install @rei-standard/amsg-server web-push @netlify/blobs

# 数据库驱动二选一
npm install @neondatabase/serverless
# 或
npm install pg
```

## 快速使用

```js
import { createReiServer } from '@rei-standard/amsg-server';

const rei = await createReiServer({
  vapid: {
    email: process.env.VAPID_EMAIL,
    publicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY
  },
  tenant: {
    blobNamespace: 'rei-tenants',
    kek: process.env.TENANT_CONFIG_KEK,
    tokenSigningKey: process.env.TENANT_TOKEN_SIGNING_KEY,
    initSecret: process.env.INIT_SECRET,
    publicBaseUrl: process.env.PUBLIC_BASE_URL
  }
});

// 映射路由
// POST /api/v1/init-tenant          -> rei.handlers.initTenant.POST
// GET  /api/v1/get-user-key         -> rei.handlers.getUserKey.GET
// POST /api/v1/schedule-message     -> rei.handlers.scheduleMessage.POST
// POST /api/v1/send-notifications   -> rei.handlers.sendNotifications.POST
// PUT  /api/v1/update-message       -> rei.handlers.updateMessage.PUT
// DELETE /api/v1/cancel-message     -> rei.handlers.cancelMessage.DELETE
// GET  /api/v1/messages             -> rei.handlers.messages.GET
```

## 关于 `messageType: 'instant'`

> **两条 instant 路径，按各自特点选一条（都是正式支持路径）：**
> - **本端点的 `messageType: 'instant'`**（create task → process by UUID → delete task）：任务先写进数据库再处理，投递不绑在请求连接上——客户端断开也没关系，任务行还在，能继续跑、能重试，想跑多久跑多久。适合**有数据库、需要长时间生成或保证消息零丢失**的场景。
> - **[@rei-standard/amsg-instant](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/instant/README.md)**：纯 SSE 流 + Web Push backup，不需要数据库，适合无状态边缘运行时（如 Cloudflare Workers）。它的处理挂在响应连接上，客户端一断开就只剩平台给的那点宽限期把活干完（Deno Deploy 实测 ≈20-30s），所以适合**能快速跑完的短即时消息**。

## AI 接口 `apiUrl` 约束

当 `messageType` 为 `prompted` / `auto`，或 `instant` 使用 AI 配置时：

- `apiUrl` 是聊天端点 URL（例如：`https://api.openai.com/v1/chat/completions`），必须能 `new URL(...)` 解析。
- SDK 对 OpenAI 风格路径做**幂等**补全（去首尾空白、去尾部多余 `/` 后）：

  | 输入 | 输出 |
  |---|---|
  | `https://api.openai.com`（裸域名） | `https://api.openai.com/v1/chat/completions` |
  | `https://api.openai.com/v1`（版本段结尾） | `https://api.openai.com/v1/chat/completions`（不重复加 `/v1`） |
  | `https://api.openai.com/v1/chat/completions` | 原样返回 |
  | `https://api.anthropic.com/v1/messages`（其他自定义路径） | 原样返回，不猜 |

- 规则幂等，传完整 URL 不会被改坏；代理路径很特殊时直接传完整 `…/chat/completions` 绕开补全。
- `maxTokens` 为可选字段：传了就映射为 `max_tokens`；不传则不指定（由上游模型默认策略决定）。

如果上游返回 `405 Method Not Allowed`，通常表示 `apiUrl` 指向了基础域名而非聊天端点，请优先检查配置值。

## 提示词字段（`completePrompt` vs `messages`，2.2.0+）

AI 配置消息的提示词可以用两种形态之一，**互斥二选一**：

- `completePrompt: string` —— 简单场景：内部包成单条 `{role:'user', content}` 后发给 LLM。
- `messages: Array<{ role: 'system'|'user'|'assistant'|'tool', content: string | unknown[] }>` —— 多轮 / 带 system role：**原样**转发给 LLM，不做任何 role 注入或重排。和上游主聊天路径调用 LLM 的 body 字节级一致。

两个字段同时给 → `400 INVALID_PARAMETERS`；都不给且没 `userMessage`（仅 instant 类型允许 fallback）也是 400。`messages` 数组必须非空，role 必须是上面四种之一。

可选 `temperature?: number` 透传给 LLM：`completePrompt` 路径未传时默认 0.8（保持旧行为）；`messages` 路径未传时**不发**，让上游主路径自己决定。

## 自定义分句正则 `splitPattern`（server 2.3.0+）

`processSingleMessage` 默认按 `/([。！？!?]+)/` 把 LLM 返回的整段文本切成多条推送（每条间隔 1.5s）。`splitPattern` 让调用方覆盖这个正则：

- `splitPattern: string` —— 单个正则 source（不带 flags）。例：`"([\\n]+)"` 按换行切。
- `splitPattern: string[]` —— **级联**应用：第一个正则切完，每段再用第二个切。例：`["(\\n\\n+)", "([。！？!?]+)"]` 先按段落、再按句号。
- 不传 / `null` / `[]` → 走默认正则，行为字节级与 2.2.x 一致；老库存任务（无此字段）零迁移。

**约定**：

- 传**正则 source**，不要带两边的 `/.../` 也不要带尾部 flag（`/foo/i` 会被当字面量斜杠 + 字面量 `i` 匹配）。需要大小写不敏感请用 `[Aa]` 这种字符类替代。
- 想让分隔符回贴到前一段（与默认行为一致），把分隔符包进 `(...)` 捕获组。库不会自动包——传 `"\\n+"` 而不是 `"(\\n+)"` 会得到首尾相连、分隔符丢失的奇怪结果。
- 数组语义是级联，不是"任一匹配就切"。后者请自己用 `|` 合一条正则。
- 限制：每项 ≤ 200 字符，数组 ≤ 10 项；非法或无法 `new RegExp(...)` 通过 → `400 INVALID_PARAMETERS`（schedule）/ `400 INVALID_UPDATE_DATA`（update）。
- `update-message` 显式传 `splitPattern: null` 可重置回默认；不传则保留原值。

## 一条 Web Push 能塞多少

推送服务（FCM / APNs / Mozilla autopush）限的是**加密后** body 的 4096 字节，超了当场 413 拒收，用户什么也收不到。明文额度要把 aes128gcm 的固定开销减掉——header 86（salt 16 + record size 4 + keyid 长度 1 + 应用服务器公钥 65）+ 填充分隔符 1 + GCM auth tag 16 = 103 字节——所以**一条 push 的 payload 上限是 3993 字节**，按 UTF-8 字节算，不是字符数。

`sendWebPush` 会在发出去之前挡下超限的 payload，抛出 `err.code === 'PUSH_PAYLOAD_TOO_LARGE'` 的错误，消息里带实际字节数和上限。

组 payload 之前想自己做预算，用导出的常量和工具函数，别写死魔法数字：

```js
import { MAX_PUSH_PAYLOAD_BYTES, measurePushPayload } from '@rei-standard/amsg-server';

const { bytes, remainingBytes, withinLimit } = measurePushPayload(JSON.stringify(push));
// remainingBytes = 还能再塞多少字节（已超限时为负）
```

装不下的内容（长文、附件详情）建议走旁路：正文存进 `client_state`，push 里只带一个引用键，客户端上线后用 `GET /client-state` 取回。单用户 Worker 的 fire-time hook 用 `ctx.writeState()` 写，见 [`examples/cloudflare-single-user/README.md`](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/examples/cloudflare-single-user/README.md)。

## 导出（新增）

- `validateLlmMessagesArray(messages)` — 同步预校验 messages 数组，返回 `string | null`（错误信息 / 通过）。和 `@rei-standard/amsg-instant` 的校验规则字节级一致。
- `validateSplitPattern(value)` — 同步预校验 splitPattern（string / string[] / null），返回 `string | null`。
- `MAX_PUSH_PAYLOAD_BYTES` — 一条 push 的明文上限，3993 字节。
- `WEB_PUSH_MAX_BODY_BYTES` / `WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES` — 推送服务的密文 body 上限（4096）与 aes128gcm 固定开销（103），上面那个数就是两者相减。
- `measurePushPayload(payload)` — 量一段 payload 的字节数与剩余额度，返回 `{ bytes, maxBytes, remainingBytes, withinLimit }`。

以上四个在包根和 `@rei-standard/amsg-server/cloudflare` 两个入口都有。

## 一体化初始化流程

1. 管理员配置环境变量（VAPID + tenant secrets）
2. 租户调用 `POST /api/v1/init-tenant` 提交自己的 `databaseUrl`
3. 服务端自动完成：建表 + 生成 masterKey + 写入 Blob + 返回 `tenantToken`/`cronToken`
4. 前端使用 `tenantToken`，cron 使用 `cronToken`

## 端点鉴权

- `get-user-key`、`schedule-message`、`update-message`、`cancel-message`、`messages`
  - `Authorization: Bearer <tenantToken>`
- `send-notifications`
  - `Authorization: Bearer <cronToken>` 或 `?token=<cronToken>`

## 触发任务时的占位

`send-notifications`（以及单用户 Worker 的 `scheduled()`）每条任务开跑前会先占位：在这一行的 `lease_until` 上写下「归我管到现在 + 租期为止」，本次投递期间别的 tick 领不走它；占位改到 0 行说明别人先领走了，本次直接跳过。cron 一分钟一跳而带工具的 AI 任务常常跑过一分钟，没有这层占位同一条任务会被相邻几跳重复触发。

租约写在自己的列上，`next_send_at` 全程不动——任务列表读到的一直是用户设的那个时刻，循环任务也按它推进到下一次。投递收尾时租约就放掉，失败重试的退避（2 分钟起）不会被租期压住。

领了任务的那一跳中途没了（Worker 被回收之类）就没人来放租约，这条任务要等租约到期才会被后面的 tick 接手。把租期设得比最慢的一次投递长一点即可。

租期默认 10 分钟；配了 `totalTimeoutMs` 的话按它 + 2 分钟往上抬。想自己定就在 `runScheduledTick` 的 ctx（或单用户 Worker 的 config）里传 `claimLeaseMs`——注意 `createReiServer` 内置的 `/send-notifications` 处理器不透传这两个值，要调租期就自己调 `runScheduledTick`。`onBeforeFire` 里按次放宽的预算占位时看不到，那种情况也要显式设 `claimLeaseMs`。

占位管的是定时触发这条路径。`messageType: 'instant'` 走的是「建行 → 当场投递」，不经过占位。

内置适配器都实现了占位。自定义适配器可以不实现 `claimTask`，跑得动，只是回到不占位的行为。

`lease_until` 是这次新加的列。走 `POST /init-tenant`（或任何一次 `initSchema`）会自动给已有的表补上；手工建表的看 `examples/cloudflare-single-user/schema.sql`。

## 导出 API（Exports）

- `createReiServer`
- `createAdapter`
- `createTenantToken`
- `verifyTenantToken`
- `deriveUserEncryptionKey`
- `decryptPayload`
- `encryptForStorage`
- `decryptFromStorage`
- `validateScheduleMessagePayload`
- `measurePushPayload`
- `MAX_PUSH_PAYLOAD_BYTES`
- `WEB_PUSH_MAX_BODY_BYTES`
- `WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES`
- `isValidISO8601`
- `isValidUrl`
- `isValidUUID`
- `isValidUUIDv4`

## 运行环境与要求

- Node.js `>=20`
- 必须装：`web-push`、`@netlify/blobs`、以及至少一个数据库驱动（`@neondatabase/serverless` 或 `pg`）

### 环境变量

必填：

- `VAPID_EMAIL` — VAPID 联系邮箱
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — VAPID 公私钥对，[vapidkeys.com](https://vapidkeys.com) 生成
- `TENANT_CONFIG_KEK` — 加密 Blob 里租户配置（含 db connection、masterKey）的 KEK
- `TENANT_TOKEN_SIGNING_KEY` — `tenantToken` / `cronToken` 的 HMAC 签名密钥

可选：

- `INIT_SECRET` — 配了之后 `POST /api/v1/init-tenant` 必须带 `X-Init-Secret` 头才能初始化租户
- `PUBLIC_BASE_URL` — 生产域名（如 `https://your-domain.com`），用来让 `init-tenant` 返回完整 `cronWebhookUrl`
- `VERCEL_PROTECTION_BYPASS` — Vercel 部署 + Preview Protection 时给 cron 走的 bypass key

`TENANT_CONFIG_KEK` / `TENANT_TOKEN_SIGNING_KEY` / `INIT_SECRET` 推荐：

```bash
openssl rand -base64 32
```

### `.env` 模板

```dotenv
VAPID_EMAIL=youremail@example.com
NEXT_PUBLIC_VAPID_PUBLIC_KEY=YOUR-PUBLIC-KEY
VAPID_PRIVATE_KEY=YOUR-PRIVATE-KEY
TENANT_CONFIG_KEK=YOUR-KEK-SECRET
TENANT_TOKEN_SIGNING_KEY=YOUR-TOKEN-SIGNING-KEY

# 可选
INIT_SECRET=YOUR-INIT-SECRET
PUBLIC_BASE_URL=https://your-domain.com
VERCEL_PROTECTION_BYPASS=YOUR_BYPASS_KEY
```

Vercel 部署配置可参考 [`examples/vercel.json.example`](https://github.com/Tosd0/ReiStandard/blob/main/examples/vercel.json.example)。

## 相关链接（绝对 URL）

- [SDK Workspace 总览](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/README.md)
- [Client 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md)
- [SW 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md)
- [API 技术规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)
- [Service Worker 规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/service-worker-specification.md)
