# Changelog — @rei-standard/amsg-instant

## 0.11.0-next.5

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

- Updated dependencies [80f471d]
- Updated dependencies [80f471d]
  - @rei-standard/amsg-shared@0.4.0-next.7

## 0.11.0-next.4

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

### Patch Changes

- ab1df8a: 两个适配器的故障不再伪装成「服务不在」：Cloudflare 配置构建失败回可读的 500，Node 上的 SSE 真流式

  **Cloudflare 适配器：`createCloudflareWorker` 的构建失败有了降级路径。**

  `optionsBuilder` 抛错（wrangler.toml 里 binding 名字写错、preview 环境没配、secret 被重新部署刷掉）或 `createInstantHandler` 拒绝配置时，原来异常直接冲出 `fetch`。跨域前端只能读到一句 `TypeError: Failed to fetch`（Safari 是 `Load failed`），HTTP 状态码、错误码、错误信息一概拿不到；预检 OPTIONS 一起挂，浏览器于是根本不会发那条真正的 POST。运维从外面探测看到的就是「彻底离线且零报错」，而 Worker 其实部署成功、在跑，只是每次请求都在同一行抛。`blobStore` 和 `createCloudflareWorker` 一起用时尤其容易踩到——Workers 的 `env` 只在请求期可得，blob 存储的构造只能写在 `optionsBuilder` 里。

  现在这条路径：

  - 预检回 204，其余请求回一条能读的 500：`{ success: false, error: { code: 'INTERNAL_ERROR', message, cause } }`，`cause` 是机读的 `{ stage, name, message?, code? }`（`stage` = `'config'` 构建配置时炸的 / `'request'` handler 抛出来的），长得像凭据的串会先遮掉；
  - CORS 头**回显来访的 `Origin`，不退化成 `*`**：配置都没建起来，这个部署允许哪些站点无从得知；配置一修好所有响应立刻回到 handler 自己那套 CORS；
  - 回显 Origin 意味着任意第三方页面都能读到这条响应，所以构建失败那条路上跨域读到的 `cause` 只有 `stage` / `name` / `code`，不带 `message`——构建期异常的原文往往就是部署信息本身（`env.BLOB_KV is undefined` 报的是 binding 名，配置校验的报错里可能有内网域名、环境变量名）。同源请求和不带 `Origin` 的调用（`curl`、服务端之间调用）照旧拿全文；
  - `Access-Control-Max-Age: 0`，故障期间答的那次预检不会留在浏览器缓存里；
  - 同源调用（请求没有 `Origin` 头）依然一个 CORS 头都不加；
  - 构建失败不被记住，下一个请求照常重试：binding 补上之后不用重新部署也能自己恢复。

  真因除了随响应回给调用方，也照常记一行 `[amsg-instant] createCloudflareWorker:` 日志，`wrangler tail` 里能看到。

  **Node/Express 适配器：`toNodeHandler` 改成边收边写。**

  原来它用 `response.arrayBuffer()` 把响应整个读完再交给 Node，而 instant 的默认传输就是 SSE：客户端要等整轮 LLM + 全部推送跑完才收到第一个字节，`keepaliveMs` 心跳（默认 1 秒，本来就是为了防连接闲置被掐）全被压在缓冲里，慢一点的模型撞上 nginx 默认的 `proxy_read_timeout 60s` 就是 504——而响应头写的仍然是 `text/event-stream`，从外面完全看不出传输层已经降级。现在响应体一产出就往下写，心跳按时到达，反代也不会再把连接判死。

  顺带的行为变化：

  - 客户端提前断开时上游那个流会被 cancel，instant 据此停掉心跳定时器、把剩下的消息切到 Web Push 兜底，不再留一个没人读的流继续跑；
  - 响应中途出错（字节已经发出去一部分）时连接直接断开，而不是在流里追加一个 JSON 错误信封再正常收尾——调用方能看出这是一条没收完的流；
  - 所有响应改由 chunked 传输编码发出（原来单次 `end()` 会带 `Content-Length`）。JSON 模式（`Accept: application/json`）的状态码、响应头与响应体不变。
  - 这条路由上别再套会缓冲响应的中间件：`compression` 默认连 `text/event-stream` 一起压，压缩缓冲区攒够才吐字节，等于把流式又压回非流式，用它的 `filter` 跳过该路由即可。

  `toVercelNodeHandler` 就是同一个函数，一并生效。

  **Node 适配器：响应流没写完就结束时留一行日志。**

  `pipeline` 无论因为什么失败都会先把响应销毁，所以「响应被销毁了」分不出是客户端走了还是服务端自己的流炸了；客户端断开和服务端流中途失败给的也是同一个 `ERR_STREAM_PREMATURE_CLOSE`。分不出就不硬猜：这两种情况 socket 都已经没了，往上抛只会去写一个没人读的 500，所以记一条 `console.warn`（不是 `error`——用户随手关页面是家常便饭，记成故障会把日志淹掉）。socket 层明确的 `EPIPE` / `ECONNRESET` 是对端掐了连接，照旧安静收场；其余错误照常抛给外层。

  **Cloudflare 适配器：请求阶段的兜底 500 走部署自己的 CORS。**

  handler 建起来之后，「允许哪些 origin」就是已知的了，这条兜底 500 用的是部署配置的那套 CORS 头，跟正常响应一致。回显来访 Origin 的降级头只用在「配置都没建起来」那条路上——那时白名单确实无从得知。

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

- Updated dependencies [922afe1]
- Updated dependencies [ca83382]
- Updated dependencies [c3e1906]
- Updated dependencies [922afe1]
- Updated dependencies [922afe1]
  - @rei-standard/amsg-shared@0.4.0-next.6

## 0.11.0-next.3

### Minor Changes

- 导出 `validateClientAuth` / `DEFAULT_MAX_LOOP_ITERATIONS` / `CORS_ALLOW_HEADERS`；`cors.allowHeaders` 可配置

  在同一个 worker 里挂自己路由的宿主，此前只能照抄本包内部的鉴权与 CORS 实现——抄的那份不会跟着上游修：

  - `validateClientAuth(request, expectedToken)`：X-Client-Token 的独立校验口（presence 检查 + 常时比较，与 handler 内部同一套语义）。返回 `{ ok: true }` 或 `{ ok: false, status: 401, body }`，宿主直接用 body 造响应即可；expectedToken 为空 = 部署没配共享密钥，一律放行。
  - `DEFAULT_MAX_LOOP_ITERATIONS`（= 10）：agentic 循环的默认轮数上限，之前只有内部默认值，宿主各写各的迟早对不上。
  - `CORS_ALLOW_HEADERS`：本 handler 的允许头列表；`cors.allowHeaders` 现在可配置（宿主的路由多带自定义头时覆盖，不配就是导出的这一份）。

### Patch Changes

- Updated dependencies [a384a93]
- Updated dependencies
  - @rei-standard/amsg-shared@0.4.0-next.4

## 0.10.1-next.2

### Patch Changes

- d47a842: 包元数据对齐：instant 的 `engines.node` 从 `>=18` 收紧到与其余包和构建目标一致的 `>=20`；instant / sw 对 `@rei-standard/amsg-shared` 的依赖区间统一为 `^0.4.0-next.1`。
- Updated dependencies [d6bea67]
  - @rei-standard/amsg-shared@0.4.0-next.3

## 0.10.1-next.1

### Patch Changes

- 3dae842: LLM 调用器收敛到 shared：新模块 `shared/src/llm-call.js` 承载「构造请求体 + fetch + 超时 + 解析响应 + trim」的公共核心，从包根导出 `callLlm` / `buildLlmRequestBody` / `normalizeAiApiUrl`

  此前 instant（`message-processor.js` 的 `callLlmRaw`）与 server（`lib/llm.js` 的 `callLlm`）各写一份 LLM HTTP 调用，已出现漂移（stream 字段、messages 模式探测、超时可配性、trim 位置）。现在单一来源在 shared，两侧差异走 options 参数化（`stream` / `forwardTools` / `timeoutMs` / `fetch` / `requireContent`），instant 与 server 的调用点改薄，各自的导出名（instant 的 `normalizeAiApiUrl`、server 的 `callLlm` / `buildAiRequestBody` / `normalizeAiApiUrl`）与错误码包装不变。`llm.js` 里「两包各自拷贝以避免架构依赖」的过期注释一并删除——两包都已依赖 shared，该理由不再成立。

  行为变化（均为边缘修正）：

  - instant：messages 模式探测统一为 `Array.isArray(payload.messages) && payload.messages.length > 0`（server 语义）。`messages: []` 从「把空数组原样发给上游 LLM」改为「回退 completePrompt 模式」——这是修正错误行为。经公开 handler 不可触达（校验层已拒绝空 messages），仅影响直接调用 `processInstantMessage` 的调用方。
  - instant：`maxTokens` 非法时的错误文案统一为 server 措辞（`Invalid maxTokens: maxTokens must be a positive integer when provided.`）。handler 校验在前，正常路径不可触达。
  - server：`normalizeAiApiUrl` 对非字符串输入统一为 instant 的宽松语义（先 `String()` 强转再解析；此前直接抛「apiUrl is required」）。字符串输入两侧行为本就一致，不受影响。
  - server：`callLlm` 现接受额外 options（`fetch` / `stream` / `forwardTools`），默认值即原 server 语义，既有调用不受影响。

