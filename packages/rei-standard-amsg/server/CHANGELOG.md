# Changelog — @rei-standard/amsg-server

## 2.6.0-next.21

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

- ca83382: `client_state` 支持按命名空间过期清理（config 的 `clientStateTtl`）

  `client_state` 默认不过期，写进去的东西一直在——这对客户端同步上来的状态是对的，但「大内容旁路」那类用法写的是一次性内容：一条 push 塞不下的正文先写进状态、push 里只带一个引用键，客户端取走之后没人再回来删它，攒着白占库。

  现在可以逐个命名空间配上天数，cron 每跳顺手清一次：

  ```js
  clientStateTtl: {
    fire_pack: 7,     // fire_pack 下超过 7 天没更新的条目自动清掉
    scratch_pad: 1,
  }
  ```

  - 没写进配置的命名空间一个都不动，不配就是原来的行为；
  - 判据是行本来就有的 `updated_at` 列，**不加列**——升级后老库不用改表结构；
  - 大值分块存储的切片行跟着根行一起走，不留读不出来的垃圾行；
  - 天数不是正数的条目跳过并告警一次；清理本身失败只记日志，不影响这一跳的投递。

  要注意 `PUT /client-state` 和 `writeState()` 的条件写护栏（entry 上的 `version`）落的就是 `updated_at` 这一列：护栏值传自增计数器之类的小整数时，那行看起来就像 1970 年写的，第一次清理就会被扫走。给命名空间配 TTL 时，让它的写入方把 `version` 传成毫秒时间戳。

  适配器接口新增可选方法 `cleanupClientState(targets)`（D1 已实现；没实现的适配器不清理）。特性位：`client-state-ttl`。

- ca83382: 请求体带 `Content-Encoding: gzip` 时自动解压，所有带 body 的端点一次全通

  客户端把大 body（一整批 `client_state`、一条内容很长的任务）压了再传能省下几倍传输量，之前服务端不认这个头，压过的请求体会被当明文读，报出来是一句「请求体不是有效的 JSON」。

  现在正文的读取统一走 `readRequestBody()`，`Content-Encoding: gzip` 在那一步还原，单用户 Worker 上每个带 body 的端点都认。放在路由之前是有意的——各端点自己判那个头的话，漏判的那个照样收到乱码。

  边界：没有这个头 → 原样读，行为一字不差；说是 gzip 而字节是明文 → 按明文处理（有些边缘网关会替你解开却留着这个头）；`br` / `deflate` 之类 → `415 UNSUPPORTED_CONTENT_ENCODING`，不猜着解；解压后超过上限 → `413 REQUEST_BODY_TOO_LARGE`（默认 32MB，config 的 `maxRequestBodyBytes` 可调，上限只管压缩这条路——几百 KB 的压缩数据能展开成几个 GB）；数据坏了 → `400 INVALID_CONTENT_ENCODING`。

  新导出：`readRequestBody`、`DEFAULT_MAX_REQUEST_BODY_BYTES`（自己包路由的宿主用它代替 `await request.text()`）。特性位：`gzip-request-body`。

- 7291704: 失败记录成功后会清干净、超大 payload 不再空转重试、取消撞上投递不再照发

  **1. `lastError` 不再永久停在一次旧失败上**

  任务的失败记录存在两个地方：任务行的 `last_error` 列（每次失败刷新、成功时清空），以及密文 payload 里的一份（只在终审失败和过期快进时写，成功时不会去动）。原来 `GET /message` / `GET /messages` 优先读密文里那份，于是循环任务失败过一次（比如推送回 410）之后，哪怕用户重新登记了订阅、之后天天正常送达，响应里的 `lastError` 也永远停在那一次，还带着 `pushStatus: 410`。客户端按这个字段判断「要不要提示用户重建订阅」，就会在一切正常的时候一直提示。

  现在以行上那一列为准：投递成功后 `lastError` 就是 `null`。密文里那份留给没有 `last_error` 列的自定义适配器兜底，对那类适配器，成功时也会把它一并擦掉。

  **2. 发不出去的超大 payload 一次判死，不再走 2 / 4 / 6 分钟的重试梯子**

  一条 push 的明文上限是 3993 字节，超了库在加密之前就抛 `PUSH_PAYLOAD_TOO_LARGE`，一个字节都不会发出去。原来这种失败照样进退避阶梯，而投递是先跑 LLM 再推送——每一跳重试都把整轮生成重跑一遍，真花钱，一条也发不出去。带思考内容的模型很容易撞上：`reasoning_content` 是整段塞进一条 push 的，而它是首条，一抛整批都发不出去。

  现在这种失败当场作废本次 occurrence（一次性任务标 `failed`，循环任务跳到下一次触发时刻）。推送服务回的 **413**（密文超限，同一件事晚一步发现）同样按终态处理。

  VAPID 配错回的 **400 / 401 / 403** 维持原样，仍走重试梯子：那是整个部署级别的故障，一把钥匙配错就是所有任务一起发不出去，判终态会把这段时间内每一条一次性任务都永久标 `failed`，配置修好也回不来了。

  失败记录里同时多了 `errorCode`（底层错误的稳定 code，如 `PUSH_PAYLOAD_TOO_LARGE`），和已有的 `pushStatus` 一样，行上的列和 payload 里都写。判断该怎么处置读这两个字段就够，不必去正则匹配 `reason` 那句人话。

  **3. 取消撞上投递：不再「回了取消成功，消息照样发出去」**

  `DELETE /message`（以及 `POST /schedule-message` 的 `supersedesUuid`）是无条件删行并当场回 200。而投递从领取任务到推送之间不再读库，用的是领取时那份行快照——所以取消发生在这中间时，LLM 照样跑完、推送照样发出、任务还被记成一次成功投递，日志里一点痕迹都没有。

  现在投递期间的租约心跳会盯着这件事：续租是条件写，匹配不到行就说明这条任务已经不在了。收到这个信号后剩下的推送一条都不发，这一跳既不记成功也不记失败，而是记进 `details.cancelledTasks`：

  ```jsonc
  {
    "taskId": 42,
    "reason": "任务在投递期间被取消或顶替",
    // 推送在发出去之前被拦下
    "status": "cancelled_mid_delivery"
    // 或 "cancelled_after_delivery"：推送已经发完，收尾写库才发现行没了
  }
  ```

  心跳没开的部署（适配器没实现 `renewTaskLease`，或 `leaseHeartbeatMs` 设成 0）拿不到中途的信号，但收尾写库那一步仍会认出来，记成 `cancelled_after_delivery`。

  取消检查挂在 `ctx.webpush` 上的方式：拿宿主对象当原型建一个影子对象，只盖住 `sendNotification`。宿主按常见写法传 `webpush: Object.freeze({ sendNotification })` 时，这条路照样能用。

  心跳只把「行真的没了」当取消信号。收尾写库会把 `lease_until` 置空、成功的一次性任务干脆把行删掉，之后续租当然也匹配不到行——那是本次投递自己放的手，不记成取消。收尾之后宿主 hook 还可能 await 一阵子（`onStaleSkip` 之类），这期间飞在路上的心跳会照样落地。

- b0da1a8: 任务正文加大小上限，超了在建任务时就回 400，并导出预算用的常量

  一条任务的正文（`messages` / `completePrompt` / `metadata` 等）整个加密成一个字符串落在 `scheduled_messages.encrypted_payload` 这一列上。原来这条链路上没有任何大小检查，正文多大都照单收下；写到 Cloudflare D1 时才撞上它 2,000,000 字节的单行上限，调用方拿到的是一个 500，错误体里只有一句 `D1_ERROR: string or blob too big`——既不知道是哪份数据太大，也不知道上限是多少。本地测试跑的是 SQLite、生产用 Postgres 的部署也碰不到这条线，所以问题只在 D1 上、且只在运行时才暴露。

  现在 `POST /schedule-message` 与 `PUT /update-message` 在加密落库前先量一次正文，超限直接回 400：

  ```json
  {
    "success": false,
    "error": {
      "code": "TASK_PAYLOAD_TOO_LARGE",
      "message": "任务内容 1048576 字节，超过 995871 字节上限",
      "details": { "bytes": 1048576, "maxBytes": 995871 }
    }
  }
  ```

  判断读 `details.bytes` / `details.maxBytes` 就够，不用去解析 message 那句话。`PUT /update-message` 量的是合并之后的正文：patch 本身很小、叠到存量正文上顶穿上限的情况同样会被拦下。

  上限是 **995,871 字节**（明文的 UTF-8 字节数，不是字符数——一段全中文的正文，字节数是字符数的三倍），从 D1 的 2,000,000 字节反推：密文按十六进制存，字节数正好翻倍，再给行里其他列、以及投递失败时补写 `lastError` 留出余量。这个数从包根导出成 `MAX_TASK_PAYLOAD_BYTES`，客户端想在提交前自己预算就读这一份，别手抄第二个数。

  上限对所有适配器一视同仁（D1 / Postgres / Neon）：同一份任务在不同库之间搬家时契约不该跟着变。正常大小的任务不受影响——一条塞满 messages 的对话离这个量级还差得远；真要放大段内容，走 `client_state` 旁路存，任务里只留引用键。

  **`PUT /update-message` 只拦「这次改动把它变大了」**

  大小闸门量的是合并之后的正文，不是这次的 patch——patch 本身可能很小，叠到存量正文上却顶穿上限。但上限是后加的，比它更早建出来的大任务本来跑得好好的：一律按合并后的大小拒的话，那条任务连把 `nextSendAt` 往后挪一小时都做不到，只能删掉重建。所以合并后超限、且比改动前更大才回 `400`；改小或大小没变的改动照常放行。

