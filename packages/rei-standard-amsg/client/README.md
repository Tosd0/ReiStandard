# @rei-standard/amsg-client

`@rei-standard/amsg-client` 是 ReiStandard 主动消息标准的浏览器端 SDK 包，负责加密请求、解密响应、Push 订阅、收件箱补拉，以及 **送达协调**。

## 先看你接的是哪条服务端线

| 服务端 | 这份 README 里主要用到 |
|---|---|
| **`@rei-standard/amsg-server` 单用户线**（新接入走这条） | `scheduleMessage()` 排任务（`messageType: 'instant'` 也走它）、`putPushSubscription()` 登记订阅、**`getOutbox()` / `ackOutbox()` 上线补拉** |
| `@rei-standard/amsg-instant`（连数据库都不要的部署，维护态） | `deliver()` / `sendInstant()` / `consumeInstantStream()` |

接单用户线是四步：部署 worker → 装 Service Worker 并 `putPushSubscription()` 登记订阅 → 发消息 / 排任务 → **应用启动时拉一次收件箱**。

第四步不能省：到了客户端不会弹通知的内容（思考过程、工具请求、错误）只落收件箱、不发推送，不补拉就等于没有。写法见[上线补一次收件箱](#上线补一次收件箱)。

`deliver()` 是给 instant 那条线用的送达裁决 primitive，把"发出去"和"业务上是否真送达"分开：那条线没有服务端收件箱可退，判送达只能靠一条 out-of-band 的观察通道。它本身**不绑死任何后端 / 平台**——接收一个普通的 `Promise<ObservedDeliveryReceipt>`，Service Worker 广播、Electron IPC、原生桥、轮询都能接——所以自建 worker 也用得上。`sendInstant()` / `consumeInstantStream()` 是它底下的**低级 transport**，只在你已经自己接好了送达校验时才直接用，否则会踩「HTTP 200 / SSE 不报错 ≠ 消息真送到」（见[为什么需要 `deliver()`](#为什么需要-deliver)）。

---

## 目录

- [快速使用](#快速使用)
- [上线补一次收件箱](#上线补一次收件箱)
- [`deliver()` 标准用法](#deliver-标准用法)
- [为什么需要 `deliver()`](#为什么需要-deliver)
- [`DeliverOptions` 全字段](#deliveroptions-全字段)
- [五种 `outcome` 含义](#五种-outcome-含义)
- [接观察通道的几种典型形态](#接观察通道的几种典型形态)
- [低级 API（`sendInstant` / `consumeInstantStream`）](#低级-apisendinstant--consumeinstantstream)
- [发送即时消息（加密 vs 明文）](#发送即时消息加密-vs-明文)
- [`messages` 多轮 / `splitPattern` 自定义分句](#messages-多轮--splitpattern-自定义分句)
- [本地软清空与可选 `maxPayloadBytes`](#本地软清空与可选-maxpayloadbytes)
- [其他工具：scheduleMessage / listMessages / client-state / subscribePush…](#其他工具)
- [模块格式与环境](#模块格式与环境)

---

## 安装

```bash
npm install @rei-standard/amsg-client
```

## 快速使用

```js
import { ReiClient } from '@rei-standard/amsg-client';

const client = new ReiClient({
  baseUrl: '/api/v1',
  userId: '550e8400-e29b-41d4-a716-446655440000',
});

await client.init();
```

发送即时消息（单用户线：任务先落库再处理，客户端断开也跑得完，内容同时落收件箱）：

```js
const result = await client.scheduleMessage({
  contactName: 'Rei',
  messageType: 'instant',
  userMessage: '帮我看看今天的日程',
});
// result.status === 'sent'，附 messagesSent / sentAt
```

接 `@rei-standard/amsg-instant` 那条线的话，即时消息走 `deliver()`，见[下面那节](#deliver-标准用法)。

订 Web Push 并登记订阅——服务端一个用户存一份，所有任务到点都读它，不登记就一条推送都收不到：

```js
await navigator.serviceWorker.register('/service-worker.js');
const registration = await navigator.serviceWorker.ready;

// 公钥从 worker 自己拿（单用户线）；多租户线从你的部署配置里取。
const vapidPublicKey = await client.getVapidPublicKey();
const subscription = await client.subscribePush(vapidPublicKey, registration);
await client.putPushSubscription(subscription);

await client.scheduleMessage({
  contactName: 'Rei',
  messageType: 'fixed',
  userMessage: '下班记得带伞～',
  firstSendTime: new Date(Date.now() + 60 * 1000).toISOString(),
  recurrenceType: 'none',
});
```

接 amsg-server 时还差一步：**应用启动时拉一次收件箱**（`getOutbox()` → 处理 → `ackOutbox()`），完整写法见下一节。

订阅登记之后随时可以覆盖：用户清了站点数据、重装了 PWA、或者推送服务轮换了 endpoint，再调一次 `putPushSubscription()` 就全好了——已排的任务一条都不用碰。任务不再携带 `pushSubscription` 字段，`scheduleMessage` / `updateMessage` 里带了会被服务端 400 拒掉。

`subscribePush()` 返回的订阅 endpoint 保证是活的，可以直接往服务端登记。刚 `unsubscribe()` 过又马上重订时，Chromium 会给一个 `https://permanently-removed.invalid/...` 的占位订阅——结构齐全但推什么都到不了；这种订阅会被识别出来，退掉重订，最多试三次。三次都是占位订阅时抛 `err.code === 'PUSH_ENDPOINT_ZOMBIE'`，给用户看什么话由你决定：

```js
try {
  const subscription = await client.subscribePush(vapidPublicKey, registration);
  await client.putPushSubscription(subscription);
} catch (err) {
  if (err.code === 'PUSH_ENDPOINT_ZOMBIE') {
    // 浏览器一直给不出可用的推送地址，提示用户换个浏览器 / 稍后再开。
  }
  throw err;
}
```

---

## 上线补一次收件箱

服务端每条 payload 在发出去之前都会先记进收件箱。到了客户端**不会弹通知的那些**——思考过程、工具请求、错误、带 `notification: { show: false }` 的结果——只落收件箱、不发推送，不补拉就等于没有。会弹的那些也照落，推送没送到（离线、订阅失效、推送服务抽风）时同样从这里补回来。

所以接入时这是必做的一步：**应用启动、以及页面从后台回到前台时，各拉一次。**

```js
async function drainOutbox(client) {
  let since;
  for (;;) {
    const { entries, cursor, hasMore } = await client.getOutbox({ since, limit: 100 });
    if (entries.length === 0) return;

    // entry.push 就是推送信封本身，与 Service Worker 收到的那份逐字一致，
    // 交给已有的推送处理逻辑即可。
    for (const entry of entries) await handlePush(entry.push);

    // 先落库成功再销账。反过来的话账已经销了、落库半途失败，这条就补不回来了。
    await client.ackOutbox(entries.map((entry) => entry.messageId));

    if (!hasMore) return;
    since = cursor;
  }
}

await drainOutbox(client);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') drainOutbox(client);
});
```

几点：

- **去重靠 `messageId`**。同一条消息可能推送和补拉各来一次。`installReiSW()` 的包级 dedupe 只管 Service Worker 那条路，补拉走的是 HTTP，业务侧要自己认一次 `messageId`。想两条路共用同一份落地逻辑和去重，把 `entry.push` 桥进 SW（`REI_SW_MESSAGE_TYPE.DELIVER`，见 [`@rei-standard/amsg-sw` README 的「页面 -> SW 业务投递」](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md#页面---sw-业务投递)）——代价是补拉时用户明明已经在应用里，SW 还会按 `notification.show` 给 `content` 补弹一条系统通知。
- **ack 一定在落库之后**，见上面注释里那句。
- **翻页**把上一页的 `cursor` 当下一页的 `since`，`limit` 取 1–100。
- 这两个端点在单用户线（D1）上有。多租户线的 pg / neon 适配器还没有收件箱，调用会拿到 501——`getCapabilities()` 的 `features` 说的是「这份代码支持什么」，不反映部署用的哪个适配器，所以这里判 501 比判 feature 准。

---

## `deliver()` 标准用法

```js
import { ReiClient } from '@rei-standard/amsg-client';

const client = new ReiClient({ baseUrl: 'https://instant.example.com', instantEncryption: false });

// 1. 准备「观察通道」Promise —— 任何能告诉你"消息已经进库 / 上屏 / 上通知中心"的来源都行。
//    形状要求：resolve 时给一个 { messageId?, sessionId?, channel? }；至少含其中一个 ID。
const observationPromise = waitForReceipt({ /* 业务上下文 */ });

// 2. 发出消息并等送达裁决
const abort = new AbortController();
const result = await client.deliver(payload, {
  delivery: { mode: 'observed', observed: observationPromise },
  timeoutMs: 300_000,                       // 整体预算
  onChunk: (chunk) => routeChunk(chunk),    // 可选：SSE 每帧 UI 钩子；抛错被吞，不影响 outcome
  signal: abort.signal,                     // 可选：caller 主动取消
});

// 3. 五值 outcome —— 每一个都对应**明确**的业务动作
switch (result.outcome) {
  case 'delivered':
    // 真送达。result.detail.receipt 是你自己 resolve 的那份。
    break;
  case 'cancelled':
    // 用户主动 abort，期间无延迟送达。安静返回，不弹错。
    break;
  case 'timeout':
    if (result.detail.observationChannelStalled) {
      // ⚠ 重要分支：transport 干净结束但观察通道没接力。
      // 多半是 SW / IPC / native 推送处理那一侧挂了 / 卡了。
      // 不要当发送失败，提示"已发送，本机推送通道暂未确认"即可。
    } else {
      // 整体预算耗完，啥信号都没等到。可重试。
    }
    break;
  case 'send-failed':
    // transport 自己挂了（带 detail.transportError），并且没有观察到送达。
    // 这才是「真的发送失败」。
    showError(result.detail.transportError);
    break;
  case 'completed-unconfirmed':
    // 仅 transport-only 模式才出现。下面专门讲。
    break;
}
```

`result.detail` 永远有，里面带 `waitedMs` / `transportEnded` / `transportError` / `transportResponse`（JSON 模式）/ `chunkHandlerError` / `cancelledByCaller` / `observationChannelStalled` / `receipt`，按需取诊断信息。

---

## 为什么需要 `deliver()`

如果你的后端是 `@rei-standard/amsg-instant` 0.9.0+，**它默认强制开启 Web Push always-on backup**：同一条业务消息**总是**同时走两条通道下去——

1. SSE 流式直送（前台收到走 `event: payload`）
2. Web Push 备份（即使 SSE 成功 enqueue，也照样发一份，由 SW 端按 `messageId` 去重）

这种双通道语义让旧的两条单一信号路径都不再可靠：

| 旧 API | 看到的信号 | 实际意味着 |
| --- | --- | --- |
| `sendInstant()` 返回 `200` | dispatch 成功 | ❌ **不等于**消费者真收到（push backup 仍可能没到） |
| `consumeInstantStream()` reject | SSE 这条路断了 | ❌ **不等于**消息没送达（push backup 可能已到） |

最朴素的 naive 代码 `try { await consumeInstantStream() } catch { fail() }` 在这套语义下**必然出错**——iOS 把后台 fetch 杀掉时，SSE reject，用户看到「失败」，但其实 push backup 已经把消息送进去了，过一会儿冒出来。计费、UI 文案、重试逻辑全部错乱。

`deliver()` 的解法：

- **transport 只是辅助**——它的成败用来收紧延迟，不用来判送达
- **送达由"观察通道"决定**——caller 提供一个 `Promise<ObservedDeliveryReceipt>`，等业务上"真到了"才 resolve。这条 Promise 怎么实现库不关心，**真正平台无关**
- **race 四路 + grace + 严格 outcome**——返回值告诉你到底是 delivered / cancelled / timeout / send-failed / completed-unconfirmed 的哪一个，不再让 caller 自己脑补

---

## `DeliverOptions` 全字段

```ts
interface DeliverOptions {
  delivery:
    | { mode: 'observed'; observed: Promise<ObservedDeliveryReceipt> }
    | { mode: 'transport-only' };

  timeoutMs: number;                                       // 总预算（含 transport + grace）
  onChunk?: (payload: unknown) => Promise<void> | void;    // 可选 SSE 每帧钩子，抛错被吞
  onRawRead?: (meta: RawReadMeta) => void;                 // 可选 SSE 原始读遥测，排查链路用；抛错被吞
                                                            // 每次 reader.read() 后触发，保留 ':' 注释行
  postTransportGraceMs?: number;                           // transport 结束后等观察的 grace
                                                            // 默认 = min(remaining, max(5000, timeoutMs * 0.1))
                                                            // cancel 路径下生效的是 grace / 2
  signal?: AbortSignal;                                    // 已 aborted → 立即 cancelled，不发 fetch
                                                            // listener 在每个终态会被卸载，长生命周期 signal 反复
                                                            // 调用不会累积
  headers?: Record<string, string>;                        // 额外请求头；可覆盖 Content-Type，但不能覆盖
                                                            // X-User-Id / X-Payload-Encrypted / X-Encryption-Version
                                                            // / X-Client-Token / Authorization
  authorization?: string;                                  // 透传成 Authorization header（与 sendInstant 对齐）
  endpointPath?: string;                                   // 默认 '/instant'，可改 '/continue' 续跑
  compressRequest?: boolean | { thresholdBytes?: number }; // 可选请求体 gzip。不传/falsy = 关（行为不变）
                                                            // true / {} = 开，阈值默认 16384 字节(16KB)
                                                            // { thresholdBytes: N } = 开 + 自定义阈值
                                                            // 仅当 body 超阈值且运行时有 CompressionStream 才压；
                                                            // 否则发明文（优雅降级，绝不抛）。压时发 gzip 字节 +
                                                            // 头 X-Amsg-Request-Encoding: gzip（非标准 Content-
                                                            // Encoding），由接收端 gunzip。SSE / JSON 两路通用。
}

interface ObservedDeliveryReceipt {
  messageId?: string;        // 至少一个非空字符串
  sessionId?: string;        // ↑
  channel?: string;          // 'sw' / 'ipc' / 'native' / 'poll' / 任意诊断 label
}

interface RawReadMeta {
  ts: number;                // Date.now()
  byteLength: number;        // 本次 reader.read() 拿到的字节数
  done: boolean;             // 流是否结束
  textPreview: string;       // 本次数据解码后的前 120 字符，保留 ':' keepalive 注释行
  status?: number;           // 仅首帧带：响应状态码
  contentEncoding?: string | null;  // 仅首帧带：响应 Content-Encoding（查是否被边缘压缩）
  contentType?: string | null;      // 仅首帧带
}
```

> `onRawRead` 是诊断钩子：SSE 解析层默认丢弃 `:` 注释行（含每秒一发的 keepalive），出问题时无从判断「静默期里到底有没有字节到达」。挂上它就能在 raw `reader.read()` 这一层看到每次读到的原始字节与 keepalive 帧。不传则零开销、行为不变。

> `compressRequest` 用于大 body 上传：开启后，要发的 JSON 在上网线前 gzip（中文 + 重复结构压缩比很高），网线上字节小了就能在慢/不稳链路的发送超时之前传完，且上下文一字不动。仅当 body 超阈值且运行时支持 `CompressionStream` 才压，否则照常发明文；压缩出错也兜回明文，永不影响发送。压缩的是请求体，与响应 / `onChunk` / `onRawRead` 无关。接收端需按 `X-Amsg-Request-Encoding: gzip` 头自行解压。

### `delivery.mode` 必须显式选

| mode | 何时用 | outcome 取值 |
| --- | --- | --- |
| `'observed'` | **99% 用户用这个**。有任何能确认"消息真到了"的 out-of-band 通道 | `delivered` / `cancelled` / `timeout` / `send-failed` |
| `'transport-only'` | 没有 out-of-band 通道（amsg-instant 0.9+ 默认场景几乎不会用到；某些自定义后端 / 调试场景才会） | `completed-unconfirmed` / `cancelled` / `timeout` / `send-failed` |

> 库**不允许**「传一个永不 resolve 的 Promise 假装在 observed 模式」的写法——那等于教人写错代码。模式必须显式声明。

### `postTransportGraceMs`

transport 结束后（无论干净结束还是 error）等观察通道的额外窗口。默认公式：

```
default = min(remainingBudget, max(5000ms, timeoutMs * 0.1))
```

- 5 秒下限保住极短 timeout 下 grace 不被砍到 0
- 10% 比例让 30s / 300s / 多分钟级 timeout 都有合理 grace
- caller 显式传时仍会被 `remainingBudget` cap，不会超出 `timeoutMs` 总预算

cancel 路径用的是 `grace / 2`（abort 后只给一半时间等延迟送达，剩下半给清理）。

---

## 五种 `outcome` 含义

| outcome | `ok` | 何时出现 | 推荐 caller 行为 |
| --- | --- | --- | --- |
| `'delivered'` | ✅ true | observed 模式 + 收到匹配 receipt（任何路径，包括 abort 后 grace 内仍到） | 正常成功路径 |
| `'cancelled'` | ❌ false | caller `signal.abort()` 触发，且 grace 内没观察到送达 | 安静返回，不弹错（这是用户主动） |
| `'timeout'` | ❌ false | 总预算耗完；**或** observed 模式 transport 干净结束但 observation 没接力 | 可重试；如带 `observationChannelStalled` 标记则提示「已发送、本机推送通道暂未确认」 |
| `'send-failed'` | ❌ false | transport 自己挂了（`detail.transportError` 有值）+ 没观察到送达 | 这才是真发送失败，给 `detail.transportError` 报错 |
| `'completed-unconfirmed'` | ❌ false | **仅 transport-only 模式**，transport 干净结束，无真相信号 | best-effort 乐观，caller 自决怎么判 |

特别注意两个细分：

- **`outcome:'timeout'` + `detail.observationChannelStalled:true`** —— transport 都好好结束了，是观察那一侧（SW / IPC / native push handler）没把信号给到 `observed`。多半是观察那侧的实现有问题，不是发送失败。文案应该跟普通 timeout 区分。
- **`outcome:'delivered'` + `detail.cancelledByCaller:true`** —— 用户切走 / 关页面后，消息在 grace 内仍然送达了（实战常见：iOS Safari 切 tab，几百 ms 后 push 才到）。不算 cancelled。

---

## 接观察通道的几种典型形态

`deliver()` 不绑死任何平台。这一节给几个常见形态的 reference 写法——**库里都不内置，全是 caller 自己几行胶水**。

### Service Worker 广播

如果你的 SW 是 `@rei-standard/amsg-sw` 或类似实现，会在落库后 `postMessage` 一份 `{ type: 'REI_AMSG_PUSH', event, payload }`——`event` 是按 `messageKind` 区分的事件名（`'rei-amsg-content-received'`、`'rei-amsg-reasoning-received'` 等，见 `@rei-standard/amsg-shared` 导出的 `REI_SW_EVENT`），**不是** `'DELIVER'`（`'REI_AMSG_DELIVER'` 是页面→SW 方向的 message type，方向相反）。按 `messageId` 匹配即可，不必按 `event` 过滤；要过滤就用 `REI_SW_EVENT` 里的值。这些常量的单一来源是 `@rei-standard/amsg-shared`——页面侧从 shared import，而不要从 amsg-sw 包 import（那会执行 SW 模块的顶层状态）。把它包成 Promise：

```js
import { REI_AMSG_POSTMESSAGE_TYPE } from '@rei-standard/amsg-shared';

function waitForSwReceipt(messageId, signal) {
  return new Promise((resolve, reject) => {
    function handler(e) {
      if (e.data?.type !== REI_AMSG_POSTMESSAGE_TYPE) return;
      const p = e.data.payload;
      if (p?.messageId === messageId) {
        navigator.serviceWorker.removeEventListener('message', handler);
        resolve({ messageId: p.messageId, sessionId: p.sessionId, channel: 'sw' });
      }
    }
    navigator.serviceWorker.addEventListener('message', handler);
    signal?.addEventListener('abort', () => {
      navigator.serviceWorker.removeEventListener('message', handler);
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true });
  });
}

await client.deliver(payload, {
  delivery: { mode: 'observed', observed: waitForSwReceipt(payload.messageId, abort.signal) },
  timeoutMs: 300_000,
});
```

### Electron / Tauri IPC

```js
function waitForIpcReceipt(messageId) {
  return new Promise((resolve) => {
    const off = window.ipcBridge.on('amsg:received', (p) => {
      if (p.messageId !== messageId) return;
      off();
      resolve({ messageId: p.messageId, channel: 'ipc' });
    });
  });
}
```

### 原生 push 桥（React Native / native WebView）

```js
function waitForNativeReceipt(messageId) {
  return new Promise((resolve) => {
    const sub = NativeEventEmitter.addListener('amsg-received', (p) => {
      if (p.messageId !== messageId) return;
      sub.remove();
      resolve({ messageId: p.messageId, channel: 'native' });
    });
  });
}
```

### 纯轮询 fallback

```js
function pollReceipt(messageId, signal) {
  return new Promise((resolve, reject) => {
    const t = setInterval(async () => {
      if (signal.aborted) { clearInterval(t); reject(new DOMException('aborted', 'AbortError')); return; }
      const found = await db.findReceipt(messageId);
      if (found) { clearInterval(t); resolve({ messageId, channel: 'poll' }); }
    }, 1000);
  });
}
```

`deliver()` 对这些一视同仁，只看 `Promise` 何时 resolve 出什么。

---

## 低级 API：`sendInstant` / `consumeInstantStream`

这两个 API 仍然保留，但**只在以下情况推荐**：

- 你已经在更上层自己接好了送达确认（典型：业务库直接同步落库后就算完成，根本没有"观察通道"概念）
- 你只需要 SSE 每帧的 UI 钩子，不需要 outcome 裁决
- 临时调试 / one-off 脚本

不在这些情况下，**用 `deliver()`**。

### `sendInstant(payload, endpointPath?, opts?)`

POST JSON 到 instant endpoint，原样返回 worker 的 `{ success, data?, error? }`。

> ⚠ **HTTP 200 ≠ delivery confirmation**，当 worker 配了 backup Web Push 时（amsg-instant 0.9.0+ 默认）。`200` 只说明 dispatch 成功，不说明消费者真收到。要正确判断送达，用 `deliver()`。

可选 `opts.expectsBackupPush`：
- 设 `true` —— 本实例此方法首次调用时 `console.warn` 一次，提醒上述陷阱（migration 期审计有用）
- 设 `false` —— 显式表示「我知道这点」，永久静音
- 不传 —— 不警告

### `consumeInstantStream(payload, endpointPath?, options)`

POST 并按 SSE 帧解析 `event: payload` / `event: done` / `event: error`，分发到 `options.onPayload`。

```js
try {
  await client.consumeInstantStream(payload, '/instant', {
    onPayload: async (push) => routePush(push),
    onError: (err) => log.warn('stream error', err),
    onDone:  () => stopSpinner(),
    signal:  abort.signal,
  });
} catch (err) {
  // ⚠ reject ≠ delivery failure（详见上面）
}
```

> ⚠ **rejection ≠ delivery failure**，当 worker 配了 backup Web Push 时。SSE 可能因为 iOS 杀后台 fetch、网络抖动、worker 5xx 而 reject，但 backup push 仍然把消息送到了。把 reject 当成「发送失败」会导致**虚报失败 + 消息晚到时用户困惑**。要正确判断送达，用 `deliver()`。

`opts.expectsBackupPush` 与 `sendInstant` 一致。

---

## 发送即时消息（加密 vs 明文）

`deliver()` 与 `sendInstant` 共享同一套 transport 配置，由构造器决定：

### 加密模式（默认；兼容 amsg-server / amsg-instant 0.1.x）

```js
const client = new ReiClient({
  baseUrl: '/api/v1',
  customBaseUrls: { instant: 'https://instant.example.com' },
  userId: '550e8400-e29b-41d4-a716-446655440000',
});

await client.init();

await client.deliver({
  contactName: 'Rei',
  completePrompt: '你是 Rei，用一句话提醒用户带伞',
  apiUrl: 'https://api.openai.com/v1/chat/completions',
  apiKey: '...',
  primaryModel: 'gpt-4o-mini',
  pushSubscription: subscription.toJSON(),
}, {
  delivery: { mode: 'observed', observed: observationPromise },
  timeoutMs: 300_000,
});
```

> `customBaseUrls` 是按端点名（如 `instant`）覆盖 `baseUrl` 的通用机制；后续其他端点也可以用同一字段独立指定。

### 明文模式（配 amsg-instant 0.2.x+ / 单租户自部署）

```js
const client = new ReiClient({
  baseUrl: 'https://instant.example.com',
  instantEncryption: false,
  instantClientToken: 'shared-secret-xyz',
});

// init() 在明文模式下是 no-op，调不调都行
```

> ⚠ **`instantClientToken` 是弱共享密钥**：它会随前端 bundle 发出去，devtools 一开就能看到。只防 URL 直怼，不防有心人。要真正鉴权，用 amsg-instant 的 `tokenSigningKey`（HMAC JWT，配后端签发短期 token）。

> ⚠ **双模式陷阱**：`instantEncryption: false` 时 `init()` 变 no-op，`scheduleMessage` / `listMessages` / `updateMessage` 这类**仍走加密**的方法会因 `userKey` 没初始化抛 "Not initialised"。同一前端两类方法都要用，请改回 `instantEncryption: true`（默认）。

---

## `messages` 多轮 / `splitPattern` 自定义分句

`deliver()` / `sendInstant` / `consumeInstantStream` 都是 **payload-agnostic 透传**——这些字段写进 payload 就行，client 不校验，所有错误从 Worker / Server 端返回。

`messages`（OpenAI 格式数组）：

```js
await client.deliver({
  contactName: 'Rei',
  messages: [
    { role: 'system', content: '你是 Rei，回复要简短自然。' },
    { role: 'user', content: '今天会下雨吗？' },
    { role: 'assistant', content: '看了下，下午有阵雨。' },
    { role: 'user', content: '那提醒我一下带伞' },
  ],
  apiUrl: '...',
  apiKey: '...',
  primaryModel: 'gpt-4o-mini',
  pushSubscription: subscription.toJSON(),
}, { delivery: ..., timeoutMs: 300_000 });
```

`completePrompt` 和 `messages` **必须恰好二选一**，同时给会被远端返回 `400 INVALID_PAYLOAD_FORMAT`。

`splitPattern`（自定义分句正则，`string | string[]`）：

```js
splitPattern: '([\\n]+)',                   // 按换行
splitPattern: ['(\\n\\n+)', '([。！？!?]+)'], // 数组级联：先段落、再句号
```

**两个常见坑**：

- 传**正则 source**，不要带 `/.../` 也不要尾 flag。`'/foo/i'` 会被当字面斜杠 + 字面 `i`，不是大小写不敏感的 `foo`。要大小写不敏感请用 `[Aa]` 字符类。
- 想让分隔符回贴到前一段（默认行为），把分隔符包进 `(...)` 捕获组。库**不会自动包**——传 `'\\n+'` 而不是 `'(\\n+)'` 会得到首尾相连、分隔符丢失的奇怪结果。

---

## 本地软清空与可选 `maxPayloadBytes`

`scheduleMessage` / `sendInstant` / `consumeInstantStream` / `deliver` / `updateMessage` 在发请求**之前**会保留 `avatarUrl` 软清空保护。请求体大小默认不限制；要本地护栏可在构造器显式传 `maxPayloadBytes`：

```js
const client = new ReiClient({
  baseUrl: '/api/v1',
  userId,
  maxPayloadBytes: 256_000, // 默认 null / 不限制
});
```

| 触发条件 | 处理方式 |
| --- | --- |
| `payload.avatarUrl` 是 `data:` URI / 长度 > 2048 字符 / 非字符串 | `console.warn` + 在 payload 上把 `avatarUrl` 置为 `null`（`updateMessage` 从 patch 里删除字段，保留服务端原头像），请求照发 |
| `maxPayloadBytes` 配了，且 `JSON.stringify(payload)` UTF-8 字节数超过该值 | 抛 `Error` with `.code === 'PAYLOAD_TOO_LARGE_LOCAL'`，`.details = { method, actualBytes, limitBytes }` |

头像是装饰字段，单个不合规 URL 不再让整次调用挂掉。要拦错请监听 `console.warn`。

```js
try {
  await client.deliver(payload, { delivery, timeoutMs: 300_000 });
} catch (err) {
  if (err.code === 'PAYLOAD_TOO_LARGE_LOCAL') {
    // err.details = { method: 'deliver', actualBytes: 87320, limitBytes: 256000 }
  } else { throw err; }
}
```

---


## 其他工具

`ReiClient` 还有这些方法（与 2.4.x 相比无字节变化）：

- `scheduleMessage(payload)` —— 排定 fixed / prompted / auto / instant 任务，加密走 amsg-server
- `updateMessage(uuid, updates)` —— 改任务字段
- `cancelMessage(uuid)` —— 取消任务
- `listMessages(opts)` —— 拉当前 user 的任务列表。每条任务只带 `charId` / `clientTaskId` 两个 `metadata` 子字段
- `getMessage(uuid)` —— 单条任务（`GET /message`，单用户线），比列表多给**完整的 `metadata`**。`updateMessage` 对 `metadata` 是整体替换，只改其中一个键就得先用它读回完整那份，改完再整份传上去；只传一部分会把存在里面的其余键一起冲掉。只读得到还没发出去的任务（已完成/已失败 → 409，不存在 → 404）
- `subscribePush(vapidPublicKey, registration)` —— 标准 Push API 订阅封装，返回的 endpoint 保证是活的（认出 Chromium 的 `permanently-removed.invalid` 占位订阅就退掉重订，最多三次；仍然拿不到就抛 `PUSH_ENDPOINT_ZOMBIE`）

对接单用户 amsg-server worker 的配套方法：

- `getVapidPublicKey()` —— 拉 worker 自己的 VAPID 公钥（`GET /vapid-public-key`），创建 Web Push 订阅时作 `applicationServerKey` 用；worker 没配公钥时抛错
- `getCapabilities()` —— 拉 worker 能力清单（`GET /capabilities`，单用户线），返回 `{ serverVersion, features }`；worker 太旧没有该端点（404 或非 JSON 响应）时返回 `null`，可以据此提示「worker 需要重新部署」而不是让新功能静默失效
- `putClientState(entries)` —— 批量 upsert 客户端状态到云端镜像（`PUT /client-state`，单用户线）。entries 为 `[{ namespace, key, value, updatedAt }]`（`value` 需自行序列化成字符串、`updatedAt` 为毫秒时间戳）；按 `updatedAt` last-write-wins，重发旧批次无害；非法/超限条目只拒绝自己，此时响应带 `data.rejected` 明细。单值超 200KB 时 worker 自动分片存储（用 `getCapabilities()` 探测 `features` 含 `client-state-chunking`，别判版本号）
- `getClientState(namespace)` —— 读回一个 namespace 的全部条目（走加密响应信封，方法内解密后返回明文值）
- `clearClientState()` —— 清空该用户所有 namespace 的云端状态（如「清除云端数据」设置项）
- `putPushSubscription(subscription, opts?)` —— 登记 / 覆盖这个用户的 Web Push 订阅（`PUT /push-subscription`）。传 `pushManager.subscribe()` 的结果（或它的 `toJSON()`）即可，方法内部会取 `toJSON`。服务端一个用户存一份，所有定时任务到点投递时都读它——包括角色在 fire 里给自己排的、客户端根本不知道存在的那些任务。`opts.updatedAt` 是 epoch 毫秒，不传由服务端取当前时刻
- `getPushSubscription()` —— 服务端登记的订阅现状：`{ exists, updatedAt, endpoint }`，不含订阅的密钥部分。设置页显示状态、或者拿 `endpoint` 跟本地订阅对一下是不是同一个
- `deletePushSubscription()` —— 删掉服务端登记的订阅（设置页的「停止接收推送」）。删掉之后已有的定时任务到点会投递失败并记下原因，不会静默消失
- `putLlmCredentials(credentials)` —— 批量登记 / 覆盖用户级 LLM 凭据（`PUT /llm-credentials`；worker 支不支持用 `getCapabilities()` 探测 features 含 `llm-credentials`，别判版本号）。credentials 为 `[{ credId, value: { apiUrl, apiKey, primaryModel } }]`；`credId` 由客户端起名（约定 `char:<charId>/<purpose>`、`global/<purpose>`）。登记后排程 payload 用 `credRefs: { chat: credId }` 引用它，任务到点现读——换 Key 覆盖对应行就够，所有引用它的任务（含角色自排的）自动跟随
- `listLlmCredentials()` —— 云端凭据对账清单 `{ credentials: [{ credId, updatedAt }] }`，凭据本体永远不回传
- `deleteLlmCredentials(opts)` —— 删凭据：`{ credIds: [...] }` 删指定那几行（如角色删除时清它名下的），`{ all: true }` 全删（「清空云端数据」）。两种删法互斥，`all: true` 和 `credIds` 同时传直接抛 TypeError、不发请求（跟服务端对这种 body 的 400 同一口径）——用两份状态拼 opts 时记得只留一个字段。删掉之后还引用着它的任务到点会失败并记 `CREDENTIAL_MISSING`，重新登记同名 credId 即恢复
- `getOutbox(opts?)` —— 拉这个用户还没确认收到的服务端消息（`GET /outbox`，单用户线）。服务端在每条 Web Push 发出去之前先记进账本，「哪些消息还没收下」因此是查得出来的事实，不用拿本地最近几条去比对着猜。返回 `{ entries, cursor, hasMore }`（走加密响应信封，方法内解密）；每条 entry 形如 `{ id, messageId, taskUuid, sessionId, messageIndex, totalMessages, createdAt, deliveredAt, push }`，其中 **`push` 就是推送信封本身**——与 Service Worker 收到的那一份逐字一致，可以原样交给已有的推送处理逻辑。翻页把上一页的 `cursor` 当下一页的 `opts.since`，`opts.limit` 为 1–100（缺省由服务端定，50）
- `ackOutbox(messageIds)` —— 销账（`POST /outbox/ack`，请求体加密）：这些消息之后不再出现在 `getOutbox()` 的结果里。幂等，单次最多 200 条。顺序要紧——**先落库成功再 ack**，反过来的话账已经销了而落库半途失败，这条消息就补不回来了

以及从 `@rei-standard/amsg-shared` re-export 的运行时常量 / builder / type guard：

- `MESSAGE_KIND` / `MESSAGE_TYPE` / `PUSH_SOURCE`
- `buildContentPush` / `buildReasoningPush` / `buildToolRequestPush` / `buildErrorPush`
- `isContentPush` / `isReasoningPush` / `isToolRequestPush` / `isErrorPush`

这些在 SW / app 端处理 push 时用得上，单独装 `@rei-standard/amsg-shared` 没必要。

---

## 模块格式与环境

- ESM：`import { ReiClient } from '@rei-standard/amsg-client'`
- CJS：`const { ReiClient } = require('@rei-standard/amsg-client')`
- 类型：包内提供 `types` 入口（`dist/index.d.ts`）
- 浏览器环境（需 `fetch`、`crypto.subtle`、`ReadableStream`、`AbortController`）
- Push 订阅需可用 Service Worker 与 Push API
- `userId` 必须是 UUID v4（明文 instant 模式 `instantEncryption: false` 下可省）

## 相关链接

- [SDK Workspace 总览](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/README.md)
- [Server 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/server/README.md)
- [Instant 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/instant/README.md)
- [SW 包 README](https://github.com/Tosd0/ReiStandard/blob/main/packages/rei-standard-amsg/sw/README.md)
- [Service Worker 规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/service-worker-specification.md)
- [API 技术规范](https://github.com/Tosd0/ReiStandard/blob/main/standards/active-messaging-api.md)
