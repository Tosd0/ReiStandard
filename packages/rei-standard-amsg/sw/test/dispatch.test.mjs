import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  installReiSW,
  REI_SW_EVENT,
  REI_AMSG_POSTMESSAGE_TYPE
} from '../src/index.js';

/**
 * Build a minimal `ServiceWorkerGlobalScope` mock that captures:
 *  - the listeners installed via `addEventListener`
 *  - every `showNotification` call (title + options)
 *  - every `postMessage` payload delivered to each fake client
 *
 * The mock exposes `triggerPush(payload)` which awaits the full
 * `event.waitUntil` chain so tests can assert on side effects
 * synchronously after the await.
 */
function createSwMock({ clientCount = 1, visibleCount = 0 } = {}) {
  /** @type {Map<string, Function>} */
  const listeners = new Map();
  /** @type {Array<{ title: string, options: Record<string, unknown> }>} */
  const notifications = [];
  /** @type {Array<{ client: number, message: unknown }>} */
  const postedMessages = [];

  const clients = Array.from({ length: clientCount }, (_, index) => ({
    id: `client-${index}`,
    visibilityState: index < visibleCount ? 'visible' : 'hidden',
    postMessage(message) {
      postedMessages.push({ client: index, message });
    }
  }));

  const sw = {
    addEventListener(name, handler) {
      listeners.set(name, handler);
    },
    registration: {
      showNotification(title, options) {
        notifications.push({ title, options: options || {} });
        return Promise.resolve();
      },
      // No `sync` manager — installReiSW must tolerate that.
    },
    clients: {
      async matchAll(query) {
        // Echo the query so tests can verify it if they care.
        sw.clients._lastQuery = query;
        return clients;
      }
    }
  };

  async function triggerPush(payload) {
    const pushHandler = listeners.get('push');
    if (!pushHandler) throw new Error('push handler was never registered');

    /** @type {Array<Promise<unknown>>} */
    const pending = [];
    const fakeEvent = {
      data: {
        json: () => payload
      },
      waitUntil(work) {
        pending.push(Promise.resolve(work));
      }
    };
    pushHandler(fakeEvent);
    await Promise.all(pending);
  }

  return { sw, listeners, notifications, postedMessages, triggerPush };
}

const COMMON = Object.freeze({
  messageType: 'instant',
  source: 'instant',
  messageId: 'msg_test_0',
  sessionId: 'sess_test_0',
  timestamp: '2026-05-19T00:00:00.000Z'
});

function buildMultipartPayloads(payload, {
  id = `mp_test_${Math.random().toString(16).slice(2)}`,
  maxChunkBytes = 80,
  ttlMs = 60_000,
  createdAt = Date.now(),
} = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const total = Math.ceil(bytes.byteLength / maxChunkBytes);
  return Array.from({ length: total }, (_, index) => {
    const start = index * maxChunkBytes;
    const chunk = bytes.subarray(start, Math.min(start + maxChunkBytes, bytes.byteLength));
    return {
      messageKind: '_multipart',
      multipart: {
        version: 1,
        id,
        index: index + 1,
        total,
        encoding: 'json-utf8-base64url',
        originalMessageKind: typeof payload.messageKind === 'string' ? payload.messageKind : null,
        createdAt,
        ttlMs,
      },
      chunk: Buffer.from(chunk).toString('base64url'),
    };
  });
}

test('installReiSW registers the push listener', () => {
  const { sw, listeners } = createSwMock();
  installReiSW(sw);
  assert.equal(typeof listeners.get('push'), 'function');
  assert.equal(typeof listeners.get('message'), 'function');
  assert.equal(typeof listeners.get('sync'), 'function');
});

test('content push triggers showNotification AND postMessage with CONTENT_RECEIVED', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw);

  const payload = {
    ...COMMON,
    messageKind: 'content',
    message: 'Hello!',
    title: 'Rei',
    contactName: 'Rei'
  };
  await triggerPush(payload);

  assert.equal(notifications.length, 1, 'one notification rendered');
  assert.equal(notifications[0].title, 'Rei');
  assert.equal(notifications[0].options.body, 'Hello!');

  assert.equal(postedMessages.length, 1, 'one client received exactly one message');
  assert.deepEqual(postedMessages[0].message, {
    type: REI_AMSG_POSTMESSAGE_TYPE,
    event: REI_SW_EVENT.CONTENT_RECEIVED,
    payload
  });
});

