# 单用户 amsg-server · Cloudflare Worker

定时消息存 D1，定时投递用 CF Cron Trigger。适合只有自己一个人用、想全程跑在 Cloudflare 上的场景。

## 跑通步骤

1. 建 D1 数据库，把返回的 id 填进 `wrangler.toml` 的 `database_id`：
   ```bash
   wrangler d1 create amsg
   ```
2. 建表（二选一）：
   - 命令行：`wrangler d1 execute amsg --file schema.sql`
   - 或部署后调一次 `POST /init-tenant`（幂等；配了 serverToken 要带 `X-Client-Token`）
3. 配 secrets：
   ```bash
   wrangler secret put AMSG_MASTER_KEY      # 随机 32 字节 hex，见下
   wrangler secret put VAPID_EMAIL          # 例如 mailto:you@example.com
   wrangler secret put VAPID_PUBLIC_KEY
   wrangler secret put VAPID_PRIVATE_KEY
   wrangler secret put AMSG_SERVER_TOKEN    # 可选：共享密钥，配了才校验 X-Client-Token
   ```
   生成 `AMSG_MASTER_KEY`：
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. 部署：`wrangler deploy`

## 端点

`/get-user-key`、`/schedule-message`、`/messages`、`/update-message`、`/cancel-message`、`/init-tenant`、`/vapid-public-key`、`/client-state`、`/push-subscription`、`/capabilities`。
**没有 HTTP `/send-notifications`**——定时投递由 CF Cron Trigger 直接触发 `scheduled()`。

`GET /vapid-public-key` 返回本 Worker 的 `VAPID_PUBLIC_KEY`，供前端创建 Web Push 订阅时作 `applicationServerKey`；未配置 VAPID 时返回 503。跟其它端点一样受 CORS 和 `serverToken` 约束。

`GET /capabilities` 返回 `{ serverVersion, features }`，给前端做特性探测：worker 部署版本落后时新功能只是探测不到，前端（`client.getCapabilities()`，打到老 worker 时返回 `null`）可以据此在设置页提示重新部署。feature 名如 `client-state` / `client-state-chunking` / `agentic-hooks`，随版本追加。

VAPID 和 webpush 都要配齐：定时投递（cron）和 `instant` 类型消息都靠它推送，缺了就发不出去。

## 推送订阅（/push-subscription）

这是啥：一份用户级的 Web Push 订阅。任务行不携带订阅，到点投递时读这一份。

为什么这么放：用户清了站点数据、重装了 PWA、或者推送服务轮换了 endpoint 之后，覆盖这一份就全好了。订阅冻结在每条任务里的话，得把任务一条条翻出来刷——而角色在 fire 里给自己排的任务客户端根本不知道存在，刷不到它，于是那条任务就永远推不出去了。

| 端点 | 语义 |
|------|------|
| `PUT /push-subscription` | 登记 / 覆盖。body =（加密后的）`{ subscription, updatedAt? }`，`subscription` 至少要有非空 `endpoint` |
| `GET /push-subscription` | `{ exists, updatedAt, endpoint }`（不含订阅的密钥部分） |
| `DELETE /push-subscription` | 删掉，设置页做「停止接收推送」按钮用 |

客户端侧：

```js
const sub = await client.subscribePush(vapidPublicKey, registration);
await client.putPushSubscription(sub);
```

`subscribePush()` 拿到订阅之后调一次；之后每次应用启动确认订阅仍然有效时再调一次（幂等覆盖）。

配套约束：

- 这个用户还没登记订阅时，`POST /schedule-message` 返回 `409 PUSH_SUBSCRIPTION_MISSING`——建了也永远发不出去。
- `POST /schedule-message` / `PUT /update-message` 都不收 `pushSubscription` 字段（带了 `400 PUSH_SUBSCRIPTION_NOT_ACCEPTED`）。
- 投递时读不到订阅 → 任务按投递失败处理，原因记进 `lastError`，`GET /messages` 上看得见。
- 表是 `push_subscriptions`（`user_id` 主键，`subscription` 密文，`updated_at` epoch 毫秒）。`POST /init-tenant` 会建，手工建表的看 `schema.sql`。

## 客户端状态同步（/client-state）

