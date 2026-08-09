# Changelog — @rei-standard/amsg-client

## 2.9.0-next.11

### Patch Changes

- e6b382a: credRefs 继承按 chat 引用分支，空凭据任务响亮失败

  `ctx.scheduleTask()` 的凭据继承改按 `credRefs.chat` 分支：父任务带 chat 引用 → 复制整份引用、内联置空（原行为）；父任务只带非 chat 引用（如仅 emotion）→ 引用与内联三件套**都**复制——此前对任何非空 credRefs 一刀切置空内联，会产出既无引用可解析又无内联凭据的空壳后代。

  `prompted` / `auto` 任务 fire 时既无 `credRefs.chat` 也无内联三件套 → 按 `CREDENTIAL_MISSING` 失败进常规重试（此前会拿空凭据去撞 LLM 接口、报一句对不上号的 Invalid apiUrl）。`instant` 的「无凭据 = 纯推送」路由语义不变。

  client 侧只改文档提法：可用性门槛引用 capabilities feature `'llm-credentials'`，不再写死版本号。

## 2.9.0-next.10

### Minor Changes

- 3f8e197: 新增 `getOutbox()` / `ackOutbox()`，对接服务端的消息收件箱（amsg-server 的 `/outbox` 与 `/outbox/ack`）

  服务端在每条 Web Push 发出去之前先把它记进账本，「哪些消息客户端还没收下」因此是查得出来的事实。此前这套账本只有服务端一半，SDK 没有对应方法，而加密与 userKey 封在客户端内部、没有通用出口，调用方没法自己拼请求。补上这两个方法之后，补收不再需要拿本地最近几条记录去比对着猜。

  - `getOutbox({ since, limit })`：拉还没确认收到的消息，返回 `{ entries, cursor, hasMore }`。响应走加密信封，方法内解密后返回明文。每条 entry 的 `push` 就是推送信封本身，与 Service Worker 收到的那一份逐字一致，可以原样交给已有的推送处理逻辑。翻页时把上一页的 `cursor` 当下一页的 `since`；两个参数都不传就从头拉、由服务端定页大小。
  - `ackOutbox(messageIds)`：销账，之后 `getOutbox()` 不再返回这些消息。请求体加密，幂等，单次最多 200 条。顺序上先落库再 ack——反过来的话账已经销了而落库半途失败，消息就补不回来了。

  `since` / `limit` / `messageIds` 不合法时在本地抛 `TypeError`，不跑一趟必然被服务端拒的网络请求。

## 2.9.0-next.9

### Minor Changes

- d94ccf7: 用户级 LLM 凭据存储（llm_credentials 表）+ 任务凭据引用（credRefs）

  凭据（apiUrl / apiKey / primaryModel）可以先用 `PUT /llm-credentials` 集中登记（`cred_id` 由客户端起名的不透明字符串，per-user key 加密落库），排程 payload 里带 `credRefs: { chat: '<credId>' }` 引用它——任务到点按引用现读，换 Key 覆盖对应行就够，所有引用它的任务（包括角色在 fire 里给自己排的、客户端不知道存在的那些）下次触发自动用新凭据。内联三件套继续支持（存量任务不迁移，fire 时作为表行缺失的兜底）。

  服务端：`PUT/GET/DELETE /llm-credentials` 三端点（GET 只回 credId + updatedAt，凭据本体永远不回传）；schedule/update 对 credRefs 做存在性检查（缺的 `409 CREDENTIAL_NOT_FOUND` 点名）、credRefs.chat 与内联同传 `400`；fire 解析顺序为表 → 内联兜底 → `CREDENTIAL_MISSING` 常规重试；`ctx.scheduleTask()` 自排任务复制引用而不是凭据本体；fire hook ctx 新增 `resolveLlmCredential(credId)`（每次返回新对象，供宿主取非 chat 用途的副 API）；任务投影带 `credRefs`；capabilities 新增 `'llm-credentials'`。D1 / pg / neon 适配器都实现了新表，自定义适配器需补四个方法（缺则相关端点 501）。

  客户端 SDK：新增 `putLlmCredentials()` / `listLlmCredentials()` / `deleteLlmCredentials()`；`scheduleMessage` / `updateMessage` 的 payload 原样透传 `credRefs`。

## 2.9.0-next.8

### Minor Changes

- 5e75d69: `subscribePush()` 认出并重订浏览器给的死 endpoint，订阅成功就是真能收到推送

  刚 `unsubscribe()` 过又马上 `subscribe()` 时，Chromium 那边旧订阅的待删除标记还没清干净，这一小段窗口期里它不去推送服务要新地址，而是直接给一个 `https://permanently-removed.invalid/...` 的占位订阅。`.invalid` 是 RFC 2606 保留顶级域，全球 DNS 永不解析。这种订阅结构上完全正常——有 endpoint、有密钥、`getSubscription()` 也认得——之前会被原样返回、登记到服务端，之后所有推送必然发不出去。表现是最难查的那一种：用户看到「订阅成功」，服务端也存下了，两边都没有任何报错，只是到点什么都收不到。

  现在 `subscribePush()` 返回的订阅保证 endpoint 是活的：拿到占位订阅就先退掉它，等浏览器把标记清干净再重订，最多试三次（间隔 800ms、1600ms）。

  - 三次都是占位订阅时抛错，`err.code === 'PUSH_ENDPOINT_ZOMBIE'`，`err.details` 为 `{ attempts, endpoint }`。SDK 不产出面向用户的提示文案——那句话该怎么说、用什么语言，由接入方按自己的产品和用户群决定。
  - `pushManager.subscribe()` 自己抛的错（用户拒了通知权限、运行环境没有 Push API、VAPID 公钥不合法）原样往外抛，不重试：重试只会把同一个错误多抛两遍。
  - 第一次就拿到活 endpoint 时只调一次 `subscribe()`，不产生任何额外等待，与之前一致。

