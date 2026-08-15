/**
 * ReiStandard Service Worker helpers.
 *
 * Drop-in plugin for Service Workers that handles:
 *  - Three-axis `push` payload dispatch — keyed by `payload.messageKind`
 *    (see `@rei-standard/amsg-shared`). Every push is mirrored to every
 *    controlled client via `postMessage` under a per-kind event name.
 *  - Notification rendering for `messageKind: 'content'` / `'result'` (and
 *    legacy payloads without `messageKind`, for back-compat with 2.0.x
 *    producers).
 *  - Generic `_multipart` transport reassembly. Multipart chunks are
 *    stored below the business layer and never dispatched until the
 *    original payload has been fully restored.
 *  - Offline request queueing and retry with Background Sync.
 *
 * Notes:
 *  - This plugin intentionally does not install `notificationclick`.
 *    Main applications can implement their own click navigation logic.
 *  - `reasoning` / `tool_request` / `error` pushes are dispatched as
 *    `postMessage` events but **do not** trigger `showNotification` —
 *    apps render those in-app via the postMessage channel.
 *  - Blob envelopes (`{ _blob: true, key, url, messageKind? }`) are
 *    dispatched to clients verbatim. The SW never auto-fetches the
 *    blob body — that's the client's job.
 *  - Multipart is different: it is a transparent transport fallback.
 *    Apps see only the restored original payload.
 *  - When a multipart id cannot be completed, `MULTIPART_EXPIRED` carries a
 *    `reason` telling the app which way it failed — waited past the TTL, or
 *    gave up on the spot (bad envelope, chunks disagreeing, over the size
 *    limit, unrestorable, storage broken, multipart turned off locally).
 *    See `MULTIPART_FAILURE_REASON` for the values.
 *
 * Usage (inside your sw.js):
 *   import { installReiSW, REI_SW_EVENT, REI_SW_MESSAGE_TYPE } from '@rei-standard/amsg-sw';
 *   installReiSW(self);
 *
 * Usage (inside your web app):
 *   navigator.serviceWorker.addEventListener('message', (e) => {
 *     if (e.data?.type !== 'REI_AMSG_PUSH') return;
 *     switch (e.data.event) {
 *       case REI_SW_EVENT.CONTENT_RECEIVED:      // render in-app message
 *       case REI_SW_EVENT.REASONING_RECEIVED:    // render thinking UI
 *       case REI_SW_EVENT.TOOL_REQUEST_RECEIVED: // prompt tool exec
 *       case REI_SW_EVENT.ERROR_RECEIVED:        // show error toast
 *       case REI_SW_EVENT.RESULT_RECEIVED:       // 宿主自定义结果，页面自己消化
 *       case REI_SW_EVENT.MULTIPART_EXPIRED:    // observe incomplete transport
 *       case REI_SW_EVENT.UNKNOWN_RECEIVED:      // legacy 2.0.x payload
 *     }
 *   });
 */

/**
 * @typedef {import('@rei-standard/amsg-shared').AmsgPush} AmsgPush
 * @typedef {import('@rei-standard/amsg-shared').ContentPush} ContentPush
 * @typedef {import('@rei-standard/amsg-shared').ReasoningPush} ReasoningPush
 * @typedef {import('@rei-standard/amsg-shared').ToolRequestPush} ToolRequestPush
 * @typedef {import('@rei-standard/amsg-shared').ErrorPush} ErrorPush
 * @typedef {import('@rei-standard/amsg-shared').ResultPush} ResultPush
 */

import {
  MESSAGE_KIND,
  MULTIPART_MESSAGE_KIND,
  MULTIPART_ENCODING,
  MULTIPART_VERSION,
  DEFAULT_MULTIPART_TTL_MS,
  DEFAULT_MULTIPART_MAX_CHUNKS,
  DEFAULT_MULTIPART_MAX_TOTAL_BYTES,
  MULTIPART_FAILURE_REASON,
  REI_AMSG_POSTMESSAGE_TYPE,
  REI_SW_EVENT,
  REI_SW_MESSAGE_TYPE,
  REI_AMSG_DELIVER_MESSAGE_TYPE,
  notificationIntent,
  base64UrlToBytes,
  concatBytes,
} from '@rei-standard/amsg-shared';

const REI_SW_DB_NAME = 'rei-sw';
const REI_SW_DB_STORE = 'request-outbox';
const REI_SW_MULTIPART_STORE = 'multipart-pending';
const REI_SW_MULTIPART_DONE_STORE = 'multipart-done';
const REI_SW_MULTIPART_CHUNK_STORE = 'multipart-chunk';
const REI_SW_DB_VERSION = 3;
let cachedDB = null;
const REI_AMSG_DEDUPE_DB_NAME = 'rei_amsg_sw_dedupe_v1';
const REI_AMSG_DEDUPE_STORE = 'delivery-dedupe';
const DEFAULT_DEDUPE_TTL_MS = 10 * 60_000;
const DEFAULT_DEDUPE_CLEANUP_INTERVAL_MS = 60_000;
const REI_SW_SYNC_TAG = 'rei-sw-flush-request-outbox';
// 通知正文的兜底文案（opts.defaultBody 可覆盖），见 resolveNotificationBody。
const DEFAULT_NOTIFICATION_BODY = 'New message';
// multipart 的 kind / encoding / version 与限额默认值来自
// @rei-standard/amsg-shared 的 protocol 模块（与 instant 发送端同一份）。
const DEFAULT_MULTIPART_OPTIONS = Object.freeze({
  enabled: true,
  ttlMs: DEFAULT_MULTIPART_TTL_MS,
  maxTotalBytes: DEFAULT_MULTIPART_MAX_TOTAL_BYTES,
  maxChunks: DEFAULT_MULTIPART_MAX_CHUNKS,
  cleanupIntervalMs: 15 * 60_000,
});
const memoryMultipartPending = new Map();
const memoryMultipartDone = new Map();
const memoryMultipartChunks = new Map();
const multipartLocks = new Map();
/**
 * 已经报过「这条 multipart 收不了」的 id → 这条记录自己的过期时刻。
 *
 * 一条消息的分片是一起发出来的，被拒收时（信封不合规、本地关掉了 multipart、
 * 分片仓库坏掉）每一片都会各走一次拒收出口，页面就会为同一条消息收到几十条
 * 一模一样的 MULTIPART_EXPIRED。这些分片一片都不落库，写不了 done 墓碑，所以
 * 记在内存里：同一条消息的分片只隔几秒就到齐，SW 睡了重启最多让它多报一次。
 *
 * 这张表同时就是这条结论的墓碑：报过之后，这个 id 的分片不再进重组管线、TTL
 * 清扫也不再为它广播第二次（见 multipartIdAlreadyRejected）。墓碑记在内存而不
 * 是 IndexedDB，是因为走到拒收出口的路里就有一条是「IndexedDB 刚刚出错」——那
 * 时候再去写一条 done 记录，多半也是白写。
 */
const rejectedMultipartIds = new Map();
const dedupeDbCache = new Map();

// SW ↔ 页面 postMessage 常量（REI_AMSG_POSTMESSAGE_TYPE / REI_SW_EVENT /
// REI_SW_MESSAGE_TYPE / REI_AMSG_DELIVER_MESSAGE_TYPE）单一来源在
// @rei-standard/amsg-shared 的 protocol 模块，这里 re-export 保持本包
// 既有导出名不变。页面侧代码建议直接从 shared import 这些常量——从本包
// import 会执行 SW 模块的顶层状态，在窗口环境里并不合适。
export {
  MULTIPART_FAILURE_REASON,
  REI_AMSG_POSTMESSAGE_TYPE,
  REI_SW_EVENT,
  REI_SW_MESSAGE_TYPE,
  REI_AMSG_DELIVER_MESSAGE_TYPE,
} from '@rei-standard/amsg-shared';

/**
 * @typedef {Object} ReiSWOptions
 * @property {string} [defaultIcon]  - Fallback notification icon URL.
 * @property {string} [defaultBadge] - Fallback notification badge URL.
 * @property {string} [defaultBody]  - Fallback notification body, used when the
 *   payload's body/message is empty or blank (default `'New message'`).
 * @property {Object} [multipart]
 * @property {boolean} [multipart.enabled=true]
 * @property {number} [multipart.ttlMs=60000]
 * @property {number} [multipart.maxTotalBytes=256000]
 * @property {number} [multipart.maxChunks=128]
 * @property {number} [multipart.cleanupIntervalMs=900000]
 * @property {Object} [dedupe]
 * @property {boolean} [dedupe.enabled=true]
 * @property {number} [dedupe.ttlMs=600000]
 * @property {number} [dedupe.cleanupIntervalMs=60000]
 * @property {(payload: any) => string | undefined} [dedupe.key]
 * @property {string} [dedupe.dbName='rei_amsg_sw_dedupe_v1'] - 隔离去重数据用。每个 dbName 对应一个独立的 IndexedDB instance，互不影响。`dedupe.storeName` 不再可配（传了会抛错）；本包不维护跨 storeName 的迁移逻辑。
 * @property {(payload: any) => void | Promise<void>} [onBusinessPayload]
 * @property {(info: { key: string, source: string, messageKind?: string, firstSeenAt?: number, existingSource?: string, existingMessageKind?: string, existingNotificationShown?: boolean, duplicateNotificationShown?: boolean }) => void | Promise<void>} [onDuplicate]
 */

/**
 * Install the ReiStandard Service Worker baseline handlers.
 *
 * @param {ServiceWorkerGlobalScope} sw   - Typically `self` inside a SW script.
 * @param {ReiSWOptions}             [opts]
 */
export function installReiSW(sw, opts = {}) {
  const defaultIcon = opts.defaultIcon || '/icon-192x192.png';
  const defaultBadge = opts.defaultBadge || '/badge-72x72.png';
  // 正文空白时顶上的那一句，见 resolveNotificationBody。
  const defaultBody = opts.defaultBody || DEFAULT_NOTIFICATION_BODY;
  const multipart = normalizeMultipartOptions(opts.multipart);
  const dedupe = normalizeDedupeOptions(opts.dedupe);
  let lastMultipartCleanupAt = 0;
  let lastDedupeCleanupAt = 0;
  const makeDeliveryContext = (source) => ({
    defaultBadge,
    defaultIcon,
    defaultBody,
    dedupe,
    multipart,
    onDuplicate: opts.onDuplicate,
    onBusinessPayload: opts.onBusinessPayload,
    source,
    getLastDedupeCleanupAt: () => lastDedupeCleanupAt,
    setLastDedupeCleanupAt: (value) => { lastDedupeCleanupAt = value; },
    getLastMultipartCleanupAt: () => lastMultipartCleanupAt,
    setLastMultipartCleanupAt: (value) => { lastMultipartCleanupAt = value; },
  });

  sw.addEventListener('push', (event) => {
    const payload = readPushPayload(event);
    if (!payload) return;

    event.waitUntil(handlePushPayload(sw, payload, makeDeliveryContext('webpush')));
  });

  sw.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    if (message.type === REI_SW_MESSAGE_TYPE.ENQUEUE_REQUEST) {
      event.waitUntil(
        enqueueAndFlush(sw, event, message.request)
      );
      return;
    }

    if (message.type === REI_SW_MESSAGE_TYPE.DELIVER) {
      event.waitUntil(handleDeliverMessage(sw, event, message, makeDeliveryContext()));
      return;
    }

    if (message.type === REI_SW_MESSAGE_TYPE.FLUSH_QUEUE) {
      event.waitUntil(flushQueuedRequests(sw));
    }
  });

  sw.addEventListener('sync', (event) => {
    if (event.tag !== REI_SW_SYNC_TAG) return;
    event.waitUntil(flushQueuedRequests(sw));
  });
}

