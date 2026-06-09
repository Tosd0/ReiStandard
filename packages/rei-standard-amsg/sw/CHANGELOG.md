# Changelog — @rei-standard/amsg-sw

## 2.3.1 — `showNotification` 拒绝不再卡死 dedupe 状态

- **Fix**: `dispatchBusinessPayload` 给 `sw.registration.showNotification(...)` 加了 `.catch(...)` 兜底。原链路只挂了成功分支 `.then(() => notificationState.shown = true)`，当浏览器拒绝展示（权限被撤、quota / OS 限制等）时整个 `Promise.all(notificationWork)` 会 reject，`onNotificationSettled` 被跳过，dedupe 记录永远停在 `notificationStatePending: true`。后续同 key 的 backup transport 重复会被 `maybeShowDuplicateNotification` 当成 `first-delivery-pending` 吞掉，用户彻底看不到通知。现在拒绝只记录到 `console.error`，`notificationState.shown` 保持 false，但 `onNotificationSettled` 一定执行，dedupe 状态正常推进。

## 2.3.0 — IndexedDB 连接韧性 + 业务感知的 DELIVER ack

- **Fix**: IndexedDB 连接被浏览器**强制关闭**（backing store 出错 / 存储压力 / 清数据）后自愈。强关只触发 `close`、不触发 `versionchange`，此前缓存里的死连接会被无限复用，每次事务都抛 `InvalidStateError`，导致去重失灵、push 落库被阻断、`dedupe cleanup failed` 刷屏且不重启 SW 不恢复。dedupe 库与 queue / multipart 库（`cachedDB`）一并修复。
  - 给缓存连接挂 `onclose`：被强关时剔除缓存，下次访问重开。
  - 事务级一次重开兜底：`close` 事件可能晚于下一次事务、而 `db.transaction()` 同步抛错，故发事务命中「连接 closing/closed」时清缓存、重开一次、重试一次；重试上限 1 次，第二次仍失败如实抛出。
- **New**: DELIVER ack 增加可选字段 `businessError`（非破坏）。`onBusinessPayload` reject 或抛错时，ack 仍是 `ok: true` 但带上 `businessError: <message>`；成功时不出现该字段。`ok` 的含义明确为「已收下并分发」而非「业务已落库」，需要严格区分「传输成功 / 业务落库成功」的消费方读 `businessError` 即可。webpush `push` 路径无 ack，业务失败仅内部 `console.error`，不会让投递 promise reject。
  - 失败会持久化到 dedupe 记录上：之后**同 key 的重复包**（发送方重试 / 另一条 transport 的 backup）被去重后，ack 仍会带上首包的 `businessError`，而不是回一个看着干净的 `ok:true, duplicate:true`。注意：去重不会让 `onBusinessPayload` 重跑——这只是让信号诚实，不是补救机制；要「失败可重试」需消费方自己做幂等（见 README「在 SW 内执行 tool_request 的安全边界」）。

## 2.2.0 — delivery dedupe + SSE bridge

