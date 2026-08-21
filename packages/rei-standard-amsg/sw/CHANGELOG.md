# Changelog — @rei-standard/amsg-sw

## 2.4.0-next.7

### Patch Changes

- 65a9f91: 入队回执不再把「被并发冲刷送达」误报成「还在排队」

  页面入队（`ENQUEUE_REQUEST`）后，SW 从落库到自己那轮冲刷去读队列之间隔着一次异步等待（Background Sync 注册）。这个空当里，这条记录可能已经被并发在跑的另一轮冲刷——刚注册的 Background Sync、或别的窗口发的 `FLUSH_QUEUE`——发出去并从队列里删掉。原来入队回执只认自己那轮冲刷的结果，这种情况下会回 `delivered: false`；按约定页面把它当「还在队列里等重试」展示，而成功送达不广播任何事件，没有第二条消息来纠正，用户手动重试就会在服务端排出重复任务。

  现在任何一轮冲刷结算一条记录时，都会把结局交给正在等这条回执的入队方：被并发冲刷成功送走的如实回 `delivered: true`；被并发冲刷判了 4xx 永久拒绝的，回执也带上 `dropped: true` / `status` / `error`。回执的字段和 `ok` 的老含义都不变。

- 65a9f91: multipart 的 done 墓碑写失败时，TTL 清扫不再把已交付的消息报成丢了

  一条 multipart 消息收齐、还原、交付之后，收尾的第一步是往 IndexedDB 写一条 done 墓碑，TTL 清扫全靠它认出「这条已有结论」。这笔写恰恰容易失败：restore 刚重读完全部分片，紧接着的第一笔写最容易撞上一时的配额不足。原来写失败只留一条日志，残留的 pending 记录过期（默认 60 秒）后，下一条 push 触发清扫时所有窗口都会收到这条消息的 `MULTIPART_EXPIRED`（`ttl-expired`）——一条用户已经读过的消息被报成没收到。

  现在持久墓碑写不进去时，同样的结论会记在内存里兜底：SW 存活期内，TTL 清扫认得「这条已经交付过了」，不再误报；推送服务重投的旧分片也不会把这条消息重新拼齐再投一次。SW 重启后内存结论会丢——那时持久墓碑本来也没写成，误报一次是权衡后接受的残余风险。

- Updated dependencies [65a9f91]
  - @rei-standard/amsg-shared@0.4.0-next.9

## 2.4.0-next.6

### Minor Changes

- d1b269d: `notification.silent` 新增 `"when-visible"`：前台安静、切后台照响

  `silent` 管的是通知响不响铃、震不震，跟弹不弹（`show`）是两件独立的事。除了原有的 `true` / `false`，现在还认一个 `"when-visible"`：

  | 值               | 行为                                                                |
  | ---------------- | ------------------------------------------------------------------- |
  | 不配 / `false`   | 正常响铃震动                                                        |
  | `true`           | 一律不响                                                            |
  | `"when-visible"` | 有 `visibilityState === "visible"` 的窗口客户端时静音，没有就照常响 |

  它是给「页面自己会把内容画出来」的那类消息准备的——聊天回复、即时对话这种用户按下发送就盯着屏幕等的。用户正看着页面时，内容页面已经渲染了，通知安静地进通知中心就够；人切后台或者锁了屏，这条照样响铃震动把他叫回来。

  这一档只有 Service Worker 算得出来，跟 `show: "when-hidden"` 是同一个道理：发送端发推的那一刻并不知道用户此刻在不在前台，`silent: true` 一写死，切到后台收到的那条也不会响。实现上两者读同一份窗口可见性，一条 payload 只取一次结论，不会出现「按 A 时刻决定要弹、按 B 时刻决定静音」。

  `true` / `false` / 不配的行为一个字没变。`@rei-standard/amsg-shared` 的 push builders 放行 `notification.silent: "when-visible"`，别的字符串照旧拒掉并在报错里列出合法取值；顶层 `payload.silent`（老 payload 的兜底档）与 `notification.silent` 读同一套规则。各包 README 与 Service Worker 规范里「前台自绘」的示例改用这一档。

### Patch Changes

- Updated dependencies [d1b269d]
  - @rei-standard/amsg-shared@0.4.0-next.8

## 2.4.0-next.5

### Patch Changes

- 80f471d: 通知策略统一成「要推就一定弹，不想弹就别推」

  订阅是按 `userVisibleOnly: true` 建的，收到 push 却不弹通知，各家浏览器的处理不一样。iOS 那边实测下来是宽限期机制：订阅刚建好的几天里，发多少条不弹通知的 push 都不掉订阅（跟条数无关，只跟订阅建了多久有关）；宽限期一过，一条不弹的就立刻吊销；吊销后重新订阅，判定比第一次更严，之后随时可能再掉。最难查的是这个时间差——本地订阅完立刻测一轮都正常，上线几天后用户订阅才开始成片掉，而且掉订阅是静默的，服务端只看到推送返回 410。

  于是通知策略的口径收敛成一条，跟客户端跑在什么设备上无关：**要推就一定弹**（`notification.show: "always"`，嫌打扰用 `tag` 折叠加 `silent: true`；弹通知不影响页面自绘，`postMessage` 照常派发），**不想弹就别推**（内容落服务端收件箱，客户端上线 `GET /outbox?since=` 补拉）。

  `"when-hidden"` 标为兼容档：应用在前台时它就是一条不弹的 push，那笔账照记（规范允许 user agent 在有可见窗口时免掉展示约束，Chrome 认这条豁免，iOS 不认）。既有部署照常工作，新代码在上面两条里挑一个。文档里的场景示例统一改用 `"always"` + `tag` 折叠 + `silent: true`。

  `show` 四个档各是什么、什么时候用，收进 `@rei-standard/amsg-shared` README 的「选哪个 `show`」一张表，其余包只留一句「兼容档，新代码不选」加链接。amsg-sw README 新增「不展示通知的代价」一节收口这套取舍，shared / server / instant / client 的相关段落指过去；Service Worker 规范同步新增 §4.1.2，正文与变更历史里的通知策略建议改用同一口径。纯文档改动，运行行为不变。

