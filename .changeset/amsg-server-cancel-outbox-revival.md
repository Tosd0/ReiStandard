---
"@rei-standard/amsg-server": patch
---

补上「取消后消息不再从收件箱复活」的四个缺口

取消 / 顶替一条任务后，它名下还没发出去的 `message_outbox` 行要跟着撤掉，否则客户端下一次 `GET /outbox` 会把已取消任务的内容补收回去。此前有四条路漏掉了这一步，这次一起补上：

**1. 取消撞上投递收尾（`cancelled_after_delivery`）也清收件箱。** 取消发生在 LLM 还在生成的时候，取消那侧的清理扫不到之后才落进收件箱的行（思考过程那条按策略只落行、不推送，正是必然留下的那种）。现在投递侧发现「行已被取消或顶替」时（`cancelled_mid_delivery` / `cancelled_after_delivery`，一次性与循环任务都算），会顺手把该任务名下未投递的行撤掉。

**2. `ctx.emitResult` 不发推送的那条路（`notification: { show: false }`）也认取消信号。** 原来取消只在推送前那一道拦截上生效，不推送的结果感知不到取消，照样落行。现在 `runScheduledTick` 的投递把取消信号一路递给结果出口：任务已被取消时 `emitResult` 抛 `TASK_CANCELLED`（与推送那条路同一个错误形状），不落行；落行的 await 期间才发现取消的，把刚落的行自己撤掉。

**3. fire 内的 `ctx.cancelTask(uuid)` 与 `DELETE /cancel-message` 同一收尾。** 取消的任务此前投递到一半失败过的话，未投递的分段还在收件箱里等重试——现在删行成功后同样把它们撤掉（best-effort，清不掉不影响取消本身）。

**4. 清理不再受未 ack 积压量限制。** 原来按任务清收件箱靠「按用户翻页扫全部未 ack 行、在 JS 里挑 `task_uuid`」，有 5000 行的扫描上限——积压超过它时，被取消任务的行（最新的那批）正好扫不到，一行都没撤还没有任何日志。适配器接口新增可选方法 `discardUndeliveredOutboxForTask(userId, taskUuid)`（内置 D1 已实现）：按任务一次直删，一个数据库来回，不受积压量影响。没有这个方法的适配器退回翻页扫描，行为与以前一致，但扫到上限没扫完时会记一条点名日志，不再静默。

判据不变：只撤 `delivered_at` 为空的行，已经推给设备的留着让客户端照常 ack。
