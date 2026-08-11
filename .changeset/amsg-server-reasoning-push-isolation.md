---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-instant": patch
---

思考过程发不出去不再连累正文，超长的思考过程改走分片送达

**1. 思考过程发不出去时，正文照发**

模型回了 `reasoning_content` 时，库会在正文之前先发一条 ReasoningPush。原来它和正文共用一个发送循环，而这个循环是一条抛错就整批中断——ReasoningPush 又排在最前面，所以它一失败，这条消息的正文一句都发不出去。一条 push 的明文上限是 3993 字节（约 1300 汉字），推理模型的思考过程很容易超，于是 `deepseek-reasoner` 这类默认返回思考过程的模型，定时消息基本必挂。

现在思考过程单独发，失败就地记一行日志、正文一条不少地照发。它是正文之外的附赠内容，发不出去只影响它自己。

失败原因同时回到 `processSingleMessage` 的结果上（`reasoningError`）——`success` 仍是 `true`，但调用方能知道这次思考过程没送到，而不是只在服务端日志里留一行。

任务在投递期间被取消是例外：那是整条任务的中止信号，不是「思考过程没发成」，会照常往上抛。

**2. 一条装不下的思考过程改走分片**

超出单条上限的思考过程会切成 `_multipart` 分片逐条发出，Service Worker 收齐后还原成原样的 ReasoningPush 再走正常派发——用的是 `@rei-standard/amsg-instant` 已经在用的那套通用分片传输，`@rei-standard/amsg-sw` 的重组端不用改。切完仍超出分片传输量级上限（默认 256 KB / 128 片）的，跳过这条思考过程，正文照发。

分片的重组窗口由 Service Worker 侧的 `multipart.ttlMs` 决定（默认 60 秒），发送端不再额外收窄。

分片之间跟正文的段一样按 1.5 秒的节奏发：一口气推几十条会被推送服务限流，而这里丢一条整段思考过程就收不齐了。

限额跟着宿主走：服务端 ctx 上的 `multipart`（`maxChunkBytes` / `maxChunks` / `maxTotalBytes` / `ttlMs`）用来跟 `installReiSW` 那份对齐。接收端把 `maxChunks` 调小了而发送端不知道的话，切出来的分片到了那边会被逐片拒收，一条也拼不回来，而发送端这边两道门槛全都过了、看不出任何异常。

切片构造函数 `buildMultipartPushPayloads` 与默认切片大小 `DEFAULT_MULTIPART_CHUNK_BYTES` 随之上移到 `@rei-standard/amsg-shared`，两个发送端共用同一份。`@rei-standard/amsg-instant` 的导出名和行为不变。

**3. `pushStatusCode` 只认推送那一步的状态码**

失败结果里的 `pushStatusCode` 原来是从捕获到的任何异常上读 `statusCode`，而这个 catch 罩着整个投递流程——LLM 调用、fire-time hook、解密都在里面。Node 生态的 HTTP 库习惯把上游状态码挂成 `statusCode`，所以宿主 hook 里转手抛出的一个 404，会让任务被判成「推送订阅已失效」永久 `failed`，失败记录里的 `pushStatus: 404` 还会让客户端去引导用户重建订阅。

现在这个字段只在真正发 push 的那一步赋值，别的来路的 `statusCode` 一律不认。推送服务回的 404 / 410 / 413 判定不变。