- 922afe1: 思考过程发不出去不再连累正文，超长的思考过程改走分片送达

  **1. 思考过程发不出去时，正文照发**

  模型回了 `reasoning_content` 时，库会在正文之前先发一条 ReasoningPush。原来它和正文共用一个发送循环，而这个循环是一条抛错就整批中断——ReasoningPush 又排在最前面，所以它一失败，这条消息的正文一句都发不出去。一条 push 的明文上限是 3993 字节（约 1300 汉字），推理模型的思考过程很容易超，于是 `deepseek-reasoner` 这类默认返回思考过程的模型，定时消息基本必挂。

  现在思考过程单独发，失败就地记一行日志、正文一条不少地照发。它是正文之外的附赠内容，发不出去只影响它自己。

  失败原因同时回到结果上（`reasoningError`）——`success` 仍是 `true`，但「这次没有思考过程」在三处看得见：定时任务的 tick 汇总多一个 `details.reasoningSkippedTasks`（`[{ taskId, reason }]`，这些任务照常计入 `successCount`），instant 消息（`POST /schedule-message`）的成功响应带上 `reasoningError`，服务端日志各打一行。

  刻意不写进 `last_error`：那一列说的是「上一次没发出去的原因」，一条正文已经送达的消息挂着它，客户端会当成这次投递失败了。

  任务在投递期间被取消是例外：那是整条任务的中止信号，不是「思考过程没发成」，会照常往上抛。

  **2. 一条装不下的思考过程改走分片**

  超出单条上限的思考过程会切成 `_multipart` 分片逐条发出，Service Worker 收齐后还原成原样的 ReasoningPush 再走正常派发——用的是 `@rei-standard/amsg-instant` 已经在用的那套通用分片传输，`@rei-standard/amsg-sw` 的重组端不用改。切完仍超出分片传输量级上限（默认 256 KB / 128 片）的，跳过这条思考过程，正文照发。

  分片的重组窗口由接收端说了算：Service Worker 取「信封上写的 `ttlMs`」和「它自己的 `multipart.ttlMs`」里更紧的那个，默认 60 秒，从它收到第一片起算。

  发送节奏按这个窗口排：片数少时每片之间隔 1.5 秒（跟正文的段一样，一口气推几十条会被推送服务限流），片数多时自动收紧到刚好能在窗口内发完（128 片约 236 毫秒一片）；收紧到下限还塞不进窗口，就一片都不发、走上面那条 `reasoningError`。发一半的下场是接收端窗口一到就宣告这条收不到，之后的分片被静默丢弃，用户那边整段思考过程凭空消失，而发送端每一片都发成功、看不出任何异常。

  限额跟着宿主走：`multipart`（`maxChunkBytes` / `maxChunks` / `maxTotalBytes` / `ttlMs`）在 `createReiServer` / `createSingleUserServer` / `createSingleUserCloudflareWorker` 的 config 上收，把传给 `installReiSW` 的那一份原样传过来即可（cron 和 `runTask` 两条路都认）。不配 = 两边都用默认值。两边对不上的话——接收端把 `maxChunks` 调小了而发送端不知道——切出来的分片到了那边会被逐片拒收，一条也拼不回来，而发送端这边两道门槛全都过了、看不出任何异常。

  切片构造函数 `buildMultipartPushPayloads` 与默认切片大小 `DEFAULT_MULTIPART_CHUNK_BYTES` 随之上移到 `@rei-standard/amsg-shared`，两个发送端共用同一份。`@rei-standard/amsg-instant` 的导出名和行为不变。

  **3. `pushStatusCode` 只认推送那一步的状态码**

  失败结果里的 `pushStatusCode` 原来是从捕获到的任何异常上读 `statusCode`，而这个 catch 罩着整个投递流程——LLM 调用、fire-time hook、解密都在里面。Node 生态的 HTTP 库习惯把上游状态码挂成 `statusCode`，所以宿主 hook 里转手抛出的一个 404，会让任务被判成「推送订阅已失效」永久 `failed`，失败记录里的 `pushStatus: 404` 还会让客户端去引导用户重建订阅。

  现在这个字段只在真正发 push 的那一步赋值，别的来路的 `statusCode` 一律不认。推送服务回的 404 / 410 / 413 判定不变。

- 922afe1: 必然失败的投递不再白跑三轮，`PUT /update-message` 认它该认的字段、也不再谎报改了什么

  **1. instant 任务的重试判定跟定时任务对齐**

  `messageType: 'instant'` 的任务失败后会重试三轮。原来这条路只看 hook 抛没抛 `NonRetryableError`，定时任务那条退避阶梯却还会看错误码和推送状态码——于是「用户压根没登记推送订阅」「推送服务回 410 说这条订阅没了」这类必然同败的错误，在 instant 上照样重试满三轮，每轮都把整轮 LLM 生成重跑一遍。

  现在两条路共用同一份判定（永久性错误码 / 终态推送状态码 / payload 超限 / hook 标注的确定性失败），instant 任务遇到这些当场返回，`error.permanent` 为 `true`。说不清是什么毛病的失败（网络抖动之类）照常重试满。

  **2. fire-time hook 的契约违约带上了稳定的 `code`，也算确定性失败**

  宿主 hook 返回了库不认的东西、或者轮数用尽也没等到 `finish`——这些错误原来是裸 `Error`，错误码只写在消息文本的前缀里，投递侧读到的 `errorCode` 是 `null`，于是按普通投递失败排退避阶梯，每一跳重试都把 `onBeforeFire` 和一整轮 LLM 重跑一遍。

  现在它们都带 `permanent: true` 和一个稳定的 `code`：

  `AGENTIC_BAD_BEFORE_FIRE` / `AGENTIC_BAD_DECISION` / `AGENTIC_SCHEDULE_FAILED`

  「这一轮模型掷出了什么」决定的两种结果不在此列，它们带 `code` 但不带 `permanent`，照常走退避阶梯：`AGENTIC_LOOP_EXCEEDED`（回合数用光也没等到 finish/skip-push 决策）与 `AGENTIC_EMPTY_TOOL_REQUEST`（tool-request 决策里一个能解析的 toolCall 都没有）。隔两分钟重掷一次多半就正常收尾了；判成终态的话，一次性任务第一次掷歪就永久 `failed`，而且行离开 `pending` 之后连 `PUT /update-message` 都救不回来（409）。

  错误消息和类型都没变（决策校验抛的仍是 `TypeError`，`scheduleTask` 的参数护栏仍是 `TypeError` / `RangeError`），按消息文本或类型分流的宿主代码不受影响。

  部署级的配置 / 适配器能力错误是另一档，见下面的 `DeploymentConfigError`。`AGENTIC_TOTAL_TIMEOUT`（整条 fire 链超出 `totalTimeoutMs`）也走退避重试：这一轮慢不代表下一轮也慢。

  **2b. 部署配错了走退避重试，新增 `DeploymentConfigError`**

  没配 `onLLMOutput` / `executeToolCalls`，或者自定义适配器缺 `createTask` / `deleteTaskByUuid` / `getTaskByUuid` / `upsertClientState`——这类错误抛的是新导出的 `DeploymentConfigError`，带 `code`（`AGENTIC_CONFIG_ERROR` / `AGENTIC_SCHEDULE_UNSUPPORTED` / `AGENTIC_CANCEL_UNSUPPORTED` / `AGENTIC_RENEW_UNSUPPORTED` / `AGENTIC_STATE_WRITE_UNSUPPORTED`）但不带 `permanent`，走普通的退避阶梯。

  坏的不是某一条任务，是这个部署：同一个坏部署下每条到点的任务都撞同一个错，判终态等于把那段时间里每条一次性任务都永久标 `failed`，运维改好配置重新部署也捞不回来（行已不在 `pending`，`PUT /update-message` 回 409）。留在阶梯上，配置一修好，还在阶梯上的任务下一跳就正常发出去。VAPID 配错回的 400 / 401 / 403 一直是这么处理的。

  **3. hook 建的任务也过任务内容大小闸门**

  `scheduleTask` 建任务原来不量大小——`POST /schedule-message` 和 `PUT /update-message` 都过这道闸门，只有它绕过去了。hook 往 `metadata` 里塞一坨大对象就会一路走到落库那步，撞上存储的单行上限，抛出来的正是当初加闸门要消灭的那种看不出所以然的错。现在超限当场抛 `RangeError`（`code: 'TASK_PAYLOAD_TOO_LARGE'`），一行都不落库。

  这道闸门排在建任务额度之前，跟其余参数护栏（`contactName` / `uuid` / `tzId` …）一致：正文超限也是「这次调用的参数不合法」，不占 `maxScheduledTasksPerFire` 的额度，hook 捕获之后换份小 `metadata` 重排照样排得进去。

  **4. `userMessage` 必须是字符串**

  `POST /schedule-message` 和 `PUT /update-message` 原来只看 `userMessage` 是不是真值。传个数字进来会被收下、落库，到点投递时才炸在正文切分上——那时早已离开 HTTP 请求，用户看到的只是一条任务莫名其妙失败，还连着重试三轮同样地失败。现在这两个入口当场返回 `400`。

  **5. `PUT /update-message` 收 `messageSubtype` 和 `llmExtraBody`**

  这两个字段 `POST /schedule-message` 一直收，更新接口的合并白名单里却没有——请求带上它们会拿到 `200`，库里一个字节没变。现在能改了，显式传 `null` 表示改回默认（分别是投递时的 `'chat'` 和「不透传额外参数」）。

  **6. `updatedFields` 只列真正落库的字段**

  响应里的 `updatedFields` 原来是把请求里的键照单列回去。这个接口不接受的键、拼错的键、传了 `null` 走「不改」语义的字段，都会被报成「改了」，而库里其实没动。现在只列真正落进这次更新的那些。

