# Changelog — @rei-standard/amsg-server

## 2.6.0-next.10

### Minor Changes

- 73afa4f: 补发新鲜度守卫、循环任务不进终态、退避写租约、occurrence 级 push id、发送后 hook、update-message 认凭据字段

  - **补发新鲜度守卫：错过触发时刻超过 60 分钟的任务不再照常补发。** 服务停摆几天恢复后，cron 捞到的旧任务按「错过了」处理，不把积压一口气倒给用户：
    - 一次性任务：不发，行标 `failed`，原因记在 payload 的 `lastError`（`{ at, occurrence, reason: 'stale' }`）上，`GET /messages` 每条任务随之多返回一个 `lastError` 字段（没有记录 → `null`）。同时调用新增的可选 hook `ctx.onStaleSkip?.(task, { reason: 'stale', metadata })`（单用户 worker 从 config 的 `onStaleSkip` 透传），宿主用它写「这条错过了」的回执。`task` 是任务行原样（payload 是密文）；`metadata` 是解密 payload 里的 `metadata` 子字段（没有则为 `null`），宿主靠它对上是哪个角色的任务——解密 payload 里的 `apiKey` / `pushSubscription` 等凭据不会递给 hook。hook 抛错只记日志，不影响主流程。
    - daily / weekly 任务：不发，`next_send_at` 快进到未来第一个名义时刻（保持钟点不变），`retry_count` 归零，行保持 `pending`。
    - 正在重试链上的任务（`retry_count > 0`）不算过期：它的 `next_send_at` 一直是名义时刻，重试拖过一小时不等于用户错过了它。
    - tick 返回值的 `details` 多一个 `staleTasks` 数组（`{ taskId, reason, action: 'expired' | 'fast_forwarded' }`）。
  - **循环任务永不进终态：终审失败改为跳过本次 occurrence。** daily / weekly 任务重试用尽时不再标 `failed`（发送成功但发送后写库失败的场景也不再标 `sent`）——两种终态都会让循环任务从此退出捞取、每日消息无声消失。现在这两条路都改为：`next_send_at` 从名义时刻推进到下个周期、`retry_count` 归零、错误记在 payload 的 `lastError` 上（`GET /messages` 可见）。一次性任务维持既有终态行为。
  - **重试退避改写在租约上，`next_send_at` 全程保持名义时刻。** 投递失败安排重试时，退避时刻写进 `lease_until`（捞取条件里的租约过滤到点自然放行），不再改写 `next_send_at`。循环任务的推进基准、hook 拿到的 `nextSendAt`、过期判定因此都始终对着用户设的触发时刻，不会每失败一次漂几分钟。没实现 `claimTask` 的自定义适配器没有租约列，维持老行为（退避写进 `next_send_at`）。
  - **默认 messageId / sessionId 掺入名义触发时刻。** 有任务行的推送，默认 id 变为 `msg_task_<id>@<occurrenceMs>_<i>`（agentic 路径为 `..._hook_<i>`）与 `sess_task_<id>@<occurrenceMs>`，`occurrenceMs` 取 `Date.parse(task.next_send_at)`。循环任务跨天复用同一行，之前的 id 只含 task.id，离线设备一次性收到多天积压推送（push TTL 四周）时会在 service worker 端互相去重、收件箱按 messageId 覆盖，几天的消息只剩一条；掺入名义时刻后每个 occurrence 一套 id，同一 occurrence 的重试仍复用同一套（重投已送达的段照旧被去重）。调用方在 pushPayloads 里显式带了 `messageId` / `sessionId` 时仍以调用方为准；行上没有可解析的 `next_send_at` 时保持旧格式。
  - **新增发送后 hook `ctx.onAfterSend?.({ task, sentCount, total, error })`。** agentic 路径的 pushPayloads 逐段发完（或中途发挂）后调用（单用户 worker / `createSingleUserServer` 从 config 的 `onAfterSend` 透传）。载荷带 `task`（任务行本身）：tick 内最多 8 个任务并发投递，宿主按任务写回执时靠它对号入座。全部成功时 `error` 为 `null`；第 k 段失败时 `sentCount = k`、`error` 带原始错误，且 hook 会在错误往上抛之前调用完。宿主用它把「真的发出去了几段」写回自己的存储——发送前的 hook（`onBeforeFire` / `onLLMOutput`）写的副作用，在推送全挂时会变成「云端记得说过、用户没收到」。hook 自身抛错只记日志，不影响主流程。
  - **`PUT /update-message` 认 `apiUrl` / `apiKey` / `primaryModel` / `pushSubscription` 四个字段。** 消费方换了聊天 API 配置或重新订阅推送后，已挂任务里冻结的旧值可以刷新掉了（此前这四个字段不在合并白名单里，传了会被静默丢弃）。校验口径与 `schedule-message` 一致：前三个只要求 truthy，`pushSubscription` 带值时必须是对象（否则 400 `INVALID_UPDATE_DATA`）。四个字段都是 truthy 合并——传 `null` 不清空、只是忽略（清掉任何一个，任务到点就发不出去）。
  - **`GET /capabilities` 的 features 追加** `tick-stale-guard` / `recurring-skip-occurrence` / `occurrence-scoped-push-ids` / `after-send-hook` / `update-message-credentials`，前端可以据此判断部署的 worker 认不认这些行为。

### Patch Changes