这是啥：一张给客户端存状态的云端表。客户端平时把要给「fire 时刻 hooks」用的数据（最近聊天摘要、设置项……存啥由你定）批量同步上来，worker 触发定时任务时就能读到最新状态。一份活状态，按 namespace 组织。

两个方向都通：客户端用下面的端点写、hooks 用 `ctx.readState()` 读；hooks 也能用 `ctx.writeState()` 往回写（比如把塞不进 push 的大内容存下来），客户端再用 `GET /client-state` 取回。两边写出来的数据同构，读的时候不分是谁写的。

| 端点 | 语义 |
|------|------|
| `PUT /client-state` | 批量 upsert。body =（加密后的）`{ entries: [{ namespace, key, value, updatedAt }] }`。`updatedAt` 是 epoch 毫秒，旧于库内的条目跳过（last-write-wins）；单条 `value` 默认最大 5MB（工厂配置 `maxStateValueBytes` 可调），单次 ≤ 200 条 |
| `GET /client-state?namespace=<ns>` | 取一个 namespace 的全部条目（解密后返回，响应加密） |
| `DELETE /client-state` | 清空该用户的全部状态（设置页做「清除云端状态」按钮用） |

`value` 是任意字符串（想存对象就自己 `JSON.stringify`），落库前用 per-user key 加密。鉴权和加密头跟其它端点完全一样。

大值不用自己切：超过 200KB 的 `value` 由 worker 切片跨行存储，读取（`GET` 和 hooks 的 `ctx.readState()`）拿到的是拼好的原值，客户端无感。批量上传里某条超限/非法只拒它自己，其余照常入库——有拒绝时响应带 `data.rejected`（逐条给 `index / namespace / key / code / message`），全部成功时响应形状不变。namespace / key 里不能带控制字符（`\u0000`-`\u001f`，库内部保留）。

### 从 hooks 里写：`ctx.writeState(namespace, entries)`

`onBeforeFire` / `onLLMOutput` / `executeToolCalls` 的 ctx 上都有它：

```js
await ctx.writeState('bypass', [
  { key: 'note-42', value: JSON.stringify(detail) },  // 整条覆盖写
  { key: 'note-41', value: null },                    // 删掉这个 key
]);
// → { upserted, skipped, deleted }
```

- `value` 是字符串就整条覆盖（不是追加，序列化自己来）；`value` 为 `null` 就删掉这个 key，连带它的分块切片行一起清干净。
- `updatedAt` 可以显式给（epoch 毫秒），不给就取当前时刻。规则和客户端同步一样是 last-write-wins：比库里已有值旧的写入或删除不生效（落在 `skipped` 里），客户端后写的数据不会被这次 fire 盖回去。
- 限制与 `PUT /client-state` 同一套：单条 `value` 默认 5MB（`maxStateValueBytes` 可调）、单次 ≤ 200 条、namespace / key 不能带控制字符。不合规当场抛 `TypeError` / `RangeError`，一条也不会落库。
- 数据库适配器不支持 `client_state` 时抛 `AGENTIC_STATE_WRITE_UNSUPPORTED`。写不进去必须让 hook 知道，否则 push 里带的引用键会指向不存在的数据。

**谁清、什么时候清**：写进去的东西一直在，库不做 TTL 也不自动回收。两种收尾挑一种——旁路内容放在固定的少量 key 上（比如每个角色一个），下次写同一个 key 直接覆盖，存量天然有上限；或者一次性的大内容在确认客户端取走之后，用 `{ key, value: null }` 删掉。两样都不做的话 D1 会一直涨。`DELETE /client-state` 是清空这个用户全部状态的兜底。

## Fire 时刻 hooks（服务端工具循环）

这是啥：默认情况下，AI 类任务的 prompt 在排程那一刻就冻结进数据库，cron 到点后拿冻结文本调一次 LLM 就推送——上下文停留在排程时。配置 hooks 后，worker 会在**触发那一刻**现场组装 prompt，LLM 要查资料时直接在 worker 里执行工具、多轮循环，最后推送成品，全程不需要客户端在线。

啥时候用：任务触发离排程隔得久（比如每周提醒）、希望消息基于最新状态生成，或生成过程需要查数据（配合 `/client-state`）。不配 hooks 一切照旧。