- 80f471d: 文档：新接入的推荐路径收敛到 amsg-server 单用户线

  **接入这套 SDK 的标准四步**写进了工作区 README：部署 worker → 装 Service Worker + 订阅推送 → 发消息 / 排任务 → **应用启动时拉一次收件箱**。第四步以前只在 API 列表里有两行说明，现在 amsg-client README 有独立一节「上线补一次收件箱」，给出翻页、ack 顺序、去重的完整写法——到了客户端不会弹通知的内容只落收件箱、不发推送，少了这步就等于没有。

  **amsg-client README 按这条线重排**：开头新增「先看你接的是哪条服务端线」，把 `scheduleMessage()`（含 `messageType: 'instant'`）+ 收件箱补拉这条摆在前面，`deliver()` / `sendInstant()` 收进 instant 那条线的说明里；「上线补一次收件箱」一节提到目录第二位、正文紧跟「快速使用」。`scheduleMessage()` 的 JSDoc（会出现在 IDE 悬浮提示和 `.d.ts` 里）同步改写成同一口径。

  **amsg-server README 开头新增「两条部署线」**，把单用户线（D1）和多租户线（pg / neon）的能力差异摆成一张表：服务端收件箱和 `client_state` 目前只有 D1 适配器实现，多租户线上这两组端点返回 501，不会弹通知的 payload 也只能照旧推送。新接入走单用户线，README 也给了它一段快速使用。给 pg / neon 补收件箱记为待办。

  **amsg-instant 标为维护态**：它是无后端场景的产物，没有数据库也就没有服务端收件箱，push 漏掉的内容补不回来。继续修，已经在用的部署照常工作，新接入不从它起步。amsg-sw README 的「生产推荐链路」一节据此改写成「Web Push + 上线补拉 + SW dedupe」。

  **两份规范按同一条线重排**。API 规范：新增 §1.1「两条部署线」把单用户线和多租户线的差异摆成一张表；第 6 章端点清单补上单用户线独有的那几组端点（`outbox` / `push-subscription` / `vapid-public-key` / `client-state` / `llm-credentials` / `capabilities`）；新增 §6.7「服务端收件箱与到达保证」，收件箱的两个端点、落行时序、哪些 payload 发推送、ack 顺序都在那一节；§10 补上 10.1 单用户线的对接流程（部署三步 + 客户端四步），原有的多租户流程顺延；§12 DoD 分成「两条线通用」与「多租户线另需满足」两组，前者把实现服务端收件箱、按 §6.7 决定发不发推送列为要求。

  Service Worker 规范第 0 章的最小示例补上「订 Web Push 并 `putPushSubscription()` 登记订阅」这一步，四步齐了；§4.1.1 的前台自绘一节写明它跟弹不弹系统通知是两件独立的事。

- 80f471d: 不会弹通知的 payload 不发推送，只落收件箱

  一条 payload 出门有两条腿：落进 `message_outbox`（到达的保证，客户端上线 `GET /outbox?since=` 补拉）和发一条 Web Push（及时性）。收件箱那条腿每条 payload 都走，推送这条腿只留给「到了客户端会弹通知」的那些。

  | payload                                                         | 落收件箱 | 发推送 |
  | --------------------------------------------------------------- | -------- | ------ |
  | `content` / `result`                                            | ✅       | ✅     |
  | `reasoning` / `tool_request` / `error`                          | ✅       | ❌     |
  | 任意 kind + `notification: { show: false }`                     | ✅       | ❌     |
  | 任意 kind + `notification: { show: 'always' \| 'when-hidden' }` | ✅       | ✅     |

  订阅是按 `userVisibleOnly: true` 建的，每条 push 都欠用户一次可见反馈。`reasoning` / `tool_request` / `error` 在 Service Worker 那边是静默送给页面的，推过去不会有任何可见反馈，却要跟浏览器赊一次账：Firefox 对这类 push 有配额、超了退掉订阅；iOS 给新订阅几天宽限期，过后一条不弹的就吊销订阅，而且掉订阅是静默发生的，服务端只看得到后续推送返回 410。这些内容在收件箱里一个字不少，走补拉既不影响到达，也不再拿订阅去换一条根本不会显示的横幅。

  想让某一条照样弹，给它带上 `notification: { show: 'always' }`——发送端和 Service Worker 读同一份判定，宿主说了要弹就照推。`show: 'when-hidden'` 也照推：它到底弹不弹要看当下有没有可见窗口，那只有 Service Worker 知道；这一档是给既有部署留的兼容值，新代码在「一定弹」和「压根不推」里挑一个。

  一个例外不用配：这一批没能落进收件箱时照旧推送，那时推送是这条内容唯一的腿。收件箱是 D1 适配器的能力，多租户线的 pg / neon 还没有，那条线上所有 payload 照旧全推。跳过推送的行不标 `delivered_at`，留在收件箱里等客户端补收。

  agentic 链路的 `onAfterSend` / `onFireSettled` 回执新增 `pushedCount`：这批里真的占用了推送通道的有几条。`sentCount` 含义不变（这批走完了几段），`sentCount === total` 照旧表示整批都到位了。

  `@rei-standard/amsg-shared` 新增导出 `notificationIntent(payload)`：把「这条到了客户端会不会弹」算成 `'always'` / `'when-hidden'` / `'never'`。SW 和发送端读同一份，判定不会各走各的。

- Updated dependencies [80f471d]
- Updated dependencies [80f471d]
  - @rei-standard/amsg-shared@0.4.0-next.7

## 2.4.0-next.4

### Minor Changes