- 8ca959c: 线协议常量收敛到 shared：新模块 `shared/src/protocol.js` 承载 multipart transport 与 SW ↔ 页面 postMessage 的全部线协议常量，从包根导出

  此前 multipart 的 kind / encoding / 默认限额在 instant（`src/multipart.js`，导出）与 sw（`src/index.js`，本地重写、未导出）各写一份，`version: 1` 字面量也两侧各写；SW ↔ 页面 postMessage 常量只定义在 sw 包里，README 教页面侧硬编码字符串。现在单一来源在 shared：

  - multipart：`MULTIPART_MESSAGE_KIND` / `MULTIPART_ENCODING` / `MULTIPART_VERSION`（新增，替代两侧的 `version: 1` 字面量）/ `DEFAULT_MULTIPART_TTL_MS` / `DEFAULT_MULTIPART_MAX_CHUNKS` / `DEFAULT_MULTIPART_MAX_TOTAL_BYTES`
  - postMessage 信封：`REI_AMSG_POSTMESSAGE_TYPE` / `REI_SW_EVENT` / `REI_SW_MESSAGE_TYPE` / `REI_AMSG_DELIVER_MESSAGE_TYPE`

  instant 的 `src/multipart.js` 与 sw 的 `src/index.js` 改为 import shared 并按原导出名 re-export，两个包的公开导出面与 wire format 不变（`DEFAULT_MULTIPART_CHUNK_BYTES` 是发送端独有的切片默认值，留在 instant）。页面侧代码现在可以从 `@rei-standard/amsg-shared` import 这些常量，不必硬编码字符串，也不必从 sw 包 import（那会执行 SW 模块的顶层状态）；client / sw 的 README 示例已相应更新。

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

## 0.10.1-next.0

### Patch Changes

- 914ddcf: amsg-shared 新增 agentic 循环契约工具：`buildSessionContext`、`extractAssistantMessage`、`assertValidDecision`（新增 `inlineToolCalls` 选项，允许 `tool-request` 直接携带 `toolCalls`，供服务端就地执行工具的场景用）、`extractToolCallsFromDecision`。amsg-instant 的 SessionContext 构建与 decision 校验改为从 amsg-shared 复用同一实现，对外行为与错误信息不变。
- Updated dependencies [914ddcf]
  - @rei-standard/amsg-shared@0.4.0-next.0

## 0.10.0

### Minor Changes

- f4812ce: 接收端支持 gzip 压缩的请求体。带 `X-Amsg-Request-Encoding: gzip` 头的请求会先 gunzip 再解析，不带这个头的请求按原样读取，行为不变。CORS 预检白名单里也加上了这个头。这样 `@rei-standard/amsg-client` 的 `deliver({ compressRequest })` 就能直接发到 `amsg-instant` 的 `/instant` / `/continue`，不用自己在后端解压。

### Patch Changes

- Updated dependencies [5c0e047]
  - @rei-standard/amsg-shared@0.3.0

## 0.9.1 — SSE stream lifecycle owns LLM + push completion

- **Fix**: SSE 模式下 LLM 调用与每条 payload 的 Web Push backup / fallback 完整运行在 `ReadableStream.start()` 内——`start()` 先 await 所有 backup 推送，再 `controller.close()`。响应仍在产出期间 runtime 不会施加 wall-clock 上限，慢 LLM + 客户端中途断开（iOS Safari 杀掉后台 SSE socket、页面切走等）的组合下也能把这一轮消息送达。
- **Fix**: `event: error`（流内业务错误诊断）的 always-on backup push 现在确定性到达 push gateway，与其它 SSE payload 共用同一 `messageId`，由 `@rei-standard/amsg-sw` 的 dedupe gate 合并为单次通知。
- **Fix**: `isPurePush` 不再用严格相等比对 Accept header。原 `headers.get('accept') === 'application/json'` 把 `application/json; charset=utf-8` / `application/json, */*` 这类合规变种全部错路由到 SSE 分支；改成 `acceptsJsonOnly()`——只在所有 media range 都是 `application/json` 时返回纯 push 分支，让声明要 JSON 的调用方真的拿到 JSON。
- **Fix**: `readReasoningContent` 命中 `<think>` / `<thinking>` / `<thought>` fallback 时，原本同一段内容会被推两次——一次 ReasoningPush，一次仍带 raw 标签嵌在 ContentPush。新增 `stripReasoningTags()` 在 sentence-split 之前剥掉这些 span，私有 chain-of-thought 不再泄到正文。
- **Tests**: 增加三条针对"LLM 永远不被塞进 waitUntil 30s 桶"契约的回归测试——多 chunk + 中途 abort 全 fallback 投递、SSE 模式 waitUntil 注册数恒为 1（只剩 startDone）、慢 LLM 必须先于 `controller.close()` resolve。任何让 LLM 调用或 push HTTP 漂出 `start()` 的改动都会被这套断言拦下。
- **Docs**: README / JSDoc 校准 SSE 生命周期描述。SSE 模式由 stream 生命周期托管；`ctx.waitUntil` 在该模式下只做收尾兜底。纯 Web Push 模式（`Accept: application/json`）继续把主回复链路注册到 `waitUntil`。

## 0.9.0 — always-on SSE backup push + keepalive controls

- **New**: SSE backup push 固定开启。SSE payload enqueue 成功后立即发送同 `messageId` 的 Web Push backup，配合 `@rei-standard/amsg-sw` 默认 dedupe 作为正式环境推荐链路。
- **Changed**: `sse.backupPush:'off' | 'delayed'` 与 `sse.backupDelayMs` 在稳定版中移除并拒绝配置，避免正式部署误入已知可能丢 payload 的模式。
- **New**: SSE keepalive 可配置，默认 `immediateKeepalive:true` + `keepaliveMs:1000`，并把 `keepaliveMs` clamp 到最小 250ms。
- **New**: SSE transport 事件补齐：`sse_payload_enqueued`、`sse_payload_enqueue_failed`、`sse_stream_aborted`、`sse_stream_canceled`、`backup_push_scheduled`、`backup_push_sent`、`backup_push_failed`、`fallback_push_sent`、`fallback_push_failed`。`backup_push_*` 事件 payload 不再带 `delayMs` 字段（always-on backup 后永远是 0，留着只是噪声）。
- **Fix**: SSE `ReadableStream.cancel(reason)` 现在会标记 stream 不可用，后续 payload 走 Web Push fallback。
- **Fix**: Blob envelope 现在携带原始 payload 的 `messageId` / `id` / `dedupeKey`，让 SSE payload 与 blob backup 能在 `@rei-standard/amsg-sw` 层共用 dedupe。
- **Docs**: `safeEnqueue` 内联注释跟 always-on backup 行为对齐——之前注释只描述了 fallback 路径，没提成功 enqueue 也会照样发同 `messageId` 的 backup push。注释修正，行为不变。

## 0.9.0-next.1 — SSE 分支接入 waitUntil (pre-release)

修补 `0.9.0-next.0` SSE 分支没接生命周期保护的遗漏。

**问题**：SSE 模式下 handler 同步 `return Response`，`ReadableStream.start()` 在后台跑。客户端断开后流不再写字节，fallback 路径里 `await sendPushWithMaybeBlob(...)`（发 HTTP 给 push gateway）失去 runtime 的"还在干活"信号，部分 runtime（典型如 Cloudflare Workers）可能在这一步中途回收 isolate，导致 fallback push **服务端代码没机会跑完**。这是 plan §"环境约束"已经预警过的脆弱点，但 `0.9.0-next.0` 的实现没盖到。