async function handlePushPayload(sw, payload, ctx) {
  await maybeCleanupMultipart(sw, ctx);

  if (isMultipartPush(payload)) {
    if (!ctx.multipart.enabled) {
      // 本地关掉了 multipart，发送端却还在发分片：这条消息在这里就到头了。
      // 出个声，别让页面拿着 id 一直等。
      await rejectMultipartChunk(
        sw,
        payload,
        ctx.multipart,
        MULTIPART_FAILURE_REASON.DISABLED,
        'multipart reassembly is disabled by options'
      );
      return;
    }
    const restoredPayload = await acceptMultipartChunkSafely(sw, payload, ctx.multipart);
    if (!restoredPayload) return;
    return handlePushPayload(sw, restoredPayload, ctx);
  }

  const claim = await claimDedupeSafely(payload, ctx);
  if (claim.duplicate) {
    const duplicateNotification = await maybeShowDuplicateNotification(sw, payload, claim, ctx);
    claim.duplicateNotification = duplicateNotification;
    await notifyDuplicate(payload, claim, ctx);
    const result = { ...claim, duplicateNotification };
    if (duplicateNotification && duplicateNotification.error !== undefined) {
      result.notificationError = duplicateNotification.error;
    }
    // The first delivery claims this key and runs business once. If that
    // business failed, the failure is persisted on the dedupe record — and a
    // duplicate (sender retry, or the other transport's backup) is the only
    // later chance to repair the missed inbox write. Re-run the business
    // callback here, mirroring the notification repair path above, and keep
    // the ack honest when even the re-run fails.
    // Read the LATEST record, not the pre-await `claim.existing` snapshot:
    // while we awaited the repair path above, an in-flight first delivery may
    // have just persisted its businessError, which the stale snapshot misses.
    // No businessError on the record means the first delivery's business
    // either succeeded or is still in flight (a failure is only persisted
    // after it settles) — in both cases the duplicate must NOT run business:
    // a success would be double-written, and an in-flight first delivery
    // would race its own retry.
    const businessError = await readDuplicateBusinessError(claim, ctx);
    if (businessError !== undefined) {
      const remainingError = await repairDuplicateBusiness(payload, claim, ctx, businessError);
      // A successful re-run means the payload has now landed — do not carry
      // the stale failure on the ack (callers read businessError as
      // "dispatched but not persisted").
      if (remainingError !== undefined) {
        result.businessError = remainingError;
      }
    }
    return result;
  }

  const dispatchResult = await dispatchBusinessPayload(sw, payload, {
    defaultIcon: ctx.defaultIcon,
    defaultBadge: ctx.defaultBadge,
    defaultBody: ctx.defaultBody,
    onBusinessPayload: ctx.onBusinessPayload,
  }, async (intermediateResult) => {
    // Settle the dedupe pending flag as soon as the notification policy
    // is decided (dispatch + showNotification done) — do NOT wait for
    // onBusinessPayload. A backup arriving mid-business would otherwise
    // hit `notificationStatePending` and skip the repair path.
    await updateDedupeNotificationState(claim, ctx, intermediateResult);
  });
  const notificationError = dispatchResult && dispatchResult.notification
    ? dispatchResult.notification.error
    : undefined;
  if (notificationError !== undefined) {
    claim.notificationError = notificationError;
  }
  const businessError = dispatchResult ? dispatchResult.businessError : undefined;
  if (businessError !== undefined) {
    claim.businessError = businessError;
    // Persist the failure on the dedupe record so later duplicates of this
    // same key (a retry, or the other transport's backup) can report it too.
    await updateDedupeBusinessState(claim, ctx, businessError);
  }
  return claim;
}

async function handleDeliverMessage(sw, event, message, ctx) {
  let result = {};
  try {
    if (!Object.prototype.hasOwnProperty.call(message, 'payload')) {
      throw new Error('[rei-standard-amsg-sw] REI_AMSG_DELIVER requires payload');
    }
    const source = typeof message.source === 'string' && message.source
      ? message.source
      : 'message';
    result = await handlePushPayload(sw, message.payload, { ...ctx, source }) || {};
    const ack = {
      ok: true,
      duplicate: Boolean(result.duplicate),
      key: result.key,
      requestId: message.requestId,
    };
    // `ok` means "received and dispatched", NOT "business persisted". When
    // the consumer's onBusinessPayload failed, surface it without flipping
    // `ok`, so existing callers keep working and stricter callers can react.
    if (result.businessError !== undefined) {
      ack.businessError = result.businessError;
    }
    // 去重仓库坏掉时这条 payload 是「绕过去重直接投递」的（见
    // claimDedupeSafely）。分发本身成功了，所以 `ok` 保持 true，但发送端得
    // 知道这次没有去重保护——同一条消息的另一路 backup 可能会再投一次。
    if (result.dedupeError !== undefined) {
      ack.dedupeError = result.dedupeError;
    }
    // 通知没弹出来（权限被撤 / 配额 / OS 错误）。payload 收下了也分发了，所以
    // `ok` 保持 true；但把 DELIVER 当备份通道用的发送端要靠这个字段判断这条
    // 消息用户到底看没看见。
    if (result.notificationError !== undefined) {
      ack.notificationError = result.notificationError;
    }
    respondToSender(event, ack);
  } catch (error) {
    respondToSender(event, {
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to deliver payload',
      key: result && result.key,
      requestId: message.requestId,
    });
  }
}

async function dispatchBusinessPayload(sw, payload, defaults, onNotificationSettled) {
  const eventName = resolveEventName(payload);

  let clientList = [];
  try {
    clientList = await sw.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });
  } catch (_matchError) {
    // Ignored
  }

  const notificationState = {
    shouldRender: shouldRenderNotification(payload, clientList),
    shown: false,
  };

  /** @type {Array<Promise<unknown>>} */
  const notificationWork = [dispatchPushToClients(sw, eventName, payload, clientList)];

  if (notificationState.shouldRender) {
    const notification = createNotificationFromPayload(payload, defaults);
    // A rejected showNotification (permission revoked / quota / OS error)
    // must NOT stop onNotificationSettled from running — that callback is
    // the only thing that clears `notificationStatePending`, and leaving
    // it stuck makes the backup transport's repair path swallow every
    // duplicate as 'first-delivery-pending'.
    notificationWork.push(
      sw.registration.showNotification(notification.title, notification.options)
        .then(
          () => { notificationState.shown = true; },
          (error) => {
            // 记下来（不只是打日志）：DELIVER 的回执要能说出「收下了，但没弹
            // 出来」，跟 businessError 同一个口径。
            notificationState.error = errorToMessage(error);
            console.error('[rei-standard-amsg-sw] showNotification rejected:', error);
          }
        )
    );
  }

  // Kick the user's business callback off in parallel with notification
  // work, but do NOT block notification-state settlement on it. A slow
  // onBusinessPayload would otherwise keep `notificationStatePending`
  // set, and a Web Push backup arriving in that window would be swallowed
  // as 'first-delivery-pending' with no chance to repair a missed
  // notification. The overall waitUntil chain still awaits the business
  // callback below so the SW does not get killed mid-flight.
  let businessWork = null;
  let businessError;
  if (typeof defaults.onBusinessPayload === 'function') {
    try {
      const result = defaults.onBusinessPayload(payload);
      if (result && typeof result.then === 'function') {
        businessWork = Promise.resolve(result).then(
          () => {},
          (error) => {
            // Capture (do not swallow) the rejection so the DELIVER ack can
            // reflect that the payload was dispatched but not persisted.
            businessError = errorToMessage(error);
            console.error('[rei-standard-amsg-sw] onBusinessPayload promise rejected:', error);
          }
        );
      }
    } catch (error) {
      businessError = errorToMessage(error);
      console.error('[rei-standard-amsg-sw] onBusinessPayload error:', error);
    }
  }

  await Promise.all(notificationWork);
  const settledResult = { eventName, notification: notificationState };
  if (typeof onNotificationSettled === 'function') {
    await onNotificationSettled(settledResult);
  }
  if (businessWork) await businessWork;

  // Resolved as `undefined` on success — callers only act when it is set.
  settledResult.businessError = businessError;
  return settledResult;
}

/**
 * Map a parsed push payload to its corresponding per-kind event name.
 * Falls back to `UNKNOWN_RECEIVED` for legacy 2.0.x payloads and blob
 * envelopes without `messageKind`.
 *
 * @param {Record<string, unknown>} payload
 * @returns {string}
 */
function resolveEventName(payload) {
  const kind = payload && typeof payload === 'object' ? payload.messageKind : undefined;
  switch (kind) {
    case MESSAGE_KIND.CONTENT:
      return REI_SW_EVENT.CONTENT_RECEIVED;
    case MESSAGE_KIND.REASONING:
      return REI_SW_EVENT.REASONING_RECEIVED;
    case MESSAGE_KIND.TOOL_REQUEST:
      return REI_SW_EVENT.TOOL_REQUEST_RECEIVED;
    case MESSAGE_KIND.ERROR:
      return REI_SW_EVENT.ERROR_RECEIVED;
    case MESSAGE_KIND.RESULT:
      return REI_SW_EVENT.RESULT_RECEIVED;
    default:
      return REI_SW_EVENT.UNKNOWN_RECEIVED;
  }
}

/**
 * True when the payload should trigger `showNotification`.
 *
 * 弹不弹的判定本身在 `@rei-standard/amsg-shared` 的 `notificationIntent`：
 * `notification.show` 说了算，没说才按 `messageKind` 走默认（`content` /
 * `result` 与缺 kind 的 2.0.x 老 payload 弹，`reasoning` / `tool_request` /
 * `error` 不弹）。判定放在 shared 是因为发送端也要用同一份——服务端据此决定
 * 一条 payload 值不值得占用推送通道。
 *
 * 这里只多做一件 shared 做不了的事：`'when-hidden'` 要看当下有没有可见窗口，
 * 而那只有 SW 知道。
 *
 * @param {Record<string, unknown>} payload
 * @param {Array<Client>} clientList
 * @returns {boolean}
 */
