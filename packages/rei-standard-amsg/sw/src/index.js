/**
 * ReiStandard Service Worker helpers.
 *
 * Drop-in plugin for Service Workers that handles:
 *  - Basic push payload -> notification rendering
 *  - Offline request queueing and retry with Background Sync
 *
 * Notes:
 *  - This plugin intentionally does not install `notificationclick`.
 *    Main applications can implement their own click navigation logic.
 *
 * Usage (inside your sw.js):
 *   import { installReiSW, REI_SW_MESSAGE_TYPE } from '@rei-standard/amsg-sw';
 *   installReiSW(self);
 *
 * Usage (inside your web app):
 *   navigator.serviceWorker.controller?.postMessage({
 *     type: REI_SW_MESSAGE_TYPE.ENQUEUE_REQUEST,
 *     request: {
 *       url: '/api/messages/send',
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: { text: 'hello' }
 *     }
 *   });
 */

const REI_SW_DB_NAME = 'rei-sw';
const REI_SW_DB_STORE = 'request-outbox';
const REI_SW_DB_VERSION = 1;
const REI_SW_SYNC_TAG = 'rei-sw-flush-request-outbox';

export const REI_SW_MESSAGE_TYPE = Object.freeze({
  ENQUEUE_REQUEST: 'REI_ENQUEUE_REQUEST',
  FLUSH_QUEUE: 'REI_FLUSH_QUEUE',
  QUEUE_RESULT: 'REI_QUEUE_RESULT'
});

/**
 * @typedef {Object} ReiSWOptions
 * @property {string} [defaultIcon]  - Fallback notification icon URL.
 * @property {string} [defaultBadge] - Fallback notification badge URL.
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

  sw.addEventListener('push', (event) => {
    const payload = readPushPayload(event);
    if (!payload) return;

    const notification = createNotificationFromPayload(payload, {
      defaultIcon,
      defaultBadge
    });
    if (!notification) return;

    event.waitUntil(
      sw.registration.showNotification(notification.title, notification.options)
    );
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

    if (message.type === REI_SW_MESSAGE_TYPE.FLUSH_QUEUE) {
      event.waitUntil(flushQueuedRequests(sw));
    }
  });

  sw.addEventListener('sync', (event) => {
    if (event.tag !== REI_SW_SYNC_TAG) return;
    event.waitUntil(flushQueuedRequests(sw));
  });
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

  const title = pushNotification.title || payload.title || 'New notification';
  const body = pushNotification.body || payload.body || payload.message || '';
  const data = payload.data && typeof payload.data === 'object'
    ? { ...payload.data }
    : {};

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
      )
    }
  };
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
  } catch (_error) {
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
  } catch (_error) {
    return false;
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

function openQueueDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(REI_SW_DB_NAME, REI_SW_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(REI_SW_DB_STORE)) return;
      db.createObjectStore(REI_SW_DB_STORE, { keyPath: 'id', autoIncrement: true });
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open queue database'));
  });
}

async function withQueueStore(mode, handler) {
  const db = await openQueueDatabase();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(REI_SW_DB_STORE, mode);
      const store = transaction.objectStore(REI_SW_DB_STORE);

      transaction.oncomplete = () => resolve(undefined);
      transaction.onerror = () => reject(transaction.error || new Error('Queue transaction failed'));

      Promise.resolve(handler(store, resolve, reject)).catch(reject);
    });
  } finally {
    db.close();
  }
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