**修复**：SSE 分支也走 `registerWaitUntil`——`start()` 返回前注册一个 deferred，`start()` 的 `finally` 里 resolve。runtime 看到 unresolved promise 就不会先掐 isolate，fallback HTTP 调用得以完整发出。

**保证范围**（去掉网络 / push 服务 / 设备 / SW 这些不可控因素后）：

- 客户端断在 LLM 调用期间 → LLM 跑完 + 所有 push 全走 fallback 发完
- 客户端断在第 N 条 SSE push 之后 → 第 N+1 条起的 fallback push 完整发出

**不保证**：

- 实际可跑时长**受所在 runtime / 计划档位的 `waitUntil` 与 CPU/wall 上限约束**——不同平台、不同付费层级窗口不一样，本包不承诺具体数字
- `controller.enqueue()` 返回成功但客户端还没读完那部分字节、随后断开 → 服务端以为送达了不会触发 fallback。修复严格 at-least-once 需要 ACK + replay buffer，本版仍不引入

非 SSE 分支与 `0.9.0-next.0` 一致。

## 0.9.0-next.0 — SSE 流式传输 + 生命周期 hooks (pre-release)

发布在 `next` dist-tag。**不要在下游 SSE consumer（`@rei-standard/amsg-client@2.4.0-next.0+` 的 `consumeInstantStream`）接入完成前升级到 latest。**

### 默认传输模式切换为 SSE

不带 `Accept: application/json` 的请求现在返回 `text/event-stream`：每条 push 通过 `event: payload\ndata: <json>\n\n` 流式投递，流末尾发 `event: done\ndata: {}\n\n`。结果直达主线程（不绕 push service → SW → IDB → window 这条链路），延迟从约 1–3s 降到次百毫秒；iOS WebKit 也不再为每条 payload 触发系统通知。

显式带 `Accept: application/json` 走 0.8.x 既有的纯 Web Push 路径，行为字节级不变——`{"success": true, "data": {...}}` JSON 响应、错误码与状态码映射、1500ms 间隔节奏都保留。

> 请求 body 仍**必须**带 `pushSubscription`：SSE 写失败或客户端断开时框架用它做 best-effort fallback push。

### Best-effort SSE → Web Push fallback

SSE 写入抛错或 `request.signal.aborted` 触发 → 当前及后续 payload 自动走 `sendPushWithMaybeBlob` 转发到 Web Push 通道。同一 payload 在 SSE 和 fallback Push 上共用同一 `messageId`，客户端按 ID 幂等去重即可。

第一版**不做**严格 at-least-once / exactly-once：

- SSE `controller.enqueue()` 只意味着字节进了 Worker 出口队列，不代表客户端已读完并入库
- 可能重复（SSE 发了但客户端没处理完就断了，Push 又补发同一条）
- 也可能少量丢失 in-flight payload
- 严格交付保证需要 ACK + replay buffer，这版不引入

### 新增 `onBeforeLoop` / `onAfterLoop` 生命周期 hook

```ts
onBeforeLoop?: (ctx: { requestBody, sessionId, metadata }) => unknown | Promise<unknown>;
onAfterLoop?:  (ctx: { deliver, sessionId, metadata, requestBody, pending }) => Promise<void>;
```

`onBeforeLoop` 在主 LLM loop 启动**前**调用，约定 hook 同步启动副任务并返回 handle 对象（例如 `{ lookup: runBackgroundLookup(...) }`，里面的 promise 已经在跑）。框架只 await 函数返回——**不**会替你 await 副任务本身。返回值作为 `pending` 透传给 `onAfterLoop`，由后者按自己的结构 `await` 并通过 `deliver(payload)` 追加 push。

两个 hook 在 SSE 与纯 Push 两种传输模式下都生效，`deliver` 抹平差异——hook 作者不用关心当前哪种传输。`requestBody` 透传给 hook（框架不解析调用方的自定义字段）。

### 流内业务错误

SSE 流已开后，业务错误（`LlmCallError`、未知异常）通过 `event: error\ndata: <完整 ErrorPush>\n\n` 投递，HTTP 状态始终是 200——SSE 模式不能再靠 HTTP 状态码表达错误。客户端按 `messageKind === 'error'` 分轨即可，与 push 通道的 ErrorPush 是同一形状。

**`HookError` 例外**：hook throw 时框架已经在 loop 内通过 `deliver` 把诊断 ErrorPush 作为 `event: payload` 送出，外层 catch 不再重复发 `event: error`——同一个逻辑错误送两次会让下游错误处理器双触发。这是这版有意的取舍；未来加新的"开 loop 后才抛"的错误类型时，按"诊断是否已通过 deliver 出去"判断是否要 emit 外层 `event: error`。

### Keepalive

SSE 空闲时每 15 秒发一行 `: keepalive\n\n` 注释，防 CDN / 反向代理的空连接超时断连。

### 内部 transport abstraction

所有 push 透传统一走 `deliverPush()` 入口，`ensureStableMessageId()` 在边界一次性兜底 `messageId`——之前散落在 `sendPushesSequentially` 的 fallback id 生成逻辑收敛到这里。`createInstantHandler` 把 `ctx.deliver` 设成 SSE enqueue 或 `sendPushWithMaybeBlob`，下游 push builder（reasoning / content / tool_request / error）对传输无感。

副作用：caller 没显式 set `messageId` 时，框架自动生成的 ID 格式从 `msg_<uuid>_chunk_<i>` 改为 `msg_<uuid>`——chunk 位置信息一直在 `messageIndex` / `totalMessages` 字段里，重复编码到 ID 反而误导客户端 dedup 实现。hook 自己 set 的 `messageId` 不受影响。

### 其他

- SSE 模式下 `sendPushesSequentially` 跳过 1500ms 间隔（push gateway 节流不适用于流式直发），纯 Push 模式保留原节奏。多 push 的 SSE 响应感知延迟少 N × 1.5s
- 内部全面切到 `MESSAGE_TYPE.INSTANT` / `PUSH_SOURCE.INSTANT` 常量
- SSE 热路径：`TextEncoder` 与 keepalive / done 字节预编码到 module 顶层（不再每请求 `new TextEncoder()` / 每 15s 重新 encode）
- `controller.close()` / `controller.enqueue()` 全部包在 try/swallow，避免 errored stream 上再次操作炸出 `TypeError`
- abort listener 命名 + finally 清理，不留 dangling 引用

## 0.8.2 — readReasoningContent fallback

- **Enhancement**: `readReasoningContent` 添加 fallback 支持。当原生 `reasoning_content` 字段缺失时，会 fallback 检查 `message.content` 是否包含 `<think>...</think>`、`<thinking>...</thinking>` 或 `<thought>...</thought>` 并提取，提供对更多模型（例如 DeepSeek-R1-Distill）的原生兼容。

## 0.8.1 — segmentTextWithProtectedBlocks utility

- **New**: 增加包级独立 utility `segmentTextWithProtectedBlocks`。该工具用于帮助 caller 将带有“不可拆片段”（如 Markdown 代码块、特定标记）的文本切分为 `PushTextSegment` 数组。纯正则匹配保护机制，不引入业务耦合，并支持自定义 preview 与 metadata，帮助更安全、方便地构建 hook 的 `pushPayloads` 返回值。
- **Fix**: hook 返回的 `pushPayloads` 现在会在发送前浅拷贝再自动补齐 `messageId` / `messageIndex` / `totalMessages`，避免原地修改 caller 对象，并支持 `Object.freeze(...)` 这类不可变 payload。

## 0.8.0 — waitUntil lifecycle support

- 稳定版发布：`0.8.0-next.*` 能力毕业到 latest，依赖收敛到 `@rei-standard/amsg-shared@0.1.0`。
- `waitUntil` 注册的是后台生命周期保护 promise；主流程失败仍由 handler 转成原有 HTTP 错误响应，同时通过 `wait_until_rejected` 事件记录，不额外制造 rejected background promise。
- Cloudflare Workers：`createCloudflareWorker.fetch` 现在接收第三个 `ExecutionContext` 参数，并把主回复链路（LLM 生成、构造/切段 push payloads、逐条 Web Push）交给 `ctx.waitUntil` 保护。直接把 `createInstantHandler(...)` 挂成 Worker module `fetch` 时，也会识别 Cloudflare 传入的 `(request, env, ctx)`。
- 其他运行时：`createInstantHandler` 新增通用 `waitUntil` 生命周期入口；Netlify / Vercel Edge adapters 会透传第二个 context 参数；Node adapter 新增可选 `toNodeHandler(fetchHandler, { waitUntil | runtime | getRuntime })`，方便宿主有生命周期钩子时统一保护主回复链路。

