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
function createSwMock({ clientCount = 1 } = {}) {
  /** @type {Map<string, Function>} */
  const listeners = new Map();
  /** @type {Array<{ title: string, options: Record<string, unknown> }>} */
  const notifications = [];
  /** @type {Array<{ client: number, message: unknown }>} */
  const postedMessages = [];

  const clients = Array.from({ length: clientCount }, (_, index) => ({
    id: `client-${index}`,
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