- 3dae842: LLM 调用器收敛到 shared：新模块 `shared/src/llm-call.js` 承载「构造请求体 + fetch + 超时 + 解析响应 + trim」的公共核心，从包根导出 `callLlm` / `buildLlmRequestBody` / `normalizeAiApiUrl`

  此前 instant（`message-processor.js` 的 `callLlmRaw`）与 server（`lib/llm.js` 的 `callLlm`）各写一份 LLM HTTP 调用，已出现漂移（stream 字段、messages 模式探测、超时可配性、trim 位置）。现在单一来源在 shared，两侧差异走 options 参数化（`stream` / `forwardTools` / `timeoutMs` / `fetch` / `requireContent`），instant 与 server 的调用点改薄，各自的导出名（instant 的 `normalizeAiApiUrl`、server 的 `callLlm` / `buildAiRequestBody` / `normalizeAiApiUrl`）与错误码包装不变。`llm.js` 里「两包各自拷贝以避免架构依赖」的过期注释一并删除——两包都已依赖 shared，该理由不再成立。

  行为变化（均为边缘修正）：

  - instant：messages 模式探测统一为 `Array.isArray(payload.messages) && payload.messages.length > 0`（server 语义）。`messages: []` 从「把空数组原样发给上游 LLM」改为「回退 completePrompt 模式」——这是修正错误行为。经公开 handler 不可触达（校验层已拒绝空 messages），仅影响直接调用 `processInstantMessage` 的调用方。
  - instant：`maxTokens` 非法时的错误文案统一为 server 措辞（`Invalid maxTokens: maxTokens must be a positive integer when provided.`）。handler 校验在前，正常路径不可触达。
  - server：`normalizeAiApiUrl` 对非字符串输入统一为 instant 的宽松语义（先 `String()` 强转再解析；此前直接抛「apiUrl is required」）。字符串输入两侧行为本就一致，不受影响。
  - server：`callLlm` 现接受额外 options（`fetch` / `stream` / `forwardTools`），默认值即原 server 语义，既有调用不受影响。

- ef2f2d1: messages 数组形状校验统一到 amsg-shared，修复 amsg-server 误拒 agentic 会话的 bug。

  - amsg-shared 新增 `validateLlmMessagesShape(messages)` 与 `LLM_MESSAGES_ERROR` 错误码常量（新模块 `src/llm-messages.js`）：返回结构化错误（稳定 code + 定位索引），支持 assistant 带 `tool_calls` 时 content 可空、`role:'tool'` 要求 `tool_call_id` 的 OpenAI 协议形状。
  - amsg-instant 的 `validateMessagesArray` 改为调用 shared 实现的薄封装，导出名、错误文案与返回形状不变。
  - amsg-server 的 `validateLlmMessagesArray` 同样改为调用 shared 实现。修复：此前该函数缺少 tool_calls / tool 消息分支，注释却声称与 amsg-instant lockstep，导致 agentic 会话（assistant tool_calls + tool 结果）回放到 `scheduleMessage` / `updateMessage` 会被 400 拒绝；现在与 amsg-instant 接受完全相同的形状。畸形 tool 消息新增对应英文错误文案（`tool_calls[j] is malformed` / `tool_call_id is required` 等）。

- 6ead0c4: crypto / 编码 utils 收敛到 shared：新模块 `shared/src/webcrypto-utils.js` 承载全生态唯一一份 runtime-neutral 帮手（`toUint8` / `concatBytes` / `utf8` / `utf8Decode` / `bytesToBase64` / `bytesToBase64Url` / `base64UrlToBytes` / `jsonToBase64Url` / `bytesToHex` / `hexToBytes` / `hmacSha256` / `timingSafeEqualBytes` / `randomBytes` / `randomUUID`），index 聚合导出（`utf8Decode` / `bytesToBase64` / `bytesToHex` / `hexToBytes` / `timingSafeEqualBytes` / `randomUUID` 为 shared 新增导出）。instant 的 `src/utils.js` 与 server 的 `lib/webcrypto-utils.js` 改为纯 re-export（文件与导出名不变，包内引用不受影响）；server 的 tenant token 模块也换用 shared 的 base64url / 常量时间比较实现（编码逐字节一致，HMAC 因同步 API 约束仍走 node:crypto）。
- b146fde: Web Push 加密栈上移 amsg-shared，instant / server 共用同一份实现

  此前 amsg-instant 的 `src/webpush.js` 与 amsg-server 的 `lib/webpush-webcrypto.js` 是逐字相同的两份拷贝（RFC 8030 传输 / RFC 8291 aes128gcm / RFC 8292 VAPID，纯 WebCrypto）。现在实现只有一份，放在 amsg-shared 的独立模块 `src/webpush.js`，从包根导出：

  - `sendWebPush` / `buildVapidJwt` / `verifyVapidJwt`
  - 顺带上移它依赖的 runtime-neutral 帮手：`utf8`、`bytesToBase64Url`、`jsonToBase64Url`、`hmacSha256`、`randomBytes`

  instant 与 server 的对应模块变薄，re-export shared 实现；两个包的公开导出面与 wire format 不变。server 独有的部分原样保留在自己包里：payload 大小护栏（`measurePushPayload` / `MAX_PUSH_PAYLOAD_BYTES` 等，`sendWebPush` 超限仍抛 `PUSH_PAYLOAD_TOO_LARGE`）、scheduled 默认 4 周 TTL 与 `createWebCryptoWebPush`。

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

## 2.6.0-next.9

### Minor Changes

