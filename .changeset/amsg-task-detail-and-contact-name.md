---
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-client": minor
---

新增 `GET /message` 单条任务查询；`update-message` 认 `contactName`

- **`GET /message?id=<uuid>`（客户端 `client.getMessage(uuid)`）** 返回单条任务，形状与 `GET /messages` 列出来的一样，外加**完整的 `metadata`**。`PUT /update-message` 对 `metadata` 是整体替换（不深合并），而列表的投影只给 `charId` / `clientTaskId` 两个子字段——两件事凑在一起，「只改 metadata 里的一个键」是做不到的：拿不回完整的那份就没法读-改-写，盲传一部分会把宿主存在里面的其余键（任务指令、锚点时间戳、过期策略之类）一起冲掉，下次触发直接失败。列表维持不带整份 metadata：一页最多 100 条，每条都驮着它会把响应撑得很大，而列表要的只是「有哪些任务」。单条查询只读得到还没发出去的任务，已完成 / 已失败返回 `409 TASK_ALREADY_COMPLETED`、不存在返回 `404 TASK_NOT_FOUND`，与 `PUT /update-message` 同一口径。

- **`PUT /update-message` 的可写字段加上 `contactName`**（非空字符串，口径与排程时一致；空串 / `null` / 非字符串返回 `400 INVALID_UPDATE_DATA`）。用户给角色改了名之后，之前排好的任务推送出来的通知标题（「来自 `<contactName>`」）靠它跟着改。`contactName` 不是 key——宿主按角色过滤用的是 `metadata.charId`，它会跨角色重名——数据库里也只活在加密 payload 中，没有独立列或索引引用它。

`GET /capabilities` 的 features 追加 `get-message-detail` / `update-message-contact-name`。
