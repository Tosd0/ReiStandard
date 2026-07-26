---
"@rei-standard/amsg-server": minor
---

fire 时刻的 hook 能往 client_state 写了：`ctx.writeState(namespace, entries)`

`onBeforeFire` / `onLLMOutput` / `executeToolCalls` 三处 ctx 上都有它，和已有的 `ctx.readState()` 配成一对。写口在后两处也给，是因为「这条内容太大、塞不进 push」往往到工具跑完、组 pushPayloads 时才知道，那时 `onBeforeFire` 早已返回。

```js
await ctx.writeState('bypass', [
  { key: 'note-42', value: JSON.stringify(detail) },  // 整条覆盖写
  { key: 'note-41', value: null },                    // 删掉这个 key
]);
// → { upserted, skipped, deleted }
```

- 落库走的是 `PUT /client-state` 那条路径的同一份实现：per-user key 加密、超过 200KB 自动分块、覆盖写清掉旧切片。所以 hook 写下的东西客户端 `GET /client-state` 能原样读回，反过来也一样。
- `updatedAt` 不给就取当前时刻，语义仍是 last-write-wins：比库里已有值旧的写入或删除不生效（记在 `skipped` 里），客户端后写的数据不会被这次 fire 盖回去。
- 限制与 HTTP 端点同一套：单条 `value` 默认 5MB（`maxStateValueBytes` 可调）、单次 ≤ 200 条、namespace / key 不能带控制字符。不合规当场抛 `TypeError` / `RangeError`，一条也不落库；适配器不支持 `client_state` 时抛 `AGENTIC_STATE_WRITE_UNSUPPORTED`（写不进去必须让 hook 知道，不能静默成功）。
- **谁清、什么时候清**：库不做 TTL 也不自动回收，写进去的东西一直在。旁路内容建议放在固定的少量 key 上，下次写同一个 key 直接覆盖；一次性的大内容在确认客户端取走后用 `{ key, value: null }` 删掉，切片行会跟着一起清干净。

适配器接口的 `upsertClientState` 第三参 `cleanups` 多认一种形态：`{ namespace, key, updatedAt }` 按精确 key 删（原来的 `{ namespace, keyPrefix, updatedAt }` 按前缀删不变）。删单条状态必须走精确匹配，否则 `note` 的删除会连带删掉 `notes`。D1 适配器已实现；自定义适配器不认这种形态的话 `writeState` 的删除会失效。

`GET /capabilities` 的 features 追加 `agentic-write-state`。
