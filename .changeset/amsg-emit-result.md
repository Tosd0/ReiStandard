---
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-sw": minor
---

新增 `ctx.emitResult(payload)`：往客户端送一条不是聊天内容的结果

聊天正文之外的产出——整理好的一份数据、一条账目、后台生成的产物——之前只能宿主自己拼：`db.appendOutboxMessages` 加 `encryptForStorage` 手工组一行，落什么列、怎么加密全靠照着库里的实现抄，公开 API 拼得出来但无文档无测试。现在收编成正式能力。

**server**：fire 级 `fireCtx`、每轮 `sessionCtx`，以及 config 级的 `onAfterSend` / `onFireSettled` / `onStaleSkip` 载荷上都挂着 `emitResult(payload)`，与 `readState` / `writeState` 同待遇。一条结果走两条路——落进 `message_outbox`（到达：客户端下次 `GET /outbox?since=` 一定拿得到，推送没送到、内容超过一条推送 4KB 上限都不会让它丢），同时发一条 Web Push（及时：跑完当场弹一下叫人回来看）。客户端因此不必为每种结果各写一套轮询。

```js
const { messageId, pushed } = await ctx.emitResult({
  resultKind: 'fire-pack',   // 必填：这类结果的名字，客户端按它分流
  packId: 'pack_42',         // 以下随便加，形状由宿主定
  notification: { title: '整理好了', body: '点开看看' },
});
```

- 落行失败会抛（收件箱是到达的保证）；适配器没有 `message_outbox` 时抛 `OUTBOX_UNSUPPORTED`。推送发不出去只记日志、返回 `pushed: false`——行还在收件箱等补收，不算失败。
- 结果行带 `task_uuid`，取消 / 顶替这条任务时**还没送到**的结果跟聊天分段一起撤；已推到设备上的留着让客户端照常 ack。
- `messageId` 缺省值掺了任务 id 与本次名义触发时刻，同一次触发重跑时不会补出第二条。

**shared**：`messageKind` 新增第五种 `'result'`（`MESSAGE_KIND.RESULT`、`ResultPush`、`buildResultPush`、`isResultPush`）。`buildResultPush` 是唯一保留自己不认识的字段的 builder——结果的形状由宿主定，白名单式的复制会把内容删掉一半。

**sw**：`messageKind: 'result'` 派发 `REI_SW_EVENT.RESULT_RECEIVED`，并且**默认弹通知**（与 `content` 同待遇，其余三种仍是静默送给页面）——结果往往正是「跑完了，回来看看」那句话。标题正文照旧在 `payload.notification` 里自定义，不想弹就 `notification: { show: false }`。

特性位：`emit-result`。