- 922afe1: 取消的消息不再从收件箱补收回去；失败细节里的模型名不再被脱敏吃掉

  **1. 投递到一半被取消：没发出去的那几条从 outbox 里撤掉**

  整批 push 是发送前就落进 `message_outbox` 的（那是补收的事实来源），而取消只拦得住 Web Push 这一路。剩下没发出去的行不撤掉的话，客户端下一次 `GET /outbox` 会照样把它们拉回去——用户看到的是「取消接口回了成功，消息还是来了」。

  现在 `DELETE /message` 取消和 `supersedesUuid` 顶替都会把该任务名下还没发出去的行撤掉，两种时机都算：投递正跑到一半时（老链路和 agentic 链路两条发送路都覆盖），以及更常见的那种——上一次投递早就失败了、还没等到重试就被取消。已经推给设备的那几条不动，行留着让客户端照常 ack；取消的意思是「别再发后面的」，不是「把用户已经收到的从收件箱里抹掉」。

  清理是 best-effort：适配器没实现 outbox、或者清理本身出错，都不影响取消 / 顶替的成功返回（任务行已经删掉了）。

  适配器接口新增可选方法 `discardOutboxMessages(userId, messageIds)`，内置只有 D1 实现；不实现的适配器行为与以前一致（取消只挡住 Web Push）。取消 / 顶替这条路还要读一遍未 ack 的行来挑出这条任务的那几段，所以 `listUnackedOutbox` 返回的行上要带 `task_uuid` 和 `delivered_at`（包内 schema 本来就有）。

  **2. 脱敏规则收敛成一份，模型 ID 不受影响**

  错误细节里长得像凭据的串会被遮成 `[redacted]`：`sk-…` / `xai-…` / `sk-ant-api03-…` 这种「短前缀 + 长随机串」，`Bearer …` 连值一起遮，以及光是一长串的 base64 / JWT 片段。随机段里夹着 `-` 和 `_` 的 Key 整条遮掉，不留半截。

  模型 ID 原样保留。上游那句「你写的这个模型不存在」里最关键的就是模型名，遮掉它报错只剩「有个东西不存在」，而模型名写错是这套错误细节要解决的头号场景。

  模型 ID 跟 Key 长得很像，认它靠四道一起：全小写字母数字、被 `-` / `.` 切成一串短段（`gpt-4o-mini-2024-07-18`、`claude-3-5-sonnet-20241022`）；不以公认的凭据前缀开头（`sk` / `key` / `api` / `token` / `xai` …，跟在它们后面的东西不管长什么形状都不豁免）；不含 uuid（8-4-4-4-12 hex）；没有「随机段」（一段里字母块数字块来回切三次以上，`mixtral-8x7b` 那种短版本段例外）。

  单看形状是不够的——自建中转（one-api / new-api / LiteLLM 这类）发的 Key 常常是 `sk-<uuid>`、`key-1a2b3c4d5e6f-7a8b9c0d1e2f` 这样全小写按短横线分段的，跟模型 ID 完全同形。判据里没有任何厂商的模型清单。

  判过是模型名的串也不会被「光长随机串」那条规则二次吞掉：`deepseek-ai.deepseek-v3-0324-thinking-preview-latest` 这类超过 48 字符的模型 ID 照样留着。

  规则本身只有一份，在 `@rei-standard/amsg-shared` 的 `redactCredentials`；amsg-server 的 `sanitizeErrorSummary`（落库的 `last_error` 列）和 amsg-instant 的 Cloudflare 适配器（跨域 502 响应体）都调它，各自只负责后面的截断长度。

  **3. instant 任务的 `last_error` 带上 `errorCode` / `pushStatus`**

  `messageType: 'instant'` 的任务终审失败时，写进 `last_error` 的记录原来只有 `{ at, occurrence, reason }`。现在跟定时任务那条路共用同一份形状：`reason` 是给用户看的人话，`errorCode` / `pushStatus` 是给下游判定用的——`pushStatus === 410` 表示订阅已注销，客户端据此引导用户重新登记，不用回去正则匹配 `reason`。

  **4. `last_error` 一律往行上写**

  原来只有实现了可选的 `claimTask` 的适配器才往行上的 `last_error` 列写。跟着包内 SQL schema 建表、但没实现 `claimTask` 的自定义适配器，行上有这一列、`GET /message` 的投影也认它权威，却没人往里写——`lastError` 读出来永远是 `null`。

  现在一律写，默认状态字段和 `last_error` 合成一笔：库有这一列时永远只花一个来回。

  这一笔挂了才分开重来——先只写状态字段。这笔成了，就说明问题出在 `last_error` 这个字段上（`updateTaskById` 是单条 UPDATE，字段不认时整条不生效，所以退回重写是安全的）；这笔也挂了，那是库真出问题了，原样抛出去按既有路径处理。状态推进（标 failed / 推进排期 / 放租约）无论如何都不受这一列影响：靠错误措辞去猜「是不是缺这一列」的话，猜不中就是 `retry_count` 不涨、`next_send_at` 不动，任务被每一跳 cron 重新捞起来，LLM 每次重跑一遍还每次都计费。

  认定「这个库没有这一列」要连续撞上两次同一个形状，中间只要成功一次就清零：连接重置、语句超时、D1 的 `Network connection lost` 这类瞬时错误落在带 `last_error` 的那笔写上时，跟缺列长得一模一样，而认定的后果是永久的（长驻 Node 部署里适配器活到进程结束）。认定之后不再带这个字段，失败原因仍记在密文 payload 的 `lastError` 里。

  带 `last_error` 的写第一次没成功就会打一行提示（每个 isolate 只说一次，措辞把「缺列」和「偶发」两种可能都写出来）——Cloudflare 部署每个请求都新建适配器，等坐实再说的话运维永远看不到。

  投递成功时行上的列和密文 payload 里的那份记录一起清掉。重写密文之前会先确认行上的密文还是领取时那一份——投递跑几十秒，其间用户 `PUT /update-message` 改过的话，把快照原样写回去等于把那次修改静默回滚；失败收尾写 `lastError` 走同一道确认。

