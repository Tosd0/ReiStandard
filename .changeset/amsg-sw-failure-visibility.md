---
"@rei-standard/amsg-sw": minor
---

离线队列被拒的请求不再无声消失，去重仓库出错也不再吞掉整条 push

**离线队列：4xx 被拒会报出来**

队列里的请求被服务端 4xx 拒绝时，SW 照旧不再重试、把记录删掉（重试策略不变，4xx 重试多少次都是同一个结果）。原来删完就没了：页面拿到的还是 `{ ok: true, queueId }`，应用以为「已入队、早晚会发出去」，实际这条请求永远不会再发，没有事件、没有日志、队列里也查不到。最常见的触发是 token 轮换后还拿着旧 token（401），其次是 X-User-Id 不合法（400）、payload 超限（413）、路由改名（404）。

现在这条请求被删掉时会同时给出三个出口：

- 入队 ack 上新增机读字段。`ok: true` 的含义不变（=「已入队」，老调用方不受影响），新增 `delivered` 表示这次立即冲刷有没有真把它发出去；被永久拒绝时另外带上 `dropped: true`、`status`（HTTP 状态码）和 `error`。三种结局分别是：发出去了（`delivered: true`）、还在队列里等重试（`delivered: false`）、已被拒且删掉（`delivered: false, dropped: true`）。
- 广播给所有窗口一条 `REI_QUEUE_RESULT`（`{ ok: false, queueId, dropped: true, status, error, request: { url, method } }`），页面在全局 `navigator.serviceWorker` 的 message 事件里就能收到，不必持有当初入队用的 MessageChannel。出于安全考虑广播里不带 headers 和 body。
- 一条带 url / method / 状态码的 `console.error`。

**push：去重或分片存储出错不再吞掉整条消息**

去重记录写 IndexedDB 失败时（设备存储写满、存储压力下连接被强关且重开失败、用户清站点数据的瞬间、宿主占用了同名 `dedupe.dbName` 却没有对应的 store），原来整个 push 事件会挂掉：通知不弹、页面收不到 postMessage、`onBusinessPayload` 不跑，只在 SW 控制台留一条大多数用户看不到的 unhandled rejection；用 `deliver()` 观察的发送端看到的是超时，排查方向整个是反的。

去重是「防重复弹」的优化，坏了应该多弹一条，不该一条都不弹。现在这种情况会降级成「当作首次投递照常分发」，并留一条能归因的日志；`REI_AMSG_DELIVER` 的 ack 仍是 `ok: true`，但会带上 `dedupeError`，让发送端知道这条没走去重保护、另一路 backup 可能还会再投一次。

multipart 分片的存储出错走另一种降级：手里只有一个分片，不能当完整消息发出去，所以放弃这个分片 id，按既有的 `rei-amsg-multipart-expired` 事件告诉页面别再等，同样留下日志。

另外，重复包补弹通知被系统拒绝（权限被撤、配额、OS 错误）时也不再让整条 push 挂掉，与首次投递路径的处理保持一致：记一条日志，并在 `onDuplicate(info)` 里如实报 `duplicateNotificationShown: false`。
