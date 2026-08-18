# @rei-standard/amsg-sw

`@rei-standard/amsg-sw` 是 ReiStandard 主动消息标准的 Service Worker 插件包，负责推送展示和离线重试，装上就能用。


## v2.1.0 — 按 kind 分发的客户端事件

2.1.0 跟随 `@rei-standard/amsg-shared` 的三轴 push schema：每条 push 现在通过 `payload.messageKind`（`content` / `reasoning` / `tool_request` / `error` / `result`）区分内容类型。SW 在收到 push 后会做两件事：

1. **永远** 通过 `postMessage` 把 payload 广播给所有受控窗口（包括 `includeUncontrolled: true` 的未受控窗口）。
2. **仅当** `messageKind === 'content'` / `'result'`，或 payload 没有 `messageKind`（2.0.x 老 payload 的回退路径）时，才调用 `showNotification`。`reasoning` / `tool_request` / `error` 三种 kind 一律不弹通知——业务在 app 内通过 postMessage 通道自行渲染。

> 「收到 push 但不弹通知」在各家浏览器那里都是要记账的，iOS 尤其严。取舍见下面的[不展示通知的代价](#不展示通知的代价)。

### 新增导出 `REI_SW_EVENT`

事件名由 SW 在每次广播时打在 `e.data.event` 上：

| 常量 | 字符串值 | 触发条件 |
|------|---------|---------|
| `REI_SW_EVENT.CONTENT_RECEIVED`      | `'rei-amsg-content-received'`      | `payload.messageKind === 'content'` |
| `REI_SW_EVENT.REASONING_RECEIVED`    | `'rei-amsg-reasoning-received'`    | `payload.messageKind === 'reasoning'` |
| `REI_SW_EVENT.TOOL_REQUEST_RECEIVED` | `'rei-amsg-tool-request-received'` | `payload.messageKind === 'tool_request'` |
| `REI_SW_EVENT.ERROR_RECEIVED`        | `'rei-amsg-error-received'`        | `payload.messageKind === 'error'` |
| `REI_SW_EVENT.RESULT_RECEIVED`       | `'rei-amsg-result-received'`       | `payload.messageKind === 'result'`（宿主自定义的结果） |
| `REI_SW_EVENT.MULTIPART_EXPIRED`     | `'rei-amsg-multipart-expired'`     | `_multipart` 分片拼不起来（`payload.reason` 说明是哪种） |
| `REI_SW_EVENT.UNKNOWN_RECEIVED`      | `'rei-amsg-unknown-received'`      | 缺 `messageKind`（2.0.x 老 payload / blob envelope） |

### 客户端订阅示例

页面侧请从 `@rei-standard/amsg-shared` import 这些常量（本包只是 re-export 同一份）：从本包 import 会执行 SW 模块的顶层状态，在窗口环境里并不合适。

```js
import { REI_AMSG_POSTMESSAGE_TYPE, REI_SW_EVENT } from '@rei-standard/amsg-shared';

navigator.serviceWorker.addEventListener('message', (e) => {
  if (e.data?.type !== REI_AMSG_POSTMESSAGE_TYPE) return;
  switch (e.data.event) {
    case REI_SW_EVENT.CONTENT_RECEIVED:      /* 渲染 app 内消息 */ break;
    case REI_SW_EVENT.REASONING_RECEIVED:    /* 渲染思考中 UI */ break;
    case REI_SW_EVENT.TOOL_REQUEST_RECEIVED: /* 弹出工具执行确认 */ break;
    case REI_SW_EVENT.ERROR_RECEIVED:        /* 显示错误 toast */ break;
    case REI_SW_EVENT.RESULT_RECEIVED:       /* 宿主自定义结果，页面自己消化 */ break;
    case REI_SW_EVENT.MULTIPART_EXPIRED:     /* 观测 transport 缺片 */ break;
    case REI_SW_EVENT.UNKNOWN_RECEIVED:      /* 2.0.x 老 payload 的兼容路径 */ break;
  }
});
```

### 通知显示策略 (Notification Rendering)

默认情况下：
- `content`、`result` 和老式 payload：自动弹系统通知。
- `reasoning` / `tool_request` / `error`：不弹通知，只触发 client 事件。

通过 `payload.notification.show`，你可以显式覆盖这个默认行为。此字段由服务端或产生 payload 时指定：

| 值 | 行为 |
|---|---|
| `"auto"` 或不传 | 保持上面的默认 |
| `"always"` | 强制弹系统通知，无视 `messageKind` |
| `false` | 强制不弹，即使是 `content`，也不看应用在不在前台。事件照常派发给页面和 `onBusinessPayload` |
| `"when-hidden"` | 仅当没有 `visibilityState === "visible"` 的客户端时才弹。兼容档，新代码不选（理由见[下面那节](#不展示通知的代价)） |

> **`false` 在发送端和接收端不是同一件事。** 有服务端收件箱的发送端（`@rei-standard/amsg-server` 单用户线）看到 `show: false` 就**根本不发这条 push**，只落收件箱等客户端上线补拉——SW 这边压根收不到它。没有收件箱的发送端（`@rei-standard/amsg-instant`、自己拼的 worker）才是「推过去、SW 不弹」，那种情况下用户可能什么反馈都收不到，代价见下面那节。
>
> 想要「立刻推到、但页面自己渲染」没有专门的档：用 `"always"` + `tag` 折叠 + `silent: true`，通知栏里只留一条且不响铃，页面自绘照做。

当设置了弹通知时，通知文案完全由 `payload.notification` 决定（支持 `title`, `body`, `icon`, `badge`, `tag`, `renotify`, `requireInteraction`, `silent`, `data` 等字段）。如果缺省，会后备到 payload 根级属性。

`silent` 管的是「响不响铃、震不震」，弹不弹还是 `show` 说了算。除了 `true` / `false`，它还认一个 `"when-visible"`：

| 值 | 行为 |
|---|---|
| 不配 / `false` | 正常响铃震动 |
| `true` | 一律不响 |
| `"when-visible"` | 有 `visibilityState === "visible"` 的客户端就静音，没有就照常响 |

`"when-visible"` 是给「页面自己会把内容画出来」的那类消息准备的：用户正盯着页面时通知安静地躺进通知中心，人切后台或锁屏了照样响。它跟 `show: "when-hidden"` 一样只有 SW 当场算得出来——发送端发推那一刻并不知道用户在不在前台，写死 `silent: true` 的话切到后台也不会响。两者读的是同一份窗口可见性，一条 payload 只算一次。

正文一路取下来是空的（或只有空白字符）时，SW 用兜底文案顶上，默认 `New message`，`installReiSW(self, { defaultBody })` 可以换成自己的。这里不能改成「干脆不弹」：订阅是按 `userVisibleOnly: true` 建的，每条 push 都欠用户一次可见反馈，代价见下面那节。弹一条只有标题、正文空白的横幅同样不行——用户在锁屏上看到一条什么都没有的消息、未读 +1，点进去也是空的。

#### 不展示通知的代价

订阅是按 `userVisibleOnly: true` 建的——那是跟浏览器约好「每条 push 都会给用户可见反馈」。收到 push 却不弹通知就是违约，各家的处理不一样：

| 浏览器 | 违约之后 |
|--------|---------|
| Chrome | 替你弹一条通用的「此网站在后台更新了内容」，订阅保住 |
| Firefox | 对不展示通知的 push 有配额，超了直接把这个订阅退掉，得等用户再访问站点才恢复 |
| iOS | 新订阅有几天宽限期，宽限期一过，一条就够，直接吊销订阅 |

**iOS 的宽限期**跟直觉不太一样，实测下来是这样的：

- 订阅刚建好的那几天，发多少条不弹通知的 push 都不会掉订阅——**跟条数无关，只跟订阅建了多久有关**。
- 过了宽限期，再来一条不弹的就立刻吊销。
- 吊销后重新订阅，判定比第一次更严，之后随时可能再掉。

最难查的就是这个时间差：本地订阅完立刻测一轮，怎么试都正常；上线几天后用户的订阅开始成片掉。而且掉订阅是静默发生的——服务端只看到推送返回 410，用户只觉得「怎么不推了」，两头都不容易对上是哪条 push 惹的。

所以口径只有一条，跟机型无关：**要推就一定弹，不想弹就别推。**

- 要推 → `notification: { show: 'always' }`。嫌打扰就用 `tag` 折叠（同 `tag` 的通知互相覆盖，通知栏里只留一条）加 `silent`（不响铃不震动），而不是不弹。只在用户看着页面时想安静的，`silent` 配 `'when-visible'`。弹了通知不影响页面自绘，`postMessage` 照样派发。
- 不想弹 → 压根别把它发成 push，落服务端收件箱，等客户端上线补拉。

`"when-hidden"` 卡在这两条中间：规范允许 user agent 在有可见窗口时免掉展示约束，Chrome 认这条豁免，iOS 不认——应用在前台时它就是一条不弹的 push，那笔账照记。它是给老部署留的兼容档，新代码不选。

同一笔账也记在默认行为上：`reasoning` / `tool_request` / `error` 默认不弹通知，它们每到一条就是一次不展示的 push。所以发送端最好压根别把它们发成 push——`@rei-standard/amsg-server` 就是这么做的：这几种只落收件箱，客户端上线 `GET /outbox?since=` 补拉，内容一个字不少（见它 README 的「哪些 payload 会发推送」一节）。想让某一条照样弹，给它带上 `notification: { show: 'always' }`，发送端据此判定这条值得占用推送通道。

更一般地说，想让后台产生的副作用到达客户端，比起发一条不弹的 push，让客户端上线时主动拉一次总是更靠得住：push 本来就是通知通道，订阅失效、离线、平台限流都会让它丢，不适合当唯一的数据同步手段。

#### 场景示例

**1. tool_request 需要用户当场处理**
某些 Agent loop 跑到 `tool_request` 时要用户在界面上确认或执行，等不到下次上线补拉。给它显式配上 `show`，发送端据此判定这条值得占用推送通道：

```json
{
  "messageKind": "tool_request",
  "sessionId": "...",
  "toolCalls": [],
  "notification": {
    "show": "always",
    "tag": "rei-tool-request",
    "silent": true,
    "title": "需要继续处理",
    "body": "点开应用继续完成工具调用"
  }
}
```

`tag` 让连着来的几条工具请求在通知栏里只占一格，`silent: true` 不响铃不震动。不配 `show` 的 `tool_request` 默认不弹，有收件箱的发送端也就不会推它——内容留在收件箱里等补拉。

**2. Content 消息在前台由页面自绘**
应用层想在页面前台做定制 Toast，同时页面不在前台时也要让用户看到：

```json
{
  "messageKind": "content",
  "message": "...",
  "notification": {
    "show": "always",
    "tag": "rei-chat",
    "silent": "when-visible"
  }
}
```

页面自绘照做——`postMessage` 跟弹不弹通知无关，前台照样能收到事件去渲染 Toast。系统通知那条被同 `tag` 的下一条覆盖掉，通知栏里始终只有一条，用户不会被刷屏。前台那条通知看着重复，代价却比「前台静默」小得多，理由见上一节。

`silent: "when-visible"` 让这条通知在用户盯着页面时安静地进通知中心（页面已经把消息画出来了，再响一声是纯打扰），人切后台或锁屏时照常响铃震动。想不管前后台一律安静就写 `silent: true`。

> **注意：对于 multipart 传输**
> 当 payload 通过 `_multipart` 分片时，未收齐前不仅不派发业务事件，也**绝不**弹系统通知。收齐并还原为原始 payload 后，再按原始 payload 的 `notification.show` 策略执行判定。

### Delivery dedupe（通知前去重）

`installReiSW()` 默认启用包级 dedupe。所有业务 payload 不管来自 Web Push、multipart 还原、blob envelope，还是页面通过 `postMessage` 桥接进 SW，都会先经过同一个 gate：

```
dedupe -> notification.show 策略 -> showNotification / postMessage / onBusinessPayload
```

第一次到达的 payload 会正常走 `notification.show` 策略、窗口广播和 `onBusinessPayload`。重复 payload **不会**再次广播，也**不会**再次调用 `onBusinessPayload`；如果第一次到达时因为前台可见等原因没有展示系统通知，而后到的 Web Push backup 已经满足 `notification.show` 条件，SW 会只补一次系统通知，然后把结果放进 `onDuplicate(info)`。这层去重发生在业务落地前面，不依赖业务层 inbox 自己兜底。

默认 key 按顺序读取：

1. `payload.messageId`
2. `payload.id`
3. `payload.dedupeKey`

没有 key 时不去重，保持旧 payload 兼容。multipart 会先还原成原始 payload 再取 key；blob envelope 如果携带 `messageId` / `id` / `dedupeKey`，也会被同一套 gate 覆盖。

```js
installReiSW(self, {
  dedupe: {
    enabled: true,              // 默认 true
    ttlMs: 10 * 60_000,         // 默认 10 分钟
    dbName: 'rei_amsg_sw_dedupe_v1', // 想隔离另一套去重数据就改这个；每个 dbName 是独立 IDB instance
    key: (payload) => payload.messageId,
  },
  onDuplicate: async (info) => {
    // { key, source, messageKind, firstSeenAt, existingSource,
    //   existingMessageKind, existingNotificationShown, duplicateNotificationShown }
  },
});
```

实现使用 IndexedDB 的 `add()` + keyPath 做原子 claim：第一次 add 成功才放行；几乎同时到达的同 key payload，后到者会命中 `ConstraintError` 并作为 duplicate 返回。TTL 清理是懒清理，不需要 KV / D1 / Durable Object。

### 页面 -> SW 业务投递

SSE 默认先进页面主线程。若要让 SSE payload 和 Web Push backup 共用 SW 的 dedupe / notification / `onBusinessPayload` 管线，页面可以把 payload 转交给 SW：

```js
import { REI_SW_MESSAGE_TYPE } from '@rei-standard/amsg-shared';

const registration = await navigator.serviceWorker.ready;
const channel = new MessageChannel();

channel.port1.onmessage = (event) => {
  // 成功：{ ok: true, duplicate?: boolean, key?: string, requestId?: string,
  //        businessError?: string, dedupeError?: string, notificationError?: string }
  // 失败：{ ok: false, error: string, key?: string, requestId?: string }
};

registration.active?.postMessage({
  type: REI_SW_MESSAGE_TYPE.DELIVER,
  source: 'sse',
  requestId: crypto.randomUUID(),
  payload,
}, [channel.port2]);
```

Web Push `push` event 和 `REI_AMSG_DELIVER` 最终都会进入同一个内部 pipeline。SSE 先到时，后来的 Web Push backup 会被 dedupe；Web Push 先到时，后来的 SSE bridge 也会被 dedupe。若首包已经落过业务但没弹通知，重复包只负责按当前 `notification.show` 策略补通知，不会重复触发业务回调。

#### ack 的 `ok` 表示「已收下并分发」，不表示「业务已落库」

DELIVER ack 的 `ok: true` 只代表 SW 收下了 payload 并完成了分发（窗口广播 + 通知策略），**不代表** `onBusinessPayload` 已经成功落库。如果业务回调 reject 或抛错，ack 仍然是 `ok: true`，但会带上一个可选的 `businessError` 字段（业务回调失败时填 `error.message`，成功时不出现这个字段）：

```js
channel.port1.onmessage = (event) => {
  const { ok, duplicate, businessError } = event.data;
  if (ok && businessError) {
    // payload 已分发，但消费方落库失败 —— 由你决定是否重试 / 上报
  }
};
```

这样设计是为了向后兼容：`ok` 的含义保持不变，原本只看 `ok` 的调用方不受影响；需要严格区分「传输成功」和「业务落库成功」的调用方读 `businessError` 即可。webpush `push` 路径没有 ack，业务回调失败只会在 SW 内部 `console.error`，不会让投递 promise reject。

同一套口径下还有两个可选字段，`ok` 一样保持 `true`：

- `notificationError`：通知没弹出来（权限被撤、系统配额、OS 错误）。payload 收下了也分发了，但用户没被提醒——把 `deliver()` 当备份通道用的发送端靠它判断是回退还是重试。首投和重复包补通知两条路都带。
- `dedupeError`：去重仓库读写失败，这条 payload 是绕过去重直接投递的。分发本身成功了，但这次没有去重保护，同一条消息的另一路 backup 可能会再投一次。

`businessError` 会持久化到 dedupe 记录上，并且是 duplicate 自愈的开关：记录上带着 `businessError` 时，之后**同 key 的重复包**（发送方重试、或另一条 transport 的 backup）到达会重跑一次 `onBusinessPayload`——重跑成功就清掉记录上的 `businessError`（本次 ack 不带该字段，之后的重复包恢复纯去重），重跑仍失败则用新的失败信息更新记录、照旧在 ack 上报。业务成功过的记录不受影响：重复包永不重跑业务，只按当前 `notification.show` 策略决定要不要补通知。

#### 在 SW 内执行 tool_request 的安全边界

`onBusinessPayload` 里直接执行 `tool_request`（在 SW 里跑工具、回结果）是支持的常见用法。这里要理解清楚去重提供的保证和它的边界：

- **正常情况下不会重复执行**：dedupe 是「先占坑、再跑业务」，所以同一个 `messageId` 在 TTL 窗口内（默认 10 分钟）只要 `onBusinessPayload` 成功过一次，就**不会再被调用**。SSE + Web Push backup 双路送达、push 服务重投递，重复的那些都会在跑业务之前被挡掉。换句话说，**dedupe 本身就是你的「执行一次」闸门**，普通场景你不需要再自己记账本。
- **边界一：TTL**。这个「只执行一次」只保 TTL 那段时间。极少数超过 TTL 才发生的重投递会被当成新消息、重新执行。绝大多数重投递都在秒级~分钟级，10 分钟够用；要更死的保证就自己按 `id` 记一张永久「执行账本」。
- **边界二：首投失败会重跑**。`onBusinessPayload` 失败时，失败信息记在 dedupe 记录的 `businessError` 上——之后同 key 的重复包到达会**重跑一次**业务回调，成功即清除、之后恢复纯去重（详见上方 `businessError` 一节）。所以：

  - 如果你的工具有**真实副作用**（发邮件、下单、转账、加未读数、播声音……），要按「失败后可能再跑一次」来写：工具执行成功、但回调在收尾处（落库之后）抛了错，重复包重跑就会让副作用发生第二次。给这类工具备一张幂等「执行账本」（执行前查 `id` 是否已执行），或保证回调里「副作用完成 = 回调成功」不留尾巴。
  - 如果你的业务回调是**纯幂等**（只按 `messageId` 覆盖写、工具可安全重跑），那重跑无害，失败自愈白拿。

> 一句话：**在 SW 里执行 tool_request，业务成功过就不会重复执行**；首投失败时 duplicate 会重跑一次来自愈，所以有真实副作用的工具要按幂等来写。

### 生产推荐链路：Web Push + 上线补拉 + SW dedupe

一条内容到达客户端有两条腿，责任分开：**服务端收件箱管到达，Web Push 管及时性。**

| 环节 | 包配置 / 调用 | 责任 |
|------|---------------|------|
| 服务端收件箱 | `@rei-standard/amsg-server` 单用户线自动做 | 每条 payload 发出去之前先落一行 `message_outbox` |
| Web Push | 只发「到了客户端会弹通知」的那些 | 当场把用户叫回来。不会弹的（思考过程、工具请求、错误）不占推送通道 |
| SW 侧 | `installReiSW(self, { onBusinessPayload })` | 落业务、按 `notification.show` 弹通知、包级 dedupe |
| 客户端上线 | `client.getOutbox()` → 处理 → `client.ackOutbox()` | 补齐没推送的和推送没送到的，一条不少 |
| 通知策略 | `payload.notification.show` / `.silent` | 要推的一律 `'always'` + `tag` 折叠 + `silent`（页面自绘的那类用 `'when-visible'`，前台安静后台照响）；不想弹的别推，走收件箱（见[上一节](#不展示通知的代价)） |

一个最小形态：

```js
installReiSW(self, {
  defaultIcon: './icons/icon-192.png',
  defaultBadge: './icons/icon-192.png',
  multipart: { enabled: true },
  onBusinessPayload: async (payload) => persistIncomingPayload(payload),
  onDuplicate: async (info) => traceDuplicate(info),
});
```

页面那侧的补拉写法见 [`@rei-standard/amsg-client` README 的「上线补一次收件箱」](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md#上线补一次收件箱)。补拉的 payload 想跟 push 那条路共用同一份落地逻辑和去重，用下面的[页面 -> SW 业务投递](#页面---sw-业务投递)桥进来。

`@rei-standard/amsg-instant` 的 SSE + always-on Web Push backup 双通道现在是维护态：它没有服务端收件箱，push 漏掉的内容补不回来。已经在用的部署照常工作——SW 这边的 dedupe 对 SSE bridge 和 Web Push 一视同仁，收到 SSE 后立刻 `postMessage` 桥进 SW 即可（见下面那节）。

### Blob envelope

当 `amsg-instant` 检测到 payload 超过 `maxInlineBytes` 时会改发 blob envelope `{ _blob: true, key, url, messageKind?, type?, messageId?, id?, dedupeKey? }`。SW **不会** 自动 fetch blob 内容（那是 client 的职责），但仍然会按 envelope 上的 `messageKind` 分发对应事件，让 client 知道有什么类型的内容即将到达，自己决定要不要拉取。Blob envelope 也只在 `messageKind === 'content'`（或缺失）时才渲染占位通知，与普通 push 行为一致。

### Generic multipart transport（2.1.0+）

2.1.0 移除了旧 reasoning 专用 `chunkIndex` / `totalChunks` wire format。现在 `_multipart` 是统一 transport kind，任何原始 payload 都可以被包起来：

```json
{
  "messageKind": "_multipart",
  "multipart": {
    "version": 1,
    "id": "mp_<uuid>",
    "index": 1,
    "total": 4,
    "encoding": "json-utf8-base64url",
    "originalMessageKind": "reasoning",
    "createdAt": 1710000000000,
    "ttlMs": 60000
  },
  "chunk": "base64url..."
}
```

SW 收到 `_multipart` 后会先写 IndexedDB，支持乱序、重复分片和 SW 重启恢复。未收齐时不 `postMessage`、不 `showNotification`。收齐后按 `index` 拼回原始 JSON payload，删除 pending，写短期 done 标记避免推送服务重投递造成二次业务事件，然后递归走普通 `messageKind` 分发。

配置：

```js
installReiSW(self, {
  defaultIcon: '/icon-192x192.png',
  defaultBadge: '/badge-72x72.png',
  defaultBody: 'New message',   // payload 正文为空时顶上的文案
  multipart: {
    enabled: true,
    ttlMs: 60_000,
    maxTotalBytes: 256_000,
    maxChunks: 128,
    cleanupIntervalMs: 15 * 60_000
  },
  // （新增于 2.1.0）离线持久化等业务拦截钩子：
  onBusinessPayload: async (payload) => {
    // 收到完整 payload 时触发，由于内置在 event.waitUntil 中，能够确保离线写库完毕再允许 SW 休眠
    // await db.saveIncomingMessage(payload);
  }
});
```

一条 multipart 拼不起来时（等到 TTL 也没收齐，或者当场就判废了），SW 会清理
pending 并广播：

```js
{
  type: 'REI_AMSG_PUSH',
  event: 'rei-amsg-multipart-expired',
  payload: { id, received, total, originalMessageKind, reason }
}
```

`reason` 说明是哪条路走到这一步的，取值从 `MULTIPART_FAILURE_REASON` 里来
（和其他常量一样，页面侧请从 `@rei-standard/amsg-shared` import）：

| 取值 | 什么情况 |
|------|---------|
| `'ttl-expired'`         | TTL 到期仍未收齐，或收到的分片本身已经过期 |
| `'invalid-chunk'`       | 分片信封不合规：version / encoding 对不上、index 越界、chunk 不是合法 base64url |
| `'chunk-conflict'`      | 同一个 id 的分片报了不一样的 total / encoding，已收的部分拼不回去 |
| `'size-limit-exceeded'` | 累计字节数超过 `multipart.maxTotalBytes` |
| `'restore-failed'`      | 收齐了但拼不回原 payload |
| `'storage-failed'`      | 分片仓库（IndexedDB）读写失败 |
| `'disabled'`            | 本地把 multipart 关了（`multipart.enabled === false`），分片没法重组 |

`'ttl-expired'` 之外的几种通常意味着发送端或链路有问题，值得报上去。同一条
信息也会打进 `console.error`。

一条 multipart 消息只会报一次收不了。分片是一起发出来的，逐片报的话页面会为
同一条消息收到几十条一模一样的事件。

报出去的结论就是最终结论：这条 id 之后的分片一律不再收，包括推送服务对失败那
片的重投。`'storage-failed'` 这种一阵子就好的故障也照此办理——不然剩下的分片
会把这条消息照常拼齐投递出去，而页面上那句「收不到」已经没有任何事件能撤掉了。

重组窗口从**本地收到第一片**起算（长度取发送端标的 `ttlMs` 与本地
`multipart.ttlMs` 里更紧的那个）。窗口过完之后才到的分片，会连同这条 id 已落
库的分片一起清掉，之后同 id 的分片静默丢弃——留着旧分片的话，新窗口的计数从零
重来，而旧分片会被「这一片已经有了」挡在门外，这条 id 再也收不齐。

业务应用只订阅普通事件即可。`content` multipart 收齐后照常弹通知；`reasoning` / `tool_request` / `error` 仍默认不弹通知（代价见「不展示通知的代价」一节）。

### IndexedDB 连接韧性（2.3.0+）

dedupe 库、queue / multipart 库都把 IndexedDB 连接缓存复用。浏览器底层可能在存储压力、backing store 出错、用户清数据等情况下**强制关闭**这些连接——这种强关只触发 `close` 事件，不触发 `versionchange`。2.3.0 之前缓存里的死连接会被无限复用，之后每次事务都抛 `InvalidStateError`，导致去重失灵、push 落库被阻断、`dedupe cleanup failed` 刷屏，且不重启 SW 不会自愈。

2.3.0 起包内做了两层兜底，无需业务侧改动：

- **`onclose` 清缓存**：连接被强关时把它从缓存里剔除，下次访问自动重开。
- **事务级一次重开**：因为 `close` 事件可能晚于下一次事务调用、而 `db.transaction()` 是同步抛错，所以发事务时若命中「连接 closing/closed」，会清缓存、重开一次、重试一次；第二次仍失败才如实抛出（重试上限 1 次，不会无限循环）。

### 升级注意事项

- 想给 `reasoning` / `tool_request` / `error` 弹通知的业务：SW 默认不再为它们弹通知，设置 `payload.notification.show = "always"` 就能让 SW 在包层直接弹，无需再强求在 app 内自绘。有服务端收件箱的发送端也认同一份判定——不配 `show` 的这三种它压根不推，内容走收件箱补拉，取舍见「不展示通知的代价」一节。
- 应用级 SW 可以删除旧 reasoning `chunkIndex` / `totalChunks` 拼接逻辑；2.1.0+ 版本只会把完整还原后的 reasoning payload 发给 client。
- 客户端代码继续兼容只有 `installReiSW` + `REI_SW_MESSAGE_TYPE`（队列）的 2.0.x 写法——新增导出不破坏既有 API。
- 想拿到 push 类型相关的 TS 类型：从 `@rei-standard/amsg-shared` 引 `AmsgPush` 等类型（本包通过 JSDoc 引用同一份类型）。

## 功能概览

- 处理 `push` 事件：按 `messageKind` 分发到客户端 + 仅 `content` 走 `showNotification`
- 透明重组 `_multipart` transport：应用层只收到完整原始 payload
- 处理 `message` 事件：支持离线请求入队与主动冲刷队列
- 处理 `sync` 事件：在网络恢复后自动重试队列请求
- 使用 IndexedDB 存储待发送请求，避免页面关闭后丢失
- IndexedDB 连接被浏览器强制关闭后自愈（`onclose` 清缓存 + 事务级一次重开），无需重启 SW

> 注意：插件默认**不内置** `notificationclick` 逻辑，点击跳转策略由业务自行实现。

## 安装

```bash
npm install @rei-standard/amsg-sw
```

## 快速使用

```js
import { installReiSW } from '@rei-standard/amsg-sw';

installReiSW(self, {
  defaultIcon: '/icon-192x192.png',
  defaultBadge: '/badge-72x72.png',
  multipart: { enabled: true },
  onBusinessPayload: async (payload) => {
    // 这里可安全地进行应用级别的离线数据库存储
  }
});

// 业务侧自行实现点击跳转
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});
```

离线入队（可选）：

```js
// 页面侧从 shared import（本包 re-export 的是同一份常量；
// import 本包会执行 SW 模块顶层状态，窗口环境里不合适）
import { REI_SW_MESSAGE_TYPE } from '@rei-standard/amsg-shared';

export async function enqueueRequestToSW(requestPayload) {
  const registration = await navigator.serviceWorker.ready;
  if (!registration.active) {
    throw new Error('No active service worker');
  }

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => {
      const result = event.data || {};
      if (result.ok) {
        resolve(result);
      } else {
        reject(new Error(result.error || 'Queue request failed'));
      }
    };

    registration.active.postMessage(
      {
        type: REI_SW_MESSAGE_TYPE.ENQUEUE_REQUEST,
        request: requestPayload
      },
      [channel.port2]
    );
  });
}
```

## 消息协议

- `REI_SW_MESSAGE_TYPE.ENQUEUE_REQUEST`：添加请求到 outbox，并立即尝试发送
- `REI_SW_MESSAGE_TYPE.FLUSH_QUEUE`：主动触发一次队列发送
- `REI_SW_MESSAGE_TYPE.QUEUE_RESULT`：SW 返回入队结果（`ok` / `error` / `queueId`）。点对点，一次入队一条
- `REI_SW_MESSAGE_TYPE.QUEUE_DROPPED`：某条队列请求被服务端永久拒绝（4xx）、已从队列删掉。广播给所有窗口，带 `queueId` / `status` / `error` / `request: { url, method }`

`QUEUE_DROPPED` 单独占一个 type，是因为它跟 `QUEUE_RESULT` 的收信人不是一回事：它是广播，可能来自后台 `sync` 冲刷、说的也可能是另一条早就排在队列里的旧请求。页面等自己那条入队回执时，不会被它打岔。

`request` 结构示例：

```json
{
  "url": "/api/v1/schedule-message",
  "method": "POST",
  "headers": {
    "content-type": "application/json",
    "x-user-id": "550e8400-e29b-41d4-a716-446655440000",
    "x-payload-encrypted": "true",
    "x-encryption-version": "1"
  },
  "body": {
    "iv": "...",
    "authTag": "...",
    "encryptedData": "..."
  }
}
```

## 导出 API（Exports）

- `installReiSW`
- `REI_SW_EVENT` — 2.1.0 新增，按 kind 分发的客户端事件名
- `REI_AMSG_POSTMESSAGE_TYPE` — 2.1.0 新增，SW → client 广播信封的 `type` 字段（恒为 `'REI_AMSG_PUSH'`）
- `REI_SW_MESSAGE_TYPE`

以上常量的单一来源是 `@rei-standard/amsg-shared`（本包 re-export 同一份）。页面侧代码请直接从 shared import，避免在窗口环境里执行本包 SW 模块的顶层状态。

`REI_SW_EVENT` 包含（详见上文 v2.1.0 章节）：

- `CONTENT_RECEIVED`
- `REASONING_RECEIVED`
- `TOOL_REQUEST_RECEIVED`
- `ERROR_RECEIVED`
- `MULTIPART_EXPIRED`
- `UNKNOWN_RECEIVED`

`REI_SW_MESSAGE_TYPE` 包含：

- `ENQUEUE_REQUEST`
- `FLUSH_QUEUE`
- `QUEUE_RESULT`
- `QUEUE_DROPPED`

## 模块格式与类型（ESM/CJS/Types）

- ESM：`import { installReiSW } from '@rei-standard/amsg-sw'`
- CJS：`const { installReiSW } = require('@rei-standard/amsg-sw')`
- 类型：包内提供 `types` 入口（`dist/index.d.ts`）

## 运行环境与要求

- Service Worker 环境
- 需支持 `indexedDB`
- Background Sync 不可用时会降级为手动冲刷队列
- 建议项目可对 SW 文件做模块打包（支持包名 import）

## 常见坑

1. 本包不会自动添加 `notificationclick`，必须业务侧实现。
2. SW 文件如果不能解析包名 import，需要改走手动接入模板。
3. 请求入队 body 必须可序列化（JSON）。

## 相关链接（绝对 URL）

- [SDK Workspace 总览](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/README.md)
- [Server 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/README.md)
- [Client 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/client/README.md)
- [Service Worker 规范（第 0 章）](https://github.com/Tosd0/ReiStandard/blob/main/standards/service-worker-specification.md)