## 0.8.0-next.7 — Dependency bump (pre-release)

- 依赖更新：升级 `@rei-standard/amsg-shared` 到 `0.1.0-next.4` 以获取最新的 `notification.show` 和 `multipart` 相关工具。删除了项目内的 `base64` / `concat` 工具函数，迁移使用 `amsg-shared` 导出的底层工具，提升代码可维护性。

## 0.8.0-next.6 — BREAKING: generic multipart transport (pre-release)

next 阶段把 oversized push 的 transport 收敛成一套通用 multipart 协议。旧 reasoning 专用 `chunkIndex` / `totalChunks` wire format 已移除；`reasoning`、`tool_request`、`content`、`error`、`status_update` 或任何自定义 `messageKind`，只要是 JSON-safe payload，都可以被 `_multipart` 包装。

### New

- **`buildMultipartPushPayloads(payload, { maxChunkBytes?, id?, ttlMs? })`** — 构造 generic `_multipart` Web Push payloads。原始 JSON 先 UTF-8 编码，再按 byte 切片并 base64url 编码，避免 Unicode 边界问题。
- **`multipart` handler option** — 默认开启。配置项：`enabled`、`maxChunkBytes`、`ttlMs`、`maxChunks`、`maxTotalBytes`。
- **`multipart_built` / `multipart_sent` events** — 发送端可观测 multipart fallback 何时触发、原始 `messageKind` 是什么、共拆了几片。

### Changed

- `sendPushWithMaybeBlob` 发送优先级现在是：
  1. 小 payload：直接 Web Push。
  2. oversized + 有 BlobStore：仍优先走 BlobStore envelope。
  3. oversized + 无 BlobStore + multipart enabled：走 generic `_multipart`。
  4. oversized + 无 BlobStore + multipart disabled / 超 multipart 上限：抛 `PayloadTooLargeError`。
- legacy content push、HOOK_THREW diagnostic、LOOP_EXCEEDED diagnostic 现在也走同一个 `sendPushWithMaybeBlob` 路径，因此 oversized payload 策略一致。
- `reasoningChunkBytes` 保留为 deprecated alias：设置数字时等价于 `multipart.maxChunkBytes`；设置 `null` 且未显式配置 `multipart` 时禁用 generic multipart。它不再产生旧 reasoning chunk fields。

### Removed

- Removed old reasoning-only `chunkIndex` / `totalChunks` wire format from producer output.
- Removed `reasoning_chunked` as the transport signal for oversized reasoning. 迁移到 `multipart_built` / `multipart_sent`。

### Migration

- 应用级 SW 不应再依赖 `chunkIndex` / `totalChunks` 拼 reasoning。请升级 `@rei-standard/amsg-sw` 到支持 generic multipart 的 next 版本，让 SW 透明还原完整 payload。
- 如果生产环境不想依赖 multipart fallback，继续配置 BlobStore；BlobStore 仍然优先于 multipart。

## 0.8.0-next.5 — `validateMessagesArray` 放宽 OpenAI tool-call 形态 (pre-release)

非破坏性修复。`validateMessagesArray` 此前过严，会拒绝合法的 OpenAI 工具调用消息：

- **`role: 'assistant'` + 非空 `tool_calls`**:`content` 现在允许为 `''` / `null` / 缺省 — 符合 OpenAI Chat Completions 协议（assistant 只发工具调用、没有 narration 是合法的）。同时对 `tool_calls` 数组做轻量形状校验（每条要 `{ id, type:'function', function:{ name, arguments } }`），形状非法时给出明确报错。
- **`role: 'tool'`**:`content` 允许为空串（工具返空结果合法，如 search 无命中）；`tool_call_id` 现在强校验为必填字符串 — 这是 OpenAI 协议的硬约束，库之前漏校。
- `system` / `user` / 不带 `tool_calls` 的 `assistant`：维持原校验，行为不变。

### 类型

`ChatMessage` typedef 同步更新：`role` 收窄为字面量联合；`content` 类型加入 `null`；`tool_calls` 改为结构化签名（`{ id, type:'function', function:{ name, arguments } }[]`）；`tool_call_id` 文档说明其在 tool 消息上必填。dist `*.d.ts` / `*.d.cts` 由 tsup 从源码 JSDoc 自动生成。

### 影响

任何之前因 `content: ''` 而 400 的 agentic-loop hook（典型场景：assistant 这一轮只回了 tool_calls 没有 narration，下一轮需要把 hook 内部历史回放给 `/continue`）现在可以直接通过。无需调整既有 hook 代码。

## 0.8.0-next.4 — BREAKING: pushPayloads-only hook decision API (pre-release)

Install with `npm install @rei-standard/amsg-instant@next`. Pre-release — breaking on purpose. 见 [`docs/migration-0.8.0-next.4.md`](./docs/migration-0.8.0-next.4.md) 完整迁移指南.

### Removed

- `decision.pushPayload` (singular). Replaced by `decision.pushPayloads: PushPayload[]`.
- Request-body fields `splitPattern` / `reasoningSplitPattern` / `errorSplitPattern` — rejected with 400 `INVALID_PAYLOAD_FORMAT` and a migration hint pointing at `pushPayloads`.
- `pushPayload.splitPattern` per-push override (next.3 only) — rejected with `HookError`.
- Public export `splitMessageIntoSentences` — used to be exported from `@rei-standard/amsg-instant` for hook authors who wanted "the same default split as the legacy path". The legacy path still uses it internally; hook authors implement their own split.
- Most internal split helpers (`splitHookPushPayload` / `pickSplitConfig` / `validatePerKindSplitPatterns` / `validateSplitPattern` / `SPLIT_PATTERN_MAX_*`) removed. `splitMessageIntoSentences` / `splitOnceByRegex` / `DEFAULT_SPLIT_REGEX` stay module-internal because `runLegacyInstant` still uses them.
- The two-layer reasoning cascade collapsed to one layer (byte chunking). The Layer-1 sentence split via `reasoningSplitPattern` is gone with the field.

### Changed

- `runAgenticLoop`'s finish / tool-request branch now reads `decision.pushPayloads` and ships each push via `sendPushWithMaybeBlob` with `SLEEP_BETWEEN_MESSAGES_MS` (1500ms) between consecutive pushes. Per-push: `messageId` is auto-filled when absent (`msg_<uuid>_chunk_<i>`); `messageIndex` / `totalMessages` are always overwritten with array-derived values.
- LOOP_EXCEEDED diagnostic is now a single `sendPushWithMaybeBlob` call (no looping needed — the diagnostic is one push).
- Reasoning auto-emit (`autoEmitReasoning: true`, default): now a single transform. Short reasoning → 1 push; oversized → N byte-chunked pushes with `chunkIndex` / `totalChunks` (Layer-2 only).

### Unchanged

- Legacy v0.6 compat path (no `onLLMOutput`) still splits raw LLM text by sentence regex and ships sequential pushes — byte-level identical to v0.6. The public `splitPattern` knob on the request body is gone, but the path's internal behaviour is preserved (default regex `/([。！？!?]+)/`).
- HOOK_THREW handling (single-shot diagnostic, best-effort delivery), blob envelope, `maxLoopIterations`, `autoEmitReasoning`, `reasoningChunkBytes`, all 4 decisions (`finish` / `tool-request` / `continue` / `skip-push`).
- VAPID / push subscription / `apiKey` are still not exposed to the hook.
- HTTP status code mapping unchanged.

### Migration cheat sheet

| next.3                                                          | next.4                                                                                                                                        |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `return { decision: 'finish', pushPayload: { ... } }`           | `return { decision: 'finish', pushPayloads: [{ ... }] }`                                                                                      |
| Request body `splitPattern: '([。！？!?]+)'`                    | Implement the split in your hook; return one push per segment                                                                                 |
| `pushPayload.splitPattern: null` (per-push disable from next.3) | Return `pushPayloads: [singleUnsplit]`                                                                                                        |
| `reasoningSplitPattern` request field                           | Set `autoEmitReasoning: false`, build N reasoning pushes yourself with `buildReasoningPush(...)`, include them at the start of `pushPayloads` |

### Why breaking in pre-release

The `0.8.0-next.*` series is pre-1.0 unstable. next.2 + next.3 stacked two overlapping mechanisms (lib-side splitPattern auto-split + hook-side pushPayload singular). next.4 collapses both into one (caller returns the exact pushes it wants sent) before 1.0 freezes the public surface.