- ca83382: 新增 `ctx.emitResult(payload)`：往客户端送一条不是聊天内容的结果

  聊天正文之外的产出——整理好的一份数据、一条账目、后台生成的产物——之前只能宿主自己拼：`db.appendOutboxMessages` 加 `encryptForStorage` 手工组一行，落什么列、怎么加密全靠照着库里的实现抄，公开 API 拼得出来但无文档无测试。现在收编成正式能力。

  **server**：fire 级 `fireCtx`、每轮 `sessionCtx`，以及 config 级的 `onAfterSend` / `onFireSettled` / `onStaleSkip` 载荷上都挂着 `emitResult(payload)`，与 `readState` / `writeState` 同待遇。一条结果走两条路——落进 `message_outbox`（到达：客户端下次 `GET /outbox?since=` 一定拿得到，推送没送到、内容超过一条推送 4KB 上限都不会让它丢），同时发一条 Web Push（及时：跑完当场弹一下叫人回来看）。客户端因此不必为每种结果各写一套轮询。

  ```js
  const { messageId, pushed } = await ctx.emitResult({
    resultKind: "fire-pack", // 必填：这类结果的名字，客户端按它分流
    packId: "pack_42", // 以下随便加，形状由宿主定
    notification: { title: "整理好了", body: "点开看看" },
  });
  ```

  - 落行失败会抛（收件箱是到达的保证）；适配器没有 `message_outbox` 时抛 `OUTBOX_UNSUPPORTED`。推送发不出去只记日志、返回 `pushed: false`——行还在收件箱等补收，不算失败。
  - 结果行带 `task_uuid`，取消 / 顶替这条任务时**还没送到**的结果跟聊天分段一起撤；已推到设备上的留着让客户端照常 ack。
  - `messageId` 缺省值掺了任务 id 与本次名义触发时刻，同一次触发重跑时不会补出第二条。

  **shared**：`messageKind` 新增第五种 `'result'`（`MESSAGE_KIND.RESULT`、`ResultPush`、`buildResultPush`、`isResultPush`）。`buildResultPush` 是唯一保留自己不认识的字段的 builder——结果的形状由宿主定，白名单式的复制会把内容删掉一半。

  **sw**：`messageKind: 'result'` 派发 `REI_SW_EVENT.RESULT_RECEIVED`，并且**默认弹通知**（与 `content` 同待遇，其余三种仍是静默送给页面）——结果往往正是「跑完了，回来看看」那句话。标题正文照旧在 `payload.notification` 里自定义，不想弹就 `notification: { show: false }`。

  特性位：`emit-result`。

- 785e1a3: 离线队列被拒的请求不再无声消失，去重仓库出错也不再吞掉整条 push

  **离线队列：4xx 被拒会报出来**

  队列里的请求被服务端 4xx 拒绝时，SW 照旧不再重试、把记录删掉（重试策略不变，4xx 重试多少次都是同一个结果）。原来删完就没了：页面拿到的还是 `{ ok: true, queueId }`，应用以为「已入队、早晚会发出去」，实际这条请求永远不会再发，没有事件、没有日志、队列里也查不到。最常见的触发是 token 轮换后还拿着旧 token（401），其次是 X-User-Id 不合法（400）、payload 超限（413）、路由改名（404）。

  现在这条请求被删掉时会同时给出三个出口：

  - 入队 ack 上新增机读字段。`ok: true` 的含义不变（=「已入队」，老调用方不受影响），新增 `delivered` 表示这次立即冲刷有没有真把它发出去；被永久拒绝时另外带上 `dropped: true`、`status`（HTTP 状态码）和 `error`。三种结局分别是：发出去了（`delivered: true`）、还在队列里等重试（`delivered: false`）、已被拒且删掉（`delivered: false, dropped: true`）。
  - 广播给所有窗口一条 `REI_SW_MESSAGE_TYPE.QUEUE_DROPPED`（`{ ok: false, queueId, dropped: true, status, error, request: { url, method } }`），页面在全局 `navigator.serviceWorker` 的 message 事件里就能收到，不必持有当初入队用的 MessageChannel。出于安全考虑广播里不带 headers 和 body。

    广播用独立的 message type，跟点对点的入队回执（`QUEUE_RESULT`，字段不变）分开：这条是广播，可能由后台 `sync` 冲刷触发、说的也可能是另一条早就排在队列里的旧请求。共用一个 type 的话，页面等自己那条入队回执时会先收到这条广播、当成自己的结果，明明入队成功却报「排队失败」。

  - 一条带 url / method / 状态码的 `console.error`。

  **push：去重或分片存储出错不再吞掉整条消息**

  去重记录写 IndexedDB 失败时（设备存储写满、存储压力下连接被强关且重开失败、用户清站点数据的瞬间、宿主占用了同名 `dedupe.dbName` 却没有对应的 store），原来整个 push 事件会挂掉：通知不弹、页面收不到 postMessage、`onBusinessPayload` 不跑，只在 SW 控制台留一条大多数用户看不到的 unhandled rejection；用 `deliver()` 观察的发送端看到的是超时，排查方向整个是反的。

  去重是「防重复弹」的优化，坏了应该多弹一条，不该一条都不弹。现在这种情况会降级成「当作首次投递照常分发」，并留一条能归因的日志；`REI_AMSG_DELIVER` 的 ack 仍是 `ok: true`，但会带上 `dedupeError`，让发送端知道这条没走去重保护、另一路 backup 可能还会再投一次。

  multipart 分片的存储出错走另一种降级：手里只有一个分片，不能当完整消息发出去，所以放弃这个分片 id，按既有的 `rei-amsg-multipart-expired` 事件告诉页面别再等，同样留下日志。

  同一条 multipart 消息只报一次收不了。分片是一起发出来的，逐片报的话（信封不合规、本地关掉了 multipart、分片仓库坏掉）页面会为一条消息收到几十条一模一样的事件。

  重组窗口过完（剩下的分片迟到得超过了整个 `ttlMs`）时，这条 id 连同已落库的分片一起清掉。只清等待记录、把分片留在库里的话，新窗口的计数从零重来，而旧分片会被「这一片已经有了」挡在门外，这条 id 再也收不齐。

  另外，补弹通知被系统拒绝（权限被撤、配额、OS 错误）时也不再让整条 push 挂掉，与首次投递路径的处理保持一致：记一条日志，并在 `onDuplicate(info)` 里如实报 `duplicateNotificationShown: false`。

  通知没弹出来这件事同时写进 `REI_AMSG_DELIVER` 的 ack：`ok` 保持 `true`（payload 收下了也分发了），另带 `notificationError`。把 `deliver()` 当备份通道用的发送端靠它判断用户到底看没看见这条消息，首投和重复包两条路都带。

