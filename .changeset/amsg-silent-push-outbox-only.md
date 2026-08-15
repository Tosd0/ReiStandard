---
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-sw": patch
---

不会弹通知的 payload 不发推送，只落收件箱

一条 payload 出门有两条腿：落进 `message_outbox`（到达的保证，客户端上线 `GET /outbox?since=` 补拉）和发一条 Web Push（及时性）。收件箱那条腿每条 payload 都走，推送这条腿只留给「到了客户端会弹通知」的那些。

| payload | 落收件箱 | 发推送 |
| --- | --- | --- |
| `content` / `result` | ✅ | ✅ |
| `reasoning` / `tool_request` / `error` | ✅ | ❌ |
| 任意 kind + `notification: { show: false }` | ✅ | ❌ |
| 任意 kind + `notification: { show: 'always' \| 'when-hidden' }` | ✅ | ✅ |

订阅是按 `userVisibleOnly: true` 建的，每条 push 都欠用户一次可见反馈。`reasoning` / `tool_request` / `error` 在 Service Worker 那边是静默送给页面的，推过去不会有任何可见反馈，却要跟浏览器赊一次账：Firefox 对这类 push 有配额、超了退掉订阅；iOS 给新订阅几天宽限期，过后一条不弹的就吊销订阅，而且掉订阅是静默发生的，服务端只看得到后续推送返回 410。这些内容在收件箱里一个字不少，走补拉既不影响到达，也不再拿订阅去换一条根本不会显示的横幅。

想让某一条照样弹，给它带上 `notification: { show: 'always' }`——发送端和 Service Worker 读同一份判定，宿主说了要弹就照推。`show: 'when-hidden'` 也照推：它到底弹不弹要看当下有没有可见窗口，那只有 Service Worker 知道；这一档是给既有部署留的兼容值，新代码在「一定弹」和「压根不推」里挑一个。

一个例外不用配：这一批没能落进收件箱时照旧推送，那时推送是这条内容唯一的腿。收件箱是 D1 适配器的能力，多租户线的 pg / neon 还没有，那条线上所有 payload 照旧全推。跳过推送的行不标 `delivered_at`，留在收件箱里等客户端补收。

agentic 链路的 `onAfterSend` / `onFireSettled` 回执新增 `pushedCount`：这批里真的占用了推送通道的有几条。`sentCount` 含义不变（这批走完了几段），`sentCount === total` 照旧表示整批都到位了。

`@rei-standard/amsg-shared` 新增导出 `notificationIntent(payload)`：把「这条到了客户端会不会弹」算成 `'always'` / `'when-hidden'` / `'never'`。SW 和发送端读同一份，判定不会各走各的。