### Patch Changes

- Updated dependencies [a384a93]
- Updated dependencies
  - @rei-standard/amsg-shared@0.4.0-next.4

## 2.9.0-next.7

### Minor Changes

- 17741db: 新增 `GET /message` 单条任务查询；`update-message` 认 `contactName`

  - **`GET /message?id=<uuid>`（客户端 `client.getMessage(uuid)`）** 返回单条任务，形状与 `GET /messages` 列出来的一样，外加**完整的 `metadata`**。`PUT /update-message` 对 `metadata` 是整体替换（不深合并），而列表的投影只给 `charId` / `clientTaskId` 两个子字段——两件事凑在一起，「只改 metadata 里的一个键」是做不到的：拿不回完整的那份就没法读-改-写，盲传一部分会把宿主存在里面的其余键（任务指令、锚点时间戳、过期策略之类）一起冲掉，下次触发直接失败。列表维持不带整份 metadata：一页最多 100 条，每条都驮着它会把响应撑得很大，而列表要的只是「有哪些任务」。单条查询只读得到还没发出去的任务，已完成 / 已失败返回 `409 TASK_ALREADY_COMPLETED`、不存在返回 `404 TASK_NOT_FOUND`，与 `PUT /update-message` 同一口径。

  - **`PUT /update-message` 的可写字段加上 `contactName`**（非空字符串，口径与排程时一致；空串 / `null` / 非字符串返回 `400 INVALID_UPDATE_DATA`）。用户给角色改了名之后，之前排好的任务推送出来的通知标题（「来自 `<contactName>`」）靠它跟着改。`contactName` 不是 key——宿主按角色过滤用的是 `metadata.charId`，它会跨角色重名——数据库里也只活在加密 payload 中，没有独立列或索引引用它。

  `GET /capabilities` 的 features 追加 `get-message-detail` / `update-message-contact-name`。

## 2.9.0-next.6

### Minor Changes

- d6bea67: 推送订阅改成用户级的一份，任务不再携带它

  - **新增 `push_subscriptions` 表与 `PUT` / `GET` / `DELETE /push-subscription` 三个端点。** 一个用户一份订阅，落库前用 per-user key 加密；`GET` 返回 `{ exists, updatedAt, endpoint }`，不含订阅的密钥部分。内置的 D1 / pg / neon 适配器都实现了对应的 `getPushSubscription` / `upsertPushSubscription` / `deletePushSubscription`，`initSchema()` 会建表；自定义适配器缺任何一个，这三个端点返回 501。
  - **任务不再携带订阅，到点投递时现读那一份。** 订阅冻结在每条任务里的话，用户清站点数据 / 重装 PWA / 推送服务轮换 endpoint 之后，每条老任务都拿着一个已死的订阅，而「刷新订阅」只能按客户端本地已知的任务清单逐行 PUT——它不知道的任务（角色在 fire 里给自己排的那些）就永远刷不到，成了死循环：推不出去 → 状态记不下来 → 客户端不知道这条任务存在 → 更刷不到它。现在覆盖用户级那一份就全好了，已排的任务一条都不用碰。
  - **`POST /schedule-message` 与 `PUT /update-message` 都不收 `pushSubscription` 字段**（带了返回 `400 PUSH_SUBSCRIPTION_NOT_ACCEPTED`）：静默丢弃会让人以为「这条任务用的是我传的这个订阅」。排程时这个用户还没登记订阅 → `409 PUSH_SUBSCRIPTION_MISSING`，建了也永远发不出去。投递时读不到订阅 → 任务按投递失败处理，原因记进 payload 的 `lastError`，`GET /messages` 上看得见。
  - **`ctx.scheduleTask()` 建的任务同样不携带订阅**，也不需要继承——到点读的就是当时最新的那份。
  - **客户端 SDK 新增** `putPushSubscription(subscription, opts?)` / `getPushSubscription()` / `deletePushSubscription()`。`putPushSubscription` 直接收 `pushManager.subscribe()` 的结果（内部取 `toJSON()`），什么时候调：拿到订阅之后一次，之后每次应用启动确认订阅仍然有效时再一次（幂等覆盖）。
  - **`GET /capabilities` 的 features 追加** `user-push-subscription`。

### Patch Changes

- Updated dependencies [d6bea67]
  - @rei-standard/amsg-shared@0.4.0-next.3

## 2.9.0-next.5

### Patch Changes