- 922afe1: 分片拼不起来时不再静默丢弃，`MULTIPART_EXPIRED` 带上失败原因

  **1. 拼不起来的 multipart 现在都会上报**

  `_multipart` 分片走到这几条路时，原来是删掉已收的分片、直接返回，既不打日志也不广播事件——页面拿着 sessionId 一直等，而这条消息其实已经废了：

  - 分片信封不合规（version / encoding 对不上、index 越界、chunk 不是合法 base64url）
  - 同一个 id 的分片报了不一样的 `total` / `encoding`
  - 累计字节数超过 `multipart.maxTotalBytes`
  - 收齐了但拼不回原 payload
  - 本地把 multipart 关了（`multipart.enabled === false`），但发送端还在切片

  现在这几条路都走同一个出口：打一条 `console.error`，并按既有的 `REI_SW_EVENT.MULTIPART_EXPIRED` 广播给页面。

  **2. `MULTIPART_EXPIRED` 事件多了 `reason`**

  事件 payload 从 `{ id, received, total, originalMessageKind }` 变成 `{ id, received, total, originalMessageKind, reason }`。`reason` 说明这条 id 是怎么废的，取值见新导出的 `MULTIPART_FAILURE_REASON`（`'ttl-expired'` / `'invalid-chunk'` / `'chunk-conflict'` / `'size-limit-exceeded'` / `'restore-failed'` / `'storage-failed'` / `'disabled'`）。

  `'ttl-expired'` 之外的几种通常意味着发送端或链路有问题，值得报上去。原有字段和事件名都没变，只读 `id` / `total` 的页面代码不受影响。

  `MULTIPART_FAILURE_REASON` 和其他线协议常量一样住在 `@rei-standard/amsg-shared`，`@rei-standard/amsg-sw` re-export 同一份；页面侧请从 shared import。

  **3. 拼好之后的收尾出错，不再把成功的重组报成丢了**

  分片收齐、payload 已经还原出来之后，还要做两件收尾的事：清掉已用的分片、写一条短期 done 标记（防推送服务重投递造成二次业务事件）。原来这两步是裸 `await`，IndexedDB 在这里抖一下，异常会一路冒到外层，把一次**成功的重组**报成 `MULTIPART_EXPIRED`——通知不弹、`onBusinessPayload` 不跑，完整数据在手里反倒丢了。

  现在收尾整段兜住，出错只记日志，payload 照常弹通知、进 `onBusinessPayload`、广播 `CONTENT_RECEIVED`。

  **4. 一条 id 有了结论就到此为止**

  不管是收齐还原了，还是中途放弃了（分片对不上、超限、拼不回来、分片仓库出错、本地把 multipart 关了），结论都是粘的：这个 id 之后再来分片一律不再收，包括推送服务对失败那片的重投。

  收齐还原和中途放弃走同一套收尾：先写一条 done 墓碑，再清 pending 记录和已收的分片。分片一片都没落库的那几条路（信封不合规、multipart 关着、仓库出错）写不了墓碑——仓库出错那次坏的正是 IndexedDB——结论记在内存里，重组路径和 TTL 清扫都认它。

  `'storage-failed'` 这种一阵子就好的故障也照此办理：不钉死的话，剩下的分片会把这条消息照常拼齐投递出去，而页面上那句「这条收不到」已经没有任何事件能撤掉了——用户看到的是一条读得到的消息旁边永远挂着失败横幅。

  粘性是必须的：不然 `multipart.maxTotalBytes` 拦下的那份，重投几次就能重新凑齐还原出来。TTL 清扫也认结论：清理途中万一出错、pending 记录留了下来，清扫看见结论就知道这个 id 已经了结，不会为一条已经还原并渲染出来的消息再广播一次 `MULTIPART_EXPIRED`。

  **5. 分片的重组窗口从本地收到第一片起算**

  `multipart.ttlMs`（默认 60 秒）说的是「攒着半截分片等剩下的能等多久」。这个窗口按接收端本地收到第一片的时刻起算，不看发送端写在信封里的 `createdAt`。

  分片是一起发出去的、也会一起送到，中间在推送服务里躺了多久跟这个窗口没关系——定时消息的传输层 TTL 是四周，设备离线时段排出去的那条只要晚到超过窗口长度，按 `createdAt` 算就会每一片都在到达的那一刻被判过期。发送端和设备的时钟差也不再影响判定。

### Patch Changes

- Updated dependencies [922afe1]
- Updated dependencies [ca83382]
- Updated dependencies [c3e1906]
- Updated dependencies [922afe1]
- Updated dependencies [922afe1]
  - @rei-standard/amsg-shared@0.4.0-next.6

## 2.4.0-next.3

### Minor Changes

- 17741db: 通知正文为空时用兜底文案顶上，不再弹空白横幅

  payload 的正文一路取下来是空串（或只有空白字符）时，SW 现在用兜底文案填上再弹，默认 `New message`，`installReiSW(self, { defaultBody })` 可以换成自己的。只有标题、正文空白的系统通知对用户来说就是一条什么都没有的消息：锁屏上看到、未读 +1、点进去还是空的。

  兜底只能是「弹一条有内容的」，不能是「干脆不弹」：订阅是按 `userVisibleOnly: true` 建的，每条 push 都欠用户一次可见反馈，不弹会被 Firefox 按配额退订、被 iOS 吊销订阅（README 的「不展示通知的代价」一节有完整说明）。

  发送方本来就不该发空正文；这层是兜底，正文非空时一个字都不动（前后空格也照原样保留）。

## 2.4.0-next.2

### Patch Changes

- d47a842: 包元数据对齐：instant 的 `engines.node` 从 `>=18` 收紧到与其余包和构建目标一致的 `>=20`；instant / sw 对 `@rei-standard/amsg-shared` 的依赖区间统一为 `^0.4.0-next.1`。
- 9f3827e: 通知显示策略文档写清 `notification.show: false` 的代价

  订阅是按 `userVisibleOnly: true` 建的，那是跟浏览器约好每条 push 都会给用户可见反馈。应用在后台时收到 push 却不展示通知，Chrome 会替你弹一条通用的「此网站在后台更新了内容」，Firefox 对这类 push 有配额、超了直接退掉订阅，iOS 会吊销订阅——而掉订阅是静默发生的。README 的通知策略一节补上这段代价说明。

  「前台自绘 Toast」的场景示例改用 `show: "always"` + `tag` 折叠 + `silent: true`：页面自绘照做（`postMessage` 跟弹不弹通知无关），系统通知被同 `tag` 的下一条覆盖掉，通知栏里始终只有一条。

- Updated dependencies [d6bea67]
  - @rei-standard/amsg-shared@0.4.0-next.3

## 2.4.0-next.1

### Minor Changes

