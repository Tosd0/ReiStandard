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

**2. 脱敏规则收敛成一份，模型 ID 不受影响**

错误细节里长得像凭据的串会被遮成 `[redacted]`：`sk-…` / `xai-…` / `sk-ant-api03-…` 这种「短前缀 + 长随机串」，`Bearer …` 连值一起遮，以及光是一长串的 base64 / JWT 片段。随机段里夹着 `-` 和 `_` 的 Key 整条遮掉，不留半截。

模型 ID 原样保留。它跟 Key 长得很像，但形状能分开：全小写字母数字、被 `-` / `.` 切成一串短段（`gpt-4o-mini-2024-07-18`、`claude-3-5-sonnet-20241022`），命中这个形状的不遮。上游那句「你写的这个模型不存在」里最关键的就是模型名，遮掉它报错只剩「有个东西不存在」，而模型名写错是这套错误细节要解决的头号场景。

规则本身只有一份，在 `@rei-standard/amsg-shared` 的 `redactCredentials`；amsg-server 的 `sanitizeErrorSummary`（落库的 `last_error` 列）和 amsg-instant 的 Cloudflare 适配器（跨域 502 响应体）都调它，各自只负责后面的截断长度。

**3. instant 任务的 `last_error` 带上 `errorCode` / `pushStatus`**

`messageType: 'instant'` 的任务终审失败时，写进 `last_error` 的记录原来只有 `{ at, occurrence, reason }`。现在跟定时任务那条路共用同一份形状：`reason` 是给用户看的人话，`errorCode` / `pushStatus` 是给下游判定用的——`pushStatus === 410` 表示订阅已注销，客户端据此引导用户重新登记，不用回去正则匹配 `reason`。

**4. `last_error` 一律往行上写**

原来只有实现了可选的 `claimTask` 的适配器才往行上的 `last_error` 列写。跟着包内 SQL schema 建表、但没实现 `claimTask` 的自定义适配器，行上有这一列、`GET /message` 的投影也认它权威，却没人往里写——`lastError` 读出来永远是 `null`。

现在一律写。状态推进（标 failed / 推进排期 / 放租约）和这条记录分开对待：第一次遇到一个适配器时分两笔写，状态字段先落地，`last_error` 单独补一笔。补得上就记住这个库有这一列，之后合成一笔；补不上（升级后没重跑 `/init-tenant` 的库、自建的 `DbAdapter`）也记住，之后不带这个字段，失败原因仍记在密文 payload 的 `lastError` 里。

分开写是为了让状态机不受这一列影响：合成一笔、又靠错误措辞去猜「是不是缺这一列」的话，猜不中就是 `retry_count` 不涨、`next_send_at` 不动，任务被每一跳 cron 重新捞起来，LLM 每次重跑一遍还每次都计费。

投递成功时行上的列和密文 payload 里的那份记录一起清掉。重写密文之前会先确认行上的密文还是领取时那一份——投递跑几十秒，其间用户 `PUT /update-message` 改过的话，把快照原样写回去等于把那次修改静默回滚；失败收尾写 `lastError` 走同一道确认。
