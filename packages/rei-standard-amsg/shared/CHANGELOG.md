# Changelog — @rei-standard/amsg-shared

## 0.4.0-next.9

### Patch Changes

- 65a9f91: 安全修复：跟模型 ID 同形的自定义网关 Key 不再被脱敏放行；截断的 Anthropic 信封不再把 providerCode 判成 `error`

  **1. `redactCredentials`：全小写、短横线分段的 Key 补上两道判定（安全修复）**

  脱敏的模型名白名单靠「全小写、被短横线切成短段」的形状放行，但自建网关发的 Key 里有一类同形的——前缀不在已知凭据名单里、随机段全落在 hex 字母表里（`mycorp-aaaabbbbcccc-ddddeeeeffff`）或只有一小段字母数字来回切（`mist-al7b-secret-key1`）——会原样放行。而这段文字正是落进 amsg-server `last_error` 明文列、也随 amsg-instant 跨域 502 响应体回给调用方的那段。影响面：用这类 Key、且上游 401 会把 Key 回显进报错（`Incorrect API key provided: …`）的部署，受影响版本里 Key 可能已经明文进过 `last_error`，建议轮换。`sk-` / `xai-` 前缀、uuid、大小写混排、带下划线这些形状一直都遮，不受影响。

  现在这两类形状也遮：连续 hex 段累计超过 15 个字符就当密钥材料（模型名里最长的 hex 形状是 8 位日期段）；字母数字来回切三次以上的段只放行 `8x7b` 这种 MoE 尺寸段，`al7b` 这类随机段不再豁免。已知模型名（`gpt-4o-mini-2024-07-18`、`claude-3-5-sonnet-20241022`、`nous-hermes-2-mixtral-8x7b-dpo`、48 字符以上的长模型 ID）继续原样保留；判定拿不准时宁可误遮。

  **2. 截断的 Anthropic 风格错误信封：providerCode 取里层的错误类别**

  Anthropic 风格信封最外层的 `"type":"error"` 只说「这是一条错误」，真正的类别在 `error.type` 上。错误响应体超过 16KB 被截断、走容错提取时，最外层这个判别字段原来会抢先占住 `providerCode`，接入方拿到的是没法判的 `error`；现在跳过它，取里层真正的类别（如 `authentication_error`），跟不截断时的取值一致——靠 `providerCode` 停止重试鉴权失败的接入方不会再一直重试。

## 0.4.0-next.8

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

## 0.4.0-next.7

### Minor Changes

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

### Patch Changes

- 80f471d: 通知策略统一成「要推就一定弹，不想弹就别推」

  订阅是按 `userVisibleOnly: true` 建的，收到 push 却不弹通知，各家浏览器的处理不一样。iOS 那边实测下来是宽限期机制：订阅刚建好的几天里，发多少条不弹通知的 push 都不掉订阅（跟条数无关，只跟订阅建了多久有关）；宽限期一过，一条不弹的就立刻吊销；吊销后重新订阅，判定比第一次更严，之后随时可能再掉。最难查的是这个时间差——本地订阅完立刻测一轮都正常，上线几天后用户订阅才开始成片掉，而且掉订阅是静默的，服务端只看到推送返回 410。

  于是通知策略的口径收敛成一条，跟客户端跑在什么设备上无关：**要推就一定弹**（`notification.show: "always"`，嫌打扰用 `tag` 折叠加 `silent: true`；弹通知不影响页面自绘，`postMessage` 照常派发），**不想弹就别推**（内容落服务端收件箱，客户端上线 `GET /outbox?since=` 补拉）。

  `"when-hidden"` 标为兼容档：应用在前台时它就是一条不弹的 push，那笔账照记（规范允许 user agent 在有可见窗口时免掉展示约束，Chrome 认这条豁免，iOS 不认）。既有部署照常工作，新代码在上面两条里挑一个。文档里的场景示例统一改用 `"always"` + `tag` 折叠 + `silent: true`。

  `show` 四个档各是什么、什么时候用，收进 `@rei-standard/amsg-shared` README 的「选哪个 `show`」一张表，其余包只留一句「兼容档，新代码不选」加链接。amsg-sw README 新增「不展示通知的代价」一节收口这套取舍，shared / server / instant / client 的相关段落指过去；Service Worker 规范同步新增 §4.1.2，正文与变更历史里的通知策略建议改用同一口径。纯文档改动，运行行为不变。