- 13c98b7: fire hook 能给自己排后续任务：ctx 上新增 `scheduleTask`

  - `onBeforeFire` / `onLLMOutput` / `executeToolCalls` 的 ctx 上多一个 `scheduleTask(options)`，在这次 fire 里给同一个用户再建一条定时任务（「这条发完，一个半小时后再接着说一句」）。建出来的是一条正常的任务行，到点由 cron 触发，用户离线也不影响。写口在 `onLLMOutput` 的 ctx 上也给，是因为「要不要接着说」往往是看完这轮 LLM 输出才定的。
  - 凭据与投递配置（`pushSubscription` / `apiUrl` / `apiKey` / `primaryModel` / `maxTokens` / `temperature` / `splitPattern`）以及 `contactName` / `avatarUrl` / `messageSubtype` / `userMessage` 从当前任务继承，宿主只提供「什么时候、说什么方向」，全程看不到凭据。`completePrompt` / `messages` 不继承（都置 `null`）：hook 每次现场重组 prompt，把排程时冻结的旧 prompt 带过去，新任务万一走回冻结 prompt 老链路就会静默顶替宿主的意图。
  - 返回 `{ created: true, id, uuid, nextSendAt }`；`uuid` 撞车时返回 `{ created: false, reason: 'duplicate', uuid }` 而不是抛错——fire 失败会整条重跑，宿主传一个由「任务 id + 触发时刻」推出来的确定性 uuid 就天然幂等。
  - 护栏：`firstSendTime` 必填且至少比当前晚 60 秒（cron 一分钟一跳，排得更近等于让下一跳立刻捡走）；`messageType` 只收 `auto` / `prompted` / `fixed`；`fixed` 必须有 `userMessage`；单次 fire 最多建 2 条，factory 配置 `maxScheduledTasksPerFire` 可调（`0` 表示不许自排）；数据库适配器没有 `createTask` 时抛 `AGENTIC_SCHEDULE_UNSUPPORTED`，不静默成功。
  - `GET /capabilities` 的 features 随之多一个 `agentic-schedule-task`，前端可以据此判断部署的 worker 认不认这条链路。

## 2.6.0-next.8

### Minor Changes

- ee17456: fire 循环支持声明工具：`onBeforeFire` 的返回值可以带 `tools`

  - `onBeforeFire` 返回对象时新增两个可选字段：`tools`（OpenAI 的 tools 数组）和 `toolChoice`。本次 fire 的每一轮 LLM 请求都会原样带上它们——补完那轮模型仍可能再发起调用，所以不是只带第一轮。此前循环只做了协议的下半场（给 assistant 补 tool_calls、配对 `role:'tool'` 结果），请求体这半边没有出口，宿主没有办法让模型走原生 function calling。库不解析 tools 的内容，执行仍然是 `executeToolCalls` 的事。
  - `tools` 是空数组时不进请求体：部分 OpenAI 兼容中转把 `tools: []` 当协议错误直接拒掉。
  - `GET /capabilities` 的 features 随之多一个 `agentic-fire-tools`，前端可以据此判断 worker 部署版本认不认这条链路。
  - 修掉 assistant 补章的一个问题：模型自带的 tool_calls 与文本协议合成的调用同轮出现时，两边的 id 现在合并起来一起写在 assistant 上。此前只保留其中一边，另一边的 `role:'tool'` 结果就没有归属的 `tool_call_id`，严格的中转会拒掉下一轮请求。

## 2.6.0-next.7

### Minor Changes

- 79da9e4: fire 时刻的 hook 能往 client_state 写了：`ctx.writeState(namespace, entries)`

  `onBeforeFire` / `onLLMOutput` / `executeToolCalls` 三处 ctx 上都有它，和已有的 `ctx.readState()` 配成一对。写口在后两处也给，是因为「这条内容太大、塞不进 push」往往到工具跑完、组 pushPayloads 时才知道，那时 `onBeforeFire` 早已返回。

  ```js
  await ctx.writeState("bypass", [
    { key: "note-42", value: JSON.stringify(detail) }, // 整条覆盖写
    { key: "note-41", value: null }, // 删掉这个 key
  ]);
  // → { upserted, skipped, deleted }
  ```

  - 落库走的是 `PUT /client-state` 那条路径的同一份实现：per-user key 加密、超过 200KB 自动分块、覆盖写清掉旧切片。所以 hook 写下的东西客户端 `GET /client-state` 能原样读回，反过来也一样。
  - `updatedAt` 不给就取当前时刻，语义仍是 last-write-wins：比库里已有值旧的写入或删除不生效（记在 `skipped` 里），客户端后写的数据不会被这次 fire 盖回去。
  - 限制与 HTTP 端点同一套：单条 `value` 默认 5MB（`maxStateValueBytes` 可调）、单次 ≤ 200 条、namespace / key 不能带控制字符。不合规当场抛 `TypeError` / `RangeError`，一条也不落库；适配器不支持 `client_state` 时抛 `AGENTIC_STATE_WRITE_UNSUPPORTED`（写不进去必须让 hook 知道，不能静默成功）。
  - **谁清、什么时候清**：库不做 TTL 也不自动回收，写进去的东西一直在。旁路内容建议放在固定的少量 key 上，下次写同一个 key 直接覆盖；一次性的大内容在确认客户端取走后用 `{ key, value: null }` 删掉，切片行会跟着一起清干净。

  适配器接口的 `upsertClientState` 第三参 `cleanups` 多认一种形态：`{ namespace, key, updatedAt }` 按精确 key 删（原来的 `{ namespace, keyPrefix, updatedAt }` 按前缀删不变）。删单条状态必须走精确匹配，否则 `note` 的删除会连带删掉 `notes`。D1 适配器已实现；自定义适配器不认这种形态的话 `writeState` 的删除会失效。

  `GET /capabilities` 的 features 追加 `agentic-write-state`。

