/**
 * ReiStandard Service Worker helpers.
 *
 * Drop-in plugin for Service Workers that handles:
 *  - Three-axis `push` payload dispatch — keyed by `payload.messageKind`
 *    (see `@rei-standard/amsg-shared`). Every push is mirrored to every
 *    controlled client via `postMessage` under a per-kind event name.
 *  - Notification rendering for `messageKind: 'content'` (and legacy
 *    payloads without `messageKind`, for back-compat with 2.0.x
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
 */

import { MESSAGE_KIND, base64UrlToBytes, concatBytes } from '@rei-standard/amsg-shared';

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
const MULTIPART_MESSAGE_KIND = '_multipart';
const MULTIPART_ENCODING = 'json-utf8-base64url';
const DEFAULT_MULTIPART_OPTIONS = Object.freeze({
  enabled: true,
  ttlMs: 60_000,
  maxTotalBytes: 256_000,
  maxChunks: 128,
  cleanupIntervalMs: 15 * 60_000,
});
const memoryMultipartPending = new Map();
const memoryMultipartDone = new Map();
const memoryMultipartChunks = new Map();
const multipartLocks = new Map();
const dedupeDbCache = new Map();

/**
 * Wire-level message type for SW → client postMessage envelopes.
 * Clients filter on `e.data.type === 'REI_AMSG_PUSH'` before reading
 * `e.data.event` (which is one of {@link REI_SW_EVENT}'s values).
 */
export const REI_AMSG_POSTMESSAGE_TYPE = 'REI_AMSG_PUSH';

/**
 * Per-kind event names dispatched to controlled clients. Each push the
 * SW receives is mirrored to every window via
 * `postMessage({ type: 'REI_AMSG_PUSH', event: <one of these>, payload })`.
 *
 * The mapping is keyed by `payload.messageKind`. Legacy payloads (and
 * blob envelopes) without a `messageKind` field dispatch as
 * {@link REI_SW_EVENT.UNKNOWN_RECEIVED} so apps can still handle 2.0.x
 * producers during migration.
 */
export const REI_SW_EVENT = Object.freeze({
  CONTENT_RECEIVED: 'rei-amsg-content-received',
  REASONING_RECEIVED: 'rei-amsg-reasoning-received',
  TOOL_REQUEST_RECEIVED: 'rei-amsg-tool-request-received',
  ERROR_RECEIVED: 'rei-amsg-error-received',
  MULTIPART_EXPIRED: 'rei-amsg-multipart-expired',
  UNKNOWN_RECEIVED: 'rei-amsg-unknown-received'
});

export const REI_SW_MESSAGE_TYPE = Object.freeze({
  ENQUEUE_REQUEST: 'REI_ENQUEUE_REQUEST',
  DELIVER: 'REI_AMSG_DELIVER',
  FLUSH_QUEUE: 'REI_FLUSH_QUEUE',
  QUEUE_RESULT: 'REI_QUEUE_RESULT'
});

export const REI_AMSG_DELIVER_MESSAGE_TYPE = REI_SW_MESSAGE_TYPE.DELIVER;

/**
 * @typedef {Object} ReiSWOptions
 * @property {string} [defaultIcon]  - Fallback notification icon URL.
 * @property {string} [defaultBadge] - Fallback notification badge URL.
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
  const multipart = normalizeMultipartOptions(opts.multipart);
  const dedupe = normalizeDedupeOptions(opts.dedupe);
  let lastMultipartCleanupAt = 0;
  let lastDedupeCleanupAt = 0;
  const makeDeliveryContext = (source) => ({
    defaultBadge,
    defaultIcon,
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
    if (!ctx.multipart.enabled) return;
    const restoredPayload = await acceptMultipartChunk(sw, payload, ctx.multipart);
    if (!restoredPayload) return;
    return handlePushPayload(sw, restoredPayload, ctx);
  }

  const claim = await claimDedupe(payload, ctx);
  if (claim.duplicate) {
    const duplicateNotification = await maybeShowDuplicateNotification(sw, payload, claim, ctx);
    claim.duplicateNotification = duplicateNotification;
    await notifyDuplicate(payload, claim, ctx);
    const result = { ...claim, duplicateNotification };
    // The first delivery claims this key and runs business at most once. If
    // that business failed, the failure is persisted on the dedupe record —
    // surface it so a retry/backup gets an honest ack, not a clean ok:true.
    // Read the LATEST record, not the pre-await `claim.existing` snapshot:
    // while we awaited the repair path above, an in-flight first delivery may
    // have just persisted its businessError, which the stale snapshot misses.
    const businessError = await readDuplicateBusinessError(claim, ctx);
    if (businessError !== undefined) {
      result.businessError = businessError;
    }
    return result;
  }

  const dispatchResult = await dispatchBusinessPayload(sw, payload, {
    defaultIcon: ctx.defaultIcon,
    defaultBadge: ctx.defaultBadge,
    onBusinessPayload: ctx.onBusinessPayload,
  }, async (intermediateResult) => {
    // Settle the dedupe pending flag as soon as the notification policy
    // is decided (dispatch + showNotification done) — do NOT wait for
    // onBusinessPayload. A backup arriving mid-business would otherwise
    // hit `notificationStatePending` and skip the repair path.
    await updateDedupeNotificationState(claim, ctx, intermediateResult);
  });
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
    if (notification) {
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
              console.error('[rei-standard-amsg-sw] showNotification rejected:', error);
            }
          )
      );
    }
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
    default:
      return REI_SW_EVENT.UNKNOWN_RECEIVED;
  }
}

/**
 * True when the payload should trigger `showNotification`. Only
 * `messageKind: 'content'` renders a notification; everything else
 * (`reasoning`, `tool_request`, `error`) is dispatched silently so
 * apps can render them in-app.
 * Legacy payloads with no `messageKind` field still render a
 * notification — that's the 2.0.x back-compat path.
 *
 * @param {Record<string, unknown>} payload
 * @returns {boolean}
 */