- 12ba6fb: duplicate 分支的业务自愈：首投 `onBusinessPayload` 失败后，同 key 重复包会重跑一次

  - dedupe 记录上带着 `businessError`（首投业务回调失败）时，同 key 的重复包（发送方重试 / 另一条 transport 的 backup）到达会重跑一次 `onBusinessPayload`：重跑成功 → 清掉记录上的 `businessError`，本次 ack 不带该字段，之后的重复包恢复纯去重；重跑仍失败 → 用新的失败信息更新记录，照旧在 ack 上报。此前修复通道只有通知这半边（首投没弹成、重复包会补弹一次），业务这半边没有：首投落库失败被持久化后，所有重复包只如实上报、永不重跑，结果是「横幅弹了、收件箱永远没写上」，任何重投都救不回。现在通知和业务走同一套 duplicate 自愈。
  - 记录上没有 `businessError` 时（首投业务成功，或业务还在 in-flight——失败要等 settle 后才落到记录上），重复包行为与之前完全一致：不重跑业务、不双写。
  - 注意：`onBusinessPayload` 现在可能对同一 key 被调用多次（仅发生在上一次调用失败之后）。按 key（如 `messageId`）幂等覆盖写的消费方天然安全；README「在 SW 内执行 tool_request 的安全边界」中的幂等建议，对「失败自动重试」场景从建议升级为前提。

### Patch Changes

- 8ca959c: 线协议常量收敛到 shared：新模块 `shared/src/protocol.js` 承载 multipart transport 与 SW ↔ 页面 postMessage 的全部线协议常量，从包根导出

  此前 multipart 的 kind / encoding / 默认限额在 instant（`src/multipart.js`，导出）与 sw（`src/index.js`，本地重写、未导出）各写一份，`version: 1` 字面量也两侧各写；SW ↔ 页面 postMessage 常量只定义在 sw 包里，README 教页面侧硬编码字符串。现在单一来源在 shared：

  - multipart：`MULTIPART_MESSAGE_KIND` / `MULTIPART_ENCODING` / `MULTIPART_VERSION`（新增，替代两侧的 `version: 1` 字面量）/ `DEFAULT_MULTIPART_TTL_MS` / `DEFAULT_MULTIPART_MAX_CHUNKS` / `DEFAULT_MULTIPART_MAX_TOTAL_BYTES`
  - postMessage 信封：`REI_AMSG_POSTMESSAGE_TYPE` / `REI_SW_EVENT` / `REI_SW_MESSAGE_TYPE` / `REI_AMSG_DELIVER_MESSAGE_TYPE`

  instant 的 `src/multipart.js` 与 sw 的 `src/index.js` 改为 import shared 并按原导出名 re-export，两个包的公开导出面与 wire format 不变（`DEFAULT_MULTIPART_CHUNK_BYTES` 是发送端独有的切片默认值，留在 instant）。页面侧代码现在可以从 `@rei-standard/amsg-shared` import 这些常量，不必硬编码字符串，也不必从 sw 包 import（那会执行 SW 模块的顶层状态）；client / sw 的 README 示例已相应更新。

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

## 2.3.3-next.0

### Patch Changes

- Updated dependencies [914ddcf]
  - @rei-standard/amsg-shared@0.4.0-next.0

## 2.3.2

### Patch Changes

- Updated dependencies [5c0e047]
  - @rei-standard/amsg-shared@0.3.0

## 2.3.1 — `showNotification` 拒绝不再卡死 dedupe 状态

- **Fix**: `dispatchBusinessPayload` 给 `sw.registration.showNotification(...)` 加了 `.catch(...)` 兜底。原链路只挂了成功分支 `.then(() => notificationState.shown = true)`，当浏览器拒绝展示（权限被撤、quota / OS 限制等）时整个 `Promise.all(notificationWork)` 会 reject，`onNotificationSettled` 被跳过，dedupe 记录永远停在 `notificationStatePending: true`。后续同 key 的 backup transport 重复会被 `maybeShowDuplicateNotification` 当成 `first-delivery-pending` 吞掉，用户彻底看不到通知。现在拒绝只记录到 `console.error`，`notificationState.shown` 保持 false，但 `onNotificationSettled` 一定执行，dedupe 状态正常推进。

## 2.3.0 — IndexedDB 连接韧性 + 业务感知的 DELIVER ack

- **Fix**: IndexedDB 连接被浏览器**强制关闭**（backing store 出错 / 存储压力 / 清数据）后自愈。强关只触发 `close`、不触发 `versionchange`，此前缓存里的死连接会被无限复用，每次事务都抛 `InvalidStateError`，导致去重失灵、push 落库被阻断、`dedupe cleanup failed` 刷屏且不重启 SW 不恢复。dedupe 库与 queue / multipart 库（`cachedDB`）一并修复。
  - 给缓存连接挂 `onclose`：被强关时剔除缓存，下次访问重开。
  - 事务级一次重开兜底：`close` 事件可能晚于下一次事务、而 `db.transaction()` 同步抛错，故发事务命中「连接 closing/closed」时清缓存、重开一次、重试一次；重试上限 1 次，第二次仍失败如实抛出。
- **New**: DELIVER ack 增加可选字段 `businessError`（非破坏）。`onBusinessPayload` reject 或抛错时，ack 仍是 `ok: true` 但带上 `businessError: <message>`；成功时不出现该字段。`ok` 的含义明确为「已收下并分发」而非「业务已落库」，需要严格区分「传输成功 / 业务落库成功」的消费方读 `businessError` 即可。webpush `push` 路径无 ack，业务失败仅内部 `console.error`，不会让投递 promise reject。
  - 失败会持久化到 dedupe 记录上：之后**同 key 的重复包**（发送方重试 / 另一条 transport 的 backup）被去重后，ack 仍会带上首包的 `businessError`，而不是回一个看着干净的 `ok:true, duplicate:true`。注意：去重不会让 `onBusinessPayload` 重跑——这只是让信号诚实，不是补救机制；要「失败可重试」需消费方自己做幂等（见 README「在 SW 内执行 tool_request 的安全边界」）。

## 2.2.0 — delivery dedupe + SSE bridge

