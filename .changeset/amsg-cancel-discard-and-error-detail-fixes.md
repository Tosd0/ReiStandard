---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-instant": minor
"@rei-standard/amsg-sw": minor
---

取消的消息不再从收件箱补收回去；失败细节里的模型名不再被脱敏吃掉

**1. 投递到一半被取消：没发出去的那几条从 outbox 里撤掉**

整批 push 是发送前就落进 `message_outbox` 的（那是补收的事实来源），而取消只拦得住 Web Push 这一路。剩下没发出去的行不撤掉的话，客户端下一次 `GET /outbox` 会照样把它们拉回去——用户看到的是「取消接口回了成功，消息还是来了」。

现在任务在投递期间被 `DELETE /message` 取消、或被 `supersedesUuid` 顶替时，这一批还没发出去的行会被删掉；已经推给设备的那几条不动，行留着让客户端照常 ack。老链路和 agentic 链路两条发送路都覆盖。

适配器接口新增可选方法 `discardOutboxMessages(userId, messageIds)`，内置只有 D1 实现；不实现的适配器行为与以前一致（取消只挡住 Web Push）。

**2. 脱敏不再把模型 ID 当成 API Key**

错误细节里长得像凭据的串会被遮成 `[redacted]`。判据现在要求尾巴有连续 16 个以上的字母数字，模型 ID（`gpt-4o-mini-2024-07-18`、`claude-3-5-sonnet-20241022` 这类被连字符切开的短词）不再命中——上游那句「你写的这个模型不存在」里最关键的就是模型名，遮掉它报错只剩「有个东西不存在」，而模型名写错是这套错误细节要解决的头号场景。`sk-…` / `xai-…` / `Bearer …` 照旧遮掉。

三处同规则的实现（`@rei-standard/amsg-shared` 的 `redactCredentials`、amsg-server 的 `sanitizeErrorSummary`、amsg-instant 的 Cloudflare 适配器）一起改。

**3. instant 任务的 `last_error` 带上 `errorCode` / `pushStatus`**

`messageType: 'instant'` 的任务终审失败时，写进 `last_error` 的记录原来只有 `{ at, occurrence, reason }`。现在跟定时任务那条路共用同一份形状：`reason` 是给用户看的人话，`errorCode` / `pushStatus` 是给下游判定用的——`pushStatus === 410` 表示订阅已注销，客户端据此引导用户重新登记，不用回去正则匹配 `reason`。

**4. `last_error` 一律往行上写**

原来只有实现了可选的 `claimTask` 的适配器才往行上的 `last_error` 列写。跟着包内 SQL schema 建表、但没实现 `claimTask` 的自定义适配器，行上有这一列、`GET /message` 的投影也认它权威，却没人往里写——`lastError` 读出来永远是 `null`。

现在一律写，存储不认这一列时自动退掉这个字段重写一次（行为与以前的库升级兼容路径一致）。投递成功时行上的列和密文 payload 里的那份记录一起清掉。

**5. `PUT /update-message` 的大小闸门只拦「这次改动把它变大了」**

任务内容大小上限是后加的，比它更早建出来的大任务本来跑得好好的。一律按合并后的大小拒的话，那条任务连把 `nextSendAt` 往后挪一小时都做不到，只能删掉重建。现在合并后超限、且比改动前更大才回 `400`；改小或大小没变的改动照常放行。

**6. `ctx.webpush` 的取消检查不再用 `Proxy`**

宿主按常见写法传 `webpush: Object.freeze({ sendNotification })` 时，`Proxy` 的 get trap 返回包装函数会踩不变式当场抛 `TypeError`，那个部署下每一条定时消息都发不出去。改成拿宿主对象当原型的影子对象，只盖住 `sendNotification`，冻结的实现照样能用。

**7. Node 适配器：服务端自己的流错误不再被当成客户端断开**

SSE 中途炸掉（LLM 流出错、推送扇出失败）时，`pipeline` 会先把响应销毁，所以「响应被销毁了」分不出是客户端走了还是服务端炸了。现在只按错误码判断客户端断开，其余失败会留下一条 `console.error`——响应头一旦发出去，状态码这条路就用不上了，不记日志的话这次失败彻底没痕迹。客户端正常断开（关页面、切走）照旧不记日志。

**8. Cloudflare 适配器：请求阶段的兜底 500 走部署自己的 CORS**

handler 建起来之后，「允许哪些 origin」就是已知的了，这条兜底 500 用的是部署配置的那套 CORS 头，跟正常响应一致。回显来访 Origin 的降级头只用在「配置都没建起来」那条路上——那时白名单确实无从得知。

**9. 队列请求被永久拒绝时的广播换了独立的 message type**

SW 里某条队列请求被服务端 4xx 永久拒绝、从队列删掉时，会广播给所有窗口一条 `REI_SW_MESSAGE_TYPE.QUEUE_DROPPED`（原来跟入队回执共用 `QUEUE_RESULT`）。

两者的收信人不是一回事：这条是广播，可能由后台 `sync` 冲刷触发、说的也可能是另一条早就排在队列里的旧请求。共用一个 type 的话，页面等自己那条入队回执时会先收到这条广播、当成自己的结果，明明入队成功却报「排队失败」。点对点的入队回执仍是 `QUEUE_RESULT`，字段不变。
