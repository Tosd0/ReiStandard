---
"@rei-standard/amsg-server": minor
---

client_state 支持条件写护栏：entry 可带 `version` / `builtAt`，按内容新旧比较而不是请求先后

同一个 key 有多个写入方时（例如 fire_pack 由常规 flush 和 instant-chat 两条路径写），last-write-wins 按「谁的请求后到」判定就是在赌网络：慢网下晚到的旧包会把先到的新包盖掉，fire 端解出来的就是缺段的旧内容。

现在 `PUT /client-state` 的每个 entry 接受可选的 `version` 或 `builtAt`（正整数，毫秒时间戳或单调递增版本号，两个名字同一个语义）。带了它，这条的比较值就是它：旧内容（值更小）盖不掉新内容，直接被忽略。被拦下的 key 在响应的 `data.skippedEntries` 里逐条回报（`[{ namespace, key }]`），写入方能区分「写进去了」和「库里已有更新的数据」。hook 的 `ctx.writeState()` 的 entry 同样认 `version`。

没带 `version` 的写入行为不变（照旧按 `updatedAt` 比较）。特性位：`client-state-version-guard`。