- 9d1f89f: 补齐许可证文件：每个包根目录加入 MIT LICENSE 文本（此前 package.json 声明 MIT 但 tarball 里没有许可证文件）。仓库层面确立双许可——代码 MIT、`standards/` 规范文本 CC BY-NC-SA 4.0，根 README 的许可一节与 npm 元数据不再互相矛盾。
- c064ecd: 修复发布产物里损坏的 .d.ts：四个包此前用 tsup `dts: true` 处理 .js 入口，发出去的 .d.ts 是 JS 源码原文，TS 消费者 import 即报错。现改用 shared 同款两步构建（tsup 出 JS + `tsc --allowJs --emitDeclarationOnly` 出真声明），subpath 导出（server `./cloudflare`、instant `./adapters/*` `./blob/*`）的声明文件一并对齐。

  amsg-server 另含两处加固：pg / neon 适配器的动态 UPDATE 列名补上与 D1 一致的白名单校验（此前直接插值进 SQL）；清理死代码（未引用的 `REQUIRED_COLUMNS`、`timingSafeEqualBytes`、schedule-message 的死分支与重复注释）。amsg-sw 清理 `createNotificationFromPayload` 永不触发的两处假值守卫。

- Updated dependencies [3dae842]
- Updated dependencies [8ca959c]
- Updated dependencies [ef2f2d1]
- Updated dependencies [6ead0c4]
- Updated dependencies [b146fde]
- Updated dependencies [9d1f89f]
  - @rei-standard/amsg-shared@0.4.0-next.2

## 2.9.0-next.4

### Minor Changes

- f13f2f1: `GET /capabilities` 特性探测端点 + 客户端 `getCapabilities()`

  worker 部署版本落后时，新功能只是「探测不到」而不是静默失效。单用户 worker 新增 `GET /capabilities`，返回 `{ serverVersion, features }`（feature 名如 `client-state` / `client-state-chunking` / `agentic-hooks`，随版本演进追加；表达代码能力，不反映部署配置）；鉴权与 `/vapid-public-key` 一致。客户端 SDK 新增 `getCapabilities()`：打到没有该路由的老 worker（404）返回 `null` 不抛错，前端可据此在设置里提示「worker 需要重新部署」。

### Patch Changes

- Updated dependencies [f13f2f1]
  - @rei-standard/amsg-shared@0.4.0-next.1

## 2.9.0-next.3

### Minor Changes

- a26b797: 新增 client_state 三方法，对接单用户 worker 的云端状态镜像（amsg-server 2.6.0 的 `/client-state` 端点）。

  - `putClientState(entries)`：批量 upsert。一次请求发完全部变更（照顾 iOS 切后台前只有几秒的存活窗口）；请求体走既有加密链路（需先 `init()`），服务端按 `updatedAt` 最后写赢，重发旧批次无害。
  - `getClientState(namespace)`：取一个 namespace 的全部条目，自动解密响应 envelope（同 `listMessages`）。
  - `clearClientState()`：清空该用户全部云端状态（给设置页「清除云端状态」这类入口用）。

  配了 `serverToken` 时三个方法都带 `X-Client-Token`。

## 2.9.0-next.2

### Patch Changes

- Updated dependencies [914ddcf]
  - @rei-standard/amsg-shared@0.4.0-next.0

## 2.9.0-next.1

### Minor Changes

- 7630754: 单用户 worker 暴露 VAPID 公钥端点，供前端跨源订阅。

  - amsg-server：单用户 Worker 新增 `GET /vapid-public-key`，返回本 Worker 自己的 `VAPID_PUBLIC_KEY`（未配置时返回 503 `VAPID_NOT_CONFIGURED`）。和其它端点共用同一套 CORS 与 `serverToken` 校验。前端拿它作为 `applicationServerKey` 来创建 Web Push 订阅——各自部署的 worker 各有各的 VAPID，公钥在运行时从 worker 拉取。
  - amsg-client：新增 `ReiClient.getVapidPublicKey()`，GET 该端点并返回公钥字符串（配了 `serverToken` 时带上 `X-Client-Token`）。

## 2.9.0-next.0

### Minor Changes

- 19c264c: 新增可选 `serverToken`：配置后，client 会在 amsg-server 端点（schedule / messages / update / cancel / user-key / init）的请求上带 `X-Client-Token` 共享密钥，用于单用户部署的访问校验。instant 路径不受影响，仍使用 `instantClientToken`。

## 2.8.0

### Minor Changes

- 5c0e047: `avatarUrl` 本地预检改用 `@rei-standard/amsg-shared` 的统一校验，与 server / instant 对齐。现在非法（非 `data:`）URL —— 例如缺少协议的 `foo.com/a.png` —— 也会在客户端被 `console.warn` 并置空；此前 client 只检查 `data:` 与长度，会放行这类 URL（之后由服务端兜底置空）。软清空策略不变：装饰性字段不合法时只做清空，不会让整条请求失败。

### Patch Changes

- Updated dependencies [5c0e047]
  - @rei-standard/amsg-shared@0.3.0

## 2.7.0 — `deliver()` 新增 `compressRequest` 请求体 gzip 压缩

给 `deliver()` 加一个**可选**的 `compressRequest`，把要发出去的请求体在上网线之前 gzip 压一下。中文 + 重复结构的 JSON 压缩比很高（实测 ~322KB 能压到 ~50KB），网线上字节小了，大 body 在慢/不稳的上行链路上就能在「发了没回应就杀」的超时之前传完。压的是**请求**，不是响应；上下文内容一字不动，只是传输层省字节。