## 0.8.0-next.3 — `pushPayload.splitPattern` per-push override (pre-release)

Coordinated with `@rei-standard/amsg-shared@0.1.0-next.3`. Install with `npm install @rei-standard/amsg-instant@next`.

next.2 把 `splitPattern` 定位成纯请求级配置——hook 在自己返回的 `pushPayload` 上写 `splitPattern: null` 会被静默忽略（库不报错、不警告、TS 也不挡，因为 `ContentPush` 等 typedef 没有声明这个字段，spread 加任意 key 就会绕过 excess-property check）。这是 leaky API：用错位置看起来正常通过，但行为完全没生效。next.3 把这个口子收紧。

### Fixed

- **`pushPayload.splitPattern` 现在被识别为 per-push override**。hook 返回的 `pushPayload` 自身带 `splitPattern` 字段时，对这一个 push 优先级高于请求级的 `splitPattern` / `reasoningSplitPattern` / `errorSplitPattern`。字段名永远是 `splitPattern`（不分 kind，因为 push 的 `messageKind` 已经定了切谁的文本）。`null` / `[]` 关切；string / string[] 走 cascade。
- **`undefined` 跟 `null` 严格区分**：`splitPattern: undefined`（或字段缺省）= 「没意见，回退请求级」；`splitPattern: null` / `[]` = 「这一个 push 显式关切，盖住请求级」。这跟请求级字段的语义、跟 JS 对 `undefined` 的直觉、跟 next.2 之前的请求级行为都保持一致——`undefined` 不会被错读成「override 在场但 disable」。
- **Override 校验沿用 `validateSplitPattern`**——形状错（非 string/array、超 200 字符、超 10 项）或正则不可编译（`new RegExp(...)` throws）→ 抛 `HookError`，message 形如 `pushPayload.splitPattern invalid: <原因>`，明确点位（不会跟请求级混）。validateSplitPattern 原本带的 `splitPattern` / `splitPattern[i]` 前缀会被 strip，避免 `pushPayload.splitPattern invalid: splitPattern 不是...` 这种重复读起来含糊。
- **Wire 不带 `splitPattern`**——库在交付前从所有 chunks（含 N-段切片、单段透传、ToolRequestPush 的 prefix 降级段）上 strip 掉这个字段，SW 永远收不到。`splitHookPushPayload` 每个 push 跑一次，降级 chunks 从已剥离的 parent spread，**不会发生二次切**。

### Unchanged

- 请求级 `splitPattern` / `reasoningSplitPattern` / `errorSplitPattern` 语义和优先级**完全不变**——只是新增了 per-push 覆盖通道。
- 没在 `pushPayload` 上写 `splitPattern` 的 hook 行为跟 next.2 byte-for-byte 一致（auto-emit reasoning、framework 内置的 `LOOP_EXCEEDED` ErrorPush 等都没有这字段，全部回退到请求级）。
- 公共 API（hook 契约、handler options、HTTP wire format）零变化。

### Coordinated

- 跟 `@rei-standard/amsg-shared@0.1.0-next.3` 一起发——shared 这版顺手补齐 `notification` 字段在 `ContentPush` / `ToolRequestPush` typedef 上的 7 字段 typed support + `buildContentPush` / `buildToolRequestPush` 的 `notification?` 入参（解决跟本 next.3 同源的 leaky-API：SW 早就消费 `notification.{title,body,icon,badge,tag,renotify,requireInteraction}`，但 typedef 没声明导致 caller 只能 untyped spread）。详见 shared CHANGELOG `0.1.0-next.3`。
- `amsg-server` / `amsg-sw` / `amsg-client` 不动。SW 行为未变，只是 shared 把它已经支持的字段类型化了。

## 0.8.0-next.2 — splitPattern hook-mode 修复 + reasoning 两层切分 (pre-release)

Coordinated with `@rei-standard/amsg-shared@0.1.0-next.2`. Install with `npm install @rei-standard/amsg-instant@next`.

### Fixed

- **`splitPattern` 在 hook 模式下重新生效**。0.7 引入的「`splitPattern is ignored when onLLMOutput is provided` 启动 warn + 不切分」是设计抽风：`splitPattern` 是「消息文本切气泡」的 UX 配置，跟 hook 决定「本轮发什么」完全正交。next.2 把它在 hook 模式下重新启用，hook 返回 `decision: 'finish'` / `'tool-request'` 后，framework 按 `messageKind` 对 pushPayload 的文本字段应用 `splitPattern`：`content.message` / `tool_request.message`（默认开，句号正则 `/([。！？!?]+)/`）。`ToolRequestPush` 切片时 `toolCalls` 仍是原子数组，绑定到含 LAST prefix 段的 chunk（emit 为 `tool_request`），前 N-1 段降级为 `content`（不带 `toolCalls`）— 保证 narration 全显示完再启动 tool 执行。
- **删除 0.7 加的 `splitPattern is ignored when onLLMOutput is provided` 启动 warn**。

### New

- **`reasoningSplitPattern` / `errorSplitPattern` payload 字段** — 按 `messageKind` 独立的句号切配置：

  | `messageKind`  | 字段                    | 默认                   |
  | -------------- | ----------------------- | ---------------------- |
  | `content`      | `splitPattern`          | `/([。！？!?]+)/` (开) |
  | `tool_request` | `splitPattern`          | `/([。！？!?]+)/` (开) |
  | `reasoning`    | `reasoningSplitPattern` | **不切**               |
  | `error`        | `errorSplitPattern`     | **不切**               |
  | 自由 payload   | —                       | 不切                   |

  四个 kind 共享的「禁用」语义：显式 `null` 或 `[]` 关闭切分。差别在 `undefined`（字段省略）：`content` / `tool_request` 回落默认句号正则；`reasoning` / `error` 保持不切（这俩历史上就没切片 UX，默认 off 才符合预期）。

- **`reasoningChunkBytes` handler option（默认 2000，`null` 禁用）** — `ReasoningPush.reasoningContent` 的 UTF-8 字节上限。reasoning-heavy LLM（DeepSeek-R1 / GLM-4.5 / Qwen3-Thinking）经常输出 3-10 KB reasoning，超 Web Push ~2.6 KB 上限。next.2 内置 transparent 字节切分：超限时按 UTF-8 codepoint 边界切成 N 份，每片带 `chunkIndex` / `totalChunks`，SW 按这两个字段拼回完整字符串。**绝大多数 reasoning-heavy 部署不再需要 BlobStore。** `createInstantHandler` 构造期校验 `reasoningChunkBytes ∈ [500, maxInlineBytes - 600]`（600 B 余量给 push payload 元字段），不合法抛 `TypeError`。

- **两层 cascade（Layer 1 句切 → Layer 2 字节切）** — `reasoningSplitPattern` 先按句切成 M 段，每段单独量字节，超阈值的段再字节切成 N 块。最终 push 同时带两组索引：

  - Layer 1：`messageIndex` 1..M / `totalMessages` M（M=1 时不写）
  - Layer 2：`chunkIndex` 1..N / `totalChunks` N（N=1 时不写）

  SW 拼接：按 `sessionId` 分桶 → 按 `messageIndex` 分子桶 → 按 `chunkIndex` 排序拼字符串。

- **新事件 `reasoning_chunked`** — `{ sessionId, iteration?, totalChunks, totalBytes }`。只在 Layer 2 实际切分时 fire 一次（Layer 1 单独的句切不 fire），避免事件洪水。

- **`chunkReasoningByUtf8Bytes` re-export** — 从 `@rei-standard/amsg-shared` 直接 re-export 出来，hook 作者想自己切（`autoEmitReasoning: false` + 手动 dispatch）也能用。

### 行为兼容

- 不传任何新字段：`reasoning_content` 小于 2000 B 时 wire format 跟 next.1 byte-for-byte 一致。
- 老 SW 拿到单 chunk 单 segment 的 ReasoningPush 完全照常消费（新字段都 optional，单值时不写）。
- HOOK_THREW 诊断仍走 `sendWebPush` 单 shot（特殊路径，跟 byte chunking 解耦）。
- LOOP_EXCEEDED 诊断走 `sendChunkedPush` 仍然遵循 `errorSplitPattern`（默认不切）。

### 投递时序