test('content push broadcasts to every controlled client', async () => {
  const { sw, postedMessages, triggerPush } = createSwMock({ clientCount: 3 });
  installReiSW(sw);

  await triggerPush({
    ...COMMON,
    messageKind: 'content',
    message: 'fanout test'
  });

  assert.equal(postedMessages.length, 3, 'every client got the message');
  for (const { message } of postedMessages) {
    assert.equal(message.type, REI_AMSG_POSTMESSAGE_TYPE);
    assert.equal(message.event, REI_SW_EVENT.CONTENT_RECEIVED);
  }
});

test('reasoning push dispatches REASONING_RECEIVED but does NOT call showNotification', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw);

  const payload = {
    ...COMMON,
    messageKind: 'reasoning',
    reasoningContent: 'thinking out loud…'
  };
  await triggerPush(payload);

  assert.equal(notifications.length, 0, 'reasoning kind must not render a notification');
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].message.event, REI_SW_EVENT.REASONING_RECEIVED);
  assert.deepEqual(postedMessages[0].message.payload, payload);
});

test('tool_request push dispatches TOOL_REQUEST_RECEIVED with no notification', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw);

  const payload = {
    ...COMMON,
    messageKind: 'tool_request',
    toolCalls: [{ id: 'call_0', type: 'function', function: { name: 'noop', arguments: '{}' } }]
  };
  await triggerPush(payload);

  assert.equal(notifications.length, 0);
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].message.event, REI_SW_EVENT.TOOL_REQUEST_RECEIVED);
});

test('error push dispatches ERROR_RECEIVED with no notification', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw);

  const payload = {
    ...COMMON,
    messageKind: 'error',
    code: 'HOOK_THREW',
    message: 'onLLMOutput threw something'
  };
  await triggerPush(payload);

  assert.equal(notifications.length, 0);
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].message.event, REI_SW_EVENT.ERROR_RECEIVED);
  assert.equal(postedMessages[0].message.payload.code, 'HOOK_THREW');
});

test('legacy payload without messageKind dispatches UNKNOWN_RECEIVED AND renders a notification (back-compat)', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw);

  // Mimic a 2.0.x payload — no `messageKind`, no `source` discriminator.
  const payload = {
    title: 'Old style',
    body: 'A legacy notification body',
    messageId: 'legacy_msg_0'
  };
  await triggerPush(payload);

  assert.equal(notifications.length, 1, 'legacy payloads must still render a notification');
  assert.equal(notifications[0].title, 'Old style');
  assert.equal(notifications[0].options.body, 'A legacy notification body');

  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].message.event, REI_SW_EVENT.UNKNOWN_RECEIVED);
  assert.deepEqual(postedMessages[0].message.payload, payload);
});

test('blob envelope with messageKind: "content" dispatches CONTENT_RECEIVED and renders a placeholder notification', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw);

  const envelope = {
    _blob: true,
    key: 'abc-123',
    url: 'https://worker.example.com/blob/abc-123',
    messageKind: 'content',
    type: 'tool-request' // legacy passthrough field — should be ignored by dispatch logic
  };
  await triggerPush(envelope);

  assert.equal(notifications.length, 1, 'content-kind blob envelopes render a placeholder notification');
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].message.event, REI_SW_EVENT.CONTENT_RECEIVED);
  assert.deepEqual(postedMessages[0].message.payload, envelope, 'blob envelope is forwarded verbatim');
});

test('blob envelope with messageKind: "tool_request" dispatches TOOL_REQUEST_RECEIVED with no notification', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw);

  const envelope = {
    _blob: true,
    key: 'xyz-789',
    url: 'https://worker.example.com/blob/xyz-789',
    messageKind: 'tool_request'
  };
  await triggerPush(envelope);

  assert.equal(notifications.length, 0, 'non-content blob envelopes do not render');
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].message.event, REI_SW_EVENT.TOOL_REQUEST_RECEIVED);
});

test('generic multipart content restores payload before dispatch and notification', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw, { multipart: { cleanupIntervalMs: 0 } });

  const payload = {
    ...COMMON,
    messageKind: 'content',
    message: 'oversized content '.repeat(20),
    title: 'Multipart Rei'
  };
  const parts = buildMultipartPayloads(payload, { id: 'mp_sw_content', maxChunkBytes: 90 });

  for (const part of parts.slice().reverse()) {
    await triggerPush(part);
  }

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Multipart Rei');
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].message.event, REI_SW_EVENT.CONTENT_RECEIVED);
  assert.deepEqual(postedMessages[0].message.payload, payload);
});