### Patch Changes

- c3e1906: LLM 上游拒了请求时能看到它到底说了什么，推送失败时能看到推送服务回的状态码

  **LLM 调用失败：上游的错误响应体不再被丢掉**

  上游回非 2xx 时，原来只拿状态行拼一句 `AI API error: 400 Bad Request. Request URL: https://…/chat/completions` 就抛，响应体从来没读过。而「模型名写错、余额不够、上下文超长、被内容审核拦下」这些区别全在那份响应体里，状态行一律只说 400。定时任务的用户看到的是 `GET /message` 里那句话，instant 的调用方看到的是 502 里同一句话，谁都查不出原因，只能等三轮重试白跑十几分钟。

  现在这份响应体会读出来，说明文字接在原来那句后面，格式跟推送失败那边一致：

  ```
  AI API error: 401 Unauthorized. Request URL: https://api.example.com/v1/chat/completions
    — Incorrect API key provided: sk-[redacted]. (provider code: invalid_api_key)
  ```

  各家的错误体形状不一样，按「先找最精确的、找不到退一层」取：OpenAI / Azure 与多数中转的 `{ error: { message, type, code } }`、Anthropic 的 `{ error: { type, message } }`、Gemini 的 `{ error: { message, status } }`，都认；反代挂掉回的 HTML 错误页、纯文本这类解析不了的，原文照抄。

  外传之前会先脱敏再截断：长得像 API Key 的串遮成 `[redacted]`（上游报错很爱把 Key 原样抄回来），说明文字截到 300 字符（内容审核类的报错常把整段请求内容回显回来）。读响应体这一步自己失败了也不影响报错，只是少了说明。

  `@rei-standard/amsg-server` 不用改代码就一起受益：任务的失败记录里，`reason` 带上了上游的原话，`errorCode` 现在是 `LLM_CALL_FAILED`（原来这一类失败的 `errorCode` 是 `null`），「这一跳是 LLM 挂了还是推送挂了」不用读那句人话也能分。

  **`@rei-standard/amsg-instant`：失败信封里多了上游的状态码**

  纯 Push 模式（`Accept: application/json`）下的错误信封，原来只有 `code` 和 `message`：

  ```jsonc
  {
    "success": false,
    "error": {
      "code": "PUSH_SEND_FAILED",
      "message": "Web Push delivery failed: 410 Gone — …"
    }
  }
  ```

  订阅已经失效（410 / 404）和推送服务临时抽风（5xx）在这里长得一模一样，要分开只能拿正则去 `message` 里捞那个数字。而前者重发多少次都是同一个结果，instant 又是先跑 LLM 再推送，每次重试都把整轮生成重跑一遍。

  现在信封里按上游分别带上状态码，`onEvent` 的 `error` 事件也带同一份：

  ```jsonc
  // 推送失败：410 / 404 = 这份订阅没了，该让用户重新订阅，不是重试
  { "success": false, "error": { "code": "PUSH_SEND_FAILED", "message": "…", "pushStatus": 410 } }

  // LLM 失败：llmStatus 是上游回的状态码，providerCode 是 provider 自己的错误码
  { "success": false, "error": { "code": "LLM_CALL_FAILED", "message": "…",
                                 "llmStatus": 401, "providerCode": "invalid_api_key" } }
  ```

  `pushStatus` 与 `@rei-standard/amsg-server` 记进 `lastError` 的字段同名同义，两个包的告警规则能照抄一份。`llmStatus` / `providerCode` 只在上游确实答复了时才有——网络直接炸、超时的时候不会出现，据此也能分清「上游拒了」和「根本没连上」。

  三条路带的是同一组字段：JSON 信封挂在 `error` 对象上，SSE 的 `event: error` 和掉线兜底的 Web Push 挂在 `ErrorPush` 顶层，`onEvent` 的 `error` 事件也带。SSE 是默认传输方式，只给信封那条路的话，浏览器客户端遇到 Key 失效仍然只能回去正则匹配那句人话。`ErrorPush` 的类型定义随之多了可选的 `llmStatus` / `providerCode`。

  HTTP 状态码没变，这类失败仍然是 502：`error.code` 是这个包对外承诺的分流依据，改状态码会把按 502 分支的老调用方一起打掉，而信息量并不比新字段多。要不要重试读 `error.pushStatus` 就够。

  错误响应体最多读开头 16 KB 就把流断开。错误信封（`{"error":{"message":…}}`）永远在最前面，而中转出问题时能把整个请求体回显回来——任务正文上限接近 1 MB，一次网关故障把一批任务同时打挂时，这些只为留 300 字符而读进来的整段文本会一起压在 Worker 的内存上限上。

  被这个上限切出来的前缀不是合法 JSON，严格解析必然失败，所以这种情况下会从残缺前缀里把 `message` / `detail` / `code` / `status` / `type` 这几个字段扫出来（同名只取第一个——错误信封在最前面，后面重复出现的多半来自被回显的请求）。一个都捞不到时给一句「响应体被截断了」的说明，而不是把一大段裸 JSON 当上游原话外传。非 JSON 的响应体（反代的 HTML 错误页、纯文本）行为不变，原文照抄。

- b5d0fdd: pg / neon 上 `runTask` 的退避守卫恢复生效；pg 连接池空闲连接出错不再拖垮进程

  - **`runTask(ctx, uuid)` 在 pg / neon 部署上会重复触发还在等重试的任务。** 退避守卫读的是任务行的 `retry_after` 列，但这两个适配器取单条任务时的 SELECT 里没有这一列，守卫读到的永远是空值，等于没有守卫。结果是一条投递失败、正在退避窗口里等着的任务，每调一次 `runTask` 就立刻再跑一遍——LLM 重烧一轮、推送重试一次，重试计数也跟着涨，连按几次就把重试额度耗光，一次性任务直接进 failed。cron 那条路（`runScheduledTick`）一直是好的，只有 `runTask` 这个入口受影响；D1 部署不受影响。现在三个适配器的任务行列集收在一处共用，投递链路和读接口各一套，加列改一处就够，不会再出现「只有某一种数据库少一列」。

  - **pg 适配器给连接池挂上了 `error` 监听。** 池子里空闲的连接被数据库那侧掐断时（主从切换、实例维护重启、`pg_terminate_backend`、网络中断），错误不在任何一次查询的调用栈上，业务代码的 try/catch 接不住；node-postgres 的连接池在没有监听时会把它抛成进程级未捕获异常，直接带走整个 Node 进程，日志里只留一句栈全在驱动内部的 `Connection terminated unexpectedly`。现在这类错误记成一条带 `[amsg-server pg]` 前缀的日志，出错的连接由连接池摘除，下一次查询自动重连，服务继续跑。Cloudflare Workers / Neon 的 HTTP 驱动是一次查询一个请求、两次之间不留连接，没有这个问题。

  对调用方没有接口变化：方法签名、返回字段、配置项都不变。