- **New**: `installReiSW({ dedupe })` 新增通用 delivery dedupe，默认开启。默认 key 为 `payload.messageId` → `payload.id` → `payload.dedupeKey`，没有 key 时保持兼容不去重。
- **New**: dedupe gate 发生在 `showNotification` 和 `onBusinessPayload` 之前；重复 payload 不重复调用业务回调。若首包未展示系统通知、重复包到达时 `notification.show` 条件满足，SW 会只补一次通知，并通过 `onDuplicate(info)` 通知应用。
- **New**: 新增页面到 SW 的通用业务投递协议 `{ type:'REI_AMSG_DELIVER', payload, source?, requestId? }`，用于让 SSE page bridge 和 Web Push 进入同一条 pipeline。
- **New**: 文档明确生产推荐链路：`amsg-instant` always-on Web Push backup + client `REI_AMSG_DELIVER` bridge + SW 默认 dedupe。
- **New**: dedupe 使用 IndexedDB keyPath + `add()` 做原子 claim，默认 DB 为 `rei_amsg_sw_dedupe_v1`，TTL 懒清理，无需 KV / D1 / Durable Object。
- **Fix**: multipart 还原后的最终 payload、携带 `messageId` 的 blob envelope、Web Push payload、SSE bridge payload 都走同一套 dedupe gate。
- **Changed**: `dedupe.storeName` 不再可配置，传了会在 `installReiSW` 安装时抛 Error。需要隔离去重数据改用 `dedupe.dbName` —— 每个 dbName 是独立 IndexedDB instance，互不影响。

  原因：同一 dbName 下换 storeName 需要做 IndexedDB 版本升级，本包不打算维护跨 storeName 的 migration 逻辑；继续暴露 storeName 配置只会让用户踩 IDB upgrade 坑（升级一次后 store 永远建不出来，所有 dedupe transaction 都抛 NotFoundError）。

  | 之前配置 | 之前行为 | 现在 |
  | --- | --- | --- |
  | 不传 dbName / storeName | 用默认 | 不变 |
  | 只传 `dbName` | 静默失效（store 建不出来） | 正常隔离 |
  | 只传 `storeName` | 静默失效 | 装包时抛 Error |
  | 同时传 `dbName` + `storeName`（首次部署） | OK | 装包时抛 Error |
  | 同时传 `dbName` + 后续改 `storeName` | 老 client 上 store 建不出来，整条 dedupe 链路挂掉 | 装包时抛 Error |

- **Fix**: 慢的 `onBusinessPayload` 回调不再阻塞 dedupe 的通知补救判定。

  之前：业务回调长时间未 resolve + 前台从可见变隐藏 + 同 `messageId` 的 Web Push backup 在窗口内到达 → backup 被判为 "first-delivery-pending" 丢弃，用户看不到通知。

  现在：通知决策一确定就解锁补救路径，backup 照常补出系统通知。业务回调依旧 await，`event.waitUntil` 生命周期不变。
- **Changed**: `@rei-standard/amsg-shared` 精确依赖升级到 `0.2.0`，并支持 `notification.silent` 透传到 `showNotification()`。

## 2.1.1 — multipart 并发与 hook thenable 修复

- **Fix**: `_multipart` reassembly 现在按 multipart id 串行处理分片，避免并发 push delivery 下 IndexedDB read-modify-write 交错导致 `receivedCount` / `receivedBytes` 丢写，最终卡住重组。
- **Fix**: `onBusinessPayload` 现在识别通用 thenable，并通过 `Promise.resolve(...)` 纳入 `event.waitUntil` 生命周期，不再只接受同 realm 的 `Promise` 实例。

## 2.1.0 — notification.show 及 Multipart chunk store

### New
- **`notification.show`** 通知显示策略: 支持 `"auto"` | `"always"` | `"when-hidden"` | `false`。现在可以直接通过包级策略实现 "有可见窗口时静默，无可见窗口时弹通知" (`"when-hidden"`) 等应用场景。

### Changed
- **性能优化**：`dispatchBusinessPayload` 现在只会调用一次 `sw.clients.matchAll` 从而避免多余的 IPC 开销。
- **IndexedDB 性能优化**：通过 `cachedDB` 保持 DB 连接，防止碎片化的 `openQueueDatabase` 导致的延迟。`REI_SW_DB_VERSION` 升级至 `3`。
- **Multipart Chunk Store**：新增 `multipart-chunk` object store 用于独立存储分片的 payload，提升了超大 payload 还原的内存稳定性和入库速度。添加了 `expiresAt` 索引大幅加速清理超时数据的过程。
- **通知标题兜底**：恢复 `createNotificationFromPayload` 中 `来自 {contactName}` 的标题 fallback，避免 custom hook 只传 `contactName` 时显示裸名字。使用 `amsg-shared` 导出的 `MESSAGE_KIND` 枚举替代了魔法字符串。

## 2.1.0-next.3 — 新增 `onBusinessPayload` 离线钩子 (pre-release)