function shouldRenderNotification(payload, clientList) {
  const intent = notificationIntent(payload);
  if (intent === 'always') return true;
  if (intent === 'never') return false;
  // 'when-hidden'：规范允许 user agent 在有可见窗口时免掉「必须展示通知」的
  // 约束，Chrome 认这条豁免，iOS 不认——前台静默掉的那条 push 在 iOS 那边照
  // 样记账，宽限期过了就吊销订阅。所以它是给老部署留的兼容档，新代码要推就发
  // 'always' + tag 折叠，不想弹就别把它发成 push（见 README 的「不展示通知的
  // 代价」一节）。
  return !clientList.some(client => client.visibilityState === 'visible');
}

/**
 * Broadcast a parsed push payload to every controlled client. Failures
 * on individual `postMessage` calls are swallowed — one offline tab
 * shouldn't break delivery to the others. The whole broadcast is
 * resolved (never rejected) so it can be safely passed to
 * `event.waitUntil`.
 *
 * @param {ServiceWorkerGlobalScope} sw
 * @param {string}                   eventName
 * @param {Record<string, unknown>}  payload
 * @param {Array<Client>|null} [preFetchedClientList] - reuse an already
 *   fetched `clients.matchAll` result instead of fetching again.
 * @returns {Promise<void>}
 */
async function dispatchPushToClients(sw, eventName, payload, preFetchedClientList = null) {
  return broadcastToClients(sw, {
    type: REI_AMSG_POSTMESSAGE_TYPE,
    event: eventName,
    payload
  }, preFetchedClientList);
}

/**
 * 把一条信封广播给所有窗口客户端。单个 client 的 postMessage 失败不影响其他
 * 窗口，拿不到 client 列表也只是没人收到——这个 helper 永远 resolve，可以直
 * 接扔给 `event.waitUntil`。
 *
 * @param {ServiceWorkerGlobalScope} sw
 * @param {Record<string, unknown>}  envelope
 * @param {Array<Client>|null} [preFetchedClientList]
 * @returns {Promise<void>}
 */
async function broadcastToClients(sw, envelope, preFetchedClientList = null) {
  try {
    const clientList = preFetchedClientList || await sw.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });
    for (const client of clientList) {
      try {
        client.postMessage(envelope);
      } catch (_postError) {
        // Per-client failures must not abort the broadcast.
      }
    }
  } catch (_matchError) {
    // No window clients available, or the matchAll call rejected. Either
    // way, a broadcast is a courtesy to the page — it must never be the
    // thing that fails its caller.
  }
}

function readPushPayload(event) {
  if (!event.data) return null;

  try {
    return event.data.json();
  } catch (_jsonError) {
    try {
      return { message: event.data.text() };
    } catch (_textError) {
      return null;
    }
  }
}

/**
 * 通知正文的兜底：正文取下来是空的（发送方漏了、或者内容被上游截没了）时用
 * 这一句顶上，而不是弹一条只有标题、正文空白的横幅——用户在锁屏上看到一条什
 * 么都没有的消息、未读 +1、点进去也是空的。
 *
 * 兜底只能是「弹一条有内容的」，不能是「干脆不弹」：订阅是按
 * `userVisibleOnly: true` 建的，每条 push 都欠用户一次可见反馈，不弹会被
 * Firefox 按配额退订、被 iOS 在订阅的宽限期过后直接吊销（见 README 的
 * 「不展示通知的代价」一节）。
 *
 * @param {unknown} value - 从 payload 上取到的正文
 * @param {{ defaultBody: string }} defaults
 * @returns {string}
 */
function resolveNotificationBody(value, defaults) {
  const body = typeof value === 'string' ? value : '';
  if (body.trim()) return body;
  const fallback = defaults && defaults.defaultBody;
  return typeof fallback === 'string' && fallback.trim() ? fallback : DEFAULT_NOTIFICATION_BODY;
}

function createNotificationFromPayload(payload, defaults) {
  if (!payload || typeof payload !== 'object') {
    return {
      title: 'New notification',
      options: {
        body: resolveNotificationBody(payload == null ? '' : String(payload), defaults),
        icon: defaults.defaultIcon,
        badge: defaults.defaultBadge
      }
    };
  }

  const pushNotification = payload.notification && typeof payload.notification === 'object'
    ? payload.notification
    : {};

  const title =
    pushNotification.title ||
    payload.title ||
    (payload.contactName && `来自 ${payload.contactName}`) ||
    'New notification';
  const body = resolveNotificationBody(
    pushNotification.body || payload.body || payload.message || '',
    defaults
  );
  const data = pushNotification.data && typeof pushNotification.data === 'object'
    ? { ...pushNotification.data }
    : (payload.data && typeof payload.data === 'object' ? { ...payload.data } : {});

  // Keep original payload so the app can decide how to route clicks.
  if (data.payload == null) data.payload = payload;

  return {
    title,
    options: {
      body,
      icon: pushNotification.icon || payload.icon || payload.avatarUrl || defaults.defaultIcon,
      badge: pushNotification.badge || payload.badge || defaults.defaultBadge,
      tag: pushNotification.tag || payload.tag || payload.messageId || `rei-${Date.now()}`,
      data,
      renotify: Boolean(pushNotification.renotify ?? payload.renotify ?? false),
      requireInteraction: Boolean(
        pushNotification.requireInteraction ?? payload.requireInteraction ?? false
      ),
      silent: Boolean(pushNotification.silent ?? payload.silent ?? false)
    }
  };
}

function normalizeMultipartOptions(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    enabled: source.enabled !== false,
    ttlMs: positiveIntegerOrDefault(source.ttlMs, DEFAULT_MULTIPART_OPTIONS.ttlMs),
    maxTotalBytes: positiveIntegerOrDefault(
      source.maxTotalBytes,
      DEFAULT_MULTIPART_OPTIONS.maxTotalBytes
    ),
    maxChunks: positiveIntegerOrDefault(source.maxChunks, DEFAULT_MULTIPART_OPTIONS.maxChunks),
    cleanupIntervalMs: source.cleanupIntervalMs === 0
      ? 0
      : positiveIntegerOrDefault(
          source.cleanupIntervalMs,
          DEFAULT_MULTIPART_OPTIONS.cleanupIntervalMs
        ),
  };
}

function normalizeDedupeOptions(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};

  // storeName 不再可配。同 dbName 下 storeName 一变就要做 IDB 版本升级，
  // 暴露这个配置点的收益（一个内部 store 名字）远小于让用户踩 IDB upgrade
  // 坑的代价。隔离用 dbName —— 每个 dbName 是独立 IndexedDB instance。
  if (Object.prototype.hasOwnProperty.call(source, 'storeName')) {
    throw new Error(
      '[rei-standard-amsg-sw] dedupe.storeName 不再可配置。改 storeName 会触发 IndexedDB 版本升级，'
        + '本包不维护 migration 逻辑。需要隔离去重数据请改用 dedupe.dbName（每个 dbName 是独立 IDB 实例）。'
    );
  }

  return {
    enabled: source.enabled !== false,
    ttlMs: positiveIntegerOrDefault(source.ttlMs, DEFAULT_DEDUPE_TTL_MS),
    cleanupIntervalMs: source.cleanupIntervalMs === 0
      ? 0
      : positiveIntegerOrDefault(
          source.cleanupIntervalMs,
          DEFAULT_DEDUPE_CLEANUP_INTERVAL_MS
        ),
    key: typeof source.key === 'function' ? source.key : null,
    dbName: typeof source.dbName === 'string' && source.dbName.trim()
      ? source.dbName.trim()
      : REI_AMSG_DEDUPE_DB_NAME,
    storeName: REI_AMSG_DEDUPE_STORE,
    _memoryStore: new Map(),
  };
}