- e1b58f2: `GET /push-subscription` 读不到库时说实话，不再谎报「没登记过」

  原来这个端点把整段取订阅的过程包在一个 catch 里：不管是订阅表没建好、数据库读超时，还是这一行的密文解不开，一律回 200 `{ exists: false, updatedAt: null, endpoint: null }`，服务端连一行日志都不留。故障期间设置页显示「推送未登记」，客户端照着这个答案去走一遍重新订阅 + `PUT /push-subscription`，真正的原因谁都看不到；同一次故障下 `POST /schedule-message` 报的却是 503 `PUSH_SUBSCRIPTION_LOOKUP_FAILED`，两个端点各说各的。

  现在两类失败分开：

  - 查询本身失败 → 503 `PUSH_SUBSCRIPTION_LOOKUP_FAILED`，与 `POST /schedule-message` 用同一个 code，客户端可以直接按「稍后重试」处理，别去重订阅。
  - 行还在、密文解不开（换过 masterKey 之类）→ 仍然回 200 `exists: false`，因为此时重新 PUT 一份确实是唯一有意义的动作；但服务端会记一行日志说明是解密失败，不再无声降级。

  `PUT` / `DELETE` 的行为没有变化。

- Updated dependencies [922afe1]
- Updated dependencies [ca83382]
- Updated dependencies [c3e1906]
- Updated dependencies [922afe1]
- Updated dependencies [922afe1]
  - @rei-standard/amsg-shared@0.4.0-next.6

## 2.6.0-next.20

### Minor Changes

- 2c4c8da: 推送服务判了订阅死刑（410 / 404）时不再重试，并把状态码结构化交给下游

  Web Push 的推送服务在订阅已经注销或过期时回 **410 Gone**，端点根本不存在时回 **404**。这两个都是终态：同一条订阅再推一万次也是同样结果。

  之前这两种失败落进普通重试梯子（2 / 4 / 6 分钟三跳）。而投递是**先生成后推送**——每一跳都会重新跑一遍 `onBeforeFire` 和 LLM 调用，再拿结果去推一个已经不存在的地址。也就是说订阅一旦失效，每条到点的任务会白白生成四轮，真花四轮 token，一条都送不出去。现在它们直接判终态：一次性任务标 `failed`，循环任务跳到下一次触发时刻。

  失败记录里同时多了一个结构化字段：

  ```jsonc
  {
    "at": "2026-08-10T05:06:00.000Z",
    "occurrence": "2026-08-10T05:06:00.000Z",
    "reason": "Web Push delivery failed: 410 Gone — ...", // 给人看的摘要，不变
    "pushStatus": 410 // 新增：推送服务回的状态码
  }
  ```

  `pushStatus` 只在拿得到状态码时出现，行上的 `last_error` 列和任务 payload 里的 `lastError` 两处都写（`GET /messages` 的投影优先读 payload 那份，只写一处的话终态失败的任务交出去时它会消失）。接入方要判断「是不是该让用户重建订阅」，读这个字段即可——不必去正则匹配 `reason` 那句人话，那是面向用户的自由文本，措辞随时会变。

  **订阅行本身不动**。`push_subscriptions` 里那条记录保持原样，不删也不改：删掉的话接入方那侧看到的是「压根没登记过收件设备」，会把用户引去重新登记，而重新登记只会把同一条死订阅再写一遍。订阅失效这件事通过 `pushStatus` 说出来，怎么处置交给接入方。

### Patch Changes