不传 = 关闭 = 行为完全不变（向后兼容）。SSE 与 JSON 两条 transport 共用同一请求体，压缩对两者一致生效。解压由接收端（worker）负责，客户端只压不解。

### New

- 新增 `deliver()` 选项 `compressRequest`：
  - 不传 / falsy ⇒ 关闭，照常发明文 JSON。
  - `true` 或 `{}` ⇒ 启用，阈值取默认 **16384 字节（16 KB）**。
  - `{ thresholdBytes: N }` ⇒ 启用并自定义阈值。
- 启用后**仅当**请求体 UTF-8 字节数超过阈值、**且**运行时有 `CompressionStream` 时才压缩；否则原样发明文（优雅降级，压缩过程任何异常都兜回明文，绝不让它把发送搞挂）。
- 压缩时请求体发**原始 gzip 字节**，并加自定义头 `X-Amsg-Request-Encoding: gzip`（特意不用标准 `Content-Encoding`——那个会被 CDN / 代理自动解压导致双重解压）。接收端据此头自行 gunzip。

## 2.6.0 — `deliver()` 新增 `onRawRead` 原始读遥测钩子

给 `deliver()` 加一个**可选**的 `onRawRead` 钩子，专供排查 SSE 链路用。SSE transport 每次 `reader.read()` 后回调，把原始字节信息交给调用方，便于回答「连接静默期里到底有没有字节真的到达客户端」这类问题。

不传 = 行为完全不变；SSE 解析逻辑（含 `:` 注释行的处理）一字未动。

### New

- 新增 `deliver()` 选项 `onRawRead(meta)`：SSE transport 每次 `reader.read()` 之后触发，`meta` 含 `ts` / `byteLength` / `done` / `textPreview`（本次数据解码后的前 120 字符，**保留 `:` 注释行**，能看到平时被解析层跳过的 keepalive 帧）；首帧额外带 `status` / `contentEncoding` / `contentType` 三个响应元信息。
- 钩子抛错被吞，不影响送达主流程；`textPreview` 用独立 decoder 取样，不干扰流式解析。

## 2.5.0 — `deliver()` 平台无关送达 primitive

把"发出去"和"业务上是否真送达"在 API 层显式分开。新增 `client.deliver()` 作为新代码的首选入口；老的 `sendInstant()` / `consumeInstantStream()` 仍可用但降级为低级 transport，配 opt-in dev warning 引导迁移。SSE 与 JSON 两条 transport 一并升级到统一的送达协调层，调用方无需感知。

`2.5.0-next.0` 先发在 `next` dist-tag 跑了一轮 SullyOS 等接入方的端到端验证（iOS PWA / SW 双通道实战），无回归后 graduate 到 `latest`。

### New

- 新增 `client.deliver(payload, opts)`：单一入口，根据响应 `Content-Type` 自动选 SSE 或 JSON transport，与 caller 提供的「观察通道 `Promise<ObservedDeliveryReceipt>`」做 race + grace，返回 `DeliveryResult` 含五值 `outcome`（`delivered` / `cancelled` / `timeout` / `send-failed` / `completed-unconfirmed`）。
- 观察通道是 **平台无关 Promise**：库不绑 Service Worker / IndexedDB / Web Push / 任何具体后端，调用方自己把 SW 广播、IPC、原生桥、轮询、自定义通道包成 Promise 即可。
- `delivery` 用 discriminated union 显式声明 `mode: 'observed' | 'transport-only'`，不允许「传永不 resolve 的 Promise 假装在 observed 模式」的写法。
- `outcome:'delivered'` 仅 observed 模式可达，且必须 receipt identity 校验通过（receipt 至少含 `messageId` 或 `sessionId` 之一的非空字符串）；invalid receipt 视为「观察从未触发」继续 race，杜绝并发串单。
- `outcome:'cancelled'` 独立于 `timeout` / `send-failed`：caller `signal.abort()` 触发；但若 grace 内仍观察到 receipt，会改报 `delivered` + `detail.cancelledByCaller: true`（iOS 切回前台后 push 仍接力的实战场景）。
- `outcome:'timeout'` 在 observed 模式 + transport 干净结束 + observation 未接力 时，额外带 `detail.observationChannelStalled: true`——观察通道挂了不等于发送失败。
- `outcome:'send-failed'` 仅在 transport 有 captured error **且** 观察通道也没接力时触发。
- `outcome:'completed-unconfirmed'` 仅 transport-only 模式专用，明确标注「best-effort 乐观，无真相信号」。
- Pre-flight `signal.aborted` 检查：进入时若已 aborted，直接返回 `cancelled`，不下发 fetch。
- `postTransportGraceMs` 默认 = `min(remainingBudget, max(5000, timeoutMs * 0.1))`：5s 下限 + 10% 比例，跨 30s / 300s / 多分钟 timeout 都有合理 grace。
- `onChunk`（可选 SSE 每帧 UI 钩子）抛错被捕获进 `detail.chunkHandlerError`，**不**升级 outcome 到 `send-failed`——UI 钩子失败是 caller-bug-shaped。

### Soft-deprecated（仍可用，文档与 warning 引导迁移）