## 0.4.0-next.6

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

## 0.4.0-next.5

### Minor Changes

- LLM 请求体支持 `llmExtraBody` 透传（thinking / reasoning_effort 等中转非标准参数）

  - shared 的 `buildLlmRequestBody`：`payload.llmExtraBody`（普通对象）原样展开进请求体，先展开再写核心字段——`model` / `messages` / `temperature` / `max_tokens` / `tools` 永远以库的口径为准，extra body 撞键盖不掉。非对象/数组静默忽略。
  - server 的 `POST /schedule-message`：payload 白名单加 `llmExtraBody`（存进任务 payload，fire 时随 `buildLlmRequestBody` 进请求体）；fire 里 `ctx.scheduleTask` 自排的后续任务继承它。形状校验只查普通对象——里面的字段是调用方与中转之间的契约。

  特性位：`llm-extra-body`。

## 0.4.0-next.4

### Minor Changes

- `buildSessionContext` 新增 `usage` 字段（`llmResponse.usage` 的直接引用）

  `onLLMOutput` 想记本轮 token 用量，之前要自己从 `llmResponse` 里扒（并假定响应形状）。现在 SessionContext 直接带 `usage`（响应没带 → null），amsg-instant 与 amsg-server 的 hook 同步获得。

### Patch Changes

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

## 0.4.0-next.3

### Minor Changes

- d6bea67: hook 契约补齐任务身份与状态读写口；push 自带任务的调度身份

  - **config 级 hook 拿到状态读写口。** `onAfterSend` / `onStaleSkip` 的载荷里现在有 `readState(ns)` / `writeState(ns, entries)`，语义与 fire 级那套一致（单用户模式下作用于当前用户的命名空间）。此前只有 fire 级 ctx 上有，宿主要在这两个 hook 里写 `client_state` 只能自己缓存一份写口：isolate 冷启动后、本次 tick 里还没有任何 fire 跑过时缓存是空的（服务停摆恢复后那一波过期跳过一条痕迹都留不下，而那正是 `onStaleSkip` 存在的意义），缓存下来的闭包还握着上一次 invocation 的数据库绑定。
  - **`onAfterSend` 收到本次 fire 的 `scratch`。** 与 `onBeforeFire` / `onLLMOutput` 是同一个对象引用，所以「这次生成了哪几段正文」这类上下文直接从 `info.scratch` 读，不用再按任务行 id 自建登记表（连带 TTL 清扫和并发隔离）。完整载荷：`{ task, sentCount, total, error, scratch, readState, writeState }`。
  - **`onLLMOutput` / `executeToolCalls` 的 ctx 直接带任务身份**：`taskId`（任务行 id）、`taskUuid`、`occurrenceMs`（本次触发的名义时刻，epoch 毫秒）。`sessionId` 是给日志和去重用的不透明字符串（当前格式 `sess_task_<id>@<occurrenceMs>`），拿它切字符串取任务身份是切不稳的。
  - **每条 push 顶层带 `taskId` / `taskUuid` / `recurrenceType` / `occurrenceMs`**（冻结 prompt 路径和 fire-time hook 路径都算）。客户端据此认领任务、判断它还会不会再来——角色在 fire 里给自己排的任务客户端从没见过，此前只能靠宿主往 `metadata` 里逐个抄。调用方在 `pushPayloads` 里自己写了这几个字段会被库覆盖：它们描述的是任务行的事实，不是内容。`@rei-standard/amsg-shared` 的 `AmsgPushCommon` 类型随之收录这四个字段（`taskId` 从 `ContentPush` 上移到公共层）。
  - **新增导出 `PUSH_ENVELOPE_RESERVED_BYTES`（384 字节）**，以及 `measurePushPayload(payload, { reserveEnvelope: true })` 这个口径。hook 把 payload 交还给库之后，库还会补 `messageId` / `sessionId` / `timestamp` / `messageIndex` / `totalMessages` / `taskId` / `taskUuid` / `recurrenceType` / `occurrenceMs`，hook 手里量到的从来不是最终 payload；不留这一截的话，卡在边界上的消息会「量出来装得下、补完字段就超了」，既没走旁路存储也发不出去。返回值多一个 `envelopeReservedBytes`。
  - **`GET /capabilities` 的 features 追加** `hook-state-accessors` / `after-send-scratch` / `fire-task-identity` / `push-task-identity` / `push-envelope-reserved-bytes`。