- **New**: `installReiSW({ dedupe })` 新增通用 delivery dedupe，默认开启。默认 key 为 `payload.messageId` → `payload.id` → `payload.dedupeKey`，没有 key 时保持兼容不去重。
- **New**: dedupe gate 发生在 `showNotification` 和 `onBusinessPayload` 之前；重复 payload 不重复调用业务回调。若首包未展示系统通知、重复包到达时 `notification.show` 条件满足，SW 会只补一次通知，并通过 `onDuplicate(info)` 通知应用。
- **New**: 新增页面到 SW 的通用业务投递协议 `{ type:'REI_AMSG_DELIVER', payload, source?, requestId? }`，用于让 SSE page bridge 和 Web Push 进入同一条 pipeline。
- **New**: 文档明确生产推荐链路：`amsg-instant` always-on Web Push backup + client `REI_AMSG_DELIVER` bridge + SW 默认 dedupe。
- **New**: dedupe 使用 IndexedDB keyPath + `add()` 做原子 claim，默认 DB 为 `rei_amsg_sw_dedupe_v1`，TTL 懒清理，无需 KV / D1 / Durable Object。
- **Fix**: multipart 还原后的最终 payload、携带 `messageId` 的 blob envelope、Web Push payload、SSE bridge payload 都走同一套 dedupe gate。
- **Changed**: `dedupe.storeName` 不再可配置，传了会在 `installReiSW` 安装时抛 Error。需要隔离去重数据改用 `dedupe.dbName` —— 每个 dbName 是独立 IndexedDB instance，互不影响。

  原因：同一 dbName 下换 storeName 需要做 IndexedDB 版本升级，本包不打算维护跨 storeName 的 migration 逻辑；继续暴露 storeName 配置只会让用户踩 IDB upgrade 坑（升级一次后 store 永远建不出来，所有 dedupe transaction 都抛 NotFoundError）。

  | 之前配置                                  | 之前行为                                          | 现在           |
  | ----------------------------------------- | ------------------------------------------------- | -------------- |
  | 不传 dbName / storeName                   | 用默认                                            | 不变           |
  | 只传 `dbName`                             | 静默失效（store 建不出来）                        | 正常隔离       |
  | 只传 `storeName`                          | 静默失效                                          | 装包时抛 Error |
  | 同时传 `dbName` + `storeName`（首次部署） | OK                                                | 装包时抛 Error |
  | 同时传 `dbName` + 后续改 `storeName`      | 老 client 上 store 建不出来，整条 dedupe 链路挂掉 | 装包时抛 Error |

- **Fix**: 慢的 `onBusinessPayload` 回调不再阻塞 dedupe 的通知补救判定。

  之前：业务回调长时间未 resolve + 前台从可见变隐藏 + 同 `messageId` 的 Web Push backup 在窗口内到达 → backup 被判为 "first-delivery-pending" 丢弃，用户看不到通知。

  现在：通知决策一确定就解锁补救路径，backup 照常补出系统通知。业务回调依旧 await，`event.waitUntil` 生命周期不变。

- **Changed**: `@rei-standard/amsg-shared` 精确依赖升级到 `0.2.0`，并支持 `notification.silent` 透传到 `showNotification()`。

## 2.1.1 — multipart 并发与 hook thenable 修复

- **Fix**: `_multipart` reassembly 现在按 multipart id 串行处理分片，避免并发 push delivery 下 IndexedDB read-modify-write 交错导致 `receivedCount` / `receivedBytes` 丢写，最终卡住重组。
- **Fix**: `onBusinessPayload` 现在识别通用 thenable，并通过 `Promise.resolve(...)` 纳入 `event.waitUntil` 生命周期，不再只接受同 realm 的 `Promise` 实例。

## 2.1.0 — notification.show 及 Multipart chunk store

### New

- **`notification.show`** 通知显示策略: 支持 `"auto"` | `"always"` | `"when-hidden"` | `false`。现在可以直接通过包级策略实现 "有可见窗口时静默，无可见窗口时弹通知" (`"when-hidden"`) 等应用场景。

### Changed

- **性能优化**：`dispatchBusinessPayload` 现在只会调用一次 `sw.clients.matchAll` 从而避免多余的 IPC 开销。
- **IndexedDB 性能优化**：通过 `cachedDB` 保持 DB 连接，防止碎片化的 `openQueueDatabase` 导致的延迟。`REI_SW_DB_VERSION` 升级至 `3`。
- **Multipart Chunk Store**：新增 `multipart-chunk` object store 用于独立存储分片的 payload，提升了超大 payload 还原的内存稳定性和入库速度。添加了 `expiresAt` 索引大幅加速清理超时数据的过程。
- **通知标题兜底**：恢复 `createNotificationFromPayload` 中 `来自 {contactName}` 的标题 fallback，避免 custom hook 只传 `contactName` 时显示裸名字。使用 `amsg-shared` 导出的 `MESSAGE_KIND` 枚举替代了魔法字符串。

## 2.1.0-next.3 — 新增 `onBusinessPayload` 离线钩子 (pre-release)

- **新增**：`installReiSW` 的 options 参数增加 `onBusinessPayload: (payload: any) => void | Promise<void>` 钩子，支持业务端自行拦截完整的解析后 payload 并离线写库。
- **功能集成**：在 SW 进行系统通知展示和 `postMessage` 客户端派发前，回调该拦截器。该钩子自动被融合进 `event.waitUntil` 生命周期链路，支持返回 `Promise` 以绝对保证离线写入能够在 SW 休眠前全部执行完毕。

## 2.1.0-next.2 — BREAKING: generic multipart reassembly (pre-release)

next 阶段统一 multipart transport。SW 现在识别 `messageKind: "_multipart"` 的运输层分片，透明还原原始 payload 后再按原始 `messageKind` 走现有分发和通知策略。

### New

- **`installReiSW(self, { multipart })`** — 新增 multipart 配置：
  - `enabled`（默认 `true`）
  - `ttlMs`（默认 `60_000`）
  - `maxTotalBytes`（默认 `256_000`）
  - `maxChunks`（默认 `128`）
  - `cleanupIntervalMs`（默认 `15 * 60_000`）
- **IndexedDB-backed pending multipart store** — 支持乱序、重复分片和 SW 重启恢复。
- **短期 done marker** — 收齐并投递后写 done 标记，避免 push service 重投递最后一片导致重复业务事件。
- **`REI_SW_EVENT.MULTIPART_EXPIRED`** — TTL 到期仍缺片时广播 `rei-amsg-multipart-expired`，payload 为 `{ id, received, total, originalMessageKind }`。

### Changed