```js
export default createSingleUserCloudflareWorker((env) => ({
  // ...其余 config
  hooks: {
    // 触发时组装 prompt。返回 null 则这个任务走冻结 prompt 老链路。
    // ctx: { task, userId, readState(ns), writeState(ns, entries),
    //        scheduleTask(options), now, scratch }
    //   task 是解密后的任务字段（不含 apiKey；推送订阅是用户级的一份，
    //   根本不在任务 payload 里）；
    //   自定义字段排程时放 metadata 里，这里原样读回。
    //   scratch 是本次 fire 的便签对象：在这里塞的东西，同一次 fire 的
    //   onLLMOutput / executeToolCalls 从 ctx.scratch 拿到同一个引用；
    //   fire 结束即丢弃，不落库、不跨 fire 共享。
    async onBeforeFire(ctx) {
      const notes = await ctx.readState('notes'); // [{ namespace, key, value, updatedAt }]
      return [
        { role: 'system', content: '你是一个提醒助手。' },
        { role: 'user', content: `根据这些记录写一条提醒：${notes.map(n => n.value).join('\n')}` },
      ];
      // 也可以返回 { messages, maxToolIterations, totalTimeoutMs } 按次放宽预算
      // 返回值里带上 tools（OpenAI 的 tools 数组，可选 toolChoice），本次 fire
      //   每一轮 LLM 请求都会带着它们，模型可以走原生 function calling。
      //   tools 缺席、是空数组、或者压根不是数组，都按「这次不带工具」处理，
      //   toolChoice 也随之不发（它单独出现没有意义）。
      // 或返回 { skip: true }：这次不生成，零推送直接算成功结束（不调 LLM）。
      //   一次性任务照删、循环任务照推进到下次。适合排程后对话已有新进展、
      //   这条到点已多余的情况。
    },

    // 每轮 LLM 输出后分类。ctx 形状与 @rei-standard/amsg-instant 的
    // onLLMOutput 一致（sessionId / messages / llmResponse / llmOutputText /
    // iteration / metadata / contactName / avatarUrl），instant 的
    // classifier 可以直接拿来用；另外这里还多两个状态访问器
    // readState / writeState 和一个 scheduleTask，都跟 onBeforeFire 拿到的
    // 是同一份，以及本次触发的任务身份 taskId / taskUuid / occurrenceMs
    //（sessionId 是不透明字符串，别拆它拿这些值）。四种 decision：
    //   { decision: 'finish', pushPayloads }        → 推送这些 payload，结束
    //   { decision: 'tool-request', toolCalls }     → 交给 executeToolCalls 执行
    //     （也接受 instant 形状：pushPayloads 里带 tool_request push）
    //   { decision: 'continue', nextHistory }       → 换个 history 再来一轮
    //   { decision: 'skip-push' }                   → 这次不发，结束
    // 返回 tool-request 时，toolCalls 要盖住模型这一轮声明的每一个原生
    //   tool_call：漏掉的那条仍然会写在 assistant 消息上（它是模型自己发的），
    //   却没有配对的 role:'tool' 结果，严格的中转会拿这个没人应答的
    //   tool_call_id 拒掉下一轮。真想放弃某个调用，就给它回一条说明放弃的
    //   结果，别直接不提它。
    async onLLMOutput(ctx) {
      const toolCalls = ctx.llmResponse?.choices?.[0]?.message?.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        return { decision: 'tool-request', toolCalls };
      }
      return {
        decision: 'finish',
        pushPayloads: [{ messageKind: 'content', message: ctx.llmOutputText }],
      };
    },

    // 工具在 worker 里就地执行（触发时客户端多半不在线，没有人替你执行）。
    // 返回 OpenAI tool-result 形状；抛错的话错误文本会作为 tool result
    // 回填给 LLM，让它自己圆场，不会整条链失败。
    async executeToolCalls(toolCalls, ctx) {
      return Promise.all(toolCalls.map(async (call) => ({
        tool_call_id: call.id,
        role: 'tool',
        content: await runMyTool(call.function.name, call.function.arguments),
      })));
    },
  },
  maxToolIterations: 5,    // LLM 轮数上限（默认 5）
  totalTimeoutMs: 240_000, // 整链墙钟超时（默认 240s）
  maxScheduledTasksPerFire: 2, // 一次 fire 里最多能自排几条后续任务（默认 2，0 = 不许自排）
}));
```

