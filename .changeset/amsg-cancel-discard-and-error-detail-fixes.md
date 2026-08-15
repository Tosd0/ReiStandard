---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-instant": minor
"@rei-standard/amsg-sw": minor
---

取消的消息不再从收件箱补收回去；失败细节里的模型名不再被脱敏吃掉

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
