---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-instant": patch
---

思考过程发不出去不再连累正文，超长的思考过程改走分片送达

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