- `_multipart` 是 transport layer，不会触发业务事件，也不会 `showNotification`。
- multipart 收齐后恢复成原始 JSON payload，再递归进入普通 dispatch。应用层只会看到完整的 `content` / `reasoning` / `tool_request` / `error` / 自定义 kind payload。
- `content` multipart 收齐后照常 `postMessage` + `showNotification`；`reasoning` / `tool_request` / `error` 仍默认不通知。

### Migration

- 应用级 SW 可以删除旧 reasoning `chunkIndex` / `totalChunks` 拼接逻辑。
- 旧 reasoning chunk wire format 不再由 `@rei-standard/amsg-instant` next 版本发送；接收 oversized reasoning 需要本版本的 generic multipart 支持。

## 2.1.0-next.1 — 标题 fallback 至 `来自 {contactName}` (pre-release)

Cherry-pick stable `2.0.2` 的标题 fallback 修复到 next 预发布线。`createNotificationFromPayload` 的标题链从

```js
pushNotification.title || payload.title || "New notification";
```

加一档 `contactName` 兜底，与 server / instant 默认 envelope 的 `title: '来自 ${contactName}'` 行为对齐：

```js
pushNotification.title ||
  payload.title ||
  (payload.contactName && `来自 ${payload.contactName}`) ||
  "New notification";
```

custom hook（0.7.x / 0.8.0-next.x 自定义 envelope）忘了塞 `title` 但塞了 `contactName` 的情况，通知不再掉到 'New notification' 这种英文兜底上。

与 `@rei-standard/amsg-server` 2.4.0-next.1 / `@rei-standard/amsg-instant` 0.8.0-next.1 / `@rei-standard/amsg-client` 2.3.0-next.1（avatarUrl 软清空）同步。

`next.0` → `next.1` 行为变化只此一项；三轴 push schema 部分**完全不动**。

## 2.1.0-next.0 — Three-axis push schema + per-kind client events (pre-release)

Published under the `next` dist-tag (repo convention for prereleases). Coordinated with the other amsg sub-packages' `*-next.0` releases. Install with `npm install @rei-standard/amsg-sw@next`. Schema is locked; the next-tag window is for downstream integrators to validate end-to-end before this graduates to `latest`.

---

Coordinated minor with the rest of the amsg ecosystem. The SW now consumes the `AmsgPush` discriminated union from `@rei-standard/amsg-shared` (keyed by `payload.messageKind`) and bridges every push to controlled clients via a per-kind `postMessage` channel, so apps can render `reasoning` / `tool_request` / `error` in-app without going through the OS notification surface.

### New

- **`REI_SW_EVENT` constants** — per-kind event names dispatched to clients. Five values: `CONTENT_RECEIVED` / `REASONING_RECEIVED` / `TOOL_REQUEST_RECEIVED` / `ERROR_RECEIVED` / `UNKNOWN_RECEIVED`. The last one is the back-compat path for 2.0.x payloads (and blob envelopes) that lack `messageKind`.
- **`REI_AMSG_POSTMESSAGE_TYPE` constant** (= `'REI_AMSG_PUSH'`) — the `type` field on every SW → client envelope. Clients filter on this before reading `event` so a single `message` listener can coexist with other postMessage protocols.
- **Per-kind client dispatch.** Every push the SW receives is mirrored to every controlled window via `client.postMessage({ type: 'REI_AMSG_PUSH', event, payload })`. `clients.matchAll` runs with `{ type: 'window', includeUncontrolled: true }` so the broadcast reaches pages that haven't yet claimed the SW.
- **Blob envelope dispatch.** Envelopes like `{ _blob: true, key, url, messageKind, type? }` are forwarded to clients verbatim with the matching per-kind event name. The SW does NOT auto-fetch the blob body — the client decides whether and when to fetch.
- **Runtime dep on `@rei-standard/amsg-shared@0.1.0`** (exact, no caret). The SW code only references shared types via JSDoc `@typedef`; no runtime symbol is imported. Listing the dep keeps the package present in the dependency graph for hoisting / type resolution alongside `amsg-instant` and `amsg-server`.
- **First test suite.** `test/dispatch.test.mjs` covers every dispatch branch using a lightweight `ServiceWorkerGlobalScope` mock — no real Workbox or sw environment needed. The package now ships a real `npm test` script (`node --test test/*.test.mjs`).

### Behavioral

- **`showNotification` only fires for content kinds.** Concretely, the SW renders a notification iff `payload.messageKind === 'content'` OR `messageKind` is absent (legacy 2.0.x back-compat). `reasoning` / `tool_request` / `error` are dispatched to clients but render nothing on the OS notification surface. Same rule applies to blob envelopes — only `messageKind === 'content'` (or absent) renders a placeholder notification.
- **Per-client `postMessage` failures are swallowed.** One offline / broken tab should not abort delivery to the rest. The `dispatchPushToClients` helper wraps each `postMessage` in its own try/catch.
- **`clients.matchAll` rejection is non-fatal.** If the call rejects, the SW still attempts `showNotification` for `content` payloads — notification rendering is independent of the broadcast path.
- **Dispatch order is best-effort parallel.** The SW kicks off `postMessage` broadcasting and `showNotification` together inside one `event.waitUntil(Promise.all(...))`. Clients should not assume the notification has been rendered (or vice versa) before the message arrives.
- **Existing `REI_SW_MESSAGE_TYPE` queue API is unchanged.** Enqueue / flush / sync paths are unaffected — the new dispatch logic only adds to the `push` listener.

### Migration

- **Apps that want desktop notifications for non-content kinds must implement them in-app.** Listen on `navigator.serviceWorker.addEventListener('message', ...)`, filter by `e.data.type === 'REI_AMSG_PUSH'`, switch on `e.data.event`, and call `Notification.requestPermission()` + `new Notification(...)` (or `registration.showNotification`) yourself for the kinds you care about. The SW intentionally no longer makes that decision for you.
- **No producer-side change is required** for 2.0.x callers that have not yet adopted the three-axis schema — their payloads route through `UNKNOWN_RECEIVED` and still render notifications via the existing path.
- **TS / JSDoc users** can pull `AmsgPush`, `ContentPush`, etc. from `@rei-standard/amsg-shared` to type the client-side `e.data.payload`. The SW package itself only references those types via JSDoc and does not re-export them.

## 2.0.1

- Maintenance release. No behavioral changes documented prior to this changelog.

## 2.0.0

- Initial public release of the v2 SW SDK with `installReiSW` + offline queue.