## 0.4.0-next.2

### Minor Changes

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

### Patch Changes

- 9d1f89f: 补齐许可证文件：每个包根目录加入 MIT LICENSE 文本（此前 package.json 声明 MIT 但 tarball 里没有许可证文件）。仓库层面确立双许可——代码 MIT、`standards/` 规范文本 CC BY-NC-SA 4.0，根 README 的许可一节与 npm 元数据不再互相矛盾。

## 0.4.0-next.1

### Minor Changes

- f13f2f1: fire 级 scratch：hook 之间传上下文不再自己维护 Map

  单次 fire 开始时库创建一个空对象，`onBeforeFire` 的 fireCtx 和同一次 fire 里每轮 `onLLMOutput` / `executeToolCalls` 的 sessionCtx 都拿到同一个 `scratch` 引用；fire 结束（finish / skip-push / 抛错 / 轮数超限）后随之丢弃。不落库、不进日志、不跨 fire 共享。amsg-shared 的 `buildSessionContext` 新增可选 `scratch` 参数（不传则字段缺席，amsg-instant 行为不变）。

## 0.4.0-next.0

### Minor Changes

- 914ddcf: amsg-shared 新增 agentic 循环契约工具：`buildSessionContext`、`extractAssistantMessage`、`assertValidDecision`（新增 `inlineToolCalls` 选项，允许 `tool-request` 直接携带 `toolCalls`，供服务端就地执行工具的场景用）、`extractToolCallsFromDecision`。amsg-instant 的 SessionContext 构建与 decision 校验改为从 amsg-shared 复用同一实现，对外行为与错误信息不变。

## 0.3.0

### Minor Changes

- 5c0e047: 新增三组共享纯函数，让 server / instant / client 复用同一份规则，不再各自维护副本：

  - `validateAvatarUrl`（含 `isValidUrl` 与 `AVATAR_URL_MAX_LENGTH`）—— 头像 URL 校验
  - `normalizeVapidSubject` —— VAPID subject 规范化（`mailto:` / `https:` 均保留，裸邮箱补 `mailto:`）
  - `readReasoningContent` / `stripReasoningTags` —— 读取推理内容与剥离私有 `<think>` 链式思考

## 0.2.0 — Notification silent support

### New

- **NotificationDirective**：新增并校验 `notification.silent?: boolean`，与 `@rei-standard/amsg-sw@2.2.0` 的无声通知渲染能力对齐。

### Fix

- **NotificationDirective typedef 与 SW 实际行为对齐**：原 typedef 写 `tag` / `renotify` / `requireInteraction` / `silent` 没有 top-level fallback，实际上 `amsg-sw` 一直对这四个字段（以及 `data`）都按 `notification.X` → `payload.X` → 默认值的顺序回退。typedef 改成承认完整 fallback，避免 producer 误以为漏在 payload 顶级的字段不生效。仅 doc / type，wire format 不变。

### Compatibility

- 纯 additive。未传 `notification.silent` 时 wire format 不变。

## 0.1.0 — NotificationDirective 与 Shared utilities

### New

- **Shared Utilities**：新增并导出了底层工具函数 `base64UrlToBytes`, `toUint8`, 和 `concatBytes`，统一了底层依赖。
- **NotificationDirective**：新增了对 `notification.show` (`"auto"` | `"always"` | `"when-hidden"` | `false`) 参数的类型定义与验证逻辑。

