---
"@rei-standard/amsg-server": minor
---

定时触发支持「同一分组的任务不并发」，投递失败的退避搬到自己的列上

同一个角色可能有好几条定时任务。撞在一起并发跑的话，用户一口气收到两条互不知情的消息；宿主在 fire hook 里维护的「我刚才说过什么」台账通常是读进内存 → 改 → 整份写回，两条各改各的再写回，后写的必然盖掉前面那条——有一句说过的话没记上账，下次角色会换个说法再讲一遍。宿主自己做的「每角色任务数上限」这类判定也一样，并发时各算各的，拦不住。

`runScheduledTick`（以及单用户 Worker 的 config）新增可选的 `serializeBy`：

```js
serializeBy: (task) => task.metadata?.charId ?? null
```

- 参数是与 `onBeforeFire` 的 `ctx.task` 同一份的只读任务视图（凭据已剔除）。返回什么算一组由宿主定义。
- 返回 `null` / 空串、或者不配这个函数 → 这条任务不参与串行，行为与不带该配置时完全一致。
- 同一分组同时只放行一条，**跨跳也算**：上一跳的 fire 还拿着租约时，下一跳捞到同组的另一条也不放行。一次 fire（组 prompt → 调 LLM → 跑工具 → 分段推送）常常跑十几秒到几分钟，只挡同一跳是不够的。
- 同一跳内同组放行的是**到点更早**的那条，跑完之后不补跑同组剩下的，留给下一跳（cron 一分钟就再来）。
- 被拦下的任务是**推迟不是丢弃**：`next_send_at` / `status` / `retry_count` 一个字段都不会被动，下一跳原样再捞一次。条数记在 tick 返回值的 `details.serializeSkippedTasks`（同一跳内拦下的）和 `details.claimSkippedTasks`（跨跳拦下的）里。
- `serializeBy` 自身抛错时这条任务这一跳不跑：分不清它属于哪一组，就不该冒着破坏宿主台账的风险跑下去。

分组判定和占位是同一条 `UPDATE`——先查「这一组忙不忙」再占位的话，两个 tick 的查询会双双在对方占位之前返回「不忙」。分组 key 不明文落库：库拿它和该用户的存储密钥做一次 HMAC，列里存的是那个派生值。

**退避与租约分两列**：`lease_until` 只表示「这条正在跑」，投递失败的退避时刻记在新的 `retry_after` 上，失败时租约当场放掉。挤在一列的话，一条正在退避、其实闲着的任务会被分组串行当成「这一组忙着」，同组别的任务白等一轮退避（最长 6 分钟）。捞取待发任务时两列都要看：租约没到期、或退避没到点，都不算待发。

**表结构**：`scheduled_messages` 新增两列 `retry_after`（SQLite `TEXT` / Postgres `timestamptz`）、`serialize_group`（SQLite `TEXT` / Postgres `VARCHAR(64)`），都可空；另加一个索引 `idx_serialize_group_lease`。`initSchema()`（包括 `POST /init-tenant`）会给已有的表补上，跑几次都没事。手工维护表结构的话，D1 执行 `ALTER TABLE scheduled_messages ADD COLUMN retry_after TEXT` 与 `ALTER TABLE scheduled_messages ADD COLUMN serialize_group TEXT`，Postgres 用对应的 `ADD COLUMN IF NOT EXISTS`；索引语句见 `examples/cloudflare-single-user/schema.sql`。**先升 worker 再让 cron 跑**：列不在时捞取语句会直接报错，整跳发不出去。

适配器接口的 `claimTask` 多一个可选的第四参数 `serializeGroup`，D1 / pg / neon 三个内置适配器都已实现；实现了它的适配器，`updateTaskById` 还要认 `retry_after`（含写 null）。自定义适配器忽略第四个参数的话，分组串行退化成只在同一跳内生效；完全不实现 `claimTask` 的同理。

`GET /capabilities` 的 features 追加 `tick-serialize-by`。