- **新增**：`installReiSW` 的 options 参数增加 `onBusinessPayload: (payload: any) => void | Promise<void>` 钩子，支持业务端自行拦截完整的解析后 payload 并离线写库。
- **功能集成**：在 SW 进行系统通知展示和 `postMessage` 客户端派发前，回调该拦截器。该钩子自动被融合进 `event.waitUntil` 生命周期链路，支持返回 `Promise` 以绝对保证离线写入能够在 SW 休眠前全部执行完毕。

## 2.1.0-next.2 — BREAKING: generic multipart reassembly (pre-release)

next 阶段统一 multipart transport。SW 现在识别 `messageKind: "_multipart"` 的运输层分片，透明还原原始 payload 后再按原始 `messageKind` 走现有分发和通知策略。

### New

- **`installReiSW(self, { multipart })`** — 新增 multipart 配置：
  - `enabled`（默认 `true`）
  - `ttlMs`（默认 `60_000`）
  - `maxTotalBytes`（默认 `256_000`）
  - `maxChunks`（默认 `128`）
  - `cleanupIntervalMs`（默认 `15 * 60_000`）
- **IndexedDB-backed pending multipart store** — 支持乱序、重复分片和 SW 重启恢复。
- **短期 done marker** — 收齐并投递后写 done 标记，避免 push service 重投递最后一片导致重复业务事件。
- **`REI_SW_EVENT.MULTIPART_EXPIRED`** — TTL 到期仍缺片时广播 `rei-amsg-multipart-expired`，payload 为 `{ id, received, total, originalMessageKind }`。

### Changed

- `_multipart` 是 transport layer，不会触发业务事件，也不会 `showNotification`。
- multipart 收齐后恢复成原始 JSON payload，再递归进入普通 dispatch。应用层只会看到完整的 `content` / `reasoning` / `tool_request` / `error` / 自定义 kind payload。
- `content` multipart 收齐后照常 `postMessage` + `showNotification`；`reasoning` / `tool_request` / `error` 仍默认不通知。

### Migration

- 应用级 SW 可以删除旧 reasoning `chunkIndex` / `totalChunks` 拼接逻辑。
- 旧 reasoning chunk wire format 不再由 `@rei-standard/amsg-instant` next 版本发送；接收 oversized reasoning 需要本版本的 generic multipart 支持。

## 2.1.0-next.1 — 标题 fallback 至 `来自 {contactName}` (pre-release)

Cherry-pick stable `2.0.2` 的标题 fallback 修复到 next 预发布线。`createNotificationFromPayload` 的标题链从

```js
pushNotification.title || payload.title || 'New notification'
```

加一档 `contactName` 兜底，与 server / instant 默认 envelope 的 `title: '来自 ${contactName}'` 行为对齐：

```js
pushNotification.title
  || payload.title
  || (payload.contactName && `来自 ${payload.contactName}`)
  || 'New notification'
```

custom hook（0.7.x / 0.8.0-next.x 自定义 envelope）忘了塞 `title` 但塞了 `contactName` 的情况，通知不再掉到 'New notification' 这种英文兜底上。

与 `@rei-standard/amsg-server` 2.4.0-next.1 / `@rei-standard/amsg-instant` 0.8.0-next.1 / `@rei-standard/amsg-client` 2.3.0-next.1（avatarUrl 软清空）同步。

`next.0` → `next.1` 行为变化只此一项；三轴 push schema 部分**完全不动**。

## 2.1.0-next.0 — Three-axis push schema + per-kind client events (pre-release)

Published under the `next` dist-tag (repo convention for prereleases). Coordinated with the other amsg sub-packages' `*-next.0` releases. Install with `npm install @rei-standard/amsg-sw@next`. Schema is locked; the next-tag window is for downstream integrators to validate end-to-end before this graduates to `latest`.

---

Coordinated minor with the rest of the amsg ecosystem. The SW now consumes the `AmsgPush` discriminated union from `@rei-standard/amsg-shared` (keyed by `payload.messageKind`) and bridges every push to controlled clients via a per-kind `postMessage` channel, so apps can render `reasoning` / `tool_request` / `error` in-app without going through the OS notification surface.