预算兜底：轮数到上限、或整链超过 `totalTimeoutMs`，按任务失败处理（沿用现有重试/标记逻辑）。hook 收到的 ctx 里没有 apiKey、pushSubscription、VAPID——`console.log(ctx)` 不会把密钥打进日志。

### 排一条后续任务：`ctx.scheduleTask(options)`

这是啥：让角色在这次 fire 里给自己再排一条定时任务——「这条发完，一个半小时后我再接着说一句」。建出来的是一条正常的任务行，到点由 cron 触发，用户全程离线也不影响。`onBeforeFire` / `onLLMOutput` / `executeToolCalls` 的 ctx 上都有它，因为「要不要接着说」往往是看完这轮 LLM 输出才定的。

```js
async onLLMOutput(ctx) {
  const result = await ctx.scheduleTask({
    firstSendTime: new Date(Date.now() + 90 * 60_000).toISOString(), // 必填，ISO 字符串
    messageType: 'auto',            // 可选，默认继承当前任务
    recurrenceType: 'none',         // 可选，默认 none
    metadata: { beat: 'followup' }, // 可选，整体替换当前任务的 metadata（不是深合并）
    // contactName / avatarUrl / messageSubtype / userMessage 也都能覆盖，不传就继承
    tzId: 'Asia/Tokyo',             // 可选，默认继承；循环推进按这个时区的墙钟走
    uuid: `fire-${ctx.taskId}-${ctx.occurrenceMs}`, // 可选，默认随机；传确定性 uuid 可做重试幂等
  });
  // result: { created: true, id, uuid, nextSendAt }
  //      或 { created: false, reason: 'duplicate', uuid, task }
  //        task = 已经存在的那条任务行的投影（同 GET /messages 的形状，不含凭据）
  return { decision: 'finish', pushPayloads: [...] };
}
```

凭据和投递配置（`apiUrl` / `apiKey` / `primaryModel` / `maxTokens` / `temperature` / `splitPattern` / `tzId`）从当前任务继承，宿主只说「什么时候、说什么方向」——和 ctx 里看不到 apiKey 是同一个原则。推送订阅是用户级的一份，任务不携带、也不用继承。`completePrompt` / `messages` 不继承（都置 `null`）：hook 每次现场重组 prompt，把排程时冻结的旧 prompt 带过去，新任务万一走回老链路就会静默发出一条谁也没打算发的文案。

撞 uuid 时返回值里的 `task` 是那条已经存在的任务行的投影。用确定性 uuid 做重试幂等时，重跑那轮靠它把这条任务记进自己的账本、随 push 带回客户端认领——否则这条任务只活在数据库里，面板列不出、用户取消不了，却照样到点触发。

护栏，以及它们各自在防什么：

| 护栏 | 阈值 / 规则 | 不满足时 | 为什么 |
|---|---|---|---|
| `firstSendTime` | 必填、能解析成合法时间、至少比现在晚 **60 秒** | `RangeError` | cron 一分钟一跳，排在 60 秒内等于让下一跳立刻捡走，容易变成自己触发自己的紧密循环 |
| `messageType` | 只收 `auto` / `prompted` / `fixed` | `TypeError` | `instant` 的语义是「建行的那一刻就投递」，那条路径归 `POST /schedule-message` 管；从 fire 里造这么一行，投递时机反而说不清 |
| `messageType: 'fixed'` | 必须有 `userMessage`（自己传或继承到） | `TypeError` | 固定文本任务没有正文，就是一条永远发空的任务 |
| 单次 fire 的建任务条数 | 默认 **2 条**，config 里的 `maxScheduledTasksPerFire` 可调（`0` = 不许自排） | `RangeError` | 模型自排后续本质上是条能无限延伸的链，没有上限就没人按停止键 |
| `uuid` 撞车 | 不当错误处理 | 返回 `{ created: false, reason: 'duplicate', uuid, task }` | fire 失败会整条重跑（见「慢任务与 cron 占位」），宿主传一个由「任务 id + 触发时刻」推出来的确定性 uuid 就天然幂等，重试不会多排一条 |
| `tzId` | 可用的 IANA 时区 id，或 `null` | `TypeError` | 认不出来的时区会让循环推进悄悄退回 UTC，用户设的钟点从此对不上 |
| 数据库适配器没有 `createTask` | — | 抛 `AGENTIC_SCHEDULE_UNSUPPORTED` | 静默成功会让宿主以为后续那条排上了，其实谁也不会触发它 |

