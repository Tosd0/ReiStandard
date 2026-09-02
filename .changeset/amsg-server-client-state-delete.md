---
"@rei-standard/amsg-server": minor
---

`PUT /client-state` 的 entry 认 `value: null`，表示删掉这个 key

hook 侧的 `ctx.writeState()` 一直可以用 `{ key, value: null }` 删掉一条状态；现在 HTTP 这一侧也是同一个语义：`PUT /client-state` 的 entry 传 `value: null`，服务端把这个 key 的行（含大值的切片行）删干净，`GET /client-state` 再也读不到它。客户端想清掉云端某条状态时直接删，不用再写一个空串留壳。

- 删除同样受 last-write-wins 约束：库里那行比这条的 `updatedAt`（或 `version`）新就不删，这个 key 进 `data.skippedEntries`，和覆盖写被拦下时一样。
- 响应多一个 `data.deleted`：这次删掉的条数（删一个本来就不存在的 key 也算成功）。没有删除条目的请求响应形状不变。
- `value` 是别的非字符串类型仍然按 `INVALID_STATE_VALUE` 逐条拒绝。
- 适配器接口 `upsertClientState()` 的返回多一个可选的 `cleanupOutcomes`，逐条报告精确 key 删除的结局（已不在 / 被拦下）；自定义适配器不回它时，删除一律按已删计。

特性位：`client-state-delete`。