- f1c6104: Web Push payload 加大小护栏，并导出预算用的常量与工具函数

  推送服务（FCM / APNs / Mozilla autopush）限的是**加密后** body 的 4096 字节，超了直接 413。之前库里对 payload 长度没有任何检查，超限的消息一路发到推送服务被拒 → 投递失败 → 重试三次 → 任务标 failed，用户完全收不到，只有服务端日志里有痕迹。

  现在 `sendWebPush` 在加密前就挡下来，抛出 `err.code === 'PUSH_PAYLOAD_TOO_LARGE'` 的错误，消息里带实际字节数和上限（`err.bytes` / `err.maxBytes` 也可直接读）。

  明文额度是 4096 减掉 aes128gcm 的固定开销——header 86（salt 16 + record size 4 + keyid 长度 1 + 应用服务器公钥 65）+ 填充分隔符 1 + GCM auth tag 16 = 103 字节——即 **3993 字节**，按 UTF-8 计。新增导出（包根与 `/cloudflare` 两个入口都有）：

  - `MAX_PUSH_PAYLOAD_BYTES` — 3993，一条 push 的明文上限
  - `WEB_PUSH_MAX_BODY_BYTES` — 4096，推送服务对密文 body 的上限
  - `WEB_PUSH_ENCRYPTION_OVERHEAD_BYTES` — 103，aes128gcm 固定开销
  - `measurePushPayload(payload)` — 返回 `{ bytes, maxBytes, remainingBytes, withinLimit }`，组 payload 前量骨架、算还能塞多少

  ```js
  const { remainingBytes } = measurePushPayload(
    JSON.stringify({ ...basePush, message: "" })
  );
  const message =
    body.length <= remainingBytes ? body : body.slice(0, remainingBytes);
  ```

  装不下的内容走旁路：正文存进 `client_state`（单用户 Worker 的 hook 用 `ctx.writeState()`），push 里只带引用键，客户端上线后 `GET /client-state` 取回。

## 2.6.0-next.6

### Minor Changes

- 579394d: 定时触发改为「先占位再投递」，同一条任务不会被相邻几跳重复发出

  cron 一分钟一跳、跳与跳之间互不相让，而一次投递「组 prompt → 调 LLM → 跑工具 → 推送」跑过一分钟很常见。之前每跳都是一条裸 SELECT 捞待发任务，任务行在整个投递期间一直是 `pending` 且时间已过，于是同一条任务会被后面几跳反复捞出来重跑，用户那边收到好几遍。

  现在每条任务开跑前先占位：在这一行的 `lease_until` 上写下「归我管到现在 + 租期为止」，本次投递期间别的 tick 领不走它；占位改到 0 行说明别人先领走了，本次直接跳过。跳过的条数记在 tick 返回值的 `details.claimSkippedTasks` 里。

  租期默认 10 分钟，配了 `totalTimeoutMs` 的按它 + 2 分钟往上抬，也可以用 `claimLeaseMs` 自己定。租期要盖住最慢的一次投递；同时它也是「投递中途进程没了之后、这条任务多久能被接手」的等待时间。

  `next_send_at` 不参与占位，全程是用户设的那个触发时刻：任务列表读到的是它，循环任务推进下一次以它为基准，hook 的 `ctx.task.nextSendAt` 也是它。投递收尾时租约就放掉，失败重试的退避（2 分钟起）不会被租期压住。

  **表结构**：`scheduled_messages` 新增一列 `lease_until`（SQLite `TEXT` / Postgres `timestamptz`，可空）。`initSchema()`（包括 `POST /init-tenant`）会给已有的表补上这一列，跑几次都没事。手工维护表结构的话，D1 执行 `ALTER TABLE scheduled_messages ADD COLUMN lease_until TEXT`，Postgres 执行 `ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS lease_until TIMESTAMP WITH TIME ZONE`。

  适配器接口新增可选的 `claimTask(taskId, expectedNextSendAt, leaseUntil)`，D1 / pg / neon 三个内置适配器都已实现；实现了它的适配器，`updateTaskById` 还要认 `lease_until` 字段（含写 null）。自定义适配器不实现 `claimTask` 也能跑，只是回到不占位的行为。

## 2.6.0-next.5

### Minor Changes

- ca31c9e: onBeforeFire 新增 `{ skip: true }` 出口：在第一次 LLM 调用之前结束本次 fire

  宿主在 fire 时刻就能判断这条消息已经多余（比如排程之后对话又有了新进展）时，`onBeforeFire` 返回 `{ skip: true }` 即可作废本次触发。这次 fire 算作一次零推送的成功投递（`status: 'skipped'`）：一次性任务照删、循环任务照推进到下次，且不调用 LLM、不消耗 token。

  返回 `null` 的既有语义不变（回退到排程时冻结的 completePrompt 老链路）。

- 81133e4: `GET /messages` 每条任务额外返回 `charId` / `clientTaskId`（取自任务 metadata 的 `charId` / `amsgClientTaskId`，缺省为 null），供宿主按角色归属筛选任务。metadata 的其余字段不回传，凭据类字段照旧不回传。

## 2.6.0-next.4

### Minor Changes

- f13f2f1: fire 级 scratch：hook 之间传上下文不再自己维护 Map

  单次 fire 开始时库创建一个空对象，`onBeforeFire` 的 fireCtx 和同一次 fire 里每轮 `onLLMOutput` / `executeToolCalls` 的 sessionCtx 都拿到同一个 `scratch` 引用；fire 结束（finish / skip-push / 抛错 / 轮数超限）后随之丢弃。不落库、不进日志、不跨 fire 共享。amsg-shared 的 `buildSessionContext` 新增可选 `scratch` 参数（不传则字段缺席，amsg-instant 行为不变）。