test('generic multipart tool_request restores silently without notification', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw, { multipart: { cleanupIntervalMs: 0 } });

  const payload = {
    ...COMMON,
    messageKind: 'tool_request',
    message: 'call a large tool',
    toolCalls: [{ id: 'call_0', type: 'function', function: { name: 'bulk', arguments: 'x'.repeat(500) } }]
  };
  const parts = buildMultipartPayloads(payload, { id: 'mp_sw_tool', maxChunkBytes: 100 });

  for (const part of parts) {
    await triggerPush(part);
  }

  assert.equal(notifications.length, 0);
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].message.event, REI_SW_EVENT.TOOL_REQUEST_RECEIVED);
  assert.deepEqual(postedMessages[0].message.payload, payload);
});

test('generic multipart custom messageKind restores and dispatches UNKNOWN_RECEIVED', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw, { multipart: { cleanupIntervalMs: 0 } });

  const payload = {
    ...COMMON,
    messageKind: 'emotion_update',
    mood: 'curious',
    detail: 'x'.repeat(400)
  };
  const parts = buildMultipartPayloads(payload, { id: 'mp_sw_emotion', maxChunkBytes: 90 });

  for (const part of parts) {
    await triggerPush(part);
  }

  assert.equal(notifications.length, 0);
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].message.event, REI_SW_EVENT.UNKNOWN_RECEIVED);
  assert.deepEqual(postedMessages[0].message.payload, payload);
});

test('generic multipart ignores duplicate chunks and duplicate completion', async () => {
  const { sw, notifications, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw, { multipart: { cleanupIntervalMs: 0 } });

  const payload = {
    ...COMMON,
    messageKind: 'reasoning',
    reasoningContent: 'thinking '.repeat(80)
  };
  const parts = buildMultipartPayloads(payload, { id: 'mp_sw_dedupe', maxChunkBytes: 100 });

  await triggerPush(parts[0]);
  await triggerPush(parts[0]);
  assert.equal(postedMessages.length, 0);

  for (const part of parts.slice(1)) {
    await triggerPush(part);
  }
  assert.equal(notifications.length, 0);
  assert.equal(postedMessages.length, 1);
  assert.equal(postedMessages[0].message.event, REI_SW_EVENT.REASONING_RECEIVED);

  await triggerPush(parts[parts.length - 1]);
  assert.equal(postedMessages.length, 1, 'done marker prevents duplicate business dispatch');
});

test('generic multipart missing chunks do not dispatch and expire observably', async () => {
  const { sw, postedMessages, triggerPush } = createSwMock();
  installReiSW(sw, { multipart: { cleanupIntervalMs: 0 } });

  const payload = {
    ...COMMON,
    messageKind: 'reasoning',
    reasoningContent: 'partial '.repeat(50)
  };
  const parts = buildMultipartPayloads(payload, { id: 'mp_sw_expire', maxChunkBytes: 80, ttlMs: 1 });

  await triggerPush(parts[0]);
  assert.equal(postedMessages.length, 0);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await triggerPush({ ...COMMON, messageKind: 'error', code: 'NOOP', message: 'tick cleanup' });

  const expired = postedMessages.find((entry) =>
    entry.message.event === REI_SW_EVENT.MULTIPART_EXPIRED
  );
  assert.ok(expired, 'expected multipart expired event');
  assert.deepEqual(expired.message.payload, {
    id: 'mp_sw_expire',
    received: 1,
    total: parts.length,
    originalMessageKind: 'reasoning'
  });
});

test('clients.matchAll is called with type:"window" and includeUncontrolled:true', async () => {
  const { sw, triggerPush } = createSwMock();
  installReiSW(sw);

  await triggerPush({ ...COMMON, messageKind: 'content', message: 'x' });

  assert.deepEqual(sw.clients._lastQuery, {
    type: 'window',
    includeUncontrolled: true
  });
});