- `sendInstant()` JSDoc 改标 **Low-level JSON dispatcher**，提示 「HTTP 200 ≠ delivery confirmation」当 backup push 开启时。
- `consumeInstantStream()` JSDoc 改标 **Low-level SSE consumer**，提示 「rejection ≠ delivery failure」当 backup push 开启时。
- 两者新增可选 `opts.expectsBackupPush`：
  - `true` → 实例 + 方法首次调用时 `console.warn` 一次（migration 审计用）
  - `false` → 显式表示「我知道这点」永久静音
  - 不传 → 不警告
- 没有立刻 `@deprecated`，留两个 minor 缓冲到 3.0.0。

### 内部重构（行为字节不变）

- 抽取私有 `_buildInstantRequest` / `_runInstantTransport` / `_consumeSseStream`，`sendInstant` / `consumeInstantStream` / `deliver` 三条路径共用。
- SSE 解析逻辑与 2.4.0 byte-identical（多行 `data:` 用 `\n` 拼接、`event: done` 优先、EOF 视为 done、`event: error` 解 JSON 抛带 `code` 的 Error）。

### Migration

| 旧写法                                                                              | 新写法                                                                                                                                        |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `try { await consumeInstantStream(p, '/instant', { onPayload }) } catch { fail() }` | `const r = await deliver(p, { delivery: { mode: 'observed', observed }, timeoutMs, onChunk: onPayload }); if (r.outcome !== 'delivered') ...` |
| `const r = await sendInstant(p); if (!r.success) fail()`                            | `const r = await deliver(p, { delivery: { mode: 'observed', observed }, timeoutMs }); if (r.outcome === 'send-failed') ...`                   |
| `sendInstant(p, '/instant', { authorization: 'Bearer ...' })`                       | `deliver(p, { delivery, timeoutMs, authorization: 'Bearer ...' })`                                                                            |

详见 README 的 `deliver()` 标准用法与「为什么需要 `deliver()`」段。

### 发布前 review 期修复（折叠进 2.5.0）

Self-review 时（仿 ultrareview 多角度分派）抓到的 correctness 修复，均不破前面任何 API：

- **SSE 帧分隔**：原 `buffer.split('\n\n')` 在 CRLF 服务端（.NET / IIS / 某些 CDN）下永远拼不到分隔符，全流静默丢。改成先 `\r\n?` → `\n` 整 buffer 归一化再 split，覆盖 `\r\n\r\n` / `\n\n` / `\r\r` 与跨 chunk seam 的混合行尾。
- **SSE EOF flush**：流结束时漏 `decoder.decode()` 收尾 + 漏处理无尾随空行的最后一帧。两处都补上，避免跨 chunk 的 UTF-8 多字节字符丢字节、最后一帧静默丢。
- **本地校验错误不再被埋**：`PAYLOAD_TOO_LARGE_LOCAL` / 加密未初始化等本地错误现在直接从 `deliver()` 抛出，不再被吞进 IIFE 变成 `outcome:'send-failed'` + `detail.transportError`。请求构造提前到 race 启动之前。
- **post-return 写穿防护**：observed 模式赢 race 后，仍在跑的 transport IIFE 不再有机会改 caller 已持有的 `detail`（`finalized` 闸口同步关）。
- **caller signal listener 卸载**：每个终态都会 removeEventListener，长生命周期 `AbortController` 跨 N 次调用不再累积 2N 个 stale 闭包。
- **abort 微任务窗口竞态**：pre-flight 与 listener 注册之间窗口内 abort 触发时，新注册的 listener 不会 fire（DOM spec），现在 addEventListener 后会再查一次 `signal.aborted` 并补触发。
- **transport-only + cancel 不再 linger**：`mode: 'transport-only'` 下 caller abort 之后直接返回，不再死等 grace/2 拿一个永远不会到的 observation。
- **`deliver()` 接受 `opts.authorization`**：从 `sendInstant({authorization})` 迁过来时不会再静默丢 header。
- **结构化 JSON Content-Type**：`application/problem+json` / `application/vnd.api+json` 这类 structured-suffix variant 现在被识别为 JSON。
- **JSDoc 写明 cancel grace `/2`**：`postTransportGraceMs` 注释明确 cancel 路径生效的是 `grace/2`（一半留给清理）。

依赖与外部接口零变更；以上全部在 `client` 包内部完成，并加了 9 条 regression 测试覆盖。

### Codex review 后追加的修复（同样折叠进 2.5.0）

走完一轮 9-angle self-review 之后，又请 Codex 独立读了一遍 working tree，抓到 7 个我漏的：