- f13f2f1: `GET /capabilities` 特性探测端点 + 客户端 `getCapabilities()`

  worker 部署版本落后时，新功能只是「探测不到」而不是静默失效。单用户 worker 新增 `GET /capabilities`，返回 `{ serverVersion, features }`（feature 名如 `client-state` / `client-state-chunking` / `agentic-hooks`，随版本演进追加；表达代码能力，不反映部署配置）；鉴权与 `/vapid-public-key` 一致。客户端 SDK 新增 `getCapabilities()`：打到没有该路由的老 worker（404）返回 `null` 不抛错，前端可据此在设置里提示「worker 需要重新部署」。

- f13f2f1: client_state 大值透明分块 + 整批局部失败（单用户 worker）

  - `PUT /client-state` 单条 value 不再受 200KB 整批 413 的限制：超过 200KB 的值由服务端切片跨行存储，`GET /client-state` 与 hook 的 `ctx.readState()` 返回拼好的原值，客户端和 hook 作者无感。单条总上限默认 5MB，工厂配置 `maxStateValueBytes` 可调。切片在码点边界（中文 / emoji 不会被劈开）；覆盖写变小不残留旧切片；块不齐全（写到一半断了）时该 key 视为不存在，读方走自己的兜底。
  - 整批局部失败：批里某条超限 / 非法只拒它自己，其余照常入库。有拒绝时响应带 `data.rejected: [{ index, namespace, key, code, message }]`；全部成功时响应形状与之前完全一致。
  - namespace / key 里的控制字符（`\u0000`-`\u001f`）为库内部保留，逐条拒绝。
  - adapter 的 `upsertClientState` 新增可选第三参 `cleanups` 与返回值 `outcomes`；自定义 adapter 不实现也能工作（只损失存储卫生，不影响正确性）。
  - `DELETE /client-state` 返回的 `deleted` 计数包含内部切片行（有分块值时会大于逻辑条目数）。

### Patch Changes

- Updated dependencies [f13f2f1]
  - @rei-standard/amsg-shared@0.4.0-next.1

## 2.6.0-next.3

### Minor Changes

- 914ddcf: 单用户 / Cloudflare 模式新增「fire 时刻现场生成」能力：

  - 新表 `client_state`（init-tenant 幂等建表）+ 三个端点：`PUT /client-state` 批量上传状态（按 `updatedAt` last-write-wins，单条 value ≤ 200KB）、`GET /client-state?namespace=` 读取、`DELETE /client-state` 清空。value 用 per-user key 加密落库，鉴权与加密头沿用现有端点。
  - `createSingleUserCloudflareWorker` 的 config 接受可选 `hooks: { onBeforeFire, onLLMOutput, executeToolCalls }` 与 `maxToolIterations`（默认 5）、`totalTimeoutMs`（默认 240000，两者都可在 onBeforeFire 返回值里按次覆盖）。配置后，AI 类任务在触发时由 onBeforeFire 现场组装 messages（可经 `ctx.readState(namespace)` 读 client_state），工具在 worker 内就地执行、多轮循环闭环后推送成品；onLLMOutput 的 ctx 与 decision 契约与 `@rei-standard/amsg-instant` 的同名 hook 一致，instant 的 classifier 可直接复用（`tool-request` 同时接受 `toolCalls` 直传与 tool_request pushPayloads 两种形状）。
  - 不配 hooks、或 onBeforeFire 返回 null 时，任务照走排程时冻结的 completePrompt 老链路；固定文本任务永远走老链路。hook ctx 不含 apiKey / pushSubscription / VAPID。多租户入口（Netlify/Neon）行为不变。

### Patch Changes

- Updated dependencies [914ddcf]
  - @rei-standard/amsg-shared@0.4.0-next.0

## 2.6.0-next.2

### Minor Changes

- 926f633: `/cloudflare` 路径去掉 node `crypto` 依赖，载荷加密改用 Web Crypto。单用户 Worker 现在可以用 esbuild `--platform=neutral` 打成自包含单文件直接粘进 Cloudflare Dashboard，不再需要 `nodejs_compat` 兼容开关（示例 wrangler.toml 已同步去掉该 flag）。

  - `lib/encryption.js` 的 5 个导出（`deriveUserEncryptionKey` / `encryptPayload` / `decryptPayload` / `encryptForStorage` / `decryptFromStorage`）改为基于 `globalThis.crypto.subtle` 实现。线格式与旧实现逐字节兼容——老数据、老客户端不受影响，并有跨实现互通测试钉住。
  - 迁移注意：这 5 个函数全部从同步改为 async，直接 import 它们的调用方需要补 `await`。
  - `randomUUID` 改从 runtime-neutral 的 webcrypto helper 获取，不再 import node `crypto`。
  - 多租户入口（Netlify/Neon）行为不变。

## 2.6.0-next.1

### Minor Changes

- 7630754: 单用户 worker 暴露 VAPID 公钥端点，供前端跨源订阅。

  - amsg-server：单用户 Worker 新增 `GET /vapid-public-key`，返回本 Worker 自己的 `VAPID_PUBLIC_KEY`（未配置时返回 503 `VAPID_NOT_CONFIGURED`）。和其它端点共用同一套 CORS 与 `serverToken` 校验。前端拿它作为 `applicationServerKey` 来创建 Web Push 订阅——各自部署的 worker 各有各的 VAPID，公钥在运行时从 worker 拉取。
  - amsg-client：新增 `ReiClient.getVapidPublicKey()`，GET 该端点并返回公钥字符串（配了 `serverToken` 时带上 `X-Client-Token`）。

## 2.6.0-next.0

### Minor Changes