test('one client throwing inside postMessage does not block delivery to the others', async () => {
  // Manual SW mock — needed because the shared createSwMock() builds
  // never-throwing clients. Three clients, the middle one throws.
  const listeners = new Map();
  const delivered = [];
  const clientFactory = (index) => ({
    id: `client-${index}`,
    postMessage(message) {
      if (index === 1) throw new Error(`client-${index} is broken`);
      delivered.push({ client: index, message });
    },
  });
  const clients = [clientFactory(0), clientFactory(1), clientFactory(2)];
  let notificationCount = 0;
  const sw = {
    addEventListener(name, handler) { listeners.set(name, handler); },
    registration: {
      showNotification() { notificationCount++; return Promise.resolve(); },
    },
    clients: { async matchAll() { return clients; } },
  };

  installReiSW(sw);

  const pending = [];
  const fakeEvent = {
    data: { json: () => ({ ...COMMON, messageKind: 'content', message: 'survive' }) },
    waitUntil(work) { pending.push(Promise.resolve(work)); },
  };
  listeners.get('push')(fakeEvent);

  // Must not reject — per-client errors are caught and swallowed inside
  // the dispatcher; the outer waitUntil chain stays healthy.
  await Promise.all(pending);

  // Clients 0 and 2 still got the message; client 1's throw was contained.
  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered.map((d) => d.client).sort(), [0, 2]);
  // Notification rendering ran independently of the broken client.
  assert.equal(notificationCount, 1);
});

test('notification.show: "auto" or undefined behavior', async () => {
  const { sw, notifications, triggerPush } = createSwMock();
  installReiSW(sw);

  // Content -> show
  await triggerPush({ ...COMMON, messageKind: 'content', message: 'Hello' });
  assert.equal(notifications.length, 1);

  // Tool request -> no show
  await triggerPush({ ...COMMON, messageKind: 'tool_request', toolCalls: [{}] });
  assert.equal(notifications.length, 1, 'Still 1 because tool_request does not show');
});

test('notification.show: "always" forces notification', async () => {
  const { sw, notifications, triggerPush } = createSwMock();
  installReiSW(sw);

  await triggerPush({
    ...COMMON,
    messageKind: 'reasoning',
    reasoningContent: 'thinking',
    notification: { show: 'always', title: 'Always Show' }
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'Always Show');
});

test('notification.show: "when-hidden" shows when no visible clients', async () => {
  const { sw, notifications, triggerPush } = createSwMock({ clientCount: 1, visibleCount: 0 });
  installReiSW(sw);

  await triggerPush({
    ...COMMON,
    messageKind: 'tool_request',
    toolCalls: [{}],
    notification: { show: 'when-hidden', title: 'When Hidden' }
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, 'When Hidden');
});

test('notification.show: "when-hidden" DOES NOT show when there is a visible client', async () => {
  const { sw, notifications, triggerPush } = createSwMock({ clientCount: 2, visibleCount: 1 });
  installReiSW(sw);

  await triggerPush({
    ...COMMON,
    messageKind: 'tool_request',
    toolCalls: [{}],
    notification: { show: 'when-hidden' }
  });

  assert.equal(notifications.length, 0);
});

test('notification.show: false prevents content notification', async () => {
  const { sw, notifications, triggerPush } = createSwMock();
  installReiSW(sw);

  await triggerPush({
    ...COMMON,
    messageKind: 'content',
    message: 'Silent message',
    notification: { show: false }
  });

  assert.equal(notifications.length, 0);
});

test('notification.data is passed through to notification options', async () => {
  const { sw, notifications, triggerPush } = createSwMock();
  installReiSW(sw);

  await triggerPush({
    ...COMMON,
    messageKind: 'content',
    message: 'Hello',
    notification: { show: 'always', data: { customField: 'value' } }
  });

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].options.data.customField, 'value');
});

test('multipart fully received payload with notification.show: "when-hidden" checks visible client', async () => {
  // Test 1: with visible client -> no notification
  {
    const { sw, notifications, triggerPush } = createSwMock({ clientCount: 1, visibleCount: 1 });
    installReiSW(sw, { multipart: { cleanupIntervalMs: 0 } });

    const payload = {
      ...COMMON,
      messageKind: 'tool_request',
      toolCalls: [{}],
      notification: { show: 'when-hidden' }
    };
    const parts = buildMultipartPayloads(payload, { id: 'mp_wh_visible', maxChunkBytes: 80 });

    for (const part of parts) {
      await triggerPush(part);
    }
    assert.equal(notifications.length, 0);
  }

  // Test 2: without visible client -> notification
  {
    const { sw, notifications, triggerPush } = createSwMock({ clientCount: 1, visibleCount: 0 });
    installReiSW(sw, { multipart: { cleanupIntervalMs: 0 } });

    const payload = {
      ...COMMON,
      messageKind: 'tool_request',
      toolCalls: [{}],
      notification: { show: 'when-hidden', title: 'Multipart Hidden' }
    };
    const parts = buildMultipartPayloads(payload, { id: 'mp_wh_hidden', maxChunkBytes: 80 });

    for (const part of parts) {
      await triggerPush(part);
    }
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, 'Multipart Hidden');
  }
});