- Layer 1 段间间隔：`SLEEP_BETWEEN_MESSAGES_MS`（1500 ms，typing-bubble UX）
- Layer 2 同段 chunk 间间隔：`SLEEP_BETWEEN_REASONING_CHUNKS_MS`（100 ms，transport-only，不需要打字感）
- 一律串行，每个 chunk 等前一个 push 返回再发，避免 push gateway 速率限制 + SW 按 `chunkIndex` 重排
- 内部统一通过 `sendPushWithMaybeBlob`，单 chunk 超限仍可走 BlobStore envelope（兜底未变）

### Unchanged

- hook API（4-decision 契约）/ agentic loop / `/continue` / `maxLoopIterations` / `autoEmitReasoning` 全部不变
- BlobStore 路径、envelope schema、`maxInlineBytes` 等不变
- 凭据（vapid / apiKey / pushSubscription）继续不暴露给 hook
- 不引入新错误码、不改 HTTP 状态码映射
- `runLegacyInstant`（不传 `onLLMOutput` 的 0.6 兼容路径）也吃 Layer 2 字节切，跟 `runAgenticLoop` 行为一致

## 0.8.0-next.1 — avatarUrl 软清空 (pre-release)

Cherry-pick stable `0.7.1` 的 `avatarUrl` 软清空策略到 next 预发布线。`/instant` 与 `/continue` 路径不合法的 `avatarUrl`（`data:` URI / 长度 > 2048 / 非字符串 / 不是合法 URL）会在 payload 上**置为 `null`** + `console.warn`，整次推送继续；`INVALID_PAYLOAD_FORMAT` 不再为 `avatarUrl` 触发，其它字段错误码不变。详见 `0.7.1` stable 条目；与 `@rei-standard/amsg-server` 2.4.0-next.1 / `@rei-standard/amsg-client` 2.3.0-next.1 / `@rei-standard/amsg-sw` 2.1.0-next.1（SW 标题 fallback 至 `来自 {contactName}`）同步。

`next.0` → `next.1` 行为变化只此一项；三轴 push schema 部分**完全不动**。

## 0.8.0-next.0 — Three-axis push schema + ReasoningPush (pre-release)

Published under the `next` dist-tag (repo convention for prereleases). Coordinated with `@rei-standard/amsg-shared@0.1.0-next.0`, `amsg-server@2.4.0-next.0`, `amsg-sw@2.1.0-next.0`, `amsg-client@2.3.0-next.0`. Install with `npm install @rei-standard/amsg-instant@next`. The schema is locked; the next-tag window is for downstream integrators to validate end-to-end before this graduates to `latest`.

---

Coordinated minor across the whole amsg ecosystem. This release replaces the legacy 13-field push envelope (and the standalone `{ type:'error', code:'...' }` shape) with a discriminated union from the new `@rei-standard/amsg-shared` package, indexed by `messageKind`. It also lifts LLM `reasoning_content` into its own first-class push so clients can render "thinking…" UI ahead of the actual reply.

### Breaking

- **Push wire shape now follows `@rei-standard/amsg-shared`'s `AmsgPush` union.** Every push carries `messageKind: 'content' | 'reasoning' | 'tool_request' | 'error'` as a literal-type discriminator. TS callers `switch (push.messageKind)` and narrow on it.
- **The 0.7.x `{ type: 'error', code: '...' }` diagnostic envelope (used for `HOOK_THREW` and `LOOP_EXCEEDED`) is gone.** Diagnostics are now `ErrorPush` (`messageKind: 'error'` + same `code` / `message` fields). The legacy `type: 'error'` field is **not** present on the new envelope — do not look for it.
- **Public export `buildInstantPushPayload` removed.** Use `buildContentPush` from `@rei-standard/amsg-shared` (re-exported from this package). The new builder takes the three-axis fields (`messageType` / `source` / `messageKind`) + the legacy 13 fields as optionals.

### New

- **Auto-emit `ReasoningPush` before the content burst / hook.** When the LLM response carries a non-empty `choices[0].message.reasoning_content`, the framework now ships a separate `ReasoningPush` first, then the existing content path. Both the legacy sentence-split path AND the agentic-loop hook path do this.
- **`autoEmitReasoning` config (default `true`)** — hook-path opt-out. Set to `false` on `createInstantHandler({...})` when the hook author wants total control over every push that leaves the worker. In that mode, hooks can read `ctx.llmResponse.choices[0].message.reasoning_content` and build their own `buildReasoningPush(...)` envelope. The legacy (non-hook) path always auto-emits regardless — it has no hook control point to honor.
- **`sessionId` is stable across one LLM round.** The auto-emitted ReasoningPush and the content burst that follows it share the same `sessionId`. In the agentic-loop path, all iterations of a single `/instant` request also share one `sessionId`. Legacy path: mints `sess_<uuid>` if the payload didn't carry one. Hook path: reuses `payload.sessionId` or mints a UUID. **The hook is responsible for propagating `ctx.sessionId` into its own `pushPayload`** — the framework does not inject it.
- **Blob envelope now carries `messageKind`.** When a push exceeds `maxInlineBytes`, the `{ _blob, key, url }` envelope now also includes `messageKind` (and the legacy `type` field for hand-rolled hook payloads). The SW can dispatch on the discriminator without having to fetch the blob first.
- **Builder / type guard re-exports.** `buildContentPush`, `buildReasoningPush`, `buildToolRequestPush`, `buildErrorPush`, `isContentPush`, `isReasoningPush`, `isToolRequestPush`, `isErrorPush`, `MESSAGE_KIND`, `MESSAGE_TYPE`, `PUSH_SOURCE` are all re-exported from `@rei-standard/amsg-instant` so hook authors don't need a second dependency on `@rei-standard/amsg-shared`.
- **`readReasoningContent(llmResponse)` helper** exported for hook authors who need to inspect or post-process reasoning content before deciding what to push.
- **New event types**: `reasoning_pushed`, `reasoning_push_failed`. Both carry `sessionId` and (for the hook path) `iteration`.

### Migration from 0.7.x

| 0.7.x                                                                  | 0.8.0                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `buildInstantPushPayload({ message, index, total, contactName, ... })` | `buildContentPush({ messageType: 'instant', source: 'instant', messageId, sessionId, message, messageIndex, totalMessages, contactName, ... })` from `@rei-standard/amsg-instant`                                                                |
| Hook payload `{ type: 'tool-request', ... }` (free-form)               | Either keep it free-form (still legal — `pushPayload: unknown`) or call `buildToolRequestPush({ ... })` for a typed envelope                                                                                                                     |
| SW dispatch by ad-hoc field sniffing on push payload                   | SW dispatch by `payload.messageKind` switch (consume the shared `AmsgPush` discriminated union)                                                                                                                                                  |
| `{ type: 'error', code: 'HOOK_THREW', message, sessionId, iteration }` | Auto-built — no caller-side change needed; the wire shape now uses `messageKind: 'error'` instead of `type: 'error'`                                                                                                                             |
| Hook fully owned every push (incl. reasoning, if you built one)        | Framework auto-emits `ReasoningPush` before the hook runs. Set `autoEmitReasoning: false` on `createInstantHandler({...})` to restore total hook control.                                                                                        |
| Hook returned `pushPayload` without a `sessionId` field                | **Set `sessionId: ctx.sessionId`** in your hook's `pushPayload`. The framework does NOT auto-inject it (the `pushPayload: unknown` contract is preserved). Without this the SW can't pair your content push with the auto-emitted ReasoningPush. |
| Legacy path push failure aborted the whole burst                       | Reasoning-push failure is now best-effort (`reasoning_push_failed` event + continue). Content-push failures still abort, same as before.                                                                                                         |

If you have a hook that builds its own pushPayload object, **set `sessionId: ctx.sessionId`** in it so the SW can pair your content push with the auto-emitted ReasoningPush.

### Dependencies

- Adds `@rei-standard/amsg-shared` at exact version `0.1.0` (no caret). The coordinated minor upgrade is intentionally strict — npm shouldn't resolve a mixed-version graph across the ecosystem.

### Fix

- **`/continue` 无 `onLLMOutput` 时给出清晰的 400 `CONTINUE_NOT_AVAILABLE`**：之前往一个没配 hook 的 handler POST `/continue` 会过 validation、进 `runAgenticLoop`、然后在 `ctx.onLLMOutput(...)` 上炸 TypeError、最终被当成 `HOOK_THREW` 报给客户端 + 推一条诊断 envelope。问题是「没钩子」是部署配置问题，不是钩子抛错，HOOK_THREW 把锅甩到了不存在的钩子上。现在在 handler 入口处直接拒，错误码明确指向缺 `onLLMOutput`。

## 0.7.0 — 2026-05-19 — Agentic Loop Framework