- **transport-only 模式 transport 结束后仍然等 grace**：之前只 fix 了 cancel 路径，post-transport-ended 路径还在白等（`timeoutMs: 60_000` 默认会多卡 ~5s）。observed mode 才有观察通道值得等，transport-only 直接按 transport 结果出 outcome。
- **abort 期间 `_buildInstantRequest` 仍可能发 fetch**：pre-flight 只查了一次，但 build 是 async（加密走 Web Crypto 会 await），signal 在 build 中途 abort 会被吞，仍走 fetch。现在 build 完成后再查一次 `signal.aborted`，aborted 就直接返回 cancelled 不下发请求。
- **post-transport grace 期间 abort 被忽略**：transport 先结束后，late-receipt 等待只 race `validatedObserved` + 自己的 timer，没 race `cancelledP`。caller 在 grace 期间 abort 会被错报成 timeout / send-failed。现在 grace 等待跟 cancel signal 一起 race，abort 赢就报 cancelled。
- **SSE CRLF 跨 chunk seam 仍然破**：第一轮修了 `\r\n\r\n` 的统一归一化，但当真实 CRLF 正好被分到两个 chunk（chunk1 末尾 `\r`、chunk2 开头 `\n`），原 normalize 会把 chunk1 的 trailing `\r` 提前变成 `\n`，再跟下一个 chunk 拼成 `\n\n` 误判帧边界。修：把 trailing `\r` 留到下一 chunk 再统一归一化。
- **`onChunk` 抛错跨 deliver-return mutate detail**：上轮防了 transport IIFE 的 `detail.transportResponse` 写穿，但 `wrappedOnChunk` 的 catch 仍直接写 `detail.chunkHandlerError`，observed 赢 race 返回后 onChunk 延迟 throw 仍能改 caller 持有的 detail。现在 `chunkHandlerError` 写入也 gate 在 `finalized`。
- **Content-Type 用 substring 不是 media-type 解析**：`application/json; note=text/event-stream` 这种参数里带其他媒体类型的会被错认。改成严格 media-type 解析：先用 `;` 切参数、trim、lowercase，再 exact match + structured-suffix 正则。`consumeInstantStream` 的 SSE 检查也一并改成走 `classifyContentType`。
- **`NEVER_SETTLES` 共享 sentinel 累积 Promise reactions**：`Promise.race` 每次都给那个全局永不 settle 的 Promise 挂 reaction，长生命周期页面会持续累积。改成条件式构造 race 数组——transport-only 不参 observed/`validatedObserved`，无 signal 不参 cancelledP，整个 `NEVER_SETTLES` 常量直接删掉。

测试集相应扩到 55 条，覆盖以上每个修复 + transport-only 短路 + 跨 chunk seam 的真 CRLF 场景；之前自己写的 5 条直接动 `globalThis.fetch` 的测试也改成走 `installFetch()` restore 模式，避免污染更大 suite。

### 正式版补丁（折叠进 2.5.0）

- **`sendInstant()` 显式带 `Accept: application/json`**：默认 `Accept: */*` 会落到 amsg-instant 的 SSE 分支，随后的 `res.json()` 在 SSE 字节流上抛 SyntaxError。`sendInstant()` 是声明回 JSON 的入口，header 一并钉死。
- **`expectsBackupPush` 文档与代码对齐**：JSDoc 与 warn 文案此前宣称 "Pass `expectsBackupPush: false` to silence"，实际 `false`、不传都是静默，`true` 才会触发一次性 warn。文案改成 opt-in dev reminder，默认静默，不再误导调用方。
- **去掉 `_urlBase64ToUint8Array`**：与 `@rei-standard/amsg-shared` 的 `base64UrlToBytes` 逐字节重复（已有 `atob` + Node `Buffer` 双兜底），改 import shared 版本。
- **模块级 `TEXT_ENCODER`**：`_encrypt` 与 `_assertPayloadSize` 此前每次都 `new TextEncoder()`。`TextEncoder` 是无状态的，提到 module top 复用，跟 instant / sw 对齐。

## 2.4.0 — `consumeInstantStream()` SSE consumer

配套 `@rei-standard/amsg-instant@0.9.0` 的 SSE 默认模式；同时移除 client 默认请求体大小上限，避免本地误拦长上下文请求。

### New

- 新增 `consumeInstantStream(payload, endpointPath?, options)`，按 SSE frame 解析 `event: payload` / `event: error` / `event: done`，并分发到 `options.onPayload`。
- 新增构造器选项 `maxPayloadBytes?: number | null`。默认 `null`，不再由 client 对请求体大小做本地限制；显式配置后，超限请求仍抛 `PAYLOAD_TOO_LARGE_LOCAL`。
- `@rei-standard/amsg-shared` 精确依赖升级到 `0.2.0`，同步 `notification.silent` 类型/校验能力。

### Changed

- 移除默认请求体大小上限。Web Push 单条回复超限仍由 `amsg-instant` 的 BlobStore / multipart 输出链路处理；client 只保留 `avatarUrl` 软清空，避免 data URI 头像把最终 push 撑爆。

### Docs

- `consumeInstantStream` 章节校正：原文写 "SSE 写失败 / 断开才 fallback push"，但 `amsg-instant 0.9.0` 起 Web Push backup 是 **always-on**——SSE 成功 enqueue 也照样发一份同 `messageId` 的 backup，由 SW / client dedupe 收敛。README 改成 "SSE 直送 + Web Push always-on backup + dedupe" 的双路语义；"fallback" 在文档里收窄回它本来该指代的含义（stream 不可用 / enqueue 抛错时的兜底）。仅文档，行为不变。

## 2.4.0-next.0 — `consumeInstantStream()` SSE consumer (pre-release)

发布在 `next` dist-tag。配套 `@rei-standard/amsg-instant@0.9.0-next.0+` 的 SSE 默认模式；老的 `sendInstant()` 字节级不变。

### 新增 `consumeInstantStream(payload, endpointPath?, options)`

POST 到 amsg-instant 的 `/instant` 或 `/continue` 端点，按 SSE frame 解析 `event: payload` / `event: error` / `event: done`，分发到 `options.onPayload` 回调；可被 `options.signal` 中止。