- 19c264c: 新增单用户模式：可在单个 Cloudflare Worker 上运行，定时消息存 D1、定时投递由 CF Cron Trigger 触发，无需多租户注册表 / Blob / tenant token。新增导出 `createSingleUserServer`、`createSingleUserCloudflareWorker`、`createD1Adapter`、`runScheduledTick`、`createWebCryptoWebPush`（Worker 上可用的纯 Web Crypto Web Push）。可选 `serverToken` 共享密钥，配置后所有 amsg-server 端点校验 `X-Client-Token`。

  Worker 从子路径入口 `@rei-standard/amsg-server/cloudflare` 导入：该入口只含单用户 + D1 + Web Crypto 推送那条路径，不牵扯 pg / neon / web-push，只装了 D1 的环境也能打包通过。可跑通的示例见 `examples/cloudflare-single-user/`。

## 2.5.3

### Patch Changes

- 5c0e047: VAPID subject 规范化支持 `https:` 形式：RFC 8292 允许 subject 使用 `https:`，规范化时按原样保留，不另加 `mailto:` 前缀。reasoning 私有思考过滤、`avatarUrl` 校验、VAPID subject 规范化统一改用 `@rei-standard/amsg-shared` 的实现。
- Updated dependencies [5c0e047]
  - @rei-standard/amsg-shared@0.3.0

## 2.5.2 — in-server instant 路径恢复为一等公民

- **文档**：移除 `schedule-message` 中 `messageType: 'instant'` 两处 JSDoc 的 `@deprecated Soft-deprecated` 标记；该路径（create task → process by UUID → delete task）现以正式支持路径身份记录，不再携带弃用暗示。
- **注释**：`message-processor` 模块头及行内注释中的 "legacy in-server instant" 措辞统一改为 "in-server instant path"（中性术语）。
- **选型说明**：JSDoc 与 README 补充两条 instant 路径各自的适用场景——本端点的 DB 路径任务落库后投递不绑连接生命周期，适合长时间生成 / 零丢失；`@rei-standard/amsg-instant` 无状态、纯 SSE + Web Push，适合能在断连宽限期内（Deno Deploy 实测 ≈20-30s）跑完的短任务。不再有"新代码请改用"的导流建议。
- 运行时行为不变，无 breaking change。

## 2.5.1 — `<think>` 不再泄进 ContentPush

- **Fix**: `readReasoningContent` 走 `<think>` / `<thinking>` / `<thought>` fallback 抽出 reasoning 后，`splitMessageIntoSentences` 拿到的还是原始字符串，私有 chain-of-thought 被同步当成 ContentPush 推送给用户。新增 `stripReasoningTags()` 并把 reasoning 抽取重排到 sentence-split 之前——命中 fallback 时把同一段从 `messageContent` 里剥掉再切句，与 `@rei-standard/amsg-instant` 0.9.1 保持镜像同步。

## 2.5.0 — Dependency bump

- 依赖更新：同步升级 `@rei-standard/amsg-shared` 至稳定版 `0.2.0`，让正式发版环境不解析出混版本 shared graph。
- 运行时行为不变；本包只是随 shared 的 `notification.silent` 类型/校验补齐做协调发版。

## 2.4.1 — readReasoningContent fallback

- **Enhancement**: `readReasoningContent` 添加 fallback 支持。当原生 `reasoning_content` 字段缺失时，会 fallback 检查 `message.content` 是否包含 `<think>...</think>`、`<thinking>...</thinking>` 或 `<thought>...</thought>` 并提取，提供对更多模型（例如 DeepSeek-R1-Distill）的原生兼容。

## 2.4.0 — Dependency bump

- 依赖更新：同步升级 `@rei-standard/amsg-shared` 至稳定版 `0.1.0`。

## 2.4.0-next.1 — avatarUrl 软清空 (pre-release)

Cherry-pick stable `2.3.3` 的 `avatarUrl` 软清空策略到 next 预发布线。把 2.3.1 引入的"严格 400"放宽为"`console.warn` + 把 `avatarUrl` 置空 + 继续"：`schedule-message` 不合法的 `avatarUrl` 在 payload 上置 `null`，`update-message` 把不合法字段从 patch 里 `delete`（旧头像保持不变）。`INVALID_PARAMETERS` / `INVALID_UPDATE_DATA` 不再为 `avatarUrl` 触发，其它字段错误码不变。详见 `2.3.3` stable 条目；与 `@rei-standard/amsg-instant` 0.8.0-next.1 / `@rei-standard/amsg-client` 2.3.0-next.1 / `@rei-standard/amsg-sw` 2.1.0-next.1（SW 标题 fallback 至 `来自 {contactName}`）同步。

`next.0` → `next.1` 行为变化只此一项；三轴 push schema 部分**完全不动**。

## 2.4.0-next.0 — Three-axis push schema + ReasoningPush (pre-release)

Published under the `next` dist-tag (repo convention for prereleases). Coordinated with the other amsg sub-packages' `*-next.0` releases. Install with `npm install @rei-standard/amsg-server@next`. Schema is locked; the next-tag window is for downstream integrators to validate end-to-end before this graduates to `latest`.

---

Coordinated minor across the whole amsg ecosystem. The server's push wire shape now follows `@rei-standard/amsg-shared`'s discriminated union, indexed by `messageKind`. LLM-driven paths (`prompted` / `auto` / the via-server `instant` path) also lift `choices[0].message.reasoning_content` into a first-class `ReasoningPush` ahead of the content burst.

### Breaking