**New**

- **`onLLMOutput` hook**: caller controls per-turn decision. Hook returns one of `{ decision: 'finish' | 'tool-request' | 'continue' | 'skip-push' }`. When the hook is provided, the handler switches to a per-turn agentic loop; when omitted, the handler runs the legacy v0.6 one-shot path **byte-for-byte unchanged**. The two paths are independent and do not share schema.
- **`/continue` endpoint** (hardcoded path) for tool-call resumption. Reuses `/instant`'s full auth chain (Bearer JWT + clientToken, in the same order). Worker stays stateless; the caller persists session state on its end.
- **Custom push payload schema** via the hook's return value. `buildInstantPushPayload` is now exported as a public helper for callers who want the v0.6 13-field shape inside their own hook.
- **Optional `blobStore` config** with a `BlobStoreAdapter` interface (`put` + non-destructive `read`). Six built-in adapters covering the major serverless / Node deployment targets, picked by the platform's native storage so callers don't need a custom adapter for typical setups:
  - **Cloudflare**: `.../blob/d1`, `.../blob/kv`
  - **Vercel / any serverless** (Upstash Redis, also covers Vercel KV which is Upstash under the hood): `.../blob/upstash`
  - **Netlify** (Netlify Blobs; no native TTL, adapter wraps body with embedded `expiresAt`): `.../blob/netlify`
  - **Postgres** (Neon / Supabase / Vercel Postgres / self-hosted via `pg`-compatible client): `.../blob/postgres`
  - **Memory** (long-lived Node only — Memory adapter is unsafe on isolate-based serverless): `.../blob/memory`
  - Arbitrary backends (DynamoDB / Cassandra / …) still plug in with a ~30-line custom adapter implementing the same two methods — templates in `examples/custom-blob-store/`.
- **`/blob/:key` GET endpoint** (hardcoded path; UUID-v4 protected; non-destructive multi-read within TTL; no auth header required so SW can fetch). Response carries `Access-Control-Allow-Origin: *` so cross-origin SW fetches can read the body. Envelope carries an absolute `url` field derived from the inbound `request.url`, so SW doesn't need a separate endpoint config.
- **`maxLoopIterations` guardrail** (default 10). Guards in-loop runaway within a single worker invocation. On overflow: emits `loop_exceeded`, pushes a diagnostic envelope, returns HTTP **200** with `{ status: 'loop_exceeded', ... }` (not 5xx — the worker has fulfilled its "deliver a diagnostic" contract).
- **New event taxonomy** — single-level type-named discriminator (no `error+code` nesting). Three semantic tiers:
  - **progress**: `llm_start`, `llm_done`, `final_pushed`, `tool_request_pushed`, `continue_received`, `blob_written`
  - **soft failure**: `blob_put_failed`, `blob_orphaned`, `diagnostic_push_failed`, `payload_too_large`
  - **hard error**: `hook_threw`, `loop_exceeded`, `llm_call_failed`
- **Named Error classes**: `HookError` (`.code='HOOK_THREW'`), `PayloadTooLargeError` (`.code='PAYLOAD_TOO_LARGE'`), `LlmCallError` (`.code='LLM_CALL_FAILED'`), `MemoryStoreFullError` (`.code='MEMORY_STORE_FULL'`). Callers can `instanceof`-dispatch instead of string-comparing `.code`. Three-tier naming is consistent: `hook_threw` (event) ↔ `HOOK_THREW` (push code / `.code`) ↔ `HookError` (class) ↔ `{ error: 'hook_threw' }` (HTTP body), so log search / Sentry grouping needs no mental translation.

**Changed**

- `processInstantMessage` now **branches at entry**: no `onLLMOutput` → legacy v0.6 path (byte-identical to v0.6); with `onLLMOutput` → multi-turn agentic loop. The two paths are independent.
- Default `maxInlineBytes` for the blob envelope detour is **2600 B**. Comparison uses **UTF-8 byte length** (via `TextEncoder`), not JS string `.length` — CJK content would otherwise bypass the limit and trip push-service 413. The 2600 default leaves ~220 B margin under `web-push-php`'s cross-service compatibility default of 2820 B.
- Hook path appends `choices[0].message` whole object to history (preserves `tool_calls` / `reasoning_content` / `refusal`). Legacy path unchanged.
- `validateInstantPayload` now takes an optional `{ hookPath, maxLoopIterations }` second argument. When `hookPath: true` it rejects `completePrompt` with `400 COMPLETE_PROMPT_NOT_SUPPORTED_ON_HOOK_PATH`.
- `splitPattern` config remains effective on the legacy path; on the hook path it is **silently ignored** and the handler emits a one-shot `console.warn` at construction time.

**Backwards compatibility**

- **Zero breaking changes.** All v0.6 callers (no `onLLMOutput` configured) keep their byte-for-byte legacy behaviour — same 13-field default payload, same `1500 ms` sentence spacing, same `splitPattern` semantics, same `onEvent` shape for legacy events.
- New events and the `/continue` + `/blob/:key` endpoints only activate when the relevant options are set. A subpath-mount caveat applies to deployers wanting to mount the handler under e.g. `/amsg/*` — see README §Subpath mount.

## 0.6.1 — 2026-05-18

**Fix**

- **`avatarUrl` 严格校验**：之前 `avatarUrl` 只检 `new URL(...)` 能不能 parse，导致 `data:image/...;base64,xxx` 这种 base64 内嵌头像也算合法 —— 一旦传进来，整个 push payload 会膨胀到几十 KB，触发下游 Web Push 服务的 4KB 硬上限或网关 `413 Payload Too Large`。现在：
  - 拒 `data:` 开头的 URI（不区分大小写）→ `400 INVALID_PAYLOAD_FORMAT`，错误信息明示「头像不支持传入 data: URI（base64 内嵌图片会触发 413 / Web Push 4KB 上限），请改为公网可访问的 https:// 图片 URL」。
  - 拒长度 > 2048 字符的 URL → `400`，错误信息明示实际长度 + 上限 + 建议（CDN 缩略图）。
  - 仍要求 `new URL(...)` 能 parse。
  - `undefined` / `null` 仍然视为「未传」，零行为变化。
- 顶层 export `validateAvatarUrl(value)`：业务可在 SDK 之外做同步预校验，避免一次远端往返。

**Compatibility**

- 0.6.0 调用者**几乎零修改**：除非之前真的在传 `data:` URI 当 avatarUrl（那本来就跑不通推送），否则升级无感。错误码 `INVALID_PAYLOAD_FORMAT` 不变。

## 0.6.0 — 2026-05-18

**New**

- **`splitPattern` 自定义分句正则**：payload 新增可选 `splitPattern` 字段，类型 `string | string[]`。LLM 返回的整段文本将按此正则切成多条 Web Push 推送（默认 `/([。！？!?]+)/`）。
  - `string` → 单个正则 source（不带 flags），用 `new RegExp(splitPattern)` 编译后替代默认正则。
  - `string[]` → **级联**应用：第一个正则切完，每段再用第二个切，以此类推。适合分层切分（先按段落 `(\n\n+)`、再按句号 `([。！？!?]+)`）。需要 "任一匹配就切" 的语义，调用方自己用 `|` 合成一条正则即可。
  - 不传 / `null` / `undefined` / `[]` → 走默认正则，行为字节级不变。
  - **捕获组约定**：想让分隔符回贴到前一段（与默认行为一致），把分隔符放进 `(...)` 捕获组。库不自动包裹。
  - **限制**：每项 ≤ 200 字符，数组 ≤ 10 项，每项必须能 `new RegExp(...)` 通过。违规 → `400 INVALID_PAYLOAD_FORMAT`。
  - 校验失败的错误信息会精确到出错的索引（如 `splitPattern[2] 不是有效正则表达式`）。

**Compatibility**

- 0.5.x 调用者**零修改**继续工作。push payload、subscription、VAPID、错误码全部不动。0.5.x 直接升级即可。

## 0.5.0 — 2026-05-17

**New**

- **`messages` 数组转发**：payload 新增可选 `messages` 字段，与 `completePrompt` 二选一互斥。上游应用直接把标准 OpenAI 格式的 `[{role:'system',...}, {role:'user',...}, {role:'assistant',...}, ...]` 透传过来，handler **原样**转给 LLM —— 不再被强行压成单个 user 消息。让 instant-push 路径和主聊天路径的 LLM 调用完全等价（system role、多轮历史、tool role 全保留）。
  - `content` 支持 `string` 或非空数组（多模态留口子，元素 schema 不深挖）。
  - role 限定 `system | user | assistant | tool`，违规 → `400 INVALID_PAYLOAD_FORMAT`。
  - 两者同时给、两者都不给、`messages` 为空数组、role 非法 → 全部 `400`，错误信息明示 "exactly one of `completePrompt` or `messages` must be provided"。
