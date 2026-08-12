---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-sw": minor
---

分片拼不起来时不再静默丢弃，`MULTIPART_EXPIRED` 带上失败原因

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