```js
await client.consumeInstantStream(payload, "/instant", {
  onPayload: async (p) => routeToIDB(p), // 必填
  onError: (err) => log(err), // 可选；通知用，不抑制 throw
  onDone: () => stopSpinner(), // 可选
  signal: abortController.signal, // 可选
});
```

错误语义：网络 / 协议 / abort / `onPayload` 抛错都会让返回的 Promise reject。`onError` 是**通知性 side-channel**（fire 后照常 throw），不是 try/catch 替代——总是 `await` + 外层 `try/catch` 处理。

加密 / 明文两种 transport 共享构造器配置（`instantEncryption` / `instantClientToken`），用法和 `sendInstant` 一致。请求体跟 `sendInstant` 完全一样——包括必须的 `pushSubscription`（SSE 写失败时框架会用它做 fallback push）。

### Spec 细节

- 多行 `data:` 按 SSE 规范用 `\n` 拼接（不是后写覆盖）
- 非 2xx / 非 `text/event-stream` 响应立即 throw，不进 parser
- 出错时 `reader.cancel(err)` 关闭底层连接，避免 fetch stream 残留至 GC
- AbortError 与其他错误一视同仁走 reject——caller 用 `signal` 主动取消时也能拿到 rejection

## 2.3.0 — Dependency bump

- 依赖更新：同步升级 `@rei-standard/amsg-shared` 至稳定版 `0.1.0`。

## 2.3.0-next.1 — avatarUrl 本地软清空 (pre-release)

Cherry-pick stable `2.2.4` 的本地 `avatarUrl` 软清空到 next 预发布线。`scheduleMessage` / `sendInstant` / `updateMessage` 不合法的 `avatarUrl`（`data:` URI / 长度 > 2048 / 非字符串）改为 `console.warn` + 在 payload 上置 `null`（`updateMessage` 路径走 `delete` 以保留服务端原头像），请求继续发送。`Error.code === 'INVALID_AVATAR_URL_LOCAL'` 已移除；当时版本的本地请求体体积预检保留不变，稳定版 2.4.0 已改为可选 `maxPayloadBytes` 且默认不限制。详见 `2.2.4` stable 条目；与 `@rei-standard/amsg-server` 2.4.0-next.1 / `@rei-standard/amsg-instant` 0.8.0-next.1 / `@rei-standard/amsg-sw` 2.1.0-next.1（SW 标题 fallback 至 `来自 {contactName}`）同步。

`next.0` → `next.1` 行为变化只此一项；shared push types re-exports 部分**完全不动**。

## 2.3.0-next.0 — Shared push types re-exports (pre-release)

Published under the `next` dist-tag (repo convention for prereleases). Coordinated with the other amsg sub-packages' `*-next.0` releases. Install with `npm install @rei-standard/amsg-client@next`. Schema is locked; the next-tag window is for downstream integrators to validate end-to-end before this graduates to `latest`.

---

Coordinated minor across the whole amsg ecosystem (shared 0.1.0 / instant 0.7.0 / server 2.3.2 / sw 2.x). The client itself does not send or receive pushes — it only talks to amsg-server / amsg-instant over HTTP — but caller apps that build the client and also handle pushes (typically in a Service Worker) used to need a second dependency on `@rei-standard/amsg-shared` to get the canonical kind/type/source constants, builders, and type guards. 2.3.0 collapses that into a single import surface.

### New

- Re-exports from `@rei-standard/amsg-shared` 0.1.0:
  - **Runtime constants**: `MESSAGE_KIND` (`CONTENT` / `REASONING` / `TOOL_REQUEST` / `ERROR`), `MESSAGE_TYPE` (`INSTANT` / `FIXED` / `PROMPTED` / `AUTO`), `PUSH_SOURCE` (`INSTANT` / `SCHEDULED`).
  - **Builders**: `buildContentPush`, `buildReasoningPush`, `buildToolRequestPush`, `buildErrorPush`.
  - **Type guards**: `isContentPush`, `isReasoningPush`, `isToolRequestPush`, `isErrorPush`.
  - **JSDoc type aliases**: `MessageKind`, `MessageType`, `PushSource`, `AmsgPush`, `ContentPush`, `ReasoningPush`, `ToolRequestPush`, `ErrorPush`.

One import surface — caller apps that consume `ReiClient` and also handle pushes (e.g. in a Service Worker) no longer need a separate dep on `@rei-standard/amsg-shared`. Everything is reachable from `@rei-standard/amsg-client`.

### Compatibility

- Zero runtime behavior change. `ReiClient` API is byte-for-byte unchanged — no method signatures, request shapes, or error codes were touched.
- The re-exports are tree-shake-friendly (shared package is `sideEffects: false`). Bundlers that ship `ReiClient` only will not pull in the builders.

### Dependencies

- Adds `@rei-standard/amsg-shared` at exact `0.1.0` (no caret). Part of the coordinated minor; pinned so a future shared minor cannot silently slip in via `npm install` without a matching client release.

### Migration

- No caller-side action needed. Strictly additive.
- Apps that already depend on `@rei-standard/amsg-shared` directly can keep that dep or drop it in favor of importing from `@rei-standard/amsg-client` — both routes resolve to the same module instance because npm dedupes the exact-pinned `0.1.0`.

## 2.2.3 — 2026-05-18

### Fix