- **`temperature` 字段**：可选 number，会透传给 LLM。legacy `completePrompt` 路径无 temperature 时仍默认 0.8（保持旧行为）；`messages` 路径无 temperature 时**不发**，跟上游主路径完全一致。
- LLM 请求 body 现在恒含 `stream: false`（instant 路径按契约非流式）。

**Compatibility**

- 旧 `completePrompt` 调用者**零修改**继续工作。push payload、subscription、VAPID key、错误码全部不动。0.4.x 直接升级即可。

## 0.4.0 — 2026-05-17

**New**

- **CORS 内置**：handler 在入口处短路 `OPTIONS` 预检请求 → `204 No Content`，所有响应（含 200 / 4xx / 5xx）自动叠 `Access-Control-Allow-Origin / -Methods / -Headers` + `Access-Control-Max-Age: 86400`。浏览器跨域调用零配置 work。
- `options.cors?: { allowOrigin?: string }`：自定义允许来源，默认 `'*'`。配成具体来源时自动附 `Vary: Origin`，避免反向代理缓存把 CORS policy 串到错的站点。
- **`normalizeAiApiUrl(apiUrl)`** 智能补全 OpenAI 兼容路径，**幂等**（跑两次 = 跑一次）：

  - 裸 host（如 `https://api.openai.com`）→ 补 `/v1/chat/completions`
  - 末尾是 `/v1` 或 `/v2` 等版本段 → 只补 `/chat/completions`，**不会重复加 v1**
  - 已含 `/chat/completions` → 原样返回
  - 其他自定义路径（如 Anthropic 的 `/v1/messages`）→ 不动，尊重 caller 的路由

  老调用者传完整 `…/v1/chat/completions` 仍然工作。函数也作为顶层 export 暴露，方便业务在前端做一致的预校验。

**Improvements**

- 验证函数（Bearer / clientToken）的所有 401/4xx 响应现在也带 CORS headers，让浏览器能正常读到 `body.error.code` 而不是 fail 在 CORS 检查上。

**Compatibility**

- 协议字段零变更；推送 payload、subscription、VAPID key 全部不动。0.3.x 直接升级即可。

## 0.3.0 — 2026-05-17

**BREAKING**

- 砍掉 `web-push` 依赖：自实现 RFC 8291 `aes128gcm` payload 加密 + RFC 8292 VAPID JWT。包不再有任何 runtime dependency。
- core 全部改用 Web Crypto API（`globalThis.crypto.subtle`），源码不再 `import 'crypto'` / `'node:crypto'`。
- `options.webpush`（之前用于注入 web-push mock）**deprecated**：参数保留兼容、运行时 `console.warn` 一次后忽略。测试改用 `options.fetch` 拦截 push endpoint 的 POST。
- `processInstantMessage(payload, ctx)` 不再读 `ctx.webpush`；改读 `ctx.vapid`（必填）。如直接调用此底层 API 请同步更新。

**New**

- 新增导出 `sendWebPush({ subscription, payload, vapid, ttl?, fetch? })`：纯 Web Crypto 实现，可单独使用。
- 新增导出 `buildVapidJwt(...)` / `verifyVapidJwt(jwt, publicKey)`：方便自定义鉴权/审计。
- 新增导出 `buildInstantPushPayload({...})`：测试可直接验证 SW 端 payload 形状，无需解密。

**Improvements**

- **Cloudflare Workers 部署不再需要 `nodejs_compat` flag**，`compatibility_date` 也无强约束。贴代码 + 配两个 VAPID secret 即可。
- 原生支持 Vercel Edge / Netlify Edge / Deno / Bun。
- 依赖树彻底清空：`web-push` + 它的 5 个传递依赖（`asn1.js` / `http_ece` / `https-proxy-agent` / `jws` / `minimist`）全部消失，`npm install` 速度和锁文件复杂度显著下降。本包 bundle 略增 ~8 KB（自实现 RFC 8291 + 8292），但 install 期总下载量净减。
- Node 18 部署：`adapters/node` 启动时按需 `import('node:crypto').webcrypto` 兜底 `globalThis.crypto`，不需要 caller 改任何代码。

**Compatibility**

- Push 协议（RFC 8291 `aes128gcm` body + RFC 8292 VAPID header）与 `web-push` 字节级兼容，浏览器订阅、SW、`@rei-standard/amsg-sw` 全部零修改可继续工作。
- VAPID 公私钥格式保持 base64url（公钥 65 B 非压缩 P-256 点 / 私钥 32 B 标量），老订阅可继续用。
- `engines.node` 从 `>=20` 放宽到 `>=18`（adapter 自动 polyfill）。

## 0.2.0 — 2026-05-16

**BREAKING**

- Handler 协议改为**纯明文**。删除 `X-Payload-Encrypted` / `X-User-Id` / `X-Encryption-Version` 三个 header 校验，删除 AES-256-GCM 信封解密路径。请求 body 现在直接是 JSON payload。
- 删除 `options.masterKey`（不再需要派生用户密钥）。
- 主入口删除三个 export：`deriveUserEncryptionKey`、`decryptPayload`、`isValidUUIDv4`。
- 删除对应错误码：`ENCRYPTION_REQUIRED`、`USER_ID_REQUIRED`、`INVALID_USER_ID_FORMAT`、`UNSUPPORTED_ENCRYPTION_VERSION`、`DECRYPTION_FAILED`。
- 删除内部文件 `src/crypto.js`（包内不再 import `createDecipheriv`；保留 `createHmac` / `timingSafeEqual` 给 `tokenSigningKey` + 新 `clientToken` 用，保留 `randomUUID` 给 messageId 用）。

**New**

- `options.clientToken`：可选共享密钥，校验请求头 `X-Client-Token`。缺失或不匹配返回 `401 INVALID_CLIENT_TOKEN`。timing-safe 比对。
- 错误码 `INVALID_CLIENT_TOKEN`（401）。

**Rationale**

- 单租户自部署场景下应用层加密无实际收益：HTTPS 已加密传输；`apiKey` 由前端塞进 payload 必然要让 Worker 见到；攻击者拿 Worker URL 也榨不出 `apiKey` / 推不动别人的订阅。
- 移除加密后 Worker bundle 体积下降，部署门槛降低（不再需要 `masterKey` env），不再依赖 `amsg-server` 的 `/get-user-key` endpoint。
- 多租户 SaaS 场景请继续使用 `amsg-server` 的 `schedule-message` 加密路径。

**Migration**

- 配合 `@rei-standard/amsg-client@2.2.0+`，构造时传 `instantEncryption: false`。Worker 端把 `options.masterKey` 改成 `options.clientToken`（或都不配，裸跑）。

## 0.1.0 — 2026-05-16

Initial release.

### Added

- `createInstantHandler(options)` — stateless one-shot instant push handler. Lifecycle = single HTTP function call: decrypt → call LLM → split sentences → deliver Web Push → 200 OK. No DB, no cron, no tenant init.
- Adapters for Cloudflare Workers, Node/Express, Netlify Functions, and Vercel Functions (Edge & Node runtimes).
- `deriveUserEncryptionKey`, `decryptPayload`, `splitMessageIntoSentences`, `processInstantMessage`, `validateInstantPayload`, `isValidUUIDv4` exported for advanced users.
- Optional `tokenSigningKey` for HMAC-signed bearer authorization. When omitted, requests are accepted without auth (use this if you delegate auth to platform middleware like Cloudflare Access).
- Push payload field shape is byte-identical to `@rei-standard/amsg-server`'s scheduled/instant path — same SW build (`@rei-standard/amsg-sw`) handles both via the `source: 'instant' | 'scheduled'` discriminator.

### Compatibility

- Requires Node.js ≥ 20 (or Cloudflare Workers with `nodejs_compat` flag for the `crypto` import).
- `masterKey` must be 64-char hex (32 bytes of entropy). When used alongside `@rei-standard/amsg-server`, set this to the same value used by the corresponding amsg-server tenant so the `userKey` derived by `@rei-standard/amsg-client` works on both endpoints.
- Only `messageType: 'instant'` is supported. Sending `firstSendTime` or `recurrenceType` returns `INVALID_PAYLOAD_FORMAT`.