### New

- **`REI_SW_EVENT` constants** — per-kind event names dispatched to clients. Five values: `CONTENT_RECEIVED` / `REASONING_RECEIVED` / `TOOL_REQUEST_RECEIVED` / `ERROR_RECEIVED` / `UNKNOWN_RECEIVED`. The last one is the back-compat path for 2.0.x payloads (and blob envelopes) that lack `messageKind`.
- **`REI_AMSG_POSTMESSAGE_TYPE` constant** (= `'REI_AMSG_PUSH'`) — the `type` field on every SW → client envelope. Clients filter on this before reading `event` so a single `message` listener can coexist with other postMessage protocols.
- **Per-kind client dispatch.** Every push the SW receives is mirrored to every controlled window via `client.postMessage({ type: 'REI_AMSG_PUSH', event, payload })`. `clients.matchAll` runs with `{ type: 'window', includeUncontrolled: true }` so the broadcast reaches pages that haven't yet claimed the SW.
- **Blob envelope dispatch.** Envelopes like `{ _blob: true, key, url, messageKind, type? }` are forwarded to clients verbatim with the matching per-kind event name. The SW does NOT auto-fetch the blob body — the client decides whether and when to fetch.
- **Runtime dep on `@rei-standard/amsg-shared@0.1.0`** (exact, no caret). The SW code only references shared types via JSDoc `@typedef`; no runtime symbol is imported. Listing the dep keeps the package present in the dependency graph for hoisting / type resolution alongside `amsg-instant` and `amsg-server`.
- **First test suite.** `test/dispatch.test.mjs` covers every dispatch branch using a lightweight `ServiceWorkerGlobalScope` mock — no real Workbox or sw environment needed. The package now ships a real `npm test` script (`node --test test/*.test.mjs`).

### Behavioral

- **`showNotification` only fires for content kinds.** Concretely, the SW renders a notification iff `payload.messageKind === 'content'` OR `messageKind` is absent (legacy 2.0.x back-compat). `reasoning` / `tool_request` / `error` are dispatched to clients but render nothing on the OS notification surface. Same rule applies to blob envelopes — only `messageKind === 'content'` (or absent) renders a placeholder notification.
- **Per-client `postMessage` failures are swallowed.** One offline / broken tab should not abort delivery to the rest. The `dispatchPushToClients` helper wraps each `postMessage` in its own try/catch.
- **`clients.matchAll` rejection is non-fatal.** If the call rejects, the SW still attempts `showNotification` for `content` payloads — notification rendering is independent of the broadcast path.
- **Dispatch order is best-effort parallel.** The SW kicks off `postMessage` broadcasting and `showNotification` together inside one `event.waitUntil(Promise.all(...))`. Clients should not assume the notification has been rendered (or vice versa) before the message arrives.
- **Existing `REI_SW_MESSAGE_TYPE` queue API is unchanged.** Enqueue / flush / sync paths are unaffected — the new dispatch logic only adds to the `push` listener.

### Migration

- **Apps that want desktop notifications for non-content kinds must implement them in-app.** Listen on `navigator.serviceWorker.addEventListener('message', ...)`, filter by `e.data.type === 'REI_AMSG_PUSH'`, switch on `e.data.event`, and call `Notification.requestPermission()` + `new Notification(...)` (or `registration.showNotification`) yourself for the kinds you care about. The SW intentionally no longer makes that decision for you.
- **No producer-side change is required** for 2.0.x callers that have not yet adopted the three-axis schema — their payloads route through `UNKNOWN_RECEIVED` and still render notifications via the existing path.
- **TS / JSDoc users** can pull `AmsgPush`, `ContentPush`, etc. from `@rei-standard/amsg-shared` to type the client-side `e.data.payload`. The SW package itself only references those types via JSDoc and does not re-export them.

## 2.0.1

- Maintenance release. No behavioral changes documented prior to this changelog.

## 2.0.0

- Initial public release of the v2 SW SDK with `installReiSW` + offline queue.