function positiveIntegerOrDefault(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * 去重是「防重复弹」的优化，不是投递的前置条件，所以它坏掉时应该多弹一条，
 * 而不是一条都不弹。claimDedupe 全程压在 IndexedDB 上（占坑 add、过期记录
 * 的 delete + 二次 add），设备存储写满、存储压力下连接被强关重开失败、宿主
 * 占了同名 dbName 却没有这个 store，都会让它抛错——裸 await 会把整条 push
 * 一起带走：通知不弹、页面收不到 postMessage、onBusinessPayload 不跑，只在
 * SW 控制台留一条 unhandled rejection。而订阅是按 `userVisibleOnly: true`
 * 建的，静默吞掉一条 push 的代价见 README 的「不展示通知的代价」一节。
 *
 * 因此这里整段兜住，失败时降级成「当作首次投递照常分发」，并把失败原因记在
 * claim 上：后续的记录写回据此跳过（store 已经坏了，再写只会刷屏），DELIVER
 * ack 也据此如实告诉发送端这条没走去重、可能重复。
 */
async function claimDedupeSafely(payload, ctx) {
  try {
    return await claimDedupe(payload, ctx);
  } catch (error) {
    console.error(
      '[rei-standard-amsg-sw] dedupe claim failed; delivering as a first delivery:',
      error
    );
    const key = ctx.dedupe && ctx.dedupe.enabled !== false
      ? resolveDedupeKey(payload, ctx.dedupe)
      : undefined;
    return { duplicate: false, key, dedupeError: errorToMessage(error) };
  }
}

async function claimDedupe(payload, ctx) {
  if (!ctx.dedupe || ctx.dedupe.enabled === false) {
    return { duplicate: false, key: undefined };
  }

  const key = resolveDedupeKey(payload, ctx.dedupe);
  if (!key) return { duplicate: false, key: undefined };

  await maybeCleanupDedupe(ctx);

  const now = Date.now();
  const record = {
    key,
    firstSeenAt: now,
    expiresAt: now + ctx.dedupe.ttlMs,
    source: ctx.source || 'unknown',
    messageKind: getPayloadMessageKind(payload),
    notificationShown: false,
    notificationStatePending: true,
  };

  if (await addDedupeRecord(ctx.dedupe, record)) {
    return { duplicate: false, key, record };
  }

  const existing = await readDedupeRecord(ctx.dedupe, key);
  if (existing && existing.expiresAt <= now) {
    await deleteDedupeRecord(ctx.dedupe, key);
    if (await addDedupeRecord(ctx.dedupe, record)) {
      return { duplicate: false, key, record };
    }
  }

  return {
    duplicate: true,
    key,
    record,
    existing: existing || null,
  };
}

async function updateDedupeNotificationState(claim, ctx, dispatchResult) {
  if (!claim || claim.duplicate || !claim.key || !ctx.dedupe || ctx.dedupe.enabled === false) return;
  // 占坑那一步就失败过（claimDedupeSafely 降级过来的），没有可更新的记录，
  // 再往坏掉的 store 里写只会多刷一条 error。
  if (claim.dedupeError !== undefined) return;
  if (!dispatchResult || !dispatchResult.notification) return;

  const notification = dispatchResult.notification;
  const next = {
    ...claim.record,
    notificationShown: notification.shown === true,
    notificationStatePending: false,
  };

  try {
    await putDedupeRecord(ctx.dedupe, next);
    claim.record = next;
  } catch (error) {
    console.error('[rei-standard-amsg-sw] dedupe notification state update failed:', error);
  }
}

/**
 * Persist a business-callback failure onto the dedupe record so that later
 * duplicates of the same key (a sender retry, or the other transport's
 * backup) can report it on their ack. Business runs at most once per key,
 * so this is the only place the failure can be remembered.
 */
async function updateDedupeBusinessState(claim, ctx, businessError) {
  if (businessError === undefined) return;
  if (!claim || claim.duplicate || !claim.key || !ctx.dedupe || ctx.dedupe.enabled === false) return;
  // 同 updateDedupeNotificationState：没占上坑就没有记录可以挂失败信息。
  if (claim.dedupeError !== undefined) return;

  try {
    // Attach only to the very record we claimed. While our business callback
    // ran, the stored record may have been:
    //   (a) repaired by a duplicate/backup — keep that by merging onto the
    //       LATEST record, not the first delivery's stale snapshot, so we
    //       don't flip `notificationShown` back and re-show a notification; or
    //   (b) replaced by a TTL-renewed claim (delete + re-add) — a fresh
    //       `firstSeenAt` means a different delivery now owns this key, and
    //       stamping our old failure onto it would mis-report that newer
    //       delivery (which may have succeeded).
    const latest = await readDedupeRecord(ctx.dedupe, claim.key);
    if (!latest || !claim.record || latest.firstSeenAt !== claim.record.firstSeenAt) return;
    const next = { ...latest, key: claim.key, businessError };
    await putDedupeRecord(ctx.dedupe, next);
    claim.record = next;
  } catch (error) {
    console.error('[rei-standard-amsg-sw] dedupe business state update failed:', error);
  }
}

/**
 * Resolve the businessError to report on a duplicate's ack. Reads the latest
 * persisted record (the first delivery's business may have failed and
 * persisted it after this duplicate snapshotted `claim.existing`), falling
 * back to that snapshot if the live read yields nothing.
 */
async function readDuplicateBusinessError(claim, ctx) {
  const snapshot = claim && claim.existing ? claim.existing.businessError : undefined;
  if (!ctx.dedupe || ctx.dedupe.enabled === false || !claim || !claim.key || !claim.existing) {
    return snapshot;
  }
  try {
    const latest = await readDedupeRecord(ctx.dedupe, claim.key);
    // Trust the live record only if it is still the same claim we duplicated.
    // A TTL-renewed claim (fresh `firstSeenAt`) belongs to a different, newer
    // delivery, so reporting its businessError on this stale duplicate's ack
    // would misattribute an unrelated failure. Mirrors the write path.
    if (latest && latest.firstSeenAt === claim.existing.firstSeenAt) {
      // The matching live record is authoritative — including an ABSENT
      // businessError, which means another duplicate's business re-run has
      // already repaired the failure. Falling back to the snapshot here
      // would resurrect the cleared error and trigger a needless re-run.
      return latest.businessError;
    }
  } catch (_readError) {
    // Fall back to the snapshot below.
  }
  return snapshot;
}

/**
 * Business self-heal for duplicates. The first delivery ran the consumer's
 * business callback and FAILED (e.g. a transient IndexedDB fault while
 * writing the inbox); the failure was persisted on the dedupe record. A
 * duplicate of that key is the natural retry vehicle, so re-run the business
 * callback once per duplicate:
 *  - success → clear `businessError` from the record (later duplicates go
 *    back to pure dedupe) and return `undefined` so the ack reads clean;
 *  - failure → persist the fresh error onto the record and return it so the
 *    ack keeps reporting the still-unresolved failure.
 * Only ever called when a businessError IS on the record — a first delivery
 * whose business succeeded or is still in flight never reaches this path.
 */
async function repairDuplicateBusiness(payload, claim, ctx, previousError) {
  if (typeof ctx.onBusinessPayload !== 'function') return previousError;

  let retryError;
  try {
    // `await` absorbs sync throws, promises and generic thenables alike —
    // the same callback surface dispatchBusinessPayload accepts on first
    // delivery.
    await ctx.onBusinessPayload(payload);
  } catch (error) {
    retryError = errorToMessage(error);
    console.error('[rei-standard-amsg-sw] onBusinessPayload re-run on duplicate failed:', error);
  }

  try {
    // Persist the outcome with the same ownership guard as the write path
    // (updateDedupeBusinessState): merge onto the LATEST record, and only if
    // it still belongs to the claim we duplicated — a TTL-renewed claim
    // (fresh `firstSeenAt`) is a different delivery and must not be stamped
    // with this stale duplicate's outcome.
    const latest = await readDedupeRecord(ctx.dedupe, claim.key);
    if (latest && claim.existing && latest.firstSeenAt === claim.existing.firstSeenAt) {
      const next = { ...latest, key: claim.key };
      if (retryError === undefined) {
        delete next.businessError;
      } else {
        next.businessError = retryError;
      }
      await putDedupeRecord(ctx.dedupe, next);
    }
  } catch (error) {
    console.error('[rei-standard-amsg-sw] dedupe business repair state update failed:', error);
  }

  return retryError;
}

async function maybeShowDuplicateNotification(sw, payload, claim, ctx) {
  const existing = claim && claim.existing ? claim.existing : null;
  if (!existing || existing.notificationShown === true) {
    return { shown: false, reason: existing ? 'already-shown' : 'no-existing-record' };
  }
  if (existing.notificationStatePending === true) {
    return { shown: false, reason: 'first-delivery-pending' };
  }

  let clientList = [];
  try {
    clientList = await sw.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });
  } catch (_matchError) {
    // Ignored
  }

  if (!shouldRenderNotification(payload, clientList)) {
    return { shown: false, reason: 'policy-suppressed' };
  }

  const notification = createNotificationFromPayload(payload, {
    defaultIcon: ctx.defaultIcon,
    defaultBadge: ctx.defaultBadge,
    defaultBody: ctx.defaultBody,
  });

  try {
    await sw.registration.showNotification(notification.title, notification.options);
  } catch (error) {
    // 补通知被拒（权限被撤 / 配额 / OS 错误）不能把整条 duplicate 处理带走：
    // 首投路径 dispatchBusinessPayload 也是这么处理的。但失败要如实带回去——
    // 发送端把 REI_AMSG_DELIVER 当备份通道用时，靠回执上的 notificationError
    // 才知道这条消息压根没弹出来，是该回退还是重试。
    console.error('[rei-standard-amsg-sw] duplicate showNotification rejected:', error);
    return { shown: false, reason: 'show-failed', error: errorToMessage(error) };
  }

  try {
    // Merge onto the LATEST record, not the pre-await `existing` snapshot:
    // while we awaited showNotification, the first delivery may have persisted
    // a `businessError` (or other fields) onto this key. Overwriting from the
    // stale snapshot would erase it and break the DELIVER ack contract.
    const latest = await readDedupeRecord(ctx.dedupe, claim.key);
    const base = latest || existing;
    const next = {
      ...base,
      notificationShown: true,
      notificationStatePending: false,
    };
    await putDedupeRecord(ctx.dedupe, next);
  } catch (error) {
    // 通知已经弹了，记不上账最多让下一条重复包再弹一次——比把整条 push
    // 挂掉强。
    console.error('[rei-standard-amsg-sw] duplicate notification state update failed:', error);
  }

  return { shown: true, reason: 'shown-from-duplicate' };
}