- 76b572e: D1 上长 key 的状态写入、批量 ack 与批量删凭据不再静默失败

  两处症状都是「代码看着跑通了、数据却没落库」，起因是 Cloudflare D1 上两条官方文档没写的限制。

  - **`client_state` 的切片清理改走字典序范围查询。** D1 把 LIKE pattern 的长度上限压到了 50 字节（SQLite 默认 50000）。清理原来用 `key LIKE '前缀%'`，key 一到 49 个字符 pattern 就超限，整条语句报 `LIKE or GLOB pattern too complex`；batch 是原子的，这一条炸掉同批的写入全部回滚。库本身声明 key 可以写到 256 字符，实际只有 48 能落库。改成 `key >= 前缀 AND key < 上界` 之后，前缀多长都不受限，key 里的 `%` `_` `\` 也不用再转义，范围条件还能直接用上主键索引。
  - **带 `IN (...)` 的四个批量口按参数预算分批发送。** D1 单条语句最多 100 个绑定参数。`POST /outbox/ack` 对外承诺一次最多 200 条，实现却把 200 个 id 拼进一条语句，到 98 条就报 `too many SQL variables`；`DELETE /llm-credentials` 同理。对外的 200 条上限保持不变，改在实现层按每条语句自己的固定参数算额度切批。切开之后原来那条语句天然的原子性靠 batch 的隐式事务补回来，不会出现「只 ack 了前 98 条」这种中间态。

  对调用方没有行为变化：接口、参数上限、返回值语义都不变，原来能成功的请求走的还是同一条路，原来会失败的请求现在能成功。

## 2.6.0-next.19

### Patch Changes

- e6b382a: credRefs 继承按 chat 引用分支，空凭据任务响亮失败

  `ctx.scheduleTask()` 的凭据继承改按 `credRefs.chat` 分支：父任务带 chat 引用 → 复制整份引用、内联置空（原行为）；父任务只带非 chat 引用（如仅 emotion）→ 引用与内联三件套**都**复制——此前对任何非空 credRefs 一刀切置空内联，会产出既无引用可解析又无内联凭据的空壳后代。

  `prompted` / `auto` 任务 fire 时既无 `credRefs.chat` 也无内联三件套 → 按 `CREDENTIAL_MISSING` 失败进常规重试（此前会拿空凭据去撞 LLM 接口、报一句对不上号的 Invalid apiUrl）。`instant` 的「无凭据 = 纯推送」路由语义不变。

  client 侧只改文档提法：可用性门槛引用 capabilities feature `'llm-credentials'`，不再写死版本号。

## 2.6.0-next.18

### Patch Changes

- 84bf07a: D1 的表结构自查跳过 Cloudflare 内部表，新建的库不再一查就报错

  Cloudflare 会在每个新建的 D1 库里放一张自己的内部表 `_cf_KV`，而对它跑 `PRAGMA table_info` 会被 D1 的 authorizer 拒掉（`D1_ERROR: not authorized: SQLITE_AUTH`）。`describeSchema()` 会把库里的表挨个遍历一遍，走到这张表就整个抛出去，`getSchemaVersion()` / `ensureSchema()` 跟着一起废，宿主拿到的是「查不了表结构」。这张表只有新建的库才有、早先建的库没有，所以症状是新部署的后端一查就挂、老部署反而一切正常。

  现在 `describeSchema()` 只认本库自己建的表，`sqlite_` 与 `_cf_` 开头的内部表一律跳过，返回的 `tables` 里也不会再出现它们。

## 2.6.0-next.17

### Minor Changes

- d94ccf7: 用户级 LLM 凭据存储（llm_credentials 表）+ 任务凭据引用（credRefs）

  凭据（apiUrl / apiKey / primaryModel）可以先用 `PUT /llm-credentials` 集中登记（`cred_id` 由客户端起名的不透明字符串，per-user key 加密落库），排程 payload 里带 `credRefs: { chat: '<credId>' }` 引用它——任务到点按引用现读，换 Key 覆盖对应行就够，所有引用它的任务（包括角色在 fire 里给自己排的、客户端不知道存在的那些）下次触发自动用新凭据。内联三件套继续支持（存量任务不迁移，fire 时作为表行缺失的兜底）。

  服务端：`PUT/GET/DELETE /llm-credentials` 三端点（GET 只回 credId + updatedAt，凭据本体永远不回传）；schedule/update 对 credRefs 做存在性检查（缺的 `409 CREDENTIAL_NOT_FOUND` 点名）、credRefs.chat 与内联同传 `400`；fire 解析顺序为表 → 内联兜底 → `CREDENTIAL_MISSING` 常规重试；`ctx.scheduleTask()` 自排任务复制引用而不是凭据本体；fire hook ctx 新增 `resolveLlmCredential(credId)`（每次返回新对象，供宿主取非 chat 用途的副 API）；任务投影带 `credRefs`；capabilities 新增 `'llm-credentials'`。D1 / pg / neon 适配器都实现了新表，自定义适配器需补四个方法（缺则相关端点 501）。

  客户端 SDK：新增 `putLlmCredentials()` / `listLlmCredentials()` / `deleteLlmCredentials()`；`scheduleMessage` / `updateMessage` 的 payload 原样透传 `credRefs`。

## 2.6.0-next.16

### Minor Changes

- e01be1a: 错误响应带上真实原因；表结构自查与补齐；单任务入口露到 `/cloudflare` 与 Worker 上

  **500 说得出哪儿坏了。** `fetch()` 兜底的 500 之前只有一句写死的「服务器内部错误」，真因（`D1_ERROR: no such table: message_outbox`、存储层写超时……）只进 `console.error`——调用方要拿到它，只能全局劫持 `console.error` 去偷听库的日志。现在 `error.cause` 随响应一起回：`{ stage, name, message, code? }`，`stage` 区分是构建配置时炸的（`config`，少 binding / 环境变量丢了）还是路由与处理器抛的（`request`）。`message` 过脱敏（遮掉长得像凭据的串、截断到 500 字符），只带错误类型和消息文本。`error.code` / `error.message` 两个老字段一个没动。

  cron 那条路上没有调用方能读到响应，另开两个出口：worker 工厂新增第二个参数 `{ onError }`，fetch 与 cron 任何一段出错都调一次（`{ stage, error, cause, path }`，best-effort）；它放在 `buildConfig` 外面，所以 `buildConfig` 自己抛错时照样调得到。`scheduled()` 现在也有返回值：`{ ok: true, summary }` 或 `{ ok: false, cause }`（Cloudflare 不看它，是给自己包一层的宿主和测试用的）。

  **表结构自查。** 建表是 `CREATE TABLE IF NOT EXISTS`，升级后老部署的表不会自己跟上，然后 cron 每分钟挂在缺的那一列上、任务一条都不发，而前端界面一切正常。新增 `getSchemaVersion(db)`（只读，回 `{ current, required, ok, missing }`，`missing` 逐条点名缺的表 / 列 / 关键索引）与 `ensureSchema(db)`（不够用就跑一次 `initSchema()` 补齐，回 `{ …, migrated, schema }`）。「需要什么」从建表语句里解析，不另抄一份会漂的清单。单用户 Worker 上有走 `env` 的同名方法。什么时候调、缺了怎么提示用户由宿主决定——库不会在每次请求里偷偷迁移，`POST /init-tenant` 的行为也一点没变。适配器接口新增可选 `describeSchema()`（活库现有的表 / 列 / 索引），内置只有 D1 实现，别的适配器调这两个函数会抛错而不是假装正常。

  **单任务入口。** `runTask` 之前只在包根导出，`/cloudflare` 子路径引不到，宿主想让刚落库的任务立刻跑起来只能触发一次全量扫描（那样多个执行者会扫同一批任务，只能退回单实例串行）。现在 `/cloudflare` 也导出 `runTask(ctx, uuid)`，单用户 Worker 上还多一个 `worker.runTask(uuid, env)`（从 `env` 拿库和配置，与 cron 共用同一份 tick ctx）。不跑的情形分开回报：`not_found` / `already_settled`（带 `status`）/ `not_due`（带 `nextSendAt`）/ `retry_pending`（带 `retryAfter`）/ `not_configured`（VAPID 没配齐，只有 Worker 那个方法有）。适配器接口新增可选 `getTaskStatusByUuidOnly(uuid)` 支撑 `already_settled`（D1 / pg / neon 都已实现），不实现的自定义适配器把它并进 `not_found`。

  新导出：包根与 `/cloudflare` 都有 `getSchemaVersion` / `ensureSchema` / `SCHEMA_VERSION` / `summarizeErrorCause`；`/cloudflare` 补上 `runTask` / `NonRetryableError` / `isNonRetryableError`。特性位：`error-cause`、`schema-self-check`、`worker-run-task`。

## 2.6.0-next.15

### Minor Changes

- LLM 请求体支持 `llmExtraBody` 透传（thinking / reasoning_effort 等中转非标准参数）

  - shared 的 `buildLlmRequestBody`：`payload.llmExtraBody`（普通对象）原样展开进请求体，先展开再写核心字段——`model` / `messages` / `temperature` / `max_tokens` / `tools` 永远以库的口径为准，extra body 撞键盖不掉。非对象/数组静默忽略。
  - server 的 `POST /schedule-message`：payload 白名单加 `llmExtraBody`（存进任务 payload，fire 时随 `buildLlmRequestBody` 进请求体）；fire 里 `ctx.scheduleTask` 自排的后续任务继承它。形状校验只查普通对象——里面的字段是调用方与中转之间的契约。

  特性位：`llm-extra-body`。

### Patch Changes

- Updated dependencies
  - @rei-standard/amsg-shared@0.4.0-next.5

## 2.6.0-next.14

### Minor Changes

- a384a93: 代码评审加固：存量任务订阅兜底、串行分组写偏斜收口、重试状态重置、错误分类与门禁去重

  **@rei-standard/amsg-server**

  - **升级前创建的任务不再必然投递失败。** 投递时解析订阅新增兜底：用户级 `push_subscriptions` 存储里没有订阅时，回退到旧任务 payload 里内嵌的 `pushSubscription`（存储里有则永远优先用存储的那份）。普通投递路径和 agentic 路径都生效——存量部署升级后，用户来不及打开新客户端登记订阅，旧任务照样发得出去。
  - **pg / neon 串行分组占位补上写偏斜收口。** READ COMMITTED 下两个并发 tick 各领同组「不同」行时，`NOT EXISTS` 互相看不见对方未提交的租约，同组两条任务可能并发执行。现在占位提交后再复查一次同组活租约，撞上就放掉自己刚写的租约、这一跳不跑（两边都让路也安全：行保持 pending，下一跳重试）。`claimTask` 与 `push_subscriptions` 三方法同时收拢到 `adapters/pg-shared.js`，pg / neon 共用一份 SQL，语义不再可能分歧。
  - **tick 内串行分组预占用按用户隔离。** 内存侧的占坑键带上 `user_id`，与落库侧 per-user HMAC 的隔离语义对齐——多用户部署下两个用户恰好返回同一个分组 key（如共用的默认角色名）不再互相顶掉对方的任务。
  - **`PUT /update-message` 重置重试状态。** 更新任务时 `retry_count` 归零、`retry_after` 清空（后者仅在支持 `claimTask` 的适配器上写）——刚修好 apiKey / 改好排期的任务不再背着耗尽的重试预算，下一次瞬时故障不会直接把它打成永久 failed。
  - **`POST /schedule-message` 的订阅预检改为存在性检查。** 不再解密（解出来的值本来也用不上）；查询本身失败时报可重试的 503 `PUSH_SUBSCRIPTION_LOOKUP_FAILED`，不再把瞬时 DB 故障伪装成 409 `PUSH_SUBSCRIPTION_MISSING` 引导客户端去走多余的重订阅流程。
  - **订阅类错误带稳定 `code`，投递失败按类别处置。** `resolvePushSubscription` 抛出的错误带 `err.code`（`PUSH_SUBSCRIPTION_MISSING` / `PUSH_SUBSCRIPTION_STORE_UNSUPPORTED`），消费方按 code 分支即可、不必匹配 message 文案；tick 的失败处置对这两类「重试也好不了」的错误短路退避阶梯——一次性任务直接进终审处置，循环任务直接作废本次 occurrence，不再每次白跑 3 轮重试。
  - **过期守卫两处收紧 / 放开。** 重试链上的任务（`retry_count > 0`）在排定的重试时刻（`retry_after`）本身也被拖过阈值时同样按过期处理——停摆恰好落在重试窗口里的任务不再于恢复后把几天前的旧内容推出去（`getPendingTasks` 随之在返回行里带上 `retry_after`）。阈值本身可用 `ctx.staleAfterMs` 覆盖（单用户 worker 从 config 的 `staleAfterMs` 透传），依赖「再晚也送达」语义的宿主有了官方出口。
  - **单用户 worker 的两处错误边界补齐。** `cors.origin` 回调抛错按「不放行这个 origin」处理，不再逃出 `fetch()` 变成 Cloudflare 1101 错误页；`scheduled()` 的配置构建失败改为记日志跳过这一跳，不再以未捕获异常崩掉 cron 调用。
  - **存量多租户租户自动补列。** 多租户侧每个进程首次取得适配器时补跑一遍幂等的 `initSchema`（建表 / `ADD COLUMN IF NOT EXISTS`），升级加列后第一个请求就把 schema 补齐——不再依赖 CHANGELOG 里的手工 DDL 步骤（同 tenantId 重放 `/init-tenant` 到不了 `initSchema` 就 409，此前存量租户没有任何自动迁移路径）。
  - **门禁与工具函数去重。** X-User-Id 门禁（8 个 handler 里的复制粘贴，文案已分裂成两种）收拢为 `lib/request.js` 的 `requireUserId()`，对同一错误码的 message 统一为「缺少用户标识符」；`UPDATABLE_COLUMNS` 白名单三个适配器共用 `schema.js` 一份；`isValidUrl` 改为 re-export shared 的实现；tenant/blob-store 的 base64url 改用 shared 实现；tick 的预解密 payload 直通投递侧（`processSingleMessage` 新增 `predecrypted` 参数），同一份密文不再解两遍，相关失实注释一并修正；过期跳过的循环/一次性两个近似复制的分支收拢为单一尾部。

  **@rei-standard/amsg-shared**

  - `verifyVapidJwt` 的 JWT payload 解码改用 `webcrypto-utils` 的 `utf8Decode`，兑现本模块「编码辅助只住在 webcrypto-utils」的约定（行为不变）。

- client_state 支持条件写护栏：entry 可带 `version` / `builtAt`，按内容新旧比较而不是请求先后

  同一个 key 有多个写入方时（例如 fire_pack 由常规 flush 和 instant-chat 两条路径写），last-write-wins 按「谁的请求后到」判定就是在赌网络：慢网下晚到的旧包会把先到的新包盖掉，fire 端解出来的就是缺段的旧内容。

  现在 `PUT /client-state` 的每个 entry 接受可选的 `version` 或 `builtAt`（正整数，毫秒时间戳或单调递增版本号，两个名字同一个语义）。带了它，这条的比较值就是它：旧内容（值更小）盖不掉新内容，直接被忽略。被拦下的 key 在响应的 `data.skippedEntries` 里逐条回报（`[{ namespace, key }]`），写入方能区分「写进去了」和「库里已有更新的数据」。hook 的 `ctx.writeState()` 的 entry 同样认 `version`。

  没带 `version` 的写入行为不变（照旧按 `updatedAt` 比较）。特性位：`client-state-version-guard`。

- 任务行新增 `last_error` 列（失败原因的明文脱敏摘要）；导出 `NonRetryableError`（确定性失败不重试）

  **last_error**：之前行标 `failed` 但不存原因——payload 里的 `lastError` 是密文，且 `GET /message` 对非 pending 行只回一句 409，最典型的失败（payload 解析失败、hook 在 onBeforeFire 里拒掉）用户一个字都看不到。现在 `scheduled_messages` 加 `last_error` 列（JSON：`{ at, occurrence, reason }`，`reason` 经 `sanitizeErrorSummary` 脱敏：Bearer/key 形态的 token 遮掉、截断 500 字符）：

  - 每次投递失败都写（等重试期间也看得到当前原因），成功后清掉；
  - `GET /message?id=` 对已失败/已完成的行，409 响应的 `error.details` 带 `{ status, lastError }`；pending 行的投影里 `lastError` 也会在 payload 没记录时退回这一列；
  - 升级后还没重跑 `POST /init-tenant`（补列迁移）的库，写入自动退掉这个字段重试，状态推进不受影响。

  **NonRetryableError**：fire_pack 缺失/解析失败这类重试必然同败的错，之前也按投递失败重试 3 次（2/4/6 分钟），用户白等 12 分钟、hook 里的计费调用白烧三轮。现在 hook 抛 `NonRetryableError`（或任何带 `permanent: true` 的错误），run-tick 直接终审处置：一次性任务标 `failed`，循环任务作废本次 occurrence；instant 路径（`processMessagesByUuid`）同样不再重试。判定用 `permanent` 属性而不是 instanceof，跨包/双实例场景安全。

  新导出：`NonRetryableError`、`isNonRetryableError`、`sanitizeErrorSummary`。适配器接口新增可选 `getTaskStatusInfo(uuid, userId)`（三个内置适配器都实现）。特性位：`task-last-error`、`non-retryable-error`。

- 租约按心跳滚动续租，isolate 死亡后任务分钟级被接手；新增 `runTask(ctx, uuid)` 单任务入口

  之前租约是认领时一次性写死的长租约（默认 10 分钟）。isolate 在 claim 后被平台回收（fetch 的 `waitUntil` 预算远小于一次 fire 的上限），行就焊死到租约走完——用户盯着「正在输入…」十几分钟。而且租期是全局一个值，为 instant 场景调短，定时任务的慢投递就会被下一跳重复触发。

  现在投递期间按心跳续租：占位只写一小段租约（默认 90 秒），之后每 30 秒把 `lease_until` 推到 now + 90s。isolate 活着租约永远够用；isolate 死了租约在 ~90 秒内到期，下一分钟的 cron 就能接手。失败路径照旧主动清租约。心跳间隔用 `leaseHeartbeatMs` 配置（0 = 关掉，退回一次性长租约 `claimLeaseMs`）。适配器接口新增可选 `renewTaskLease(taskId, leaseUntil)`（D1 / pg / neon 都已实现；只在行仍持有租约时生效，收尾放掉后迟到的心跳不会复活它）；没实现的自定义适配器自动退回老行为。

  **runTask(ctx, uuid)**：单跑一条任务的官方入口，与 cron tick 走完全同一条投递链（占位、心跳、过期守卫、重试/终态、hook 全套）。给「fetch 里只 enqueue、真正的 fire 交给 CF Queue 消费者（15 分钟预算）跑」的宿主用。行没到点或在退避窗口内不跑（`{ ran: false, reason }`）。

  新导出：`runTask`、`DEFAULT_CLAIM_LEASE_MS`、`DEFAULT_LEASE_HEARTBEAT_MS`、`DEFAULT_HEARTBEAT_LEASE_TTL_MS`。特性位：`tick-lease-heartbeat`、`run-task-entrypoint`。

- 服务端原生消息收件箱（message_outbox + ack）；fire ctx 新增 `cancelTask` / `renewTask`

  **message_outbox**：之前没有收件箱表，「补收」只能靠客户端拿「messageId 在不在本地近 N 条里」猜哪些推送丢了——猜错的每种方式都出过场（删掉的回复复活、多段丢失没人补、与进行中会话竞态重复上屏、重试轮重复生成）。现在：

  - 服务端发出的每条 push（老链路与 agentic 链路都算）在发送前先落一行 `message_outbox`（payload 是整条 push JSON 的 per-user 密文；`(user_id, message_id)` 唯一，重试同一 occurrence 不产生第二行、不复活已 ack 的行）；Web Push 发出后标 `delivered_at`，半途失败只标已发出的段；
  - 客户端两个端点：`GET /outbox?since=<cursor>[&limit=]` 拉未 ack 的行（id 升序游标翻页，响应走加密信封，逐条带解密后的完整 push + taskUuid/sessionId/messageIndex 等），`POST /outbox/ack { messageIds }` 确认收到（幂等）——「补收」变成「拉未 ack」，不存在猜；
  - tick 顺手清理：已 ack 的留 7 天，未 ack 的留 28 天（Web Push TTL 上限四周）；
  - outbox 全程 best-effort：落行失败不影响投递本身。适配器接口新增五个可选方法（`appendOutboxMessages` / `markOutboxDelivered` / `listUnackedOutbox` / `ackOutboxMessages` / `cleanupOutbox`），内置只有 D1 实现（与 client_state 同待遇），没实现的适配器发送链路静默跳过、端点回 501。

  **表结构**：新增 `message_outbox` 表（`initSchema()` / `POST /init-tenant` 会建，幂等）。

  **cancelTask / renewTask**：fire ctx 之前只有 `scheduleTask`，云端轮的角色「看得见任务、动不了」——用户说「取消那个提醒」，角色口头答应，任务照旧触发。现在 `fireCtx` 和每轮 `sessionCtx` 上新增 `ctx.cancelTask(uuid)`（语义同 `DELETE /cancel-message`）与 `ctx.renewTask(uuid, nextSendAt)`（语义同 `PUT /update-message` 只改排期：payload 的 firstSendTime 跟着改、重试计数清零、退避放掉；新时刻至少比现在晚 60 秒）。两者都不许操作当前正在 fire 的这条（收尾归 run-tick 管）。

  特性位：`message-outbox`、`agentic-cancel-renew-task`。

- `POST /schedule-message` 支持 `immediate: true` 与 `supersedesUuid`（原子替换）

  **immediate**：之前 `firstSendTime` 必须严格在未来，想「马上发一条走 cron 链路的任务」只能预留提前量再想办法把行拉回当下——慢网/低端机把提前量吃光就是 400 INVALID_TIMESTAMP。现在 body 里带 `immediate: true` 即可：跳过未来校验，`next_send_at` 落在当下，下一跳 cron（最多一分钟后）直接触发。此时 `firstSendTime` 可省略；对 `instant` 类型明确拒绝（它本就立即投递）。

  **supersedesUuid**：建这条的同时取消旧的那条。D1 适配器新增可选的 `createTaskSuperseding(params, supersedesUuid)`，删旧建新落在同一个 batch（隐式事务、单次往返）——不会出现「旧的删了、新的没建成」的中间态，INSERT 撞 uuid 时整体回滚。适配器没实现时 handler 退回「先删再建」两步。响应里带 `superseded`（旧行是否真的被取消）。

  特性位：`schedule-immediate`、`schedule-supersede`。

- `onFireSettled` 载荷带解密 `metadata` 与最后一轮 `usage`；导出 CORS 头列表与 agentic 预算常量

  - `onFireSettled` 的载荷新增 `metadata`（解密 payload 的 metadata 子字段，与 `onStaleSkip` 同待遇——task 行是密文，宿主要靠它对上是哪个角色的哪类任务，尤其是链路在 onBeforeFire 里就失败、侧信道一条都没写上的那种结局）和 `usage`（最后一轮 LLM 响应的 usage；没跑到 LLM → null）。`onAfterSend` 载荷同样带 `usage`。凭据字段照旧不透传。
  - 导出 `CORS_ALLOW_HEADERS` / `CORS_ALLOW_METHODS`（单用户 worker 的允许头/方法列表）：在 worker 外面再包一层路由的宿主 import 这一份，不用再手抄第二份等它漂移。
  - 导出 `DEFAULT_MAX_TOOL_ITERATIONS` / `DEFAULT_TOTAL_TIMEOUT_MS` / `DEFAULT_MAX_SCHEDULED_TASKS_PER_FIRE` / `MIN_SCHEDULE_LEAD_MS`：包装层要对齐预算档位时用同一份常量。

  特性位：`fire-settled-metadata`、`hook-usage`。

### Patch Changes

- Updated dependencies [a384a93]
- Updated dependencies
  - @rei-standard/amsg-shared@0.4.0-next.4

## 2.6.0-next.13

### Patch Changes

- 532e5a5: 单用户 Worker 的错误响应补上 CORS 头，服务端异常不再伪装成网络故障

  配了 `cors` 的部署里，之前只有正常响应带 `Access-Control-*`，Worker 内部抛异常时回的那条 500 是裸的。跨域前端拿到没有 `Access-Control-Allow-Origin` 的响应，浏览器会把整条丢掉，`fetch` 直接 reject 成 TypeError（Safari 显示 `Load failed`、Chrome 显示 `Failed to fetch`）。结果是**服务端故障在前端长得和「Worker 连不上」一模一样**：错误码、错误信息、HTTP 状态一概读不到，只剩一条「网络失败」。真实排查里，从外部探测该 Worker 一切正常（预检 204、401 都带 CORS 头），因为只有过了鉴权的请求才会走到抛异常那段。

  现在异常 500 带上和正常响应同一份 CORS 头，前端能照常读到 `{ success: false, error: { code: 'INTERNAL_ERROR' } }`，剩下的真因去 `wrangler tail` 里看 `[amsg single-user] fetch() unhandled error:` 那行。

  **配置构建失败也不再静默**。`buildConfig` 自己抛错时（少绑一个 binding、环境变量被重新部署刷掉），连 CORS 策略都无从得知，之前预检和真实请求会一起拿到裸 500——预检不是 2xx，浏览器根本不会发真正那条请求，整个部署在前端看来就是彻底离线且零报错。现在这条降级路径：

  - 预检回 204，真实请求回一条能读的 500；
  - CORS 头**回显来访的 `Origin`，绝不退化成 `*`**。这条路径的响应体是固定的错误信封，没有数据也不带 credentials，且只在配置炸了的时候生效——配置一旦能解析，所有响应重新由 `cfg.cors` 管辖，没配 CORS 的部署不会因为一次故障变成开放的；
  - 同源调用（请求没有 `Origin` 头）依然一个头都不加，与其余路径一致；
  - `Access-Control-Max-Age: 0`，故障期间答复的预检不进浏览器缓存，配置修好即刻失效。

  没配 `cors` 的部署（默认同源）行为不变：OPTIONS 仍然走 404，响应仍然不带任何 `Access-Control-*`。

## 2.6.0-next.12

### Minor Changes

- 17741db: 新增 `onFireSettled`：一次 fire 无论什么结局都给一次收尾回执

  `onAfterSend` 只走「有 push 要发」那条路。hook 判断这次不用说话（`onBeforeFire` 返回 `{ skip: true }`、或模型跑完后 `skip-push`）、以及链路中途抛错时，宿主收不到任何收尾信号——凡是「开始时占点什么、结束时放掉」的写法都会漏。两种典型漏法：角色在这次 fire 里用 `ctx.scheduleTask` 排了一条后续任务（任务行已经真的写进库了），但记账的代码挂在发送后，这次生成最终是空的就没人记，那条任务从此只活在数据库里——面板列不出、用户取消不掉，却照样到点触发；以及 fire 开头拿的锁没有可靠的释放点，一次 skip 就把资源占满整个 TTL。

  config 顶层（与 `onAfterSend` / `onStaleSkip` 并列）挂 `onFireSettled`，**只要 `onBeforeFire` 被调用过就一定会被调用一次**：

  ```js
  async onFireSettled(info) {
    // { task, status, skipReason, sentCount, total, iterations, error,
    //   scratch, readState, writeState }
  }
  ```

  `status` 四种：

  | status        | 什么时候                                                                                                                      |
  | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
  | `sent`        | pushPayloads 全部发完（`sentCount === total`）                                                                                |
  | `skipped`     | 这次不发。`skipReason` 区分是 `onBeforeFire` 直接 `{ skip: true }`（`'before-fire'`）还是模型跑完后判定不发（`'skip-push'`）  |
  | `failed`      | 链路抛错，`error` 带原始错误。发到第 k 段挂了也是这个：`sentCount = k`、`total` 是原本要发的段数                              |
  | `not-handled` | `onBeforeFire` 返回 `null`，这条任务交还给排程时冻结的 prompt 老链路。那条链路不归 fire hook 管，它后面发没发出去不体现在这里 |

  `onAfterSend` 的调用点和载荷都不变，两者分工是「发送回执」与「fire 结束信号」：正常发完时两个都会调，`onAfterSend` 在前，`scratch` 是同一个引用。没配 hooks 的部署、以及不需要 LLM 的固定文本任务不走 fire 这条路径，两个都不会调。`onFireSettled` 同样是 best-effort，自身抛错只记日志。

  `GET /capabilities` 的 features 追加 `fire-settled-hook`。

- 17741db: 定时触发支持「同一分组的任务不并发」，投递失败的退避搬到自己的列上

  同一个角色可能有好几条定时任务。撞在一起并发跑的话，用户一口气收到两条互不知情的消息；宿主在 fire hook 里维护的「我刚才说过什么」台账通常是读进内存 → 改 → 整份写回，两条各改各的再写回，后写的必然盖掉前面那条——有一句说过的话没记上账，下次角色会换个说法再讲一遍。宿主自己做的「每角色任务数上限」这类判定也一样，并发时各算各的，拦不住。

  `runScheduledTick`（以及单用户 Worker 的 config）新增可选的 `serializeBy`：

  ```js
  serializeBy: (task) => task.metadata?.charId ?? null;
  ```

  - 参数是与 `onBeforeFire` 的 `ctx.task` 同一份的只读任务视图（凭据已剔除）。返回什么算一组由宿主定义。
  - 返回 `null` / 空串、或者不配这个函数 → 这条任务不参与串行，行为与不带该配置时完全一致。
  - 同一分组同时只放行一条，**跨跳也算**：上一跳的 fire 还拿着租约时，下一跳捞到同组的另一条也不放行。一次 fire（组 prompt → 调 LLM → 跑工具 → 分段推送）常常跑十几秒到几分钟，只挡同一跳是不够的。
  - 同一跳内同组放行的是**到点更早**的那条，跑完之后不补跑同组剩下的，留给下一跳（cron 一分钟就再来）。
  - 被拦下的任务是**推迟不是丢弃**：`next_send_at` / `status` / `retry_count` 一个字段都不会被动，下一跳原样再捞一次。条数记在 tick 返回值的 `details.serializeSkippedTasks`（同一跳内拦下的）和 `details.claimSkippedTasks`（跨跳拦下的）里。
  - `serializeBy` 自身抛错时这条任务这一跳不跑：分不清它属于哪一组，就不该冒着破坏宿主台账的风险跑下去。

  分组判定和占位是同一条 `UPDATE`——先查「这一组忙不忙」再占位的话，两个 tick 的查询会双双在对方占位之前返回「不忙」。分组 key 不明文落库：库拿它和该用户的存储密钥做一次 HMAC，列里存的是那个派生值。

  **退避与租约分两列**：`lease_until` 只表示「这条正在跑」，投递失败的退避时刻记在新的 `retry_after` 上，失败时租约当场放掉。挤在一列的话，一条正在退避、其实闲着的任务会被分组串行当成「这一组忙着」，同组别的任务白等一轮退避（最长 6 分钟）。捞取待发任务时两列都要看：租约没到期、或退避没到点，都不算待发。

  **表结构**：`scheduled_messages` 新增两列 `retry_after`（SQLite `TEXT` / Postgres `timestamptz`）、`serialize_group`（SQLite `TEXT` / Postgres `VARCHAR(64)`），都可空；另加一个索引 `idx_serialize_group_lease`。`initSchema()`（包括 `POST /init-tenant`）会给已有的表补上，跑几次都没事。手工维护表结构的话，D1 执行 `ALTER TABLE scheduled_messages ADD COLUMN retry_after TEXT` 与 `ALTER TABLE scheduled_messages ADD COLUMN serialize_group TEXT`，Postgres 用对应的 `ADD COLUMN IF NOT EXISTS`；索引语句见 `examples/cloudflare-single-user/schema.sql`。**先升 worker 再让 cron 跑**：列不在时捞取语句会直接报错，整跳发不出去。

  适配器接口的 `claimTask` 多一个可选的第四参数 `serializeGroup`，D1 / pg / neon 三个内置适配器都已实现；实现了它的适配器，`updateTaskById` 还要认 `retry_after`（含写 null）。自定义适配器忽略第四个参数的话，分组串行退化成只在同一跳内生效；完全不实现 `claimTask` 的同理。

  `GET /capabilities` 的 features 追加 `tick-serialize-by`。

- 17741db: 新增 `GET /message` 单条任务查询；`update-message` 认 `contactName`

  - **`GET /message?id=<uuid>`（客户端 `client.getMessage(uuid)`）** 返回单条任务，形状与 `GET /messages` 列出来的一样，外加**完整的 `metadata`**。`PUT /update-message` 对 `metadata` 是整体替换（不深合并），而列表的投影只给 `charId` / `clientTaskId` 两个子字段——两件事凑在一起，「只改 metadata 里的一个键」是做不到的：拿不回完整的那份就没法读-改-写，盲传一部分会把宿主存在里面的其余键（任务指令、锚点时间戳、过期策略之类）一起冲掉，下次触发直接失败。列表维持不带整份 metadata：一页最多 100 条，每条都驮着它会把响应撑得很大，而列表要的只是「有哪些任务」。单条查询只读得到还没发出去的任务，已完成 / 已失败返回 `409 TASK_ALREADY_COMPLETED`、不存在返回 `404 TASK_NOT_FOUND`，与 `PUT /update-message` 同一口径。

  - **`PUT /update-message` 的可写字段加上 `contactName`**（非空字符串，口径与排程时一致；空串 / `null` / 非字符串返回 `400 INVALID_UPDATE_DATA`）。用户给角色改了名之后，之前排好的任务推送出来的通知标题（「来自 `<contactName>`」）靠它跟着改。`contactName` 不是 key——宿主按角色过滤用的是 `metadata.charId`，它会跨角色重名——数据库里也只活在加密 payload 中，没有独立列或索引引用它。

  `GET /capabilities` 的 features 追加 `get-message-detail` / `update-message-contact-name`。

## 2.6.0-next.11

### Minor Changes

- d6bea67: hook 契约补齐任务身份与状态读写口；push 自带任务的调度身份

  - **config 级 hook 拿到状态读写口。** `onAfterSend` / `onStaleSkip` 的载荷里现在有 `readState(ns)` / `writeState(ns, entries)`，语义与 fire 级那套一致（单用户模式下作用于当前用户的命名空间）。此前只有 fire 级 ctx 上有，宿主要在这两个 hook 里写 `client_state` 只能自己缓存一份写口：isolate 冷启动后、本次 tick 里还没有任何 fire 跑过时缓存是空的（服务停摆恢复后那一波过期跳过一条痕迹都留不下，而那正是 `onStaleSkip` 存在的意义），缓存下来的闭包还握着上一次 invocation 的数据库绑定。
  - **`onAfterSend` 收到本次 fire 的 `scratch`。** 与 `onBeforeFire` / `onLLMOutput` 是同一个对象引用，所以「这次生成了哪几段正文」这类上下文直接从 `info.scratch` 读，不用再按任务行 id 自建登记表（连带 TTL 清扫和并发隔离）。完整载荷：`{ task, sentCount, total, error, scratch, readState, writeState }`。
  - **`onLLMOutput` / `executeToolCalls` 的 ctx 直接带任务身份**：`taskId`（任务行 id）、`taskUuid`、`occurrenceMs`（本次触发的名义时刻，epoch 毫秒）。`sessionId` 是给日志和去重用的不透明字符串（当前格式 `sess_task_<id>@<occurrenceMs>`），拿它切字符串取任务身份是切不稳的。
  - **每条 push 顶层带 `taskId` / `taskUuid` / `recurrenceType` / `occurrenceMs`**（冻结 prompt 路径和 fire-time hook 路径都算）。客户端据此认领任务、判断它还会不会再来——角色在 fire 里给自己排的任务客户端从没见过，此前只能靠宿主往 `metadata` 里逐个抄。调用方在 `pushPayloads` 里自己写了这几个字段会被库覆盖：它们描述的是任务行的事实，不是内容。`@rei-standard/amsg-shared` 的 `AmsgPushCommon` 类型随之收录这四个字段（`taskId` 从 `ContentPush` 上移到公共层）。
  - **新增导出 `PUSH_ENVELOPE_RESERVED_BYTES`（384 字节）**，以及 `measurePushPayload(payload, { reserveEnvelope: true })` 这个口径。hook 把 payload 交还给库之后，库还会补 `messageId` / `sessionId` / `timestamp` / `messageIndex` / `totalMessages` / `taskId` / `taskUuid` / `recurrenceType` / `occurrenceMs`，hook 手里量到的从来不是最终 payload；不留这一截的话，卡在边界上的消息会「量出来装得下、补完字段就超了」，既没走旁路存储也发不出去。返回值多一个 `envelopeReservedBytes`。
  - **`GET /capabilities` 的 features 追加** `hook-state-accessors` / `after-send-scratch` / `fire-task-identity` / `push-task-identity` / `push-envelope-reserved-bytes`。

- d6bea67: 任务生命周期：撞车回已存在的任务、循环过期也有回执、循环推进认时区

  - **`ctx.scheduleTask()` 撞 uuid 时回已存在那一行的投影**：`{ created: false, reason: 'duplicate', uuid, task }`。`task` 与 `GET /messages` 列出来的形状一样（`id` / `uuid` / `contactName` / `messageType` / `messageSubtype` / `nextSendAt` / `recurrenceType` / `tzId` / `status` / `retryCount` / `createdAt` / `updatedAt` / `charId` / `clientTaskId` / `lastError`），不含任何凭据。用确定性 uuid 做重试幂等时，重跑那轮此前什么信息都拿不到，那条任务只活在数据库里——宿主的面板列不出、用户取消不了，却照样到点触发烧 LLM。行读不回来（已经不是 pending）→ `task` 为 `null`。投影实现与 `GET /messages` 共用一份，两边不会漂。
  - **循环任务的过期快进也走 `onStaleSkip`、也写 `lastError`。** 此前一次性任务错过太久会标 `failed`、写 `lastError`、调 hook，而循环任务直接把 `next_send_at` 快进到下一次，不回调、不记录、零痕迹——宿主完全无从知道「昨天那次没响」。两种情况现在共用一个 hook，靠 `info.action` 区分：`expired`（一次性，行已标 `failed`）/ `fast_forwarded`（循环，排期已快进，行仍是 `pending`）。载荷补齐 `recurrenceType` / `occurrenceMs` / `skippedCount`（跳过几次，含名义那一次）/ `skippedOccurrences`（被跳过的名义时刻，超过 32 次时只给首末两个并置 `skippedTruncated`）/ `nextSendAt`。tick 返回值的 `staleTasks` 每项也多一个 `skippedCount`。
  - **任务行支持 `tzId`（IANA 时区 id），`daily` / `weekly` 按该时区的墙钟推进**：同一钟点，日期 +1 天 / +7 天。此前是固定 +24h / +7×24h，跨过夏令时切换点之后墙钟永久漂一小时——用户设的「每天早八点」从此变成早九点。`POST /schedule-message`、`PUT /update-message`（传 `null` 改回按 UTC 推进）、`ctx.scheduleTask({ tzId })`（默认继承当前任务）三个入口都认这个字段，`GET /messages` 每条任务多返回一个 `tzId`（没设 → `null`）。不带 `tzId` 的任务按 UTC 推进。时区换算全部走 `Intl`，不做偏移加减：春令时被跳过的墙钟落到切换之后的等价时刻，秋令时重复出现的墙钟取其中一个、不触发两次。
  - **新增导出** `isValidTimeZoneId` / `advanceOccurrence` / `nextFutureOccurrence` / `planNextOccurrence`，宿主想自己算「下次什么时候」时用的是同一份实现。
  - **`GET /capabilities` 的 features 追加** `schedule-task-duplicate-row` / `recurring-stale-skip-hook` / `task-timezone`。

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
