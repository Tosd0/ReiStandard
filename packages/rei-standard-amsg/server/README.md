# @rei-standard/amsg-server

`@rei-standard/amsg-server` 是 ReiStandard 主动消息标准的服务端 SDK：Blob 租户配置、`tenantToken` / `cronToken` 鉴权、标准路由处理器。API 规范见 [API 技术规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)。

历史变更见各版本 [CHANGELOG](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/CHANGELOG.md)。2.2+ 的字段增量（`messages` 数组、`splitPattern`、`avatarUrl` 软清空策略）在规范的 [§6.1](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md#61-ai-消息字段约束) / [§6.2](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md#62-avatarurl-软清空策略)。其中 `splitPattern` 是 server 调度任务的持久化配置；`amsg-instant` 0.8.0 起改为 hook 内自定义 split 函数 + `pushPayloads`。

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
// GET  /api/v1/message?id={uuid}    -> rei.handlers.getMessage.GET
// PUT  /api/v1/push-subscription    -> rei.handlers.pushSubscription.PUT
// GET  /api/v1/push-subscription    -> rei.handlers.pushSubscription.GET
// DELETE /api/v1/push-subscription  -> rei.handlers.pushSubscription.DELETE
// PUT  /api/v1/llm-credentials      -> rei.handlers.llmCredentials.PUT
// GET  /api/v1/llm-credentials      -> rei.handlers.llmCredentials.GET
// DELETE /api/v1/llm-credentials    -> rei.handlers.llmCredentials.DELETE
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

### 信封预留：fire-time hook 组 payload 时要多留一截

hook 把 `pushPayloads` 交还给库之后，库还会往每条 push 上补一批「这是谁、第几条、什么时候」的字段：

```
messageId / sessionId / timestamp / messageIndex / totalMessages
taskId / taskUuid / recurrenceType / occurrenceMs
```

也就是说 hook 手里量到的不是最终 payload。这批字段占的字节由导出的 `PUSH_ENVELOPE_RESERVED_BYTES`（384 字节，含 JSON 的引号逗号，按 uuid ≤ 64 字符算）兜住；`measurePushPayload` 传 `{ reserveEnvelope: true }` 就是「库补完字段之后还装得下」的口径：

```js
import { measurePushPayload, PUSH_ENVELOPE_RESERVED_BYTES } from '@rei-standard/amsg-server';

const { remainingBytes } = measurePushPayload(
  JSON.stringify({ ...basePush, message: '' }),
  { reserveEnvelope: true }
);
const message = body.length <= remainingBytes ? body : body.slice(0, remainingBytes);
```

用比 64 字符更长的 uuid（`scheduleTask` 允许传任意字符串）就自己再多留一点。

### 装不下就切片：`multipart`

思考过程（reasoning）常常一条 push 装不下。装不下时服务端会把它切成分片逐条发，Service Worker 收齐后还原成原样再走正常派发。切多大一片、最多切几片、收齐前能等多久，都是接收端说了算——所以给 `installReiSW` 传了什么，就把同一份原样传给服务端：

```js
const multipart = { maxChunkBytes: 1800, maxChunks: 128, maxTotalBytes: 256_000, ttlMs: 60_000 };

installReiSW({ multipart });                                    // 页面
createReiServer({ tenant: { … }, multipart });                  // 多租户
createSingleUserServer({ db, masterKey, multipart });           // 单用户
createSingleUserCloudflareWorker((env) => ({ …, multipart }));  // CF Worker（cron 与 runTask 都认）
```

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `maxChunkBytes` | `1800` | 每片装多少字节原文 |
| `maxChunks` | `128` | 一条消息最多切几片，超了就不发 |
| `maxTotalBytes` | `256000` | 整条消息的原文上限，超了就不发 |
| `ttlMs` | `60000` | 接收端收到第一片之后，等齐剩下分片能等多久 |

不配 = 两边都用默认值。发送节奏也按 `ttlMs` 排：片数多时自动收紧每片之间的间隔，保证整批分片在这个窗口内发完；收紧到下限还装不下就一片都不发。

两边对不上的下场值得记一下：页面把 `maxChunks` 收窄到 32、服务端还按 128 切的话，分片到了接收端会被逐片拒收；节奏排得比窗口长的话，迟到的分片会被当过期丢掉。两种都是「页面上这条思考过程直接没有」，而服务端那边每一片都发成功、看不出任何异常。

### 思考过程没送到时的可见性

思考过程是正文之外的附赠内容：它没发出去不影响正文，任务照样算成功。这件事有三处看得见——

- 定时任务的 tick 汇总多一个 `details.reasoningSkippedTasks`：`[{ taskId, reason }]`。这些任务同时计在 `successCount` 里。
- instant 消息（`POST /schedule-message`）的成功响应带 `reasoningError`（字符串，只在思考过程没送到时出现）。
- 服务端日志各打一行：一行说原因，一行说是哪条任务。

刻意不写进 `last_error`：那一列说的是「上一次没发出去的原因」，一条正文已经送达的消息挂着它，客户端会当成这次投递失败了。

## 推送订阅（用户级）

推送订阅一个用户存一份，任务行不携带它，到点投递时现读。用户清了站点数据、重装了 PWA、或者推送服务轮换了 endpoint 之后，覆盖这一份就够了——所有已排的任务，包括角色在 fire 里给自己排的、客户端根本不知道存在的那些，下次触发读到的都是新订阅。

| 端点 | 语义 |
|---|---|
| `PUT /push-subscription` | 登记 / 覆盖。body =（加密后的）`{ subscription, updatedAt? }`，`subscription` 至少要有非空 `endpoint` |
| `GET /push-subscription` | `{ exists, updatedAt, endpoint }`。不含订阅的密钥部分——判断「登记过没有、是不是我手里这一个」用 `endpoint` 就够 |
| `DELETE /push-subscription` | 删掉（设置页的「停止接收推送」） |

客户端侧对应 `client.putPushSubscription(subscription)` / `getPushSubscription()` / `deletePushSubscription()`。什么时候调 PUT：`subscribePush()` 拿到订阅之后一次，之后每次应用启动确认订阅仍然有效时再一次（幂等覆盖）。

配套的约束：

- `POST /schedule-message` 在这个用户还没登记订阅时返回 `409 PUSH_SUBSCRIPTION_MISSING`——建了也永远发不出去，早点说清楚比让它烂在库里强。
- `POST /schedule-message` 和 `PUT /update-message` 都不收 `pushSubscription` 字段（带了返回 `400 PUSH_SUBSCRIPTION_NOT_ACCEPTED`）：静默丢弃会让人以为「这条任务用的是我传的这个订阅」。
- 投递时读不到订阅（没登记 / 被删了）→ 任务按投递失败处理，原因记进 payload 的 `lastError`，`GET /messages` 上看得见。
- 数据库侧是 `push_subscriptions` 表（`user_id` 主键，`subscription` 密文，`updated_at` epoch 毫秒）。内置的 D1 / pg / neon 适配器都实现了，`initSchema()` 会建表。自定义适配器要补 `getPushSubscription` / `upsertPushSubscription` / `deletePushSubscription` 三个方法，缺任何一个这几个端点返回 501。

装不下的内容（长文、附件详情）建议走旁路：正文存进 `client_state`，push 里只带一个引用键，客户端上线后用 `GET /client-state` 取回。单用户 Worker 的 fire-time hook 用 `ctx.writeState()` 写，见 [`examples/cloudflare-single-user/README.md`](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/examples/cloudflare-single-user/README.md)。

## LLM 凭据（用户级）与 credRefs

LLM API 凭据（`apiUrl` / `apiKey` / `primaryModel`）有两种给法：

- **内联**：随排程请求带三件套，冻结进任务行（一直以来的方式，继续支持）。
- **引用**：凭据先用 `PUT /llm-credentials` 集中登记，排程 payload 里只带
  `credRefs: { chat: '<credId>' }`。到点投递时按 credId 现读——换 Key 覆盖对应
  行就够了，所有引用它的任务（包括角色在 fire 里给自己排的、客户端根本不知道
  存在的那些）下次触发用的都是新凭据。

| 端点 | 语义 |
|---|---|
| `PUT /llm-credentials` | 批量登记 / 覆盖。body =（加密后的）`{ credentials: [{ credId, value: { apiUrl, apiKey, primaryModel } }] }`，一批 ≤100 条，单用户 ≤500 行 |
| `GET /llm-credentials` | 对账清单 `{ credentials: [{ credId, updatedAt }] }`。**凭据本体永远不回传** |
| `DELETE /llm-credentials` | 删除。body =（加密后的）`{ credIds: [...] }` 或 `{ all: true }` |

客户端侧对应 `client.putLlmCredentials(credentials)` / `listLlmCredentials()` / `deleteLlmCredentials(opts)`。

`credId` 是客户端起名的**不透明字符串**（1–128 字符、不含控制字符），服务端不
解释语义。约定：`char:<charId>/<purpose>`（角色级）、`global/<purpose>`（全
局）。`credRefs` 的 purpose 键里只有 `chat` 由服务端消费（fire 时的主 LLM 调
用）；其余 purpose（如情绪评估的副 API）归宿主 hook 侧，fire hook 的 ctx 上有
`resolveLlmCredential(credId)` 可按需取用（每次返回新对象；拿到就用，别挂到
ctx / metadata / push 上）。

配套的规则：

- 排程 / 更新时对 `credRefs` 里的**全部** credId 做存在性检查，缺的返回
  `409 CREDENTIAL_NOT_FOUND` 并点名（先登记再排程）。
- `credRefs.chat` 与内联三件套在同一个请求里不能都传（`400`）：chat 凭据只能
  有一个来源。
- fire 时的解析顺序：`credRefs.chat` → 查表；行没了 → 退回任务里的内联三件套
  （如有）；都没有 → 本轮失败，`lastError` 记 `CREDENTIAL_MISSING`，走常规重
  试——补传凭据后下一轮自愈。
- hook 的 `ctx.scheduleTask()` 自排任务时按 **`credRefs.chat`** 分支：父任务带
  chat 引用 → 复制整份引用、不复制凭据本体，换 Key 自动作用于整条自排链；父任
  务只带非 chat 引用（如仅 emotion）→ 引用与内联三件套**都**复制（引用归 hook
  用途，聊天凭据在内联那份里）；存量内联任务照旧复制三件套。
- `prompted` / `auto` 任务 fire 时既无 `credRefs.chat` 也无内联三件套 → 按
  `CREDENTIAL_MISSING` 失败进常规重试（不会被静默判成「不需要 LLM」）。
  `instant` 保持「无凭据 = 纯推送 `userMessage`」的路由语义。
- 任务投影（`GET /messages` / hook 的 `ctx.task`）带 `credRefs`（只是名字，不
  是机密），客户端对账用；凭据本体照旧被白名单挡在外面。
- 数据库侧是 `llm_credentials` 表（`(user_id, cred_id)` 主键，`encrypted_value`
  密文，时间戳 ISO8601 文本）。内置的 D1 / pg / neon 适配器都实现了，
  `initSchema()` 会建表。自定义适配器要补 `upsertLlmCredentials` /
  `getLlmCredentials` / `listLlmCredentials` / `deleteLlmCredentials` 四个方法，
  缺任何一个这几个端点返回 501、带 `credRefs` 的排程也会被拒。
- 特性探测：`GET /capabilities` 的 `features` 含 `'llm-credentials'`。

## 读一条任务：列表 vs 单条

| 端点 | 给什么 |
|---|---|
| `GET /messages` | 任务列表。每条只带 `charId` / `clientTaskId` 两个 `metadata` 子字段 |
| `GET /message?id=<uuid>` | 单条任务。同样的形状，外加**完整的 `metadata`** |

什么时候需要单条：`PUT /update-message` 对 `metadata` 是**整体替换**（不深合并），所以「只改 metadata 里的一个键」必须先把完整的那份读回来，改完再整份传上去；只传一部分会把宿主存在里面的其余键（任务指令、锚点时间戳、过期策略之类）一起冲掉。列表不带整份 metadata，是因为一页最多 100 条，每条都驮着它会把响应撑得很大，而列表要的只是「有哪些任务」。

`GET /message` 只读得到还没发出去的任务；已完成 / 已失败的返回 `409 TASK_ALREADY_COMPLETED`，不存在返回 `404 TASK_NOT_FOUND`（与 `PUT /update-message` 同一口径）。响应和列表一样是加密的，客户端侧对应 `client.getMessage(uuid)`。

## 更新任务时能改哪些字段

`PUT /update-message` 的可写字段：`contactName` / `avatarUrl` / `userMessage` / `completePrompt` / `messages` / `nextSendAt` / `recurrenceType` / `tzId` / `metadata` / `messageSubtype` / `maxTokens` / `temperature` / `splitPattern` / `llmExtraBody`、凭据三件套 `apiUrl` / `apiKey` / `primaryModel`，以及凭据引用 `credRefs`。

- `contactName` 必须是非空字符串（口径与排程时一致），空串 / `null` / 非字符串一律 `400`。用户给角色改了名之后，之前排的任务推送出来的通知标题（「来自 <contactName>」）靠它跟着改。
- `metadata` 是整体替换，不深合并——只改一个子字段的读-改-写流程见上一节。
- `avatarUrl` 显式传 `null` 是「不改」而不是「清空」（§6.2 的软清空策略要求非法头像被摘掉时保留旧头像，「摘掉」和「传了个 null」在这一层是同一件事）。
- 凭据三件套传 `null` 同样只是忽略：清掉任何一个，任务到点就发不出去。
- `credRefs` 是整体替换（语义同 `metadata`），同样做存在性检查；与内联三件套在同一个请求里混着传返回 `400`。给存量内联任务补 `credRefs` 时不动已存的三件套——那份留作 fire 时表行缺失的兜底。
- `pushSubscription` 不收（`400 PUSH_SUBSCRIPTION_NOT_ACCEPTED`），它是用户级的一份，走 `PUT /push-subscription`。
- `userMessage` 给了就必须是字符串（口径与排程时一致）：它到点要过正则切分，别的类型收进来只会在投递时炸。
- `messageSubtype` / `llmExtraBody` 显式传 `null` 是「改回默认」（分别是投递时的 `'chat'` 和「不透传额外参数」），不会被当成「不改」吞掉。
- 响应里的 `updatedFields` 只列真正落进这次更新的字段。请求里带了但没被应用的键——这个接口不接受的、拼错的、传了 `null` 走「不改」语义的——不会出现在里面。

## 取消 / 顶替时，没发出去的那几段也会撤掉

适配器实现了 outbox 那组方法（内置 D1 有）时，每条 push 在发出去之前会先落一行 `message_outbox`，客户端离线或推送服务抽风时靠 `GET /outbox` 补收。这就带来一个收尾问题：一条任务投递到一半失败过的话，没发出去的那几段还留在 outbox 里等补收，光删任务行它们不会跟着走。

所以 `DELETE /cancel-message` 和 `POST /schedule-message` 的 `supersedesUuid` 顶替，都会顺手把该任务名下还没发出去的行撤掉。已经推到设备上的分段不动——取消的意思是「别再发后面的」，不是「把用户已经收到的从收件箱里抹掉」，那几条留着让客户端照常 ack。

清理是 best-effort：适配器没实现 outbox、或者清理本身出错，都不影响取消 / 顶替的成功返回（任务行已经删掉了）。

## 推送自带任务身份

每条从任务行发出去的 push（冻结 prompt 路径和 fire-time hook 路径都算）顶层带这四个字段：

| 字段 | 是什么 |
|---|---|
| `taskId` | 任务行 id；没有行的 in-server instant 路径为 `null` |
| `taskUuid` | 任务 uuid（排程方选的那个） |
| `recurrenceType` | `none` / `daily` / `weekly` —— 这条任务还会不会再来 |
| `occurrenceMs` | 本次触发的名义时刻，epoch 毫秒 |

客户端据此认领任务：角色在 fire 里给自己排的任务，客户端从没见过它，靠这四个字段就能把它记进面板、让用户取消得掉。放在顶层而不是 `metadata` 里——`metadata` 是调用方自己的地盘，库不往里写。

hook 在 `pushPayloads` 里自己写了这几个字段的话会被库覆盖：它们描述的是任务行的事实，不是内容。

## Fire 时刻 hooks

配上 `hooks: { onBeforeFire, onLLMOutput, executeToolCalls }` 之后，AI 类任务的 prompt 不再是排程那一刻冻结的文本，而是 cron 触发时现场组装，工具也在服务端就地跑完，全程不需要客户端在线。完整用法见 [`examples/cloudflare-single-user/README.md`](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/examples/cloudflare-single-user/README.md) 的「Fire 时刻 hooks」。

三个 hook 拿到的 ctx 上都有这几个口子：

| ctx 上的口子 | 干什么 |
|---|---|
| `readState(ns)` / `writeState(ns, entries)` | 读写 `client_state`，和客户端 `GET/PUT /client-state` 是同一份数据 |
| `scheduleTask(options)` | 给同一个用户再建一条定时任务 |
| `scratch` | 本次 fire 的便签对象，三个 hook 加上发送后的 `onAfterSend` 共享同一个引用，fire 结束即丢弃 |

`onLLMOutput` / `executeToolCalls` 的 ctx 上另外带着任务身份：

| 字段 | 是什么 |
|---|---|
| `taskId` | 任务行 id |
| `taskUuid` | 任务 uuid（排程方选的那个） |
| `occurrenceMs` | 本次触发的名义时刻，epoch 毫秒 |

`sessionId` 是给日志和去重用的不透明字符串，格式随版本变，别拆它拿上面这些值。

### config 级 hook

这两个挂在 worker 工厂 config 的顶层（不在 `hooks` 里）：

| hook | 什么时候调 | 载荷 |
|---|---|---|
| `onAfterSend` | fire 的 pushPayloads 逐段发完，或中途发挂 | `{ task, sentCount, total, error, scratch, readState, writeState }` |
| `onFireSettled` | 一次 fire 收尾——只要 `onBeforeFire` 被调用过，什么结局都调一次 | `{ task, status, skipReason, sentCount, total, iterations, error, scratch, readState, writeState }` |
| `onStaleSkip` | 任务错过触发时刻超过 60 分钟、这一次（或这几次）不再补发 | `{ reason, action, metadata, recurrenceType, occurrenceMs, skippedCount, skippedOccurrences, skippedTruncated, nextSendAt, readState, writeState }` |

三个 hook 都自带 `readState` / `writeState`，作用于当前用户的 `client_state`，语义与 fire 级那套一致。`onStaleSkip` 尤其需要：服务停摆恢复后的第一跳里可能一次 fire 都没跑过，而那正是它要留痕迹的时候。

`onAfterSend` 的 `scratch` 与本次 fire 的 `onBeforeFire` / `onLLMOutput` 是同一个引用——「这次生成了哪几段正文」之类的上下文直接从这里读，不用自建按任务分格的登记表。全部成功时 `error` 为 `null`；第 k 段失败时 `sentCount = k`、`error` 带原始错误，且在错误往上抛之前调用完。

`onFireSettled` 是「这次 fire 结束了」这一个信号，`status` 说明结局：

| status | 什么时候 |
|---|---|
| `sent` | pushPayloads 全部发完（`sentCount === total`） |
| `skipped` | 这次不发。`skipReason` 区分是 `onBeforeFire` 直接 `{ skip: true }`（`'before-fire'`）还是模型跑完后判定不发（`'skip-push'`） |
| `failed` | 链路抛错，`error` 带原始错误。发到第 k 段挂了也是这个：`sentCount = k`、`total` 是原本要发的段数 |
| `not-handled` | `onBeforeFire` 返回 `null`，这条任务交还给排程时冻结的 prompt 老链路。那条链路不归 fire hook 管，它后面发没发出去不体现在这里 |

跟 `onAfterSend` 的分工：`onAfterSend` 只走「有 push 要发」这条路，所以 hook 判断这次不用说话、或者链路中途抛错时它不会被调到——「开始时占点什么、结束时放掉」的写法要挂 `onFireSettled`（fire 里已经用 `ctx.scheduleTask` 建出来的任务，不记账就成了只活在数据库里的幽灵任务；fire 开头拿的锁，没有可靠释放点就只能等 TTL）。正常发完时两个都会调，`onAfterSend` 在前。`scratch` 是同一个引用。没配 hooks 的部署、以及不需要 LLM 的固定文本任务不走 fire 这条路径，两个都不会调。

`onStaleSkip` 的 `action` 分两种：

- `expired` —— 一次性任务，这一次永远不会补发了，行已标 `failed`。
- `fast_forwarded` —— 循环任务，攒下的这几次都跳过，排期已快进到 `nextSendAt`，行仍是 `pending`，下一次照常触发。

`skippedCount` 是一共跳过几次（含名义那一次），`skippedOccurrences` 是被跳过的名义时刻列表（epoch 毫秒）；超过 32 次时只给首末两个并把 `skippedTruncated` 置 `true`。两种 action 都会把原因写进 payload 的 `lastError`，`GET /messages` 上看得见。

两个 hook 都是 best-effort：自身抛错只记日志，不影响主流程。

### `ctx.scheduleTask(options)`

角色在这次 fire 里给自己排一条后续任务：「这条发完，一个半小时后我再接着说一句」。建出来的是一条正常的任务行，到点由 cron 触发，用户全程离线也不影响。

```js
const result = await ctx.scheduleTask({
  firstSendTime: new Date(Date.now() + 90 * 60_000).toISOString(), // 必填，ISO 字符串
  messageType: 'auto',            // 可选，默认继承当前任务
  recurrenceType: 'none',         // 可选，默认 none
  tzId: 'Asia/Tokyo',             // 可选，默认继承当前任务；循环推进按这个时区的墙钟走
  metadata: { beat: 'followup' }, // 可选，整体替换当前任务的 metadata（不深合并）
  uuid: `fire-${ctx.taskId}-${ctx.occurrenceMs}`, // 可选，默认随机
});
// → { created: true, id, uuid, nextSendAt }
//   或 { created: false, reason: 'duplicate', uuid, task }
```

撞 uuid 时 `task` 是那条**已经存在的任务行**的投影，形状与 `GET /messages` 列出来的一样（`{ id, uuid, contactName, messageType, messageSubtype, nextSendAt, recurrenceType, tzId, status, retryCount, createdAt, updatedAt, charId, clientTaskId, lastError }`，不含任何凭据）。用确定性 uuid 做重试幂等时，重跑那轮靠它把这条任务记进自己的账本、随 push 带回客户端认领——否则这条任务只活在数据库里，面板列不出、用户取消不了，却照样到点触发。行读不回来（已经不是 pending）→ `task` 为 `null`。

凭据和投递配置（`apiUrl` / `apiKey` / `primaryModel` / `maxTokens` / `temperature` / `splitPattern`）以及 `contactName` / `avatarUrl` / `messageSubtype` / `userMessage` / `tzId` 从当前任务继承，宿主只说「什么时候、说什么方向」——hook 全程看不到凭据。推送订阅是用户级的一份，任务不携带、也不用继承。`completePrompt` / `messages` 不继承（都置 `null`）：hook 每次现场重组 prompt，把排程时冻结的旧 prompt 带过去，新任务万一走回冻结 prompt 老链路就会静默发出一条谁也没打算发的文案。

护栏：

| 护栏 | 阈值 / 规则 | 不满足时 | 为什么 |
|---|---|---|---|
| `firstSendTime` | 必填、能解析成合法时间、至少比现在晚 **60 秒** | `RangeError` | cron 一分钟一跳，排在 60 秒内等于让下一跳立刻捡走，容易变成自己触发自己的紧密循环 |
| `messageType` | 只收 `auto` / `prompted` / `fixed` | `TypeError` | `instant` 的语义是「建行的那一刻就投递」，那条路径归 `POST /schedule-message` 管；从 fire 里造这么一行，投递时机反而说不清 |
| `messageType: 'fixed'` | 必须有 `userMessage`（自己传或继承到） | `TypeError` | 固定文本任务没有正文，就是一条永远发空的任务 |
| 单次 fire 的建任务条数 | 默认 **2 条**，factory 配置 `maxScheduledTasksPerFire` 可调（`0` = 不许自排） | `RangeError` | 模型自排后续本质上是条能无限延伸的链，没有上限就没人按停止键 |
| `uuid` 撞车 | 不当错误处理 | 返回 `{ created: false, reason: 'duplicate', uuid, task }` | fire 失败会整条重跑，宿主传一个由「任务 id + 触发时刻」推出来的确定性 uuid 就天然幂等 |
| `tzId` | 可用的 IANA 时区 id，或 `null` | `TypeError` | 认不出来的时区会让循环推进悄悄退回 UTC，用户设的钟点从此对不上 |
| 任务内容大小 | 与 `POST /schedule-message` 同一道闸门 | 抛 `RangeError`（`code: 'TASK_PAYLOAD_TOO_LARGE'`） | 往 `metadata` 里塞一坨大对象会顶穿存储的单行上限，不拦的话到落库那步才炸，报错看不出所以然 |
| 数据库适配器没有 `createTask` | — | 抛 `DeploymentConfigError`（`code: 'AGENTIC_SCHEDULE_UNSUPPORTED'`） | 静默成功会让宿主以为后续那条排上了，其实谁也不会触发它 |

`recurrenceType` 沿用排程接口那套 `none` / `daily` / `weekly`，别的值抛 `TypeError`。参数不合法的调用不占建任务额度；uuid 撞车占（那条任务其实已经建出来了）。

### hook 契约违约算确定性失败

宿主 hook 返回了库不认的东西（`onBeforeFire` 的返回形状、`onLLMOutput` 的决策标签），或者建后续任务时 `createTask` 没把行交回来——这些错误带 `permanent: true` 和一个稳定的 `code`（`AGENTIC_BAD_BEFORE_FIRE` / `AGENTIC_BAD_DECISION` / `AGENTIC_SCHEDULE_FAILED` / `TASK_PAYLOAD_TOO_LARGE`），投递侧据此跳过退避阶梯：一次性任务直接标 `failed`，循环任务作废本次 occurrence。重试也是同一个结果，而每重试一轮都要把 `onBeforeFire` 和一整轮 LLM 重跑一遍。

分界线是「谁写错了」：契约由宿主代码定死，重掷一次还是同一个形状；而模型这一轮掷出了什么则是每轮都可能不同的。所以「tool-request 决策里没有能解析的 `toolCalls`」（`AGENTIC_EMPTY_TOOL_REQUEST`）和「轮数用尽也没等到 `finish` / `skip-push`」（`AGENTIC_LOOP_EXCEEDED`）带 `code` 但不带 `permanent`，留在退避阶梯上——隔两分钟重掷一次多半就正常收尾了，判终态的话一次性任务第一次掷歪就永久 `failed`，行离开 `pending` 之后连 `PUT /update-message` 都救不回来（回 409）。

### 部署配错了算可重试

部署缺了必要的能力——没配 `onLLMOutput` / `executeToolCalls`，或者自定义适配器没有 `createTask` / `deleteTaskByUuid` / `getTaskByUuid` / `upsertClientState`——抛的是 `DeploymentConfigError`：带同样的 `code`（`AGENTIC_CONFIG_ERROR` / `AGENTIC_SCHEDULE_UNSUPPORTED` / `AGENTIC_CANCEL_UNSUPPORTED` / `AGENTIC_RENEW_UNSUPPORTED` / `AGENTIC_STATE_WRITE_UNSUPPORTED`），但**不带** `permanent`，走的是普通的退避阶梯。

因为坏的不是这条任务，是这个部署：同一个坏部署下每条到点的任务都会撞同一个错，判终态等于把那段时间里每一条一次性任务都永久标 `failed`，配置改好重新部署也捞不回来（行已不在 `pending`，`PUT /update-message` 回 409）。留在阶梯上的话，配置一修好，下一跳就正常发出去。VAPID 配错回的 400 / 401 / 403 是同一个道理，见下面的推送失败分级。

`AGENTIC_TOTAL_TIMEOUT`（整条 fire 链超出 `totalTimeoutMs`）也走退避重试：这一轮慢不代表下一轮也慢。

`GET /capabilities` 的 features 里有 `agentic-schedule-task`，前端可以据此判断部署的 worker 认不认这条链路。

## 导出（新增）

- `validateLlmMessagesArray(messages)` — 同步预校验 messages 数组，返回 `string | null`（错误信息 / 通过）。形状规则统一在 `@rei-standard/amsg-shared` 的 `validateLlmMessagesShape`，和 `@rei-standard/amsg-instant` 共用同一实现（含 agentic 会话：assistant 带 `tool_calls` 时 content 可空、`role:'tool'` 要求 `tool_call_id`）。
- `validateSplitPattern(value)` — 同步预校验 splitPattern（string / string[] / null），返回 `string | null`。
- `MAX_PUSH_PAYLOAD_BYTES` — 一条 push 的明文上限，3993 字节。
- `PUSH_ENVELOPE_RESERVED_BYTES` — 库在 hook 交还 payload 之后还要补的那批字段占的字节上界，384。
- `WEB_PUSH_MAX_BODY_BYTES` / `WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES` — 推送服务的密文 body 上限（4096）与 aes128gcm 固定开销（103），上面那个数就是两者相减。
- `measurePushPayload(payload)` — 量一段 payload 的字节数与剩余额度，返回 `{ bytes, maxBytes, remainingBytes, withinLimit }`。

以上几个在包根和 `@rei-standard/amsg-server/cloudflare` 两个入口都有。

## 一体化初始化流程

1. 管理员配置环境变量（VAPID + tenant secrets）
2. 租户调用 `POST /api/v1/init-tenant` 提交自己的 `databaseUrl`
3. 服务端自动完成：建表 + 生成 masterKey + 写入 Blob + 返回 `tenantToken`/`cronToken`
4. 前端使用 `tenantToken`，cron 使用 `cronToken`

## 端点鉴权

- `get-user-key`、`schedule-message`、`update-message`、`cancel-message`、`messages`、`message`
  - `Authorization: Bearer <tenantToken>`
- `send-notifications`
  - `Authorization: Bearer <cronToken>` 或 `?token=<cronToken>`

## 循环任务的时区（`tzId`）

`daily` / `weekly` 任务可以带一个 IANA 时区 id：

```js
await client.scheduleMessage({
  contactName: 'Rei',
  messageType: 'auto',
  firstSendTime: '2026-03-07T13:00:00.000Z', // 纽约当地 08:00
  recurrenceType: 'daily',
  tzId: 'America/New_York',
  // …
});
```

带了 `tzId` 的任务按**那个时区的墙钟**推进：日期 +1 天 / +7 天，钟点原样保留。用户设的「每天早八点」在夏令时切换前后都还是早八点。不带 `tzId` 的任务按 UTC 推进（等价于固定 +24h / +7×24h）。

`PUT /update-message` 也认这个字段：传时区 id 换一个，传 `null` 改回按 UTC 推进（`hasOwnProperty` 判断，不会被吞掉）。`GET /messages` 每条任务多返回一个 `tzId`（没设 → `null`）。

两个边界情况的收敛规则：春令时被跳过的墙钟（例如纽约 2:30 不存在）落到切换之后的等价时刻（当地 3:30）；秋令时重复出现的墙钟（当地 1:30 出现两次）取其中一个，不触发两次。时区换算全部走 `Intl`，不手搓偏移加减。

## 触发任务时的占位

`send-notifications`（以及单用户 Worker 的 `scheduled()`）每条任务开跑前会先占位：在这一行的 `lease_until` 上写下「归我管到现在 + 租期为止」，本次投递期间别的 tick 领不走它；占位改到 0 行说明别人先领走了，本次直接跳过。cron 一分钟一跳而带工具的 AI 任务常常跑过一分钟，没有这层占位同一条任务会被相邻几跳重复触发。

租约写在自己的列上，`next_send_at` 全程不动——任务列表读到的一直是用户设的那个时刻，循环任务也按它推进到下一次。投递收尾时租约就放掉，失败重试的退避（2 分钟起）不会被租期压住。

领了任务的那一跳中途没了（Worker 被回收之类）就没人来放租约，这条任务要等租约到期才会被后面的 tick 接手。把租期设得比最慢的一次投递长一点即可。

租期默认 10 分钟；配了 `totalTimeoutMs` 的话按它 + 2 分钟往上抬。想自己定就在 `runScheduledTick` 的 ctx（或单用户 Worker 的 config）里传 `claimLeaseMs`——注意 `createReiServer` 内置的 `/send-notifications` 处理器不透传这两个值，要调租期就自己调 `runScheduledTick`。`onBeforeFire` 里按次放宽的预算占位时看不到，那种情况也要显式设 `claimLeaseMs`。

占位管的是定时触发这条路径。`messageType: 'instant'` 走的是「建行 → 当场投递」，不经过占位。

内置适配器都实现了占位。自定义适配器可以不实现 `claimTask`，跑得动，只是回到不占位的行为。

投递失败的退避记在 `retry_after` 上，租约同时放掉。两件事分两列记：`lease_until` 只表示「这条正在跑」，`retry_after` 表示「这条没在跑，在等重试」。挤在一列的话，下面的分组串行会把一条正在退避、其实闲着的任务当成「这一组忙着」，同组别的任务白等一轮退避（最长 6 分钟）。

## 同一分组的任务不并发（`serializeBy`）

同一个角色可能有好几条定时任务。撞在一起并发跑的话，用户一口气收到两条互不知情的消息；宿主在 hook 里维护的「我刚才说过什么」台账通常是读进内存 → 改 → 整份写回，两条各改各的再写回，后写的必然盖掉前面那条。

`runScheduledTick`（以及单用户 Worker 的 config）收一个可选的 `serializeBy`：

```js
await runScheduledTick({
  // ...其余 ctx
  serializeBy: (task) => task.metadata?.charId ?? null,
});
```

- 参数是与 `onBeforeFire` 的 `ctx.task` 同一份的只读任务视图（凭据已剔除）。
- 返回 `null` / 空串、或者不配这个函数 → 这条任务不参与串行，行为与以前完全一致。
- 同一分组同时只放行一条，**跨跳也算**：上一跳的 fire 还拿着租约时，下一跳捞到同组的另一条也不放行。一次 fire 常常跑十几秒到几分钟，只挡同一跳是不够的。
- 同一跳内同组放行的是**到点更早**的那条；跑完之后不补跑同组剩下的，留给下一跳。
- 被拦下的任务是**推迟不是丢弃**：`next_send_at` / `status` / `retry_count` 一个字段都不会被动，下一跳原样再捞一次。条数记在 `details.serializeSkippedTasks`（同一跳内拦下的）和 `details.claimSkippedTasks`（跨跳拦下的）里。
- `serializeBy` 自身抛错时这条任务这一跳不跑：分不清它属于哪一组，就不该冒着破坏台账的风险跑下去。
- 正在等重试的任务不算「这一组忙着」（退避记在 `retry_after` 上，租约已经放掉）。

判定和占位是同一条 `UPDATE`：先查「这一组忙不忙」再占位的话，两个 tick 的查询会双双在对方占位之前返回「不忙」。分组 key 不明文落库——库拿它和该用户的存储密钥做一次 HMAC，`serialize_group` 列存的是那个派生值。

自定义适配器实现了 `claimTask` 但忽略第四个参数的，分组串行退化成只在同一跳内生效；完全没实现 `claimTask` 的同理。

`createReiServer` 内置的 `/send-notifications` 处理器不透传 `serializeBy`（和 `claimLeaseMs` 一样），多租户部署要用就自己调 `runScheduledTick`。单用户 Worker 直接在 config 里写。

## 任务表用到的三列

`lease_until` / `retry_after` / `serialize_group`（都可空）。走 `POST /init-tenant`（或任何一次 `initSchema`）会自动给已有的表补上，跑几次都没事；手工维护表结构的看 `examples/cloudflare-single-user/schema.sql`，Postgres 侧对应三句 `ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS …`。分组串行还多一个索引 `idx_serialize_group_lease`，`initSchema` 一并建。

## 表结构自查（`getSchemaVersion` / `ensureSchema`）

建表语句是 `CREATE TABLE IF NOT EXISTS`，已经存在的表不会被改动，后加的列靠 `initSchema()` 里的 ALTER 补。升级到新版之后没人再跑一次建表的话，这个部署的表就停在旧形状上——cron 每分钟挂在缺的那一列上，任务一条都不发，而前端界面一切正常。

这两个函数把「我需要什么 / 现在是什么 / 帮我补齐」露出来：

```js
import { getSchemaVersion, ensureSchema } from '@rei-standard/amsg-server/cloudflare';

const state = await getSchemaVersion(db);
// → { current: '2.6.0' | null, required: '2.6.0', ok: true | false, missing: [] }

if (!state.ok) {
  const fixed = await ensureSchema(db); // 建表 + 补列 + 建索引，重复调没事
  // → { current, required, ok, missing, migrated: true, schema }
}
```

| 字段 | 是什么 |
|---|---|
| `required` | 这一版代码需要的表结构版本（导出常量 `SCHEMA_VERSION`）。表结构自己的版本号，只在表 / 列 / 关键索引变化时抬，与包版本各走各的 |
| `current` | 活库当前满足的版本：够用就是 `required` 那个值，缺东西就是 `null`（只知道不够用，不知道它停在哪一版） |
| `ok` | 需要的表 / 列 / 关键索引是不是都在 |
| `missing` | 缺什么，形如 `table:message_outbox` / `column:scheduled_messages.last_error` / `index:uidx_uuid`。整张表缺席时只报这一张表，不逐列展开 |
| `migrated`（只有 `ensureSchema` 有） | 这次有没有真的跑 `initSchema()`。本来就够用 → `false`，`schema` 也是 `null` |

「需要什么」是从建表语句里解析出来的，不是另抄一份清单：抄的那份漏掉新列的话，自查会对着一个缺列的库回「一切正常」。

什么时候调、缺了怎么提示用户，由宿主决定——库不会在每次请求里偷偷迁移。`POST /init-tenant` 的行为一点没变（它内部做的就是 `initSchema()`）。

单用户 Worker 上有走 `env` 的同名方法：`worker.getSchemaVersion(env)` / `worker.ensureSchema(env)`，省得自己再造一次适配器。

自查要求适配器实现 `describeSchema()`（活库里现在有哪些表 / 列 / 索引，只读）。内置适配器里目前只有 D1 实现了；别的适配器调这两个函数会抛错，而不是假装一切正常。

## 只跑指定那一条任务（`runTask`）

`scheduled()` 的语义是「扫一遍所有到期任务」。刚落库的任务想立刻跑起来时，触发一次全量扫描是能达到目的，但那样多个执行者会去扫同一批任务，宿主只能退回单实例串行才不重复发。

`runTask` 只跑指定那一条，走的是 cron 完全同一条投递链（占位、租约心跳、过期守卫、失败重试 / 终态、hook 全套）：

```js
// 单用户 Worker：从 env 拿库和配置
const result = await worker.runTask(uuid, env);

// 自己攒 ctx 的宿主（和 runScheduledTick 同一份 ctx）
import { runTask } from '@rei-standard/amsg-server/cloudflare';
const result = await runTask(ctx, uuid);
```

跑起来了是 `{ ran: true, summary }`（`summary` 与 `runScheduledTick` 的返回同构，`totalTasks` 恒为 1）。不跑的几种情形分开回报，宿主不用猜：

| `reason` | 什么意思 | 附带 |
|---|---|---|
| `not_found` | 没有这条 uuid。一次性任务发完即删，所以「已经发完了」的那条也落在这里 | — |
| `already_settled` | 行还在，但已经是终态 | `status`（`sent` / `failed`） |
| `not_due` | 还没到触发时刻 | `nextSendAt` |
| `retry_pending` | 上次投递失败，还在退避窗口里 | `retryAfter` |
| `not_configured` | VAPID / webpush 没配齐，跑了也只是白扣这条任务一次重试（只有 `worker.runTask` 有这一种） | — |

这个入口只是换了个触发器，不是绕过排期的后门：没到点、在退避窗口里的都不跑。`already_settled` 要求适配器实现 `getTaskStatusByUuidOnly(uuid)`（D1 / pg / neon 都实现了）；不实现的自定义适配器把这种情况并进 `not_found`。

## 出错时的真实原因

`fetch()` 兜底的 500 一直是 `{ success: false, error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } }`。这两个字段一个没动，真因加在 `error.cause` 上：

```json
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "服务器内部错误",
    "cause": {
      "stage": "request",
      "name": "Error",
      "message": "D1_ERROR: no such table: message_outbox"
    }
  }
}
```

| 字段 | 是什么 |
|---|---|
| `stage` | 在哪一段炸的：`config` = 构建配置时（少了 binding、环境变量丢了），`request` = 路由或处理器抛错 |
| `name` | 错误类型（`error.name`，认不出来时是 `Error`） |
| `message` | 错误消息，长得像凭据的串已遮掉、超长截断到 500 字符。`stage: 'config'` 的响应回给跨域调用方时没有这个字段，见下 |
| `code` | 错误自带的 `code` 字符串，有才带 |

只带错误类型和消息文本：密钥、用户数据、任务正文都不在 `error.message` 上，也不往这里放。

`stage: 'config'` 那条路多一层收敛：配置都没建起来时这个部署允许哪些 origin 无从得知，响应头只能回显来访 Origin，于是任意第三方页面一个 `fetch` 就能读到这条响应。而构建期异常的原文往往就是部署信息本身（`env.DB is undefined` 报的是 binding 名）。所以跨域读到的那份 `cause` 只有 `stage` / `name` / `code`，`message` 不出去；同源请求和不带 `Origin` 的调用（`curl`、服务端之间调用）照旧拿全文，`wrangler tail` 里也一直有。配置一修好，响应立刻回到部署自己那套 CORS，`stage: 'request'` 的 500 不受这层影响。

cron 那条路上没有调用方能读到响应，所以另开两个出口：

```js
export default createSingleUserCloudflareWorker(buildConfig, {
  onError({ stage, error, cause, path }) {
    // fetch / cron 任何一段出错都会调一次（best-effort，自身抛错只记日志）
  },
});
```

- `onError` 放在工厂的第二个参数上，而不是 `buildConfig` 的返回值里：`buildConfig` 自己抛错时配置里的东西一个都读不到，而那恰恰是最需要被看见的一种故障。`stage` 在 cron 路径上是 `config`（配置构建失败 / VAPID 没配齐）或 `tick`（那一跳抛错）。VAPID 没配齐这一支没有异常对象，`error` 为 `null`、`cause.name` 是 `VapidNotConfigured`。
- `scheduled()` 现在有返回值：`{ ok: true, summary }` 或 `{ ok: false, cause }`。Cloudflare 不看它，是给「自己包一层再转调 `scheduled`」的宿主和测试用的。

## 导出 API（Exports）

包根（`@rei-standard/amsg-server`）：

- `createReiServer` — 多租户装配线（标准路由处理器全家）
- `createSingleUserServer` — 单用户装配线：没有租户概念，不需要 Blob 租户配置和 tenantToken 体系
- `createSingleUserCloudflareWorker` — 单用户 Cloudflare Worker 一键装配（`fetch` + `scheduled` 两个入口）
- `createAdapter` / `createD1Adapter` — pg·neon / Cloudflare D1 数据库适配器
- `runScheduledTick` — 手动触发一轮到期任务投递（自定义 cron 宿主、要调 `claimLeaseMs` 时用）
- `runTask` — 只跑指定那一条任务（与 cron 同一条投递链）
- `getSchemaVersion` / `ensureSchema` / `SCHEMA_VERSION` — 表结构自查与补齐
- `summarizeErrorCause` — 把异常压成响应体里 `error.cause` 那个形状（自己包一层路由、想回同样形状时用同一份）
- `NonRetryableError` / `isNonRetryableError` — hook 侧标注「重试也好不了」的失败
- `createWebCryptoWebPush` — 纯 Web Crypto 的 Web Push 发送器（不依赖 `web-push` 包）
- `createTenantToken` / `verifyTenantToken`
- `deriveUserEncryptionKey` / `decryptPayload` / `encryptForStorage` / `decryptFromStorage`
- `validateScheduleMessagePayload` / `validateLlmMessagesArray` / `validateSplitPattern` / `validateAvatarUrl`
- `measurePushPayload` / `MAX_PUSH_PAYLOAD_BYTES` / `PUSH_ENVELOPE_RESERVED_BYTES` / `WEB_PUSH_MAX_BODY_BYTES` / `WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES`
- `isValidISO8601` / `isValidUrl` / `isValidUUID` / `isValidUUIDv4` / `isValidTimeZoneId`
- `advanceOccurrence` / `nextFutureOccurrence` / `planNextOccurrence` — 循环任务的时区感知推进（宿主想自己算「下次什么时候」时用同一份实现）

`@rei-standard/amsg-server/cloudflare` 子路径 —— 只含「单用户 + D1 + Web Crypto 推送」这条子图，不引用多租户装配线和 pg / neon / `web-push`，所以 D1-only 安装（不装可选数据库 peer）也能干净打包，Worker 不需要 `nodejs_compat` 兼容 flag：

- `createSingleUserCloudflareWorker` / `createSingleUserServer` / `createD1Adapter` / `runScheduledTick` / `runTask`
- `getSchemaVersion` / `ensureSchema` / `SCHEMA_VERSION`
- `summarizeErrorCause` / `NonRetryableError` / `isNonRetryableError`
- `createWebCryptoWebPush` / `measurePushPayload` / `MAX_PUSH_PAYLOAD_BYTES` / `WEB_PUSH_MAX_BODY_BYTES` / `WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES`
- `deriveUserEncryptionKey` / `decryptPayload` / `encryptForStorage` / `decryptFromStorage`

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

函数超时、响应头这类 Vercel 配置的写法可参考 [`tests/vercel.json.example`](https://github.com/Tosd0/ReiStandard/blob/main/tests/vercel.json.example)（它是 `tests/` 健康检查端点的部署配置，不是本包的部署模板）；环境变量用 `vercel env add` 或控制台配置，不写进 `vercel.json`。

## 相关链接（绝对 URL）

- [SDK Workspace 总览](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/README.md)
- [Client 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md)
- [SW 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md)
- [API 技术规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)
- [Service Worker 规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/service-worker-specification.md)