- **Push wire shape now follows `@rei-standard/amsg-shared`'s `AmsgPush` union.** Every push carries `messageKind: 'content' | 'reasoning'` as a literal-type discriminator. `ContentPush` keeps every field the 2.3.x 13-field shape had (`title`, `message`, `contactName`, `messageId`, `messageIndex`, `totalMessages`, `messageType`, `messageSubtype`, `taskId`, `timestamp`, `source`, `avatarUrl`, `metadata`) — plus the new `messageKind: 'content'` discriminator and `sessionId`.
- **`sessionId` is now part of every push.** Server-emitted pushes use `sess_task_<task.id>` for scheduled rows (stable across retries) or `sess_<uuid>` when there is no task id (the legacy in-server instant path). Same `sessionId` is shared across the auto-emitted ReasoningPush and the entire ContentPush burst from one LLM round.

### New

- **Auto-emit `ReasoningPush` before the content burst** when the LLM response carries non-empty `choices[0].message.reasoning_content`. Applies to `prompted`, `auto`, and the legacy in-server `instant` path. `fixed` and explicit-`userMessage` paths produce no LLM response, so the reasoning step is naturally skipped.
- **Server-driven failures continue to flow through DB `status: 'failed'`** — server does NOT push an `ErrorPush` to clients. (This is the schema-unification release, not a behavior-expansion release; the in-band push error envelope is a separate feature shipped only by `@rei-standard/amsg-instant`.)

### Migration from 2.3.x

| 2.3.x                                      | 2.4.0                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| Hand-rolled 13-field `notificationPayload` | `buildContentPush({...})` from `@rei-standard/amsg-shared`                             |
| `messagesSent` reflects sentence count     | Unchanged — still sentence count. ReasoningPush is auxiliary, not counted.             |
| Push payload has no `messageKind`          | Push payload carries `messageKind: 'content'`. SW dispatch on `payload.messageKind`    |
| Push payload has no `sessionId`            | Push payload carries `sessionId`. Same id across ReasoningPush + ContentPush burst     |
| No reasoning push                          | If LLM returns non-empty `reasoning_content`, a separate `ReasoningPush` is sent first |

If you have a SW that hand-sniffs push fields, switch to the `messageKind` discriminator. If you have a client that pairs server-sent sentences (e.g. via `messageId` regex), use `sessionId` instead — it's stable and explicit.

### Dependencies

- Adds `@rei-standard/amsg-shared` at exact version `0.1.0` (no caret). The coordinated minor upgrade is intentionally strict — npm shouldn't resolve a mixed-version graph across the ecosystem.

## 2.3.2 — 2026-05-18

### Docs

- README 不再用 `../../../...` 跳层相对路径（在 npmjs.com 渲染时一律 404）。`standards/active-messaging-api.md`、`examples/vercel.json.example`、sibling `amsg-instant` README 改用绝对 GitHub URL，与原有「## 相关链接（绝对 URL）」小节保持同源。
- 「环境变量」小节展开：每个变量补一句说明（VAPID 邮箱 / 公私钥用途、`TENANT_CONFIG_KEK` 是用于加密 Blob 里租户配置的 KEK、`TENANT_TOKEN_SIGNING_KEY` 是 token HMAC 签名密钥、`INIT_SECRET` / `PUBLIC_BASE_URL` / `VERCEL_PROTECTION_BYPASS` 的触发条件），附 `openssl rand -base64 32` 生成命令和 `.env` 模板。
- 「v2.0.1 变更摘要」末尾加 pointer，指向规范 §6.1（`messages` 数组 / `splitPattern`）/ §6.2（`avatarUrl` 严格校验）—— 这些字段从 2.2.0 起陆续加入，未在该小节展开。

无代码变更，仅 README 重写。规范文档在仓库根的 `standards/active-messaging-api.md`（已同步到 v2.3）。

## 2.3.1 — 2026-05-18

### Fix