- **本地预校验 `avatarUrl` + payload 体积**（配合 [`@rei-standard/amsg-instant` 0.6.1](../instant/CHANGELOG.md#061--2026-05-18) / [`@rei-standard/amsg-server` 2.3.1](../server/CHANGELOG.md#231--2026-05-18)）：之前 `scheduleMessage` / `sendInstant` / `updateMessage` 是纯 payload-agnostic 透传，业务把 `data:image/...;base64,xxx` 当 `avatarUrl` 传进来，client 会先 AES-GCM 加密、再 POST 出去，绕一圈才在远端拿到 `413` 或 Web Push 4KB 上限报错。当时三个方法在发请求之前做两项本地预检；稳定版 2.4.0 已把请求体体积预检改为可选 `maxPayloadBytes`，默认不限制：
  - **avatarUrl**：拒 `data:` URI、拒长度 > 2048 字符、必须是字符串。违规 → 抛 `Error` with `.code === 'INVALID_AVATAR_URL_LOCAL'`。
  - **payload 体积**：超过当时内置本地阈值会抛 `Error` with `.code === 'PAYLOAD_TOO_LARGE_LOCAL'`，附 `.details = { actualBytes, limitBytes, method }`。此固定阈值在 2.4.0 起不再默认启用。
- 两个 code 都带 `LOCAL` 后缀，方便业务和远端返回的 `INVALID_PARAMETERS` / `INVALID_PAYLOAD_FORMAT` 区分（一个不耗远端配额，一个耗）。
- 错误 message 只写「是什么 + 怎么改」（如「头像不支持传入 data: URI，请改为公网可访问的 https:// 图片 URL」），不写「为什么」—— 触发原因写在本 CHANGELOG / README，避免错误对话框塞一整段背景说明。

### Compatibility

- 业务**几乎零修改**：除非之前真的在传 `data:` URI 当 avatarUrl，或命中了当时版本的固定本地体积预检，否则升级无感。
- 加密格式、headers、endpoint、响应 schema 全部不动。
- `scheduleMessage` / `sendInstant` / `updateMessage` 的返回类型不变；新增的两类错误**只在抛出时**才出现。

## 2.2.2 — 2026-05-18

### Docs

- README 加 `splitPattern` 字段说明，配合 `@rei-standard/amsg-instant@0.6.0+` / `@rei-standard/amsg-server@2.3.0+` 自定义分句正则。client 是 payload-agnostic 透传（`JSON.stringify(payload)`），所以**无代码改动**——业务直接把 `splitPattern: string | string[]` 放进 `sendInstant` / `scheduleMessage` 的 payload，Worker / Server 端会自己校验和应用。

## 2.2.1 — 2026-05-17

### Docs

- README 加 `messages` 模式示例，配合 `@rei-standard/amsg-instant@0.5.0+` / `@rei-standard/amsg-server@2.2.0+` 的 OpenAI 格式 messages 数组转发。client 是 payload-agnostic 透传（`JSON.stringify(payload)`），所以**无代码改动**，只更新文档说明。

## 2.2.0 — 2026-05-16

### Added

- 构造选项 `instantEncryption` (boolean, default `true`) 与 `instantClientToken` (string, optional)。
- `instantEncryption: false` 时 `sendInstant()` 直接 POST 明文 JSON，配套 `@rei-standard/amsg-instant@0.2.0`。`init()` 在该模式下变 no-op。
- 明文模式下构造时可省略 `userId`（默认加密模式仍强制要求）。
- 明文模式下若配 `instantClientToken`，请求会带 `X-Client-Token` 头（弱鉴权 —— token 随 bundle 走前端，devtools 一开就能看到，只防 URL 直怼）。

### Unchanged

- 默认 `instantEncryption: true`，行为与 2.1.0 完全一致（兼容 amsg-instant 0.1.x 与 amsg-server `schedule-message` 路径）。
- `scheduleMessage` / `listMessages` / `updateMessage` / `cancelMessage` / `subscribePush` 仍走加密路径，不受新选项影响。
- 加密模式下 `init()` 行为完全不变。

## 2.1.0 — 2026-05-16

### Added

- `client.sendInstant(payload, endpointPath?, opts?)` — sends a one-shot instant message via `@rei-standard/amsg-instant`. Uses the same `userKey` fetched by `init()`, the same AES-256-GCM envelope, and the same `X-User-Id` / `X-Payload-Encrypted` / `X-Encryption-Version` headers as `scheduleMessage`. Accepts an optional `Authorization` header passthrough for deployments that enable amsg-instant's `tokenSigningKey`.
- New constructor option `customBaseUrls` — a per-endpoint base URL override map (key = endpoint name, e.g. `instant`). Falls back to `baseUrl` when an endpoint name is not present. Set this when an endpoint is deployed separately (e.g. `instant` on Cloudflare Workers while the rest run on Netlify). This is a general mechanism — future endpoints can be overridden with the same field instead of adding more `*BaseUrl` constructor options.

### Deprecated (soft)

- `client.scheduleMessage({ messageType: 'instant', ... })` — still works for backward compatibility (it routes through amsg-server's `/schedule-message` endpoint, which creates a task → processes → deletes the task in one round-trip). New code should prefer `sendInstant()` which skips the DB round-trip entirely.

## 2.0.1

(See git history.)
