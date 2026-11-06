---
"@rei-standard/amsg-sw": minor
---

离线队列 408 / 429 留队重试、冲刷单轮串行；IndexedDB 写入等事务提交完成才算成功

**1. 离线队列**

- 服务端回 HTTP 408 / 429 的请求现在留在队列里等下一次冲刷，不再当永久拒绝删掉；其余 4xx 照旧删掉并广播 `QUEUE_DROPPED`。
- 冲刷同一时刻只跑一轮。页面的 `FLUSH_QUEUE`、入队后的立即冲刷和 Background Sync 撞上时，每个后来的调用各在当前这轮后面排一轮、串行跑，同一条记录不再被两轮各发一次。5xx 和网络错误照旧留在队列里等下次冲刷。

**2. IndexedDB 写入以事务提交为准**

入队、去重占坑、分片落库这些写操作，现在等事务 `oncomplete` 才算成功。请求本身 `onsuccess` 了、提交阶段因配额或 I/O 出错 abort 的（典型是 `QuotaExceededError`），记录并没有落盘，走失败路径：

| 写操作 | 失败时 |
|---|---|
| 入队 | 入队回执 `ok: false`，带 `error` |
| 去重占坑 | 按首投照常分发，DELIVER ack 带 `dedupeError` |
| 分片落库 | 广播 `MULTIPART_EXPIRED`，`reason` 为 `'storage-failed'` |

去重记录在占坑途中被过期清理删掉时，会重新占一次坑，这条 push 按首投处理。

**3. Multipart**

- 齐没齐按分片仓库里实际落库的分片数算，不靠 pending 记录里的计数；分片落了库、pending 那笔写却失败的情况下，重投的同一片现在能把它补齐。
- TTL 清扫放弃的 multipart id 也写 done 标记：`MULTIPART_EXPIRED`（`'ttl-expired'`）只报一次，之后迟到的分片静默丢弃，不再重新开一份 pending。

**4. 空 push 也弹通知**

`push` 事件没带 data、或 data 解析出来是空值时，弹一条标题 `New notification`、正文 `defaultBody`（默认 `New message`）的通知，不再让浏览器替站点弹「此网站已在后台更新」。

**5. 运行要求**

`engines.node` 为 `>=20.3.0`。