function isNotificationKind(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const kind = payload.messageKind;
  if (kind === undefined || kind === null) return true;
  return kind === MESSAGE_KIND.CONTENT;
}

function shouldRenderNotification(payload, clientList) {
  const showOpt = payload && payload.notification ? payload.notification.show : undefined;

  if (showOpt === 'always') {
    return true;
  }
  if (showOpt === 'when-hidden') {
    return !clientList.some(client => client.visibilityState === 'visible');
  }
  if (showOpt === false) {
    return false;
  }
  return isNotificationKind(payload);
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
 * @returns {Promise<void>}
 */
async function dispatchPushToClients(sw, eventName, payload, preFetchedClientList = null) {
  try {
    const clientList = preFetchedClientList || await sw.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });
    const envelope = {
      type: REI_AMSG_POSTMESSAGE_TYPE,
      event: eventName,
      payload
    };
    for (const client of clientList) {
      try {
        client.postMessage(envelope);
      } catch (_postError) {
        // Per-client failures must not abort the broadcast.
      }
    }
  } catch (_matchError) {
    // No window clients available, or the matchAll call rejected.
    // Either way, fail silently — notification rendering still wins.
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

function createNotificationFromPayload(payload, defaults) {
  if (!payload || typeof payload !== 'object') {
    return {
      title: 'New notification',
      options: {
        body: String(payload || ''),
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
  const body = pushNotification.body || payload.body || payload.message || '';
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
    if (latest
        && latest.firstSeenAt === claim.existing.firstSeenAt
        && latest.businessError !== undefined) {
      return latest.businessError;
    }
  } catch (_readError) {
    // Fall back to the snapshot below.
  }
  return snapshot;
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
  });
  if (!notification) {
    return { shown: false, reason: 'no-notification' };
  }

  await sw.registration.showNotification(notification.title, notification.options);

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

async function acceptMultipartChunk(sw, payload, options) {
  const normalized = normalizeMultipartChunk(payload, options);
  if (!normalized) return null;

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
  // 1. Validate the transport envelope and reject expired chunks before storage.
  // 2. Drop already-completed multipart ids using the short-lived done marker.
  // 3. Expire any stale pending record for this id before accepting a new one.
  // 4. Store only new chunk indexes, track total received bytes, and wait.
  // 5. Once all indexes are present, restore original JSON and mark done.
  if (normalized.expiresAt <= Date.now()) {
    await dispatchMultipartExpired(sw, {
      id: normalized.id,
      chunks: {},
      total: normalized.total,
      originalMessageKind: normalized.originalMessageKind,
    });
    return null;
  }

  const done = await readMultipartDone(normalized.id);
  if (done && done.expiresAt > Date.now()) return null;
  if (done) await deleteMultipartDone(normalized.id);

  const now = Date.now();
  const existing = await readMultipartPending(normalized.id);
  if (existing && existing.expiresAt <= now) {
    await deleteMultipartPending(existing.id);
    await dispatchMultipartExpired(sw, existing);
  }

  const base = existing && existing.expiresAt > now
    ? existing
    : {
        id: normalized.id,
        createdAt: normalized.createdAt,
        expiresAt: normalized.expiresAt,
        ttlMs: normalized.ttlMs,
        total: normalized.total,
        originalMessageKind: normalized.originalMessageKind,
        encoding: normalized.encoding,
        receivedCount: 0,
        receivedBytes: 0,
      };

  if (base.total !== normalized.total || base.encoding !== normalized.encoding) {
    await deleteMultipartPending(normalized.id);
    await deleteMultipartChunks(normalized.id, base.total);
    return null;
  }

  const chunkId = `${normalized.id}_${normalized.index}`;
  const chunkExists = await hasMultipartChunk(chunkId);
  if (chunkExists) return null;

  base.receivedCount++;
  base.receivedBytes = positiveIntegerOrDefault(base.receivedBytes, 0) +
    normalized.chunkBytes.byteLength;

  if (base.receivedBytes > options.maxTotalBytes) {
    await deleteMultipartPending(normalized.id);
    await deleteMultipartChunks(normalized.id, base.total);
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

  await deleteMultipartPending(base.id);
  let restored;
  try {
    restored = await restoreMultipartPayload(base, options);
  } catch (_error) {
    await deleteMultipartChunks(base.id, base.total);
    return null;
  }
  await deleteMultipartChunks(base.id, base.total);
  // Keep the done marker longer than the pending TTL so push-service
  // redelivery cannot trigger a second business event after completion.
  const doneTtlMs = Math.max(base.ttlMs * 2, base.ttlMs + 1);
  await writeMultipartDone({
    id: base.id,
    expiresAt: Date.now() + doneTtlMs,
  });
  return restored;
}

function normalizeMultipartChunk(payload, options) {
  const meta = payload.multipart;
  if (!meta || typeof meta !== 'object') return null;
  if (meta.version !== 1 || meta.encoding !== MULTIPART_ENCODING) return null;
  if (typeof meta.id !== 'string' || !meta.id) return null;
  if (!Number.isInteger(meta.index) || !Number.isInteger(meta.total)) return null;
  if (meta.total <= 0 || meta.total > options.maxChunks) return null;
  if (meta.index <= 0 || meta.index > meta.total) return null;

  let chunkBytes;
  try {
    chunkBytes = base64UrlToBytes(payload.chunk);
  } catch (_error) { console.error("RESTORE ERROR", _error);
    return null;
  }

  const now = Date.now();
  const ttlMs = Math.min(
    positiveIntegerOrDefault(meta.ttlMs, options.ttlMs),
    options.ttlMs
  );
  const createdAt = Number.isFinite(meta.createdAt) ? Number(meta.createdAt) : now;
  const expiresAt = createdAt + ttlMs;

  return {
    id: meta.id,
    createdAt,
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
  } catch (_error) { console.error("RESTORE ERROR", _error);
    // Cleanup is observability/housekeeping; never block a fresh push.
  }
}

async function cleanupMultipartStores(sw, now) {
  if (!hasIndexedDB()) {
    for (const [id, record] of memoryMultipartPending.entries()) {
      if (record.expiresAt <= now) {
        memoryMultipartPending.delete(id);
        await deleteMultipartChunks(id, record.total);
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

async function dispatchMultipartExpired(sw, record) {
  await dispatchPushToClients(sw, REI_SW_EVENT.MULTIPART_EXPIRED, {
    id: record.id,
    received: typeof record.receivedCount === 'number'
      ? record.receivedCount
      : 0,
    total: record.total,
    originalMessageKind: record.originalMessageKind,
  });
}



async function enqueueAndFlush(sw, event, requestPayload) {
  try {
    const request = normalizeQueuedRequest(requestPayload);
    const queueId = await addQueuedRequest(request);

    await registerFlushSync(sw);
    await flushQueuedRequests(sw);

    respondToSender(event, {
      type: REI_SW_MESSAGE_TYPE.QUEUE_RESULT,
      ok: true,
      queueId
    });
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
  } catch (_error) { console.error("RESTORE ERROR", _error);
    throw new Error('[rei-standard-amsg-sw] request body is not serializable');
  }
}

async function flushQueuedRequests(sw) {
  const queuedRequests = await listQueuedRequests();

  for (const queuedRequest of queuedRequests) {
    const canDelete = await trySendQueuedRequest(queuedRequest);

    if (!canDelete) {
      await registerFlushSync(sw);
      return;
    }

    await removeQueuedRequest(queuedRequest.id);
  }
}

async function trySendQueuedRequest(queuedRequest) {
  try {
    const response = await fetch(queuedRequest.url, {
      method: queuedRequest.method,
      headers: queuedRequest.headers,
      body: queuedRequest.body
    });

    // 4xx is usually a permanent issue for this payload, so do not retry forever.
    if (response.ok || (response.status >= 400 && response.status < 500)) {
      return true;
    }

    return false;
  } catch (_error) { console.error("RESTORE ERROR", _error);
    return false;
  }
}

async function registerFlushSync(sw) {
  const syncManager = sw.registration && sw.registration.sync;
  if (!syncManager || typeof syncManager.register !== 'function') return;

  try {
    await syncManager.register(REI_SW_SYNC_TAG);
  } catch (_error) { console.error("RESTORE ERROR", _error);
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

function listMultipartPending() {
  return listStoreRecords(REI_SW_MULTIPART_STORE);
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

function listMultipartDone() {
  return listStoreRecords(REI_SW_MULTIPART_DONE_STORE);
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

async function listStoreRecords(storeName) {
  if (!hasIndexedDB()) {
    return Array.from(memoryStoreFor(storeName).values()).map(cloneRecord);
  }

  return withDatabaseStore(storeName, 'readonly', (store, resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error || new Error(`Failed to list ${storeName}`));
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