`recurrenceType` 沿用排程接口那套 `none` / `daily` / `weekly`，别的值抛 `TypeError`。参数不合法的调用不占建任务额度；uuid 撞车占（那条任务其实已经建出来了）。新任务的触发靠 cron，所以自排的时间点也受 cron 精度约束——排在 `x:xx:30` 会等到下一跳才发出去。

## 一条 push 能塞多少

推送服务（FCM / APNs / Mozilla autopush）限的是加密后 body 的 4096 字节，超了当场 413 拒收。明文额度要减掉 aes128gcm 的固定开销（header 86 + 填充分隔符 1 + auth tag 16 = 103），所以**一条 push 的 payload 上限是 3993 字节**（UTF-8 计，不是字符数）。这两个数字从包里导出，别自己写死：

```js
import { MAX_PUSH_PAYLOAD_BYTES, measurePushPayload } from '@rei-standard/amsg-server/cloudflare';

// 组 payload 前先量骨架，剩下的额度才是能塞正文的
const { remainingBytes } = measurePushPayload(
  JSON.stringify({ ...basePush, message: '' }),
  { reserveEnvelope: true }
);
const message = body.length <= remainingBytes ? body : body.slice(0, remainingBytes);
```

`measurePushPayload(payload, options)` 返回 `{ bytes, maxBytes, remainingBytes, withinLimit, envelopeReservedBytes }`。超限的 payload 不会被发出去等 413：`sendWebPush` 当场抛错，`err.code === 'PUSH_PAYLOAD_TOO_LARGE'`，消息里带实际字节数和上限。

`reserveEnvelope: true` 是给 hook 用的口径。hook 把 `pushPayloads` 交还给库之后，库还会补一批「这是谁、第几条、什么时候」的字段（`messageId` / `sessionId` / `timestamp` / `messageIndex` / `totalMessages` / `taskId` / `taskUuid` / `recurrenceType` / `occurrenceMs`），加起来由导出的 `PUSH_ENVELOPE_RESERVED_BYTES`（384 字节，按 uuid ≤ 64 字符算）兜住。不留这一截的话，卡在边界上的消息会「量出来装得下、补完字段就超了」——既没走旁路存储也发不出去。

内容天生装不下（长文、笔记详情、图片描述）就走旁路：正文用 `ctx.writeState()` 存进 `/client-state`，push 里只带一个引用键，客户端收到后用 `GET /client-state?namespace=...` 取回全文。

## 循环任务的时区（tzId）

这是啥：`daily` / `weekly` 任务可以带一个 IANA 时区 id，循环推进按**那个时区的墙钟**走——日期 +1 天 / +7 天，钟点原样保留。

为什么需要：不带时区就是固定 +24h / +7×24h。有夏令时的地方（`America/New_York`、`Europe/London`）跨过切换点之后，用户设的「每天早八点」会永久变成早九点，而且再也回不去。

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

`PUT /update-message` 也认这个字段：传时区 id 换一个，传 `null` 改回按 UTC 推进。`GET /messages` 每条任务多返回一个 `tzId`（没设 → `null`）。fire 里 `ctx.scheduleTask({ tzId })` 同理，不传就继承当前任务。

两个边界情况：春令时被跳过的墙钟（纽约 2:30 不存在）落到切换之后的等价时刻（当地 3:30）；秋令时重复出现的墙钟（当地 1:30 出现两次）取其中一个，不触发两次。

## 过期跳过的回执（onStaleSkip）

这是啥：任务错过触发时刻超过 60 分钟，这一次（或这几次）就不补发了。config 顶层挂一个 `onStaleSkip`，宿主用它写「这条没响」的痕迹——用户问「说好的消息呢」时界面才给得出解释。