## 0.1.0-next.3 — `notification` 字段 typed support (pre-release)

Coordinated with `@rei-standard/amsg-instant@0.8.0-next.3`. Install with `npm install @rei-standard/amsg-shared@next`. Wire format unchanged — additive typedef + new optional builder arg.

`notification` 字段一直被 `amsg-sw` 的 `createNotificationFromPayload` 当作 `showNotification` 渲染指令读取（`title` / `body` / `icon` / `badge` / `tag` / `renotify` / `requireInteraction` 共 7 字段），但 `ContentPush` / `ToolRequestPush` typedef 没声明，hook 作者只能 untyped spread——跟 next.3 amsg-instant 修掉的 `pushPayload.splitPattern` 是同一种 leaky-API。这版补上类型，IDE 给完整的 7 字段补全。

### New

- **`NotificationDirective` typedef** — 显式 7 个 optional 字段（`title` / `body` / `icon` / `badge` / `tag` / `renotify` / `requireInteraction`），跟 `amsg-sw` `createNotificationFromPayload` 实际消费的字段一一对应。typedef 写了 SW 端的 fallback 链（`notification.title` → `payload.title` → `来自 {contactName}` → `'New notification'`），producer 不用再翻 SW 源码。
- **`ContentPush.notification?` + `ToolRequestPush.notification?`** — 两个 push kind 加可选字段。`ToolRequestPush` 上也挂是为了让 amsg-instant 的 sentence-splitter demote 出来的前 N-1 个 ContentPush chunks 继承（demoted 时 spread 整个 cleanPushObj，所以 notification 跟着走）。`ReasoningPush` / `ErrorPush` 不加——SW 这俩 kind 是 silent dispatch，挂上也不会触发渲染。
- **`buildContentPush` / `buildToolRequestPush` 加 `notification?` 入参** — passthrough 不深拷贝（跟 `metadata` 一致的处理）。形状校验：必须是 plain object，`title` / `body` / `icon` / `badge` / `tag` 是 string、`renotify` / `requireInteraction` 是 boolean。未知字段透传（保 SW forward-compat）。

### 为什么 typed 全部 7 个字段（而不只是 `title` / `body`）

SW 实际读取 7 个 notification 字段；只 typed 其中一部分会让剩余字段继续绕过 builder 校验，表现成“代码能过、行为静默不生效”。这版一次性补齐完整字段集，caller 可以直接从手写 spread 迁到 typed arg。

### 行为兼容

- 不传 `notification`：wire format 跟 next.2 byte-for-byte 一致（builder 出口不写这个 key）。
- 老 amsg-sw / amsg-instant 等 caller 不受影响——typedef 是 additive，builder 没改原有签名。
- Wire schema 不动；`AmsgPush` 联合类型不动；type guards 不变。
- 跟 amsg-instant 0.8.0-next.3 的 `pushPayload.splitPattern` per-push override 协调发版。

## 0.1.0-next.2 — ReasoningPush 字节切分 + multi-part 索引字段 (pre-release)

Coordinated with `@rei-standard/amsg-instant@0.8.0-next.2`. Install with `npm install @rei-standard/amsg-shared@next`. Existing single-shot ReasoningPush callers are wire-compatible — the new fields are emitted only when chunking actually fires.

### New

