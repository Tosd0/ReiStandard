---
"@rei-standard/amsg-server": major
---

`messageType: 'instant'` 改为落库即回，投递在后台跑；单用户 Worker 自带 Durable Object 起跳器

**这是一处代码与文档不符的修正，建议所有用 instant 的部署迁移。**

文档对 instant 的描述一直是「任务先落库再处理，投递不绑在请求连接上，客户端断开也没关系」。旧版代码并没有做到：它在请求里同步生成、推送完才响应，客户端必须挂着连接等。在 Cloudflare Worker 上，客户端一断开，请求里没做完的生成就会被取消，只能等 cron 从头再跑一遍；生成慢的时候，请求和 cron 还可能把同一条各发一遍。旧版本的实际行为跟文档对不上，所以这次按文档描述的语义修正。因为响应形状变了，版本号按破坏性变更走 major。

**1. instant 不再在请求里同步投递**

`POST /schedule-message` 收到 instant 任务后，落库就返回 `202`，生成和推送在后台跑，客户端交完就可以断开。

| | 以前 | 现在 |
|---|---|---|
| 响应 | 发完才回 `200`，带 `messagesSent` / `sentAt` / `retriesUsed` / `reasoningError`；失败回 `500 MESSAGE_SEND_FAILED` | 落库就回 `202`，`data` 与定时任务的 `201` 同形状（`id` / `uuid` / `nextSendAt` / `status: 'pending'` …），另带 `dispatch` |
| 客户端要不要挂着连接 | 要，断开后请求里没做完的生成会被取消 | 不用 |
| 和 cron 的关系 | 请求里那次不占租约，生成慢时可能和 cron 各发一遍 | 两边抢同一份租约，只发一次 |
| `firstSendTime` | 必填且在未来 | 可省（服务端取当前时刻），传了只查格式 |
| 投递链 | 请求内单独的三轮重试 | 与定时任务同一条：占位、租约心跳、失败退避（`maxDeliveryRetries`）、fire-time hook、收件箱；`onBeforeFire` 的 `{ defer }` 也能用 |
| 结果怎么拿 | 响应体 | 推送 + `GET /outbox?since=`；思考过程没送到的记在 tick 汇总的 `details.reasoningSkippedTasks` |
| 失败怎么知道 | `500 MESSAGE_SEND_FAILED` | `GET /message?id=`（等重试时 `task.lastError` 有值，终态失败回 `409` 带 `error.details.lastError`），或在 `onFireSettled` 里用 `emitResult` 送一条结果 |
| 配置不全 | VAPID 缺了回 `500 VAPID_CONFIG_ERROR` | 同上，`webpush` 缺了也在建行前报这个码 |

`dispatch` 取值：`kicked`（起跳器已叫醒）、`not_configured`（没配起跳器）、`kick_failed`（叫醒失败）。后两种都等下一跳 cron，不算失败。

`GET /capabilities` 的 `features` 多一项 `instant-background`，客户端据此判断 worker 是不是新行为。

**2. 单用户 Worker 的起跳器**

`createSingleUserCloudflareWorker` 返回值多一个 `InstantTick`（Durable Object 类）。在 wrangler 里加 binding 和 migration，入口导出它即可：

```toml
[[durable_objects.bindings]]
name = "AMSG_INSTANT_TICK"
class_name = "AmsgInstantTick"

[[migrations]]
tag = "amsg-instant-tick-v1"
new_sqlite_classes = ["AmsgInstantTick"]
```

```js
const worker = createSingleUserCloudflareWorker(buildConfig);
export default worker;
export const AmsgInstantTick = worker.InstantTick;
```

一条任务一个实例，在 alarm 里跑 `runTask`，每次有 15 分钟预算，几条 instant 同时来互不排队；和 cron 抢同一份租约，不会重复发。namespace 随 Worker 上传创建，API token 不用多勾权限。binding 名可用工厂第二个参数 `instantTickBinding` 改；没有这个 binding 时 instant 等下一跳 cron。另导出 `INSTANT_TICK_BINDING`、`kickInstantTick(namespace, uuid)`。

**3. 其他运行时**

`createSingleUserServer` / `createReiServer` 的 config 认 `dispatchInstant({ uuid, userId, tenantId, run })`，instant 落库后调一次。`run()` 跑这一条任务（库和密钥已绑好），宿主把它交给不挂在请求上的执行者去调；回调本身会被等待，别把 `run()` 的 promise 返回出来。不配就等下一次 cron（多租户线是下一次 `/send-notifications`）。

**升级要做的事**

- 依赖 instant 同步响应字段（`messagesSent`、`reasoningError` 等）或 `500 MESSAGE_SEND_FAILED` 的调用方，改成看 `202` + `dispatch`，结果从推送 / 收件箱拿。
- 单用户 Worker 想让 instant 立刻开跑，按上面加 Durable Object 配置；不加也能用，只是要等 cron。