```js
export default createSingleUserCloudflareWorker((env) => ({
  // ...其余 config
  async onStaleSkip(task, info) {
    // info: { reason: 'stale', action, metadata, recurrenceType, occurrenceMs,
    //         skippedCount, skippedOccurrences, skippedTruncated, nextSendAt,
    //         readState, writeState }
    await info.writeState('missed', [
      { key: info.metadata?.charId ?? 'unknown', value: JSON.stringify(info.skippedOccurrences) },
    ]);
  },
  async onAfterSend(info) {
    // info: { task, sentCount, total, error, scratch, readState, writeState }
    // scratch 与本次 fire 的 onBeforeFire / onLLMOutput 是同一个引用
  },
}));
```

`action` 分两种：`expired`（一次性任务，这一次永远不会补发了，行已标 `failed`）、`fast_forwarded`（循环任务，攒下的这几次都跳过，排期已快进到 `nextSendAt`，下一次照常触发）。`skippedCount` 含名义那一次；`skippedOccurrences` 超过 32 次时只给首末两个并把 `skippedTruncated` 置 `true`。两种情况都会把原因写进 payload 的 `lastError`。

两个 hook 都自带 `readState` / `writeState`（当前用户的 `client_state`）。`onStaleSkip` 尤其需要：服务停摆恢复后的第一跳里可能一次 fire 都没跑过，而那正是它要留痕迹的时候。两个都是 best-effort，自身抛错只记日志。

## 推送里带什么

每条从任务发出去的 push 顶层带 `taskId` / `taskUuid` / `recurrenceType` / `occurrenceMs`，客户端据此认领这条任务、判断它还会不会再来——角色在 fire 里给自己排的任务客户端从没见过，靠这四个字段就能把它记进面板、让用户取消得掉。hook 自己在 `pushPayloads` 里写了这几个字段会被库覆盖：它们描述的是任务行的事实，不是内容。

## 慢任务与 cron 占位

cron 一分钟一跳，跳与跳之间互不相让；带工具的任务跑过一分钟是常态。所以 `scheduled()` 每条任务开跑前会先占位：在这一行的 `lease_until` 上写下「归我管到现在 + 租期为止」，本次投递期间下一跳领不走它，抢不到的那一跳直接跳过这条。

租期默认 10 分钟，配了 `totalTimeoutMs` 就按它 + 2 分钟往上抬。想自己定就在 config 里加 `claimLeaseMs: 900_000`。`onBeforeFire` 里按次放宽的 `totalTimeoutMs` 占位时看不到，那种情况请显式设 `claimLeaseMs`。

租约写在自己的列上，`next_send_at` 全程不动。`ctx.task.nextSendAt` 拿到的就是这条任务原本的触发时刻，拿它当时间锚点（窗口判断、缓存键）对得上；循环任务也按它推进到下一次。投递收尾时租约就放掉。

Worker 中途被回收就没人来放租约，这条任务会等到租约到期才被后面的 tick 接手。所以租期要比最慢的一次投递长一点，但也别设太长——它同时也是「崩了之后多久能重来」的等待时间。

`lease_until` 是这次新加的列。部署后 `POST /init-tenant` 会自动给已有的表补上；手工建表的看 `schema.sql`。

## 导入入口

Worker 从 `@rei-standard/amsg-server/cloudflare` 导入（不是包根）。这个子路径只含单用户 + D1 + Web Crypto 推送那条路径，不牵扯 pg / neon / web-push，所以只装了 D1 的环境也能打包通过。

## 客户端

`@rei-standard/amsg-client` 配 `baseUrl` 指向本 Worker；若设了 `AMSG_SERVER_TOKEN`，client 也要配同样的 `serverToken`。

前端和 Worker 不同源时，浏览器会对带自定义头的请求发 CORS 预检。默认是同源、不开 CORS；跨源就在 config 里加 `cors`，填你的前端域名：

```js
export default createSingleUserCloudflareWorker((env) => ({
  // ...其余 config
  cors: { origin: 'https://你的前端域名' } // 或 '*'，或 (origin) => 允许的域名
}));
```
