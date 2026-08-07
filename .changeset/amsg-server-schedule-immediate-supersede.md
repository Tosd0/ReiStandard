---
"@rei-standard/amsg-server": minor
---

`POST /schedule-message` 支持 `immediate: true` 与 `supersedesUuid`（原子替换）

**immediate**：之前 `firstSendTime` 必须严格在未来，想「马上发一条走 cron 链路的任务」只能预留提前量再想办法把行拉回当下——慢网/低端机把提前量吃光就是 400 INVALID_TIMESTAMP。现在 body 里带 `immediate: true` 即可：跳过未来校验，`next_send_at` 落在当下，下一跳 cron（最多一分钟后）直接触发。此时 `firstSendTime` 可省略；对 `instant` 类型明确拒绝（它本就立即投递）。

**supersedesUuid**：建这条的同时取消旧的那条。D1 适配器新增可选的 `createTaskSuperseding(params, supersedesUuid)`，删旧建新落在同一个 batch（隐式事务、单次往返）——不会出现「旧的删了、新的没建成」的中间态，INSERT 撞 uuid 时整体回滚。适配器没实现时 handler 退回「先删再建」两步。响应里带 `superseded`（旧行是否真的被取消）。

特性位：`schedule-immediate`、`schedule-supersede`。