- **`avatarUrl` 严格校验**（与 [`@rei-standard/amsg-instant` 0.6.1](../instant/CHANGELOG.md#061--2026-05-18) 同步）：之前 `avatarUrl` 只检 `new URL(...)` 能不能 parse，导致 `data:image/...;base64,xxx` 这种 base64 内嵌头像也算合法 —— 一旦传进来，存进任务再随推送外发会膨胀几十 KB，触发下游 Web Push 服务的 4KB 硬上限或网关 `413 Payload Too Large`。`schedule-message` 与 `update-message` 现在统一：
  - 拒 `data:` 开头的 URI（不区分大小写）→ `400 INVALID_PARAMETERS` / `400 INVALID_UPDATE_DATA`，错误信息明示「头像不支持传入 data: URI（base64 内嵌图片会触发 413 / Web Push 4KB 上限），请改为公网可访问的 https:// 图片 URL」。
  - 拒长度 > 2048 字符的 URL → `400`，错误信息明示实际长度 + 上限 + 建议（CDN 缩略图）。
  - 仍要求 `new URL(...)` 能 parse。
  - `undefined` / `null` 仍然视为「未传」，零行为变化。
- 顶层 export `validateAvatarUrl(value)`：业务可在 SDK 之外做同步预校验，避免一次远端往返。

### Compatibility

- 2.3.0 调用者**几乎零修改**：除非之前真的在传 `data:` URI 当 avatarUrl（那本来就跑不通推送），否则升级无感。错误码 `INVALID_PARAMETERS` / `INVALID_UPDATE_DATA` 不变，加密格式、推送 payload 不动。
- 与 `@rei-standard/amsg-instant` 0.6.1 共享语义；两端独立实现但行为字节级一致。

## 2.3.0 — 2026-05-18

### New

- **`splitPattern` 自定义分句正则**（与 [`@rei-standard/amsg-instant` 0.6.0](../instant/CHANGELOG.md#060--2026-05-18) 同步）：`schedule-message` / `update-message` payload 新增可选 `splitPattern: string | string[]` 字段。
  - `string` → 单个正则 source（不带 flags），用 `new RegExp(splitPattern)` 编译后替代默认 `/([。！？!?]+)/`。
  - `string[]` → **级联**应用：先按数组首项切，每段再按下一项切，以此类推。适合分层切分（先按段落 `(\n\n+)`、再按句号 `([。！？!?]+)`）。
  - 不传 / `null` / `[]` → 走默认正则，行为字节级不变；老库存任务（无此字段）行为不变。
  - **限制**：每项 ≤ 200 字符，数组 ≤ 10 项，每项必须能 `new RegExp(...)` 通过。违规 → `400 INVALID_PARAMETERS`（schedule）/ `400 INVALID_UPDATE_DATA`（update）。
  - **捕获组约定**：想让分隔符回贴到前一段（与默认行为一致），把分隔符放进 `(...)` 捕获组。库不自动包裹。
  - 持久化：随 `fullTaskData` 一起加密落盘；`update-message` 用 `hasOwnProperty` 模式合并，显式传 `splitPattern: null` 可重置回默认。
- 顶层 export `validateSplitPattern(value)`：业务可在 SDK 之外做同步预校验。

### Compatibility

- 2.2.x 调用者**零修改**继续工作。DB schema、加密格式、推送 payload、错误码全部不动。2.2.x 直接升级即可。
- 与 `@rei-standard/amsg-instant` 0.6.0 共享语义；两端独立实现但行为字节级一致。

## 2.2.0 — 2026-05-17

### New

- **`messages` 数组转发**（与 [`@rei-standard/amsg-instant` 0.5.0](../instant/CHANGELOG.md#050--2026-05-17) 同步）：`schedule-message` / `update-message` payload 新增可选 `messages` 字段，与 `completePrompt` **互斥二选一**。`prompted` / `auto` / `instant` 三种 AI 配置消息全部支持。
  - 上游应用直接把标准 OpenAI 格式的 `[{role:'system',...}, {role:'user',...}, {role:'assistant',...}, ...]` 透传过来，`buildAiRequestBody` **原样**转给 LLM —— 不再被强行压成单个 user 消息。让定时消息 / 即时消息 / Worker instant 三条路径的 LLM 调用完全等价（system role、多轮历史、tool role 全保留）。
  - `content` 支持 `string` 或非空数组（多模态留口子，元素 schema 不深挖）。
  - role 限定 `system | user | assistant | tool`，违规 → `400 INVALID_PARAMETERS`。
  - 两者同时给、`messages` 为空数组、role 非法 → 全部 `400`。
  - 持久化层（加密 task data）同时存 `completePrompt` 和 `messages` 字段；`update-message` 切换 prompt source 时自动 null 掉另一个，保证存储一致性。
- **`temperature` 字段**：可选 number，会透传给 LLM。legacy `completePrompt` 路径无 temperature 时仍默认 0.8（保持旧行为）；`messages` 路径无 temperature 时**不发**，跟上游主路径完全一致。
- 顶层 export `validateLlmMessagesArray(messages)`：业务可在 SDK 之外做同步预校验。

### Compatibility

- 旧 `completePrompt` 调用者**零修改**继续工作。DB schema、加密格式、推送 payload 字段全部不动。2.1.x 直接升级即可。
- 与 `@rei-standard/amsg-instant` 0.5.0 共享语义；两端独立实现但行为字节级一致。

## 2.1.1 — 2026-05-17

### Improvements

- **`apiUrl` 智能规范化（幂等）**：`processSingleMessage` 链路里的 `normalizeAiApiUrl` 现在会自动补全 OpenAI 兼容的 chat 路径，**与 [`@rei-standard/amsg-instant`](../instant/CHANGELOG.md#040--2026-05-17) 0.4.0 完全同步**：
  - 裸 host（如 `https://api.openai.com`）→ 补 `/v1/chat/completions`
  - 末尾是 `/v1` / `/v2` 等版本段 → 只补 `/chat/completions`，**不会重复加 v1**
  - 已含 `/chat/completions` → 原样返回
  - Anthropic-shape `/v1/messages` 等自定义路径 → 不动
- 老调用者传完整 `…/v1/chat/completions` 仍然 work；逻辑严格幂等。
- `normalizeAiApiUrl` 现在作为 `src/server/lib/message-processor.js` 顶层 export（之前是私有），方便业务在 SDK 之外做同步预校验。

### Notes

- 协议字段零变更；DB schema、加密格式、推送 payload 字段全部不动。
- 与 amsg-instant 共享逻辑、但各持一份代码（避免 server → worker-pkg 的反向依赖）。任何后续规则变更都需要两边同步。

## 2.1.0 — 2026-05-16

### Changed

- `validateScheduleMessagePayload` no longer enforces a fixed `chat | forum | moment` enum for `messageSubtype`. The field is now validated as an optional string only; the taxonomy is the consumer's call (forwarded as-is to the SW push payload). This is purely a relaxation — any payload that was accepted before is still accepted; payloads with custom subtype strings (e.g. `'sms'`) now pass instead of being rejected with `INVALID_PARAMETERS`.

### Deprecated (soft)

- `messageType: 'instant'` on the `/schedule-message` endpoint. Functionality is preserved and behavior is **unchanged**; no runtime warnings, no breaking changes — purely a documentation-level recommendation. New code should prefer the new [`@rei-standard/amsg-instant`](../instant/README.md) package for a stateless, no-DB instant path.

  Source-level signal: the two `if (payload.messageType === 'instant')` branches in `src/server/handlers/schedule-message.js` now carry a JSDoc `@deprecated` block pointing to amsg-instant. The runtime path is otherwise byte-identical to v2.0.1.

## 2.0.1

(See git history.)