function resolveDedupeKey(payload, dedupe) {
  if (typeof dedupe.key === 'function') {
    try {
      const custom = dedupe.key(payload);
      return typeof custom === 'string' && custom.trim() ? custom.trim() : undefined;
    } catch (error) {
      console.error('[rei-standard-amsg-sw] dedupe.key error:', error);
      return undefined;
    }
  }

  if (!payload || typeof payload !== 'object') return undefined;
  for (const field of ['messageId', 'id', 'dedupeKey']) {
    const value = payload[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function getPayloadMessageKind(payload) {
  return payload && typeof payload === 'object' && typeof payload.messageKind === 'string'
    ? payload.messageKind
    : undefined;
}

async function notifyDuplicate(payload, claim, ctx) {
  if (typeof ctx.onDuplicate !== 'function') return;
  const existing = claim.existing || {};
  const info = {
    key: claim.key,
    source: ctx.source || 'unknown',
    messageKind: getPayloadMessageKind(payload),
    firstSeenAt: existing.firstSeenAt,
    existingSource: existing.source,
    existingMessageKind: existing.messageKind,
    existingNotificationShown: existing.notificationShown === true,
    duplicateNotificationShown: claim.duplicateNotification && claim.duplicateNotification.shown === true,
  };
  try {
    await ctx.onDuplicate(info);
  } catch (error) {
    console.error('[rei-standard-amsg-sw] onDuplicate error:', error);
  }
}

async function maybeCleanupDedupe(ctx) {
  if (!ctx.dedupe || ctx.dedupe.enabled === false || ctx.dedupe.cleanupIntervalMs === 0) return;
  const now = Date.now();
  const last = ctx.getLastDedupeCleanupAt ? ctx.getLastDedupeCleanupAt() : 0;
  if (last && now - last < ctx.dedupe.cleanupIntervalMs) return;
  if (ctx.setLastDedupeCleanupAt) ctx.setLastDedupeCleanupAt(now);
  try {
    await cleanupDedupeStore(ctx.dedupe, now);
  } catch (error) {
    console.error('[rei-standard-amsg-sw] dedupe cleanup failed:', error);
  }
}

async function cleanupDedupeStore(dedupe, now) {
  if (!hasIndexedDB()) {
    const store = memoryDedupeStoreFor(dedupe);
    for (const [key, record] of store.entries()) {
      if (record.expiresAt <= now) store.delete(key);
    }
    return;
  }

  await withDedupeStore(dedupe, 'readwrite', (store, resolve, reject) => {
    const index = store.index('expiresAt');
    const range = IDBKeyRange.upperBound(now);
    let failed = false;
    const request = index.openCursor(range);
    request.onsuccess = () => {
      if (failed) return;
      const cursor = request.result;
      if (!cursor) {
        resolve(undefined);
        return;
      }

      const deleteRequest = cursor.delete();
      deleteRequest.onsuccess = () => {
        if (failed) return;
        cursor.continue();
      };
      deleteRequest.onerror = () => {
        if (!failed) {
          failed = true;
          reject(deleteRequest.error || new Error('Failed to delete expired dedupe record'));
        }
      };
    };
    request.onerror = () => reject(request.error || new Error('Failed to scan expired dedupe records'));
  });
}

function isMultipartPush(payload) {
  return !!payload &&
    typeof payload === 'object' &&
    payload.messageKind === MULTIPART_MESSAGE_KIND &&
    payload.multipart &&
    typeof payload.multipart === 'object' &&
    typeof payload.chunk === 'string';
}

/**
 * 分片重组同样全程压在 IndexedDB 上（done 标记、pending 记录、chunk 本体），
 * 存储出错时一样不能让整条 push 挂掉。但这条路的「降级」不能照搬普通 push 的
 * 「当作首次投递照常分发」——手里只有一个分片，拿去弹通知就是把半条乱码推给
 * 用户。所以降级成「这个 multipart id 收不齐了」：丢掉这片、留一条能归因的
 * 日志，并按既有的 MULTIPART_EXPIRED 事件告诉页面别再等下去（TTL 清扫要靠
 * pending 记录才触发，而写 pending 正是刚刚失败的那一步，等不到）。
 *
 * 存储出错往往只是一阵子的事（连接被强关、配额一时不够），所以这句话尤其得说
 * 到做到：这条 id 会随即记进内存墓碑，后面的分片和推送服务的重投都不再收。不
 * 记的话，剩下的分片照样能把这条消息拼齐投出来，页面却已经挂上了「这条收不
 * 到」——一条读得到的消息旁边永远挂着失败横幅，而且再也没有事件能撤掉它。
 */
async function acceptMultipartChunkSafely(sw, payload, options) {
  try {
    return await acceptMultipartChunk(sw, payload, options);
  } catch (error) {
    await rejectMultipartChunk(
      sw,
      payload,
      options,
      MULTIPART_FAILURE_REASON.STORAGE_FAILED,
      error
    );
    return null;
  }
}

/**
 * 「这条 multipart 收不了」的统一出口：信封不合规、本地把 multipart 关了、分片
 * 仓库出错。这三条都是当场下的结论，跟「等到 TTL 也没收齐」不是一回事。
 *
 * 归因日志和给页面的 MULTIPART_EXPIRED 只能在这里发：这几条路上写不了 done 墓
 * 碑（存储出错那次，坏的正是 IndexedDB），pending 记录也不一定有，TTL 清扫未必
 * 扫得到这个 id。
 *
 * 结论在这里就得钉死——报过之后这个 id 记进 {@link rejectedMultipartIds}，同 id
 * 的分片一律不再收。只广播不钉死的话，剩下的分片会把这条消息照常拼齐投递出去，
 * 页面那边的「收不到」却撤不掉了。
 *
 * `id` 都读不出来时只留日志：没有 id 的事件页面也对不上号。
 *
 * @param {ServiceWorkerGlobalScope} sw
 * @param {any}    payload - 原始的 `_multipart` push payload。
 * @param {{ ttlMs: number }} options - 归一化后的 multipart 配置，用来算墓碑活多久。
 * @param {string} reason  - {@link MULTIPART_FAILURE_REASON} 之一。
 * @param {string} detail  - 写进日志的具体原因。
 */
async function rejectMultipartChunk(sw, payload, options, reason, detail) {
  const meta = payload && typeof payload.multipart === 'object' && payload.multipart
    ? payload.multipart
    : {};
  if (typeof meta.id !== 'string' || !meta.id) {
    console.error(
      `[rei-standard-amsg-sw] multipart chunk rejected (${reason}):`,
      detail,
      { id: meta.id, index: meta.index, total: meta.total }
    );
    return;
  }

  const now = Date.now();
  pruneRejectedMultipartIds(now);
  // 同一个 id 只报一次：日志和给页面的事件都是「这条消息收不了」，剩下的分片
  // 再说一遍不带新信息，却会让页面弹出几十个一样的提示。
  if (multipartIdAlreadyRejected(meta.id, now)) return;
  rejectedMultipartIds.set(meta.id, now + rejectedMultipartIdTtlMs(options));

  console.error(
    `[rei-standard-amsg-sw] multipart chunk rejected (${reason}):`,
    detail,
    { id: meta.id, index: meta.index, total: meta.total }
  );
  await dispatchMultipartExpired(sw, {
    id: meta.id,
    total: Number.isInteger(meta.total) ? meta.total : null,
    originalMessageKind: typeof meta.originalMessageKind === 'string'
      ? meta.originalMessageKind
      : null,
  }, reason);
}

/**
 * 拒收记录留多久：这条 id 的重组窗口翻一倍，够盖住同一条消息的所有分片和推送
 * 服务的重投。
 *
 * 跟着配置走而不是写死一个常数：记录一过期，同 id 的分片就又能从零开始攒，所以
 * 它至少得比重组窗口活得久。把 `multipart.ttlMs` 调长的接入方，写死 60 秒的话
 * 中间那段空当里迟到的分片会重新拼起一条已经报过收不到的消息。
 *
 * @param {{ ttlMs?: number }} options
 */
function rejectedMultipartIdTtlMs(options) {
  return positiveIntegerOrDefault(options && options.ttlMs, DEFAULT_MULTIPART_TTL_MS) * 2;
}

/**
 * 这个 id 是不是已经报过「收不了」了。顺手把自己这条过期记录清掉。
 *
 * @param {string} id
 * @param {number} [now]
 */
function multipartIdAlreadyRejected(id, now = Date.now()) {
  const expiresAt = rejectedMultipartIds.get(id);
  if (expiresAt === undefined) return false;
  if (expiresAt > now) return true;
  rejectedMultipartIds.delete(id);
  return false;
}

/**
 * 清掉过期的拒收记录。这个表只在拒收路径上长，长度就是「最近几分钟收不了的
 * multipart 条数」，顺手扫一遍比挂个定时器省事。
 *
 * @param {number} now
 */
function pruneRejectedMultipartIds(now) {
  for (const [id, expiresAt] of rejectedMultipartIds) {
    if (expiresAt <= now) rejectedMultipartIds.delete(id);
  }
}

async function acceptMultipartChunk(sw, payload, options) {
  const normalized = normalizeMultipartChunk(payload, options);
  if (normalized.invalid) {
    await rejectMultipartChunk(
      sw,
      payload,
      options,
      MULTIPART_FAILURE_REASON.INVALID_CHUNK,
      normalized.invalid
    );
    return null;
  }

  const previous = multipartLocks.get(normalized.id) || Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => acceptMultipartChunkInternal(sw, normalized, options));

  multipartLocks.set(normalized.id, current);
  try {
    return await current;
  } finally {
    if (multipartLocks.get(normalized.id) === current) {
      multipartLocks.delete(normalized.id);
    }
  }
}

async function acceptMultipartChunkInternal(sw, normalized, options) {
  // State machine:
  // 0. Drop chunks for ids we already told the page were unreceivable.
  // 1. Drop chunks for multipart ids that are already settled — finished, or
  //    given up on — using the short-lived done marker.
  // 2. Expire any stale pending record for this id before accepting a new one.
  // 3. Store only new chunk indexes, track total received bytes, and wait.
  // 4. Once all indexes are present, restore original JSON and mark done.
  //
  // 没有「到达即过期」这一步：重组窗口是从本地收到第一片起算的（见
  // normalizeMultipartChunk），刚算出来的 expiresAt 不可能已经过去。

  // 已经报过「这条收不了」的 id 不再收片。这一步排在所有 IndexedDB 之前：报这
  // 句话的路里有一条正是「IndexedDB 刚刚出错」，那时候写不了 done 墓碑，结论只
  // 在内存里（见 rejectedMultipartIds）。继续收下去的话，剩下的分片加上推送服务
  // 对失败那片的重投能把这条消息照常拼齐投出来，页面却已经挂上了「收不到」。
  if (multipartIdAlreadyRejected(normalized.id)) return null;

  const done = await readMultipartDone(normalized.id);
  if (done && done.expiresAt > Date.now()) return null;
  if (done) await deleteMultipartDone(normalized.id);

  const now = Date.now();
  const existing = await readMultipartPending(normalized.id);
  if (existing && existing.expiresAt <= now) {
    // 窗口从本地收到第一片起算，走到这里说明剩下的分片迟到得超过了整个 ttlMs。
    // 这条 id 到此为止：连同已落库的分片一起清掉、补一条 done 墓碑，后面迟到的
    // 分片静默丢弃。只删 pending 不删分片的话，新窗口的计数从 0 重来，而旧分片
    // 会被「这一片已经有了」挡在门外，这条 id 就再也收不齐了。
    console.error(
      '[rei-standard-amsg-sw] multipart reassembly window elapsed; giving up on this multipart id:',
      { id: existing.id, total: existing.total, receivedCount: existing.receivedCount }
    );
    await settleMultipartId(existing, existing.total, options);
    await dispatchMultipartExpired(sw, existing);
    return null;
  }

  const base = existing || {
    id: normalized.id,
    expiresAt: normalized.expiresAt,
    ttlMs: normalized.ttlMs,
    total: normalized.total,
    originalMessageKind: normalized.originalMessageKind,
    encoding: normalized.encoding,
    receivedCount: 0,
    receivedBytes: 0,
  };

  if (base.total !== normalized.total || base.encoding !== normalized.encoding) {
    // 同一个 id 的分片对 total / encoding 各说各话：已收的部分拼不回去，
    // 这条 id 到此为止。
    console.error(
      '[rei-standard-amsg-sw] multipart chunks disagree on total/encoding; giving up on this multipart id:',
      {
        id: normalized.id,
        pending: { total: base.total, encoding: base.encoding },
        incoming: { total: normalized.total, encoding: normalized.encoding },
      }
    );
    await settleMultipartId(base, Math.max(base.total, normalized.total), options);
    await dispatchMultipartExpired(sw, base, MULTIPART_FAILURE_REASON.CHUNK_CONFLICT);
    return null;
  }

  const chunkId = `${normalized.id}_${normalized.index}`;
  const chunkExists = await hasMultipartChunk(chunkId);
  if (chunkExists) return null;

  base.receivedCount++;
  base.receivedBytes = positiveIntegerOrDefault(base.receivedBytes, 0) +
    normalized.chunkBytes.byteLength;

  if (base.receivedBytes > options.maxTotalBytes) {
    // 累计字节已经超过上限，再收也不会变小，剩下的分片没必要等。
    console.error(
      '[rei-standard-amsg-sw] multipart payload exceeds maxTotalBytes; giving up on this multipart id:',
      {
        id: normalized.id,
        receivedBytes: base.receivedBytes,
        maxTotalBytes: options.maxTotalBytes,
      }
    );
    await settleMultipartId(base, base.total, options);
    await dispatchMultipartExpired(sw, base, MULTIPART_FAILURE_REASON.SIZE_LIMIT_EXCEEDED);
    return null;
  }

  await writeMultipartChunk({
    id_index: chunkId,
    id: normalized.id,
    index: normalized.index,
    chunk: normalized.chunk
  });

  if (base.receivedCount < base.total) {
    await writeMultipartPending(base);
    return null;
  }

  let restored;
  try {
    restored = await restoreMultipartPayload(base, options);
  } catch (error) {
    // 分片都到齐了，却拼不回原 payload（缺片 / 超限 / JSON 解不开）。
    console.error(
      '[rei-standard-amsg-sw] multipart restore failed; giving up on this multipart id:',
      error
    );
    await settleMultipartId(base, base.total, options);
    await dispatchMultipartExpired(sw, base, MULTIPART_FAILURE_REASON.RESTORE_FAILED);
    return null;
  }

  // 到这里 payload 已经完整地拿在手里了，下面是收尾。收尾失败只影响后续去重和
  // 存储占用，这条消息本身照常往下走。
  try {
    await settleMultipartId(base, base.total, options);
  } catch (error) {
    console.error(
      '[rei-standard-amsg-sw] multipart cleanup after a completed restore failed:',
      error
    );
  }
  return restored;
}

/**
 * 这个 multipart id 到此为止：先写 done 墓碑，再清掉 pending 记录和已收的分片。
 * 收齐还原了、和中途放弃了（分片对不上、超限、拼不回来），走的是同一套收尾。
 *
 * 墓碑必须先写，而且失败路径也要写：
 *   - 不写的话「放弃」不粘。同一个 id 的下一片会发现 pending 和 done 都是空
 *     的，于是重开一份 pending 从零累计——推送服务对前几片做几次常规重投，就
 *     能把整份重新凑齐还原出来，maxTotalBytes 这道闸门等于没有。
 *   - 排在删 pending 之前，是为了让 TTL 清扫认得它。清理途中万一出错、pending
 *     记录留了下来，清扫扫到它时会看见墓碑，知道这个 id 已经有结论了，不再重
 *     复广播一次 MULTIPART_EXPIRED——对一条已经还原、已经渲染出来的消息来说，
 *     那是条彻头彻尾的假消息。
 *
 * 墓碑比重组窗口活得久（两倍），推送服务重投旧分片时也不会再触发一次业务事件。
 *
 * @param {{ id: string, ttlMs?: number }} record
 * @param {number} total - 要清掉的分片数（冲突时取两边的较大值，别漏删）
 * @param {{ ttlMs: number }} options
 */
async function settleMultipartId(record, total, options) {
  const ttlMs = positiveIntegerOrDefault(record.ttlMs, options.ttlMs);
  await writeMultipartDone({
    id: record.id,
    expiresAt: Date.now() + Math.max(ttlMs * 2, ttlMs + 1),
  });
  await deleteMultipartPending(record.id);
  await deleteMultipartChunks(record.id, total);
}

/**
 * 解析一片 multipart 信封。合规时返回归一化后的分片；不合规时返回
 * `{ invalid: <原因> }`，原因是给日志看的一句话，调用方据此走拒收出口
 * （见 rejectMultipartChunk）。
 */
function normalizeMultipartChunk(payload, options) {
  const meta = payload.multipart;
  if (!meta || typeof meta !== 'object') return { invalid: 'missing multipart envelope' };
  if (meta.version !== MULTIPART_VERSION) {
    return { invalid: `unsupported version ${JSON.stringify(meta.version)} (expected ${MULTIPART_VERSION})` };
  }
  if (meta.encoding !== MULTIPART_ENCODING) {
    return { invalid: `unsupported encoding ${JSON.stringify(meta.encoding)} (expected ${MULTIPART_ENCODING})` };
  }
  if (typeof meta.id !== 'string' || !meta.id) return { invalid: 'missing multipart id' };
  if (!Number.isInteger(meta.index) || !Number.isInteger(meta.total)) {
    return { invalid: 'index and total must be integers' };
  }
  if (meta.total <= 0 || meta.total > options.maxChunks) {
    return { invalid: `total ${meta.total} out of range (maxChunks=${options.maxChunks})` };
  }
  if (meta.index <= 0 || meta.index > meta.total) {
    return { invalid: `index ${meta.index} out of range (total=${meta.total})` };
  }

  let chunkBytes;
  try {
    chunkBytes = base64UrlToBytes(payload.chunk);
  } catch (error) {
    return {
      invalid: `chunk is not valid base64url: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const now = Date.now();
  const ttlMs = Math.min(
    positiveIntegerOrDefault(meta.ttlMs, options.ttlMs),
    options.ttlMs
  );
  // 重组窗口从**本地收到第一片**算起，不从发送端的 createdAt 算。
  //
  // ttlMs 说的是「攒着半截分片等剩下的能等多久」，而分片是一起发出来的、也会
  // 一起送到——中间隔了多久跟这个窗口没关系。按 createdAt 算的话，一条离线时
  // 段排出去的定时消息（Web Push 传输层 TTL 是四周）只要晚到超过窗口长度，
  // 每一片都会在到达的那一刻被判过期，思考过程永远拼不回来；发送端和设备的
  // 时钟差一分钟也是同样的下场。
  //
  // 同一个 id 的后续分片沿用第一片建下的 pending 记录（见 base），窗口不会被
  // 每片续一次。
  const expiresAt = now + ttlMs;

  return {
    id: meta.id,
    expiresAt,
    ttlMs,
    total: meta.total,
    index: meta.index,
    originalMessageKind: typeof meta.originalMessageKind === 'string'
      ? meta.originalMessageKind
      : null,
    encoding: meta.encoding,
    chunk: payload.chunk,
    chunkBytes,
  };
}

async function restoreMultipartPayload(record, options) {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let totalBytes = 0;
  for (let index = 1; index <= record.total; index++) {
    const chunkRecord = await readMultipartChunk(record.id, index);
    if (!chunkRecord || typeof chunkRecord.chunk !== 'string') {
      throw new Error('[rei-standard-amsg-sw] multipart missing chunk');
    }
    const bytes = base64UrlToBytes(chunkRecord.chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > options.maxTotalBytes) {
      throw new Error('[rei-standard-amsg-sw] multipart payload exceeds maxTotalBytes');
    }
    chunks.push(bytes);
  }

  const json = new TextDecoder('utf-8', { fatal: false }).decode(concatBytes(...chunks));
  return JSON.parse(json);
}

async function maybeCleanupMultipart(sw, ctx) {
  if (!ctx.multipart.enabled) return;
  const now = Date.now();
  const last = ctx.getLastMultipartCleanupAt();
  if (last && now - last < ctx.multipart.cleanupIntervalMs) return;
  ctx.setLastMultipartCleanupAt(now);
  try {
    await cleanupMultipartStores(sw, now);
  } catch (_error) {
    // Cleanup is observability/housekeeping; never block a fresh push.
  }
}

/**
 * 这个 id 已经有结论了吗（收齐还原了、中途放弃了，或者当场就判废并报给页面了）。
 *
 * TTL 清扫扫到一条过期的 pending 记录时先问一句：收尾的第一步就是写 done 墓碑
 * （见 settleMultipartId），墓碑还在就说明这条 pending 是收尾没清干净的残留，
 * 而不是「没收齐」——那条消息可能早就还原并渲染出来了，再广播一次
 * MULTIPART_EXPIRED 等于告诉用户一条他已经读过的消息没收到。
 *
 * 当场判废那条路（见 rejectMultipartChunk）的结论只记在内存里，一样算数：页面
 * 早就收到过一次「这条收不了」，清扫再补一次只是同一句话说两遍。
 */
async function multipartIdAlreadySettled(id, now) {
  if (multipartIdAlreadyRejected(id, now)) return true;
  const done = await readMultipartDone(id);
  return !!done && done.expiresAt > now;
}

async function cleanupMultipartStores(sw, now) {
  if (!hasIndexedDB()) {
    for (const [id, record] of memoryMultipartPending.entries()) {
      if (record.expiresAt <= now) {
        memoryMultipartPending.delete(id);
        await deleteMultipartChunks(id, record.total);
        if (await multipartIdAlreadySettled(id, now)) continue;
        await dispatchMultipartExpired(sw, record);
      }
    }
    for (const [id, record] of memoryMultipartDone.entries()) {
      if (record.expiresAt <= now) {
        memoryMultipartDone.delete(id);
      }
    }
    return;
  }

  const pendingExpired = await withDatabaseStore(REI_SW_MULTIPART_STORE, 'readonly', (store, resolve, reject) => {
    const index = store.index('expiresAt');
    const range = IDBKeyRange.upperBound(now);
    const req = index.getAll(range);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  for (const record of pendingExpired) {
    await deleteStoreRecord(REI_SW_MULTIPART_STORE, record.id);
    await deleteMultipartChunks(record.id, record.total);
    if (await multipartIdAlreadySettled(record.id, now)) continue;
    await dispatchMultipartExpired(sw, record);
  }

  const doneExpiredKeys = await withDatabaseStore(REI_SW_MULTIPART_DONE_STORE, 'readonly', (store, resolve, reject) => {
    const index = store.index('expiresAt');
    const range = IDBKeyRange.upperBound(now);
    if (index.getAllKeys) {
      const req = index.getAllKeys(range);
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    } else {
      const req = index.getAll(range);
      req.onsuccess = () => resolve((req.result || []).map(r => r.id));
      req.onerror = () => reject(req.error);
    }
  });

  for (const id of doneExpiredKeys) {
    await deleteStoreRecord(REI_SW_MULTIPART_DONE_STORE, id);
  }
}

/**
 * 告诉所有窗口：这个 multipart id 别再等了。`reason` 说明是哪条路走到这一步的
 * （取值见 {@link MULTIPART_FAILURE_REASON}），不传就是 TTL 到期没收齐。
 */
async function dispatchMultipartExpired(sw, record, reason = MULTIPART_FAILURE_REASON.TTL_EXPIRED) {
  await dispatchPushToClients(sw, REI_SW_EVENT.MULTIPART_EXPIRED, {
    id: record.id,
    received: typeof record.receivedCount === 'number'
      ? record.receivedCount
      : 0,
    total: record.total,
    originalMessageKind: record.originalMessageKind,
    reason,
  });
}



async function enqueueAndFlush(sw, event, requestPayload) {
  try {
    const request = normalizeQueuedRequest(requestPayload);
    const queueId = await addQueuedRequest(request);

    await registerFlushSync(sw);
    const outcomes = await flushQueuedRequests(sw);

    // `ok: true` 只表示「已入队」，不表示「已发出去」——立即冲刷可能刚好把
    // 这条发成功了、也可能被服务端 4xx 永久拒掉（记录随即被删，不会再发）。
    // 老调用方只看 `ok`，行为不变；要分辨这三种结局的读下面这几个机读字段。
    const outcome = outcomes.get(queueId);
    const ack = {
      type: REI_SW_MESSAGE_TYPE.QUEUE_RESULT,
      ok: true,
      queueId,
      delivered: Boolean(outcome && outcome.delivered)
    };
    if (outcome && outcome.dropped) {
      ack.dropped = true;
      ack.status = outcome.status;
      ack.error = outcome.error;
    }
    respondToSender(event, ack);
  } catch (error) {
    respondToSender(event, {
      type: REI_SW_MESSAGE_TYPE.QUEUE_RESULT,
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to queue request'
    });
  }
}

function normalizeQueuedRequest(requestPayload) {
  if (!requestPayload || typeof requestPayload !== 'object') {
    throw new Error('[rei-standard-amsg-sw] `request` payload is required');
  }

  const url = typeof requestPayload.url === 'string' ? requestPayload.url.trim() : '';
  if (!url) throw new Error('[rei-standard-amsg-sw] `request.url` is required');

  const method = typeof requestPayload.method === 'string'
    ? requestPayload.method.toUpperCase()
    : 'POST';
  const headers = normalizeHeaders(requestPayload.headers);
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const body = hasBody ? normalizeRequestBody(requestPayload.body) : undefined;

  if (
    hasBody &&
    body &&
    !hasHeader(headers, 'content-type') &&
    typeof requestPayload.body === 'object'
  ) {
    headers['content-type'] = 'application/json';
  }

  return {
    url,
    method,
    headers,
    body,
    createdAt: Date.now()
  };
}

function normalizeHeaders(headersInput) {
  const headers = {};
  if (!headersInput || typeof headersInput !== 'object') return headers;

  for (const [key, value] of Object.entries(headersInput)) {
    if (value == null) continue;
    headers[String(key).toLowerCase()] = String(value);
  }

  return headers;
}

function hasHeader(headers, name) {
  const target = String(name || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(headers, target);
}

function normalizeRequestBody(bodyInput) {
  if (bodyInput == null) return '';
  if (typeof bodyInput === 'string') return bodyInput;

  try {
    return JSON.stringify(bodyInput);
  } catch (_error) {
    throw new Error('[rei-standard-amsg-sw] request body is not serializable');
  }
}

/**
 * 冲刷 outbox，并把每条记录这一轮的结局报回给调用方。
 *
 * @param {ServiceWorkerGlobalScope} sw
 * @returns {Promise<Map<unknown, { delivered: boolean, dropped?: true, status?: number, error?: string }>>}
 *   key 是入队时拿到的 queueId。没出现在 map 里的记录 = 这一轮没轮到它，还在
 *   队列里等下次。
 */
async function flushQueuedRequests(sw) {
  const queuedRequests = await listQueuedRequests();
  const outcomes = new Map();

  for (const queuedRequest of queuedRequests) {
    const outcome = await trySendQueuedRequest(queuedRequest);

    if (outcome.state === 'retry') {
      await registerFlushSync(sw);
      return outcomes;
    }

    await removeQueuedRequest(queuedRequest.id);

    if (outcome.state === 'dropped') {
      outcomes.set(queuedRequest.id, {
        delivered: false,
        dropped: true,
        status: outcome.status,
        error: outcome.error
      });
      await reportDroppedRequest(sw, queuedRequest, outcome);
      continue;
    }

    outcomes.set(queuedRequest.id, { delivered: true });
  }

  return outcomes;
}

/**
 * 一条队列请求被永久拒绝、即将从队列里删掉时的失败出口。
 *
 * 删记录这件事本身是有意的重试策略（4xx 重试多少次都是同一个结果），但删掉之
 * 后必须留下痕迹：页面这边最常见的触发是 token 轮换（还拿着旧 token → 401）、
 * X-User-Id 不合法（400）、payload 超限（413）、路由改名（404），排的定时消息
 * 就此消失，事后连查都没得查。所以这里同时给两个出口：一条能归因的
 * console.error，和一条广播给所有窗口的 `REI_QUEUE_DROPPED`——页面在全局
 * `navigator.serviceWorker` message 里按 `status` 机读判断，不用去正则匹配人话。
 *
 * 用的是独立的 message type，不是入队回执那个 `REI_QUEUE_RESULT`：这条是广播，
 * 可能由后台 `sync` 冲刷触发、说的也可能是另一条八竿子打不着的旧请求。共用一个
 * type 的话，页面等自己那条入队回执时会先收到这一条、当成自己的结果处理，明明
 * 入队成功却报「排队失败」。
 *
 * 广播里只带 url / method：headers 有鉴权信息、body 是用户内容，都不该被广播
 * 到每个窗口。
 */
async function reportDroppedRequest(sw, queuedRequest, outcome) {
  const report = {
    type: REI_SW_MESSAGE_TYPE.QUEUE_DROPPED,
    ok: false,
    queueId: queuedRequest.id,
    dropped: true,
    status: outcome.status,
    error: outcome.error,
    request: { url: queuedRequest.url, method: queuedRequest.method }
  };

  console.error('[rei-standard-amsg-sw] queued request dropped and will not be retried:', report);
  await broadcastToClients(sw, report);
}

/**
 * 发一条队列请求，返回这次的结局：
 *  - `sent`    发出去了，服务端收下了，可以从队列删掉；
 *  - `dropped` 被 4xx 永久拒绝，删掉不再重试，但要报出去（见
 *              reportDroppedRequest）；
 *  - `retry`   网络错误或 5xx，留在队列里等下一次 sync。
 */
async function trySendQueuedRequest(queuedRequest) {
  try {
    const response = await fetch(queuedRequest.url, {
      method: queuedRequest.method,
      headers: queuedRequest.headers,
      body: queuedRequest.body
    });

    if (response.ok) return { state: 'sent' };

    // 4xx is usually a permanent issue for this payload, so do not retry forever.
    if (response.status >= 400 && response.status < 500) {
      return {
        state: 'dropped',
        status: response.status,
        error: `[rei-standard-amsg-sw] request rejected with HTTP ${response.status}`
      };
    }

    return { state: 'retry' };
  } catch (_error) {
    return { state: 'retry' };
  }
}

async function registerFlushSync(sw) {
  const syncManager = sw.registration && sw.registration.sync;
  if (!syncManager || typeof syncManager.register !== 'function') return;

  try {
    await syncManager.register(REI_SW_SYNC_TAG);
  } catch (_error) {
    // Ignore unsupported/denied sync registration and rely on manual flush.
  }
}

function errorToMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function respondToSender(event, message) {
  const messagePort = event.ports && event.ports[0];
  if (messagePort && typeof messagePort.postMessage === 'function') {
    messagePort.postMessage(message);
    return;
  }

  const source = event.source;
  if (source && typeof source.postMessage === 'function') {
    source.postMessage(message);
  }
}

async function addDedupeRecord(dedupe, record) {
  if (!hasIndexedDB()) {
    const store = memoryDedupeStoreFor(dedupe);
    if (store.has(record.key)) return false;
    store.set(record.key, cloneRecord(record));
    return true;
  }

  return withDedupeStore(dedupe, 'readwrite', (store, resolve, reject) => {
    let settled = false;
    const request = store.add(record);
    request.onsuccess = () => {
      settled = true;
      resolve(true);
    };
    request.onerror = (event) => {
      settled = true;
      if (request.error && request.error.name === 'ConstraintError') {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        resolve(false);
        return;
      }
      reject(request.error || new Error('Failed to add dedupe record'));
    };
    store.transaction.onerror = () => {
      if (!settled) reject(store.transaction.error || new Error('Dedupe transaction failed'));
    };
  });
}

function readDedupeRecord(dedupe, key) {
  if (!hasIndexedDB()) {
    return Promise.resolve(cloneRecord(memoryDedupeStoreFor(dedupe).get(key) || null));
  }

  return withDedupeStore(dedupe, 'readonly', (store, resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('Failed to read dedupe record'));
  });
}

function putDedupeRecord(dedupe, record) {
  if (!record || typeof record.key !== 'string' || !record.key) {
    return Promise.resolve();
  }

  if (!hasIndexedDB()) {
    memoryDedupeStoreFor(dedupe).set(record.key, cloneRecord(record));
    return Promise.resolve();
  }

  return withDedupeStore(dedupe, 'readwrite', (store, resolve, reject) => {
    const request = store.put(record);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error || new Error('Failed to put dedupe record'));
  });
}

function deleteDedupeRecord(dedupe, key) {
  if (!hasIndexedDB()) {
    memoryDedupeStoreFor(dedupe).delete(key);
    return Promise.resolve();
  }

  return withDedupeStore(dedupe, 'readwrite', (store, resolve, reject) => {
    const request = store.delete(key);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error || new Error('Failed to delete dedupe record'));
  });
}

function readMultipartPending(id) {
  return readStoreRecord(REI_SW_MULTIPART_STORE, id);
}

function writeMultipartPending(record) {
  return putStoreRecord(REI_SW_MULTIPART_STORE, record);
}

function deleteMultipartPending(id) {
  return deleteStoreRecord(REI_SW_MULTIPART_STORE, id);
}

function readMultipartDone(id) {
  return readStoreRecord(REI_SW_MULTIPART_DONE_STORE, id);
}

function writeMultipartDone(record) {
  return putStoreRecord(REI_SW_MULTIPART_DONE_STORE, record);
}

function deleteMultipartDone(id) {
  return deleteStoreRecord(REI_SW_MULTIPART_DONE_STORE, id);
}

async function hasMultipartChunk(id_index) {
  if (!hasIndexedDB()) return memoryMultipartChunks.has(id_index);
  return withDatabaseStore(REI_SW_MULTIPART_CHUNK_STORE, 'readonly', (store, resolve, reject) => {
    const request = store.count(id_index);
    request.onsuccess = () => resolve(request.result > 0);
    request.onerror = () => reject(request.error);
  });
}

function writeMultipartChunk(record) {
  if (!hasIndexedDB()) {
    memoryMultipartChunks.set(record.id_index, cloneRecord(record));
    return Promise.resolve();
  }
  return putStoreRecord(REI_SW_MULTIPART_CHUNK_STORE, record);
}

function readMultipartChunk(id, index) {
  const id_index = `${id}_${index}`;
  if (!hasIndexedDB()) {
    return Promise.resolve(cloneRecord(memoryMultipartChunks.get(id_index) || null));
  }
  return readStoreRecord(REI_SW_MULTIPART_CHUNK_STORE, id_index);
}

async function deleteMultipartChunks(id, total) {
  if (!hasIndexedDB()) {
    for (let index = 1; index <= total; index++) {
      memoryMultipartChunks.delete(`${id}_${index}`);
    }
    return;
  }
  return withDatabaseStore(REI_SW_MULTIPART_CHUNK_STORE, 'readwrite', (store, resolve, reject) => {
    let pending = total;
    let failed = false;
    for (let index = 1; index <= total; index++) {
      const request = store.delete(`${id}_${index}`);
      request.onsuccess = () => {
        if (failed) return;
        pending--;
        if (pending === 0) resolve(undefined);
      };
      request.onerror = () => {
        if (!failed) {
          failed = true;
          reject(request.error);
        }
      };
    }
    if (total === 0) resolve(undefined);
  });
}

async function readStoreRecord(storeName, id) {
  if (!hasIndexedDB()) {
    return cloneRecord(memoryStoreFor(storeName).get(id));
  }

  return withDatabaseStore(storeName, 'readonly', (store, resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error(`Failed to read ${storeName}`));
  });
}

async function putStoreRecord(storeName, record) {
  if (!hasIndexedDB()) {
    memoryStoreFor(storeName).set(record.id, cloneRecord(record));
    return;
  }

  return withDatabaseStore(storeName, 'readwrite', (store, resolve, reject) => {
    const request = store.put(record);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error || new Error(`Failed to write ${storeName}`));
  });
}

async function deleteStoreRecord(storeName, id) {
  if (!hasIndexedDB()) {
    memoryStoreFor(storeName).delete(id);
    return;
  }

  return withDatabaseStore(storeName, 'readwrite', (store, resolve, reject) => {
    const request = store.delete(id);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error || new Error(`Failed to delete ${storeName}`));
  });
}

/**
 * True when an error means the IndexedDB connection we just used is
 * closing/closed — i.e. the browser force-closed it (backing-store error,
 * storage pressure, user clearing data) and any `transaction()` on it
 * throws synchronously. `versionchange` is NOT involved here, so the cached
 * handle would otherwise stay dead forever.
 */
function isConnectionClosingError(error) {
  if (!error) return false;
  if (error.name === 'InvalidStateError') return true;
  const message = String(error.message || error);
  return /connection is closing|database connection is closing/i.test(message);
}

// Evict the dead connection `db` from the cache. Only touch it if it is
// STILL the cached handle: under concurrent recovery, another attempt may
// have already reopened and cached a fresh connection, and closing that
// fresh one would defeat the self-heal. When `db` is undefined (the open()
// itself failed, so nothing of ours is cached) this is a no-op.
function invalidateDedupeCache(dedupe, db) {
  const cacheKey = `${dedupe.dbName}:${dedupe.storeName}`;
  const cached = dedupeDbCache.get(cacheKey);
  if (cached && cached === db) {
    try { cached.close(); } catch (_closeError) { /* already closing */ }
    dedupeDbCache.delete(cacheKey);
  }
}

function invalidateQueueCache(db) {
  if (cachedDB && cachedDB === db) {
    try { cachedDB.close(); } catch (_closeError) { /* already closing */ }
    cachedDB = null;
  }
}

/**
 * Run `run(db)` against a cached IndexedDB connection, with a single
 * transparent reopen if the connection turns out to be closing/closed.
 *
 * `db.transaction()` throws *synchronously* on a dead connection, and the
 * `close` event (which would evict the cache) can land later than the next
 * call — so we cannot rely on the `onclose` handler alone. On the first
 * attempt we drop the cached handle and retry once; a second failure is
 * surfaced as-is. The retry is capped at one to avoid spinning forever.
 */
async function withConnectionRetry(open, invalidate, run) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let db;
    try {
      db = await open();
    } catch (error) {
      // open() rejects only when nothing of ours is cached, so there is no
      // specific handle to evict here.
      if (attempt === 0) { invalidate(undefined); continue; }
      throw error;
    }
    try {
      return await run(db);
    } catch (error) {
      // Evict ONLY the handle that just failed — never whatever is cached
      // now, which a concurrent attempt may have already reopened.
      if (attempt === 0 && isConnectionClosingError(error)) { invalidate(db); continue; }
      throw error;
    }
  }
  // Unreachable: the loop returns or throws on attempt 1.
  throw new Error('[rei-standard-amsg-sw] store connection retry exhausted');
}

function withDatabaseStore(storeName, mode, handler) {
  return withConnectionRetry(openQueueDatabase, invalidateQueueCache, (db) => new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(storeName, mode);
    } catch (error) {
      reject(error);
      return;
    }
    const store = transaction.objectStore(storeName);
    transaction.onerror = () => reject(transaction.error || new Error('Database transaction failed'));
    Promise.resolve(handler(store, resolve, reject)).catch(reject);
  }));
}

function withDedupeStore(dedupe, mode, handler) {
  return withConnectionRetry(
    () => openDedupeDatabase(dedupe),
    (db) => invalidateDedupeCache(dedupe, db),
    (db) => new Promise((resolve, reject) => {
      let transaction;
      try {
        transaction = db.transaction(dedupe.storeName, mode);
      } catch (error) {
        reject(error);
        return;
      }
      const store = transaction.objectStore(dedupe.storeName);
      transaction.onerror = () => reject(transaction.error || new Error('Dedupe transaction failed'));
      Promise.resolve(handler(store, resolve, reject)).catch(reject);
    }),
  );
}

function hasIndexedDB() {
  return typeof indexedDB !== 'undefined' &&
    indexedDB &&
    typeof indexedDB.open === 'function';
}

function memoryDedupeStoreFor(dedupe) {
  if (!dedupe._memoryStore) dedupe._memoryStore = new Map();
  return dedupe._memoryStore;
}

function memoryStoreFor(storeName) {
  if (storeName === REI_SW_MULTIPART_DONE_STORE) return memoryMultipartDone;
  if (storeName === REI_SW_MULTIPART_STORE) return memoryMultipartPending;
  if (storeName === REI_SW_MULTIPART_CHUNK_STORE) return memoryMultipartChunks;
  throw new Error(`[rei-standard-amsg-sw] unknown memory store: ${storeName}`);
}

function cloneRecord(record) {
  if (record == null) return null;
  return JSON.parse(JSON.stringify(record));
}

function openDedupeDatabase(dedupe) {
  const cacheKey = `${dedupe.dbName}:${dedupe.storeName}`;
  const cached = dedupeDbCache.get(cacheKey);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dedupe.dbName, 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(dedupe.storeName)
        ? request.transaction.objectStore(dedupe.storeName)
        : db.createObjectStore(dedupe.storeName, { keyPath: 'key' });
      if (store && !store.indexNames.contains('expiresAt')) {
        store.createIndex('expiresAt', 'expiresAt', { unique: false });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      dedupeDbCache.set(cacheKey, db);
      // Only evict if WE are still the cached handle — a stale connection's
      // late close event must not drop a freshly reopened one.
      const drop = () => {
        if (dedupeDbCache.get(cacheKey) === db) dedupeDbCache.delete(cacheKey);
      };
      db.onversionchange = () => {
        db.close();
        drop();
      };
      // Browser force-closed the connection (backing-store error / storage
      // pressure / cleared data). This does NOT fire on versionchange, so
      // without it the cache would keep handing out a dead connection.
      db.onclose = () => { drop(); };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('Failed to open dedupe database'));
  });
}

function openQueueDatabase() {
  if (cachedDB) return Promise.resolve(cachedDB);

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REI_SW_DB_NAME, REI_SW_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;
      createObjectStoreIfMissing(db, tx, REI_SW_DB_STORE, { keyPath: 'id', autoIncrement: true });
      const mpStore = createObjectStoreIfMissing(db, tx, REI_SW_MULTIPART_STORE, { keyPath: 'id' });
      const mpDoneStore = createObjectStoreIfMissing(db, tx, REI_SW_MULTIPART_DONE_STORE, { keyPath: 'id' });
      createObjectStoreIfMissing(db, tx, REI_SW_MULTIPART_CHUNK_STORE, { keyPath: 'id_index' });

      if (mpStore && !mpStore.indexNames.contains('expiresAt')) {
        mpStore.createIndex('expiresAt', 'expiresAt', { unique: false });
      }
      if (mpDoneStore && !mpDoneStore.indexNames.contains('expiresAt')) {
        mpDoneStore.createIndex('expiresAt', 'expiresAt', { unique: false });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      cachedDB = db;
      db.onversionchange = () => {
        db.close();
        if (cachedDB === db) cachedDB = null;
      };
      // Browser force-closed the connection — evict so the next access
      // reopens instead of reusing a dead handle.
      db.onclose = () => {
        if (cachedDB === db) cachedDB = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('Failed to open queue database'));
  });
}

function createObjectStoreIfMissing(db, tx, name, options) {
  if (db.objectStoreNames.contains(name)) return tx.objectStore(name);
  return db.createObjectStore(name, options);
}

function withQueueStore(mode, handler) {
  return withConnectionRetry(openQueueDatabase, invalidateQueueCache, (db) => new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(REI_SW_DB_STORE, mode);
    } catch (error) {
      reject(error);
      return;
    }
    const store = transaction.objectStore(REI_SW_DB_STORE);

    transaction.oncomplete = () => resolve(undefined);
    transaction.onerror = () => reject(transaction.error || new Error('Queue transaction failed'));

    Promise.resolve(handler(store, resolve, reject)).catch(reject);
  }));
}

async function addQueuedRequest(request) {
  return withQueueStore('readwrite', (store, resolve, reject) => {
    const addRequest = store.add(request);
    addRequest.onsuccess = () => resolve(addRequest.result);
    addRequest.onerror = () => reject(addRequest.error || new Error('Failed to queue request'));
  });
}

async function listQueuedRequests() {
  return withQueueStore('readonly', (store, resolve, reject) => {
    const allRequest = store.getAll();
    allRequest.onsuccess = () => {
      const list = Array.isArray(allRequest.result) ? allRequest.result : [];
      list.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
      resolve(list);
    };
    allRequest.onerror = () => reject(allRequest.error || new Error('Failed to read queue'));
  });
}

async function removeQueuedRequest(id) {
  return withQueueStore('readwrite', (store, resolve, reject) => {
    const deleteRequest = store.delete(id);
    deleteRequest.onsuccess = () => resolve(undefined);
    deleteRequest.onerror = () => reject(deleteRequest.error || new Error('Failed to remove queued request'));
  });
}
