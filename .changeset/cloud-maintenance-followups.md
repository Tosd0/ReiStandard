---
"@rei-standard/amsg-server": patch
---

云端数据清理出错时，cron 这一跳照常投递消息：出错原因通过 `onError`（`stage: 'cloud-cleanup'`）上报，并放在 `scheduled()` 返回值的 `cloudCleanupCause` 上，`ok` 只反映消息投递这一段。升级后还没补表结构的部署，定时消息不受影响。

旧清理记录的一次性建索引每批只发一条写入语句，读不出来的清理操作也会进索引并每 15 分钟重试一次；读不出来或续不动的操作排到还在等的操作后面。没实现工作索引的自定义适配器继续按每跳全量扫描做保留期清理。`describeSchema` 不回报 `triggers` 时，表结构自查不查触发器。