- **`ReasoningPush` 加四个可选字段**：`messageIndex` / `totalMessages`（语义切，由 amsg-instant 的 `reasoningSplitPattern` 触发）+ `chunkIndex` / `totalChunks`（字节切，由 amsg-instant 的 `reasoningChunkBytes` 触发，把单段 reasoning 在 UTF-8 codepoint 边界切成 N 份绕开 Web Push ~2.6 KB 上限）。四个字段都 optional，单 chunk 单 segment 时不写到 wire 上，老 SW 看到的字节流跟 next.1 完全一致。
- **`buildReasoningPush`** 透传四个新可选字段；未传时输出不包含它们。
- **新导出 `chunkReasoningByUtf8Bytes(text, maxBytes)`** — UTF-8 codepoint-safe 字节切分 helper。`TextEncoder` → 字节扫描回退到 lead byte → `TextDecoder` 还原。汉字（3-byte）/ emoji（4-byte）/ ASCII 混排都能保证边界不切坏，`chunks.join('')` 严格等于输入。`maxBytes < 4` 抛 `RangeError`（UTF-8 codepoint 最宽 4 字节，更小没法切）；非字符串 `text` 抛 `TypeError`。
- **SW / 消费方拼接约定**（仅文档，本包不实现）：按 `sessionId` 分桶 → 有 `messageIndex` 再按它分子桶（Layer 1）→ 按 `chunkIndex` 排序拼字符串（Layer 2）。两个轴都到齐再消费。

### Unchanged

- 三轴 push schema、其它三种 push（content / tool_request / error）的 typedef + 字段、type guard、`MESSAGE_KIND` / `MESSAGE_TYPE` / `PUSH_SOURCE` 常量、零运行时依赖、ESM/CJS 双发布 — 全不动。
- 单 chunk 单 segment 的 ReasoningPush wire format 完全不变（新字段默认不写）。

## 0.1.0-next.0 — initial pre-release

Published under the `next` dist-tag (the repo's convention for prereleases — `publish-workspaces.mjs` auto-routes any version with a prerelease suffix). The schema is locked but the package is held back from `latest` until downstream integrators sign off on the wire shape end-to-end. Install with `npm install @rei-standard/amsg-shared@next`.

---

New package. The lowest layer of the ReiStandard Active Messaging
ecosystem: every other amsg sub-package (`amsg-instant`,
`amsg-server`, `amsg-sw`, `amsg-client`) depends on this one, never
the reverse.

### What's in

- `MessageKind` / `MessageType` / `PushSource` type aliases + matching
  runtime constants (`MESSAGE_KIND`, `MESSAGE_TYPE`, `PUSH_SOURCE`).
- Discriminated union `AmsgPush = ContentPush | ReasoningPush |
ToolRequestPush | ErrorPush`, with `messageKind` as the literal-type
  tag (TS consumers can `switch (push.messageKind)` and narrow).
- Common-fields `@typedef` `AmsgPushCommon` capturing the universal
  shape (`messageType` / `source` / `messageId` / `sessionId` /
  `timestamp` / `messageSubtype?` / `metadata?`).
- Four builder helpers: `buildContentPush`, `buildReasoningPush`,
  `buildToolRequestPush`, `buildErrorPush`. Each does minimum
  required-field validation and returns a plain object.
- Four type guards: `isContentPush`, `isReasoningPush`,
  `isToolRequestPush`, `isErrorPush`.

### Out of scope (deliberate)

- No `messageKind: 'tool_result'`. Tool results flow client → worker
  via the `/continue` body, not as a push.
- No streaming-chunk push type.
- No tool-call schema validation (`toolCalls` is `Array<object>` —
  whatever OpenAI-compatible the upstream returned).
- Builders do not write into `metadata`. `metadata` stays a caller-
  owned namespace.

### Migration from 0.7.x callers

The 0.7.x `amsg-instant` legacy push (13 fields, no `messageKind`)
and the standalone `{ type: 'error', code: '...' }` envelope are both
gone in the upstream packages that consume this. Use:

| Was (0.7.x)                                    | Now (≥ 0.1.0 of shared, ≥ 0.8.0 of instant)      |
| ---------------------------------------------- | ------------------------------------------------ |
| 13-field instant push                          | `buildContentPush({...})`                        |
| `{ type: 'error', code: 'HOOK_THREW', ...}`    | `buildErrorPush({ code: 'HOOK_THREW', ... })`    |
| `{ type: 'error', code: 'LOOP_EXCEEDED', ...}` | `buildErrorPush({ code: 'LOOP_EXCEEDED', ... })` |
| (no equivalent — reasoning was discarded)      | `buildReasoningPush({ reasoningContent, ... })`  |
