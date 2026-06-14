/**
 * Tests for ReiClient.deliver() — the platform-agnostic delivery primitive.
 *
 * Covers RFC outcomes: delivered / completed-unconfirmed / timeout / cancelled
 * / send-failed, plus receipt identity validation, pre-flight signal.aborted,
 * post-transport grace, onChunk error capture, and discriminated-union input
 * validation. fetch is stubbed per test; we build SSE Responses by hand on
 * Node's WebStreams.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReiClient } from '../src/index.js';

// ─── Test helpers ────────────────────────────────────────────────

const SSE_PAYLOAD_FRAME = (obj) => `event: payload\ndata: ${JSON.stringify(obj)}\n\n`;
const SSE_DONE_FRAME = `event: done\ndata: {}\n\n`;
const SSE_ERROR_FRAME = (obj) =>
  `event: error\ndata: ${JSON.stringify(obj)}\n\n`;

/**
 * Build a `Response` whose body is a `text/event-stream` ReadableStream
 * fed by the provided frames in order. If `hangForever` is true the stream
 * stays open until the caller's AbortSignal aborts (then the stream errors
 * with AbortError, simulating a real-world iOS-killed fetch).
 */
function makeSseResponse({ frames = [], hangForever = false, signal, errorAfter = null } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      if (signal) {
        if (signal.aborted) {
          try { controller.error(new DOMException('aborted', 'AbortError')); } catch {}
          return;
        }
        signal.addEventListener('abort', () => {
          try { controller.error(new DOMException('aborted', 'AbortError')); } catch {}
        }, { once: true });
      }
      (async () => {
        for (const frame of frames) {
          if (signal?.aborted) return;
          try { controller.enqueue(encoder.encode(frame)); }
          catch { return; }
        }
        if (errorAfter !== null) {
          await new Promise(r => setTimeout(r, errorAfter));
          try { controller.error(new Error('stream upstream boom')); }
          catch {}
          return;
        }
        if (!hangForever) {
          try { controller.close(); } catch {}
        }
        // else: stay open until abort
      })();
    },
    cancel() { /* reader.cancel() from our consumer — fine */ },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function makeJsonResponse(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Install a fake global fetch backed by the given handler. Returns a
 * restore function. The handler receives `(url, init)` and may return
 * a Response, a Promise<Response>, or throw.
 */
function installFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = (url, init = {}) => {
    return Promise.resolve().then(() => handler(url, init));
  };
  return () => { globalThis.fetch = original; };
}

function newClient(extra = {}) {
  return new ReiClient({
    baseUrl: 'https://example.com',
    instantEncryption: false,
    ...extra,
  });
}

// Deferred Promise utility ───────────────────────────────────────
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ─── Input validation ────────────────────────────────────────────

test('deliver() throws if opts is missing', async () => {
  const client = newClient();
  await assert.rejects(() => client.deliver({}, undefined), /requires an options object/);
});

test('deliver() throws if delivery is missing', async () => {
  const client = newClient();
  await assert.rejects(
    () => client.deliver({}, { timeoutMs: 100 }),
    /requires opts\.delivery/
  );
});

test('deliver() throws on unknown delivery.mode', async () => {
  const client = newClient();
  await assert.rejects(
    () => client.deliver({}, { delivery: { mode: 'magic' }, timeoutMs: 100 }),
    /delivery\.mode must be "observed" or "transport-only"/
  );
});

test('deliver() throws on observed mode without a Promise', async () => {
  const client = newClient();
  await assert.rejects(
    () => client.deliver({}, {
      delivery: { mode: 'observed', observed: 'not-a-promise' },
      timeoutMs: 100,
    }),
    /observed must be a Promise/
  );
});

test('deliver() throws on non-positive timeoutMs', async () => {
  const client = newClient();
  await assert.rejects(
    () => client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 0,
    }),
    /timeoutMs must be a positive finite number/
  );
});

test('deliver() throws on negative postTransportGraceMs', async () => {
  const client = newClient();
  await assert.rejects(
    () => client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 100,
      postTransportGraceMs: -1,
    }),
    /postTransportGraceMs/
  );
});

// ─── Pre-flight aborted ──────────────────────────────────────────

test('deliver() pre-flight: already-aborted signal returns cancelled without fetching', async () => {
  const client = newClient();
  let fetchCalled = false;
  const restore = installFetch(() => { fetchCalled = true; return makeSseResponse(); });

  const ac = new AbortController();
  ac.abort();

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 1000,
      signal: ac.signal,
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.detail.cancelledByCaller, true);
    assert.equal(result.detail.waitedMs, 0);
    assert.equal(fetchCalled, false, 'fetch must not be dispatched after pre-flight abort');
  } finally { restore(); }
});

// ─── outcome:'delivered' (observed mode) ─────────────────────────

test('observed mode: receipt arrives before transport ends → delivered', async () => {
  const client = newClient();
  const restore = installFetch((_url, init) =>
    makeSseResponse({
      frames: [SSE_PAYLOAD_FRAME({ messageId: 'm1', content: 'hi' })],
      hangForever: true,
      signal: init.signal,
    }));

  const observation = deferred();
  // resolve observation shortly
  setTimeout(() => observation.resolve({ messageId: 'm1', channel: 'sw' }), 20);

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 5000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'delivered');
    assert.deepEqual(result.detail.receipt, { messageId: 'm1', channel: 'sw' });
  } finally { restore(); }
});

test('observed mode: invalid receipt (no ids) does NOT trigger delivered — race continues to timeout', async () => {
  const client = newClient();
  const restore = installFetch((_url, init) =>
    makeSseResponse({ frames: [], hangForever: true, signal: init.signal }));

  const observation = deferred();
  setTimeout(() => observation.resolve({ channel: 'sw' }), 10); // missing messageId AND sessionId

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 200,
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'timeout');
    assert.equal(result.detail.receipt, undefined);
  } finally { restore(); }
});

test('observed mode: receipt by sessionId only is also accepted', async () => {
  const client = newClient();
  const restore = installFetch((_url, init) =>
    makeSseResponse({ frames: [], hangForever: true, signal: init.signal }));

  const observation = deferred();
  setTimeout(() => observation.resolve({ sessionId: 's42' }), 10);

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 5000,
    });
    assert.equal(result.outcome, 'delivered');
    assert.deepEqual(result.detail.receipt, { sessionId: 's42' });
  } finally { restore(); }
});

test('observed mode: observed Promise rejection does NOT trigger delivered — race continues', async () => {
  const client = newClient();
  const restore = installFetch((_url, init) =>
    makeSseResponse({ frames: [], hangForever: true, signal: init.signal }));

  const observation = deferred();
  setTimeout(() => observation.reject(new Error('observation channel broke')), 10);

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 200,
    });
    assert.equal(result.outcome, 'timeout');
  } finally { restore(); }
});

// ─── outcome:'cancelled' (and late-receipt-after-cancel) ─────────

test('cancelled outcome: caller aborts mid-stream and no late receipt within grace', async () => {
  const client = newClient();
  const restore = installFetch((_url, init) =>
    makeSseResponse({ frames: [], hangForever: true, signal: init.signal }));

  const observation = deferred(); // never resolves

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 5000,
      postTransportGraceMs: 30, // small cancel grace
      signal: ac.signal,
    });
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.detail.cancelledByCaller, true);
  } finally { restore(); }
});

test('cancelled outcome: late receipt arrives within grace → delivered + cancelledByCaller', async () => {
  const client = newClient();
  const restore = installFetch((_url, init) =>
    makeSseResponse({ frames: [], hangForever: true, signal: init.signal }));

  const observation = deferred();
  const ac = new AbortController();

  setTimeout(() => ac.abort(), 20);
  // late receipt lands during cancel grace
  setTimeout(() => observation.resolve({ messageId: 'late-m' }), 40);

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 5000,
      postTransportGraceMs: 200, // half = 100ms grace window for late receipt
      signal: ac.signal,
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, 'delivered');
    assert.equal(result.detail.cancelledByCaller, true);
    assert.equal(result.detail.receipt.messageId, 'late-m');
  } finally { restore(); }
});

// ─── outcome:'timeout' (overall budget exhausted) ────────────────

test('timeout outcome: transport hangs, observation never fires', async () => {
  const client = newClient();
  const restore = installFetch((_url, init) =>
    makeSseResponse({ frames: [], hangForever: true, signal: init.signal }));

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: deferred().promise },
      timeoutMs: 80,
    });
    assert.equal(result.outcome, 'timeout');
    assert.ok(result.detail.waitedMs >= 70);
  } finally { restore(); }
});

// ─── outcome:'timeout' (observed mode + clean transport + no receipt) ──

test('observed mode: transport ends clean, observation never fires → timeout + observationChannelStalled', async () => {
  const client = newClient();
  const restore = installFetch(() =>
    makeSseResponse({ frames: [SSE_PAYLOAD_FRAME({ messageId: 'm9' }), SSE_DONE_FRAME] }));

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: deferred().promise },
      timeoutMs: 500,
      postTransportGraceMs: 40,
    });
    assert.equal(result.outcome, 'timeout');
    assert.equal(result.detail.observationChannelStalled, true);
    assert.equal(result.detail.transportEnded, true);
    assert.equal(result.detail.transportError, undefined);
  } finally { restore(); }
});

// ─── outcome:'send-failed' ──────────────────────────────────────

test('send-failed: transport HTTP 500, no observation', async () => {
  const client = newClient();
  const restore = installFetch(() =>
    new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } }));

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: deferred().promise },
      timeoutMs: 500,
      postTransportGraceMs: 30,
    });
    assert.equal(result.outcome, 'send-failed');
    assert.ok(result.detail.transportError);
    assert.match(String(result.detail.transportError.message), /500/);
  } finally { restore(); }
});

test('send-failed: SSE error frame, no observation', async () => {
  const client = newClient();
  const restore = installFetch(() =>
    makeSseResponse({ frames: [SSE_ERROR_FRAME({ code: 'UPSTREAM', message: 'llm 502' })] }));

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: deferred().promise },
      timeoutMs: 500,
      postTransportGraceMs: 30,
    });
    assert.equal(result.outcome, 'send-failed');
    assert.equal(result.detail.transportError.code, 'UPSTREAM');
  } finally { restore(); }
});

test('send-failed loses to delivered: SSE error frame BUT observed receipt arrived first', async () => {
  // Even if transport errors, if observed delivered within grace we
  // report 'delivered' — the message did land.
  const client = newClient();
  const observation = deferred();

  let resolveFetch;
  const fetchGate = new Promise(r => { resolveFetch = r; });

  const restore = installFetch(async () => {
    await fetchGate; // hold transport
    return makeSseResponse({ frames: [SSE_ERROR_FRAME({ code: 'BOOM', message: 'fail' })] });
  });

  try {
    setTimeout(() => observation.resolve({ messageId: 'm-fast' }), 20);
    setTimeout(() => resolveFetch(), 40); // transport completes (with error) after observed

    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 5000,
    });
    assert.equal(result.outcome, 'delivered');
    assert.equal(result.detail.receipt.messageId, 'm-fast');
  } finally { restore(); }
});

// ─── outcome:'completed-unconfirmed' (transport-only mode) ──────

test('transport-only mode: clean SSE → completed-unconfirmed (no truth signal)', async () => {
  const client = newClient();
  const restore = installFetch(() =>
    makeSseResponse({ frames: [SSE_PAYLOAD_FRAME({ messageId: 'm9' }), SSE_DONE_FRAME] }));

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 500,
      postTransportGraceMs: 30,
    });
    assert.equal(result.ok, false);
    assert.equal(result.outcome, 'completed-unconfirmed');
    assert.equal(result.detail.transportEnded, true);
    assert.equal(result.detail.receipt, undefined);
  } finally { restore(); }
});

test('transport-only mode: HTTP 500 → send-failed', async () => {
  const client = newClient();
  const restore = installFetch(() =>
    new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } }));

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 500,
      postTransportGraceMs: 30,
    });
    assert.equal(result.outcome, 'send-failed');
  } finally { restore(); }
});

// ─── JSON transport branch ──────────────────────────────────────

test('JSON transport: response body surfaced in detail.transportResponse', async () => {
  const client = newClient();
  const restore = installFetch(() =>
    makeJsonResponse({ success: true, data: { messagesSent: 3, sentAt: '2026-06-08T00:00:00Z' } }));

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 500,
      postTransportGraceMs: 30,
    });
    assert.equal(result.outcome, 'completed-unconfirmed');
    assert.deepEqual(result.detail.transportResponse, {
      success: true,
      data: { messagesSent: 3, sentAt: '2026-06-08T00:00:00Z' },
    });
  } finally { restore(); }
});

test('JSON transport + observed mode: observation wins → delivered + JSON body preserved', async () => {
  const client = newClient();
  let resolveFetch;
  const gate = new Promise(r => { resolveFetch = r; });
  const restore = installFetch(async () => {
    await gate;
    return makeJsonResponse({ success: true, data: { messagesSent: 1 } });
  });

  const observation = deferred();

  try {
    setTimeout(() => observation.resolve({ messageId: 'm-json' }), 20);
    setTimeout(() => resolveFetch(), 40);

    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 5000,
    });
    assert.equal(result.outcome, 'delivered');
    assert.equal(result.detail.receipt.messageId, 'm-json');
  } finally { restore(); }
});

// ─── onChunk error capture (does NOT promote outcome) ──────────

test('onChunk throw is captured in detail.chunkHandlerError, outcome unaffected', async () => {
  const client = newClient();
  const restore = installFetch(() =>
    makeSseResponse({
      frames: [
        SSE_PAYLOAD_FRAME({ messageId: 'm1' }),
        SSE_PAYLOAD_FRAME({ messageId: 'm2' }),
        SSE_DONE_FRAME,
      ],
    }));

  const observation = deferred();
  setTimeout(() => observation.resolve({ messageId: 'm-receipt' }), 10);

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 5000,
      onChunk: () => { throw new Error('UI hook bug'); },
    });
    assert.equal(result.outcome, 'delivered');
    assert.ok(result.detail.chunkHandlerError, 'chunkHandlerError must be populated');
    assert.match(String(result.detail.chunkHandlerError.message), /UI hook bug/);
  } finally { restore(); }
});

test('onChunk receives parsed payload objects', async () => {
  const client = newClient();
  const restore = installFetch(() =>
    makeSseResponse({
      frames: [
        SSE_PAYLOAD_FRAME({ messageId: 'm1', content: 'hi' }),
        SSE_PAYLOAD_FRAME({ messageId: 'm2', content: 'there' }),
        SSE_DONE_FRAME,
      ],
    }));

  const chunks = [];
  try {
    await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 500,
      onChunk: (p) => { chunks.push(p); },
    });
    assert.deepEqual(chunks, [
      { messageId: 'm1', content: 'hi' },
      { messageId: 'm2', content: 'there' },
    ]);
  } finally { restore(); }
});

// ─── postTransportGraceMs default formula ──────────────────────

test('default grace formula honors 5s floor: 30s timeout → grace ≈ 5000ms (10% < 5s floor)', async () => {
  const client = newClient();
  const restore = installFetch(() =>
    makeSseResponse({ frames: [SSE_DONE_FRAME] }));

  const observation = deferred();
  // Resolve receipt 4500ms after transport ends — within 5s floor grace
  setTimeout(() => observation.resolve({ messageId: 'm-late' }), 4500);

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 30_000,
    });
    assert.equal(result.outcome, 'delivered');
    // Should arrive in ~4.5s window
    assert.ok(result.detail.waitedMs < 6000, `waitedMs=${result.detail.waitedMs}`);
  } finally { restore(); }
});

test('caller postTransportGraceMs is capped by remaining budget', async () => {
  const client = newClient();
  const restore = installFetch(() =>
    makeSseResponse({ frames: [SSE_DONE_FRAME] }));

  try {
    // total budget 100ms, grace asked for 5000ms — should cap at remaining (~99ms)
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: deferred().promise },
      timeoutMs: 100,
      postTransportGraceMs: 5000,
    });
    assert.equal(result.outcome, 'timeout');
    // We should have returned well under 5000ms — the grace was capped.
    assert.ok(result.detail.waitedMs < 500, `waitedMs=${result.detail.waitedMs}`);
  } finally { restore(); }
});

// ─── Receipt identity edge cases ────────────────────────────────

test('receipt with empty-string messageId is rejected (must be non-empty)', async () => {
  const client = newClient();
  const restore = installFetch((_url, init) =>
    makeSseResponse({ frames: [], hangForever: true, signal: init.signal }));

  const observation = deferred();
  setTimeout(() => observation.resolve({ messageId: '' }), 10);

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 150,
    });
    assert.equal(result.outcome, 'timeout');
  } finally { restore(); }
});

test('receipt that is not a plain object is rejected', async () => {
  const client = newClient();
  const restore = installFetch((_url, init) =>
    makeSseResponse({ frames: [], hangForever: true, signal: init.signal }));

  const observation = deferred();
  setTimeout(() => observation.resolve('m1'), 10); // string, not object

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 150,
    });
    assert.equal(result.outcome, 'timeout');
  } finally { restore(); }
});

// ─── Low-level dev warning ──────────────────────────────────────

test('sendInstant logs the low-level dev warning at most once when expectsBackupPush: true', async () => {
  const client = newClient();
  const restore = installFetch(() => makeJsonResponse({ success: true }));

  const calls = [];
  const origWarn = console.warn;
  console.warn = (...args) => { calls.push(args.join(' ')); };

  try {
    await client.sendInstant({}, '/instant', { expectsBackupPush: true });
    await client.sendInstant({}, '/instant', { expectsBackupPush: true });
    assert.equal(calls.length, 1, 'warning should fire exactly once per instance');
    assert.match(calls[0], /sendInstant is a low-level/);
    assert.match(calls[0], /HTTP 200/);
    assert.match(calls[0], /deliver\(\)/);
  } finally {
    console.warn = origWarn;
    restore();
  }
});

test('consumeInstantStream silenced when expectsBackupPush: false', async () => {
  const client = newClient();
  const restore = installFetch(() =>
    makeSseResponse({ frames: [SSE_DONE_FRAME] }));

  const calls = [];
  const origWarn = console.warn;
  console.warn = (...args) => { calls.push(args.join(' ')); };

  try {
    await client.consumeInstantStream({}, '/instant', {
      onPayload: () => {},
      expectsBackupPush: false,
    });
    assert.equal(calls.length, 0, 'expectsBackupPush:false must silence the warning');
  } finally {
    console.warn = origWarn;
    restore();
  }
});

test('low-level warning does not fire when expectsBackupPush is omitted', async () => {
  // Per RFC: warn only on explicit opt-in (caller "自报").
  const client = newClient();
  const restore = installFetch(() => makeJsonResponse({ success: true }));

  const calls = [];
  const origWarn = console.warn;
  console.warn = (...args) => { calls.push(args.join(' ')); };

  try {
    await client.sendInstant({}, '/instant');
    assert.equal(calls.length, 0, 'no opt-in → no warning');
  } finally {
    console.warn = origWarn;
    restore();
  }
});

// ─── /simplify Phase 1 fixes — regression tests ─────────────────

// SSE consumer must handle CRLF frame separators (.NET / IIS / some CDNs).
test('SSE: CRLF frame separators (\\r\\n\\r\\n) are parsed correctly', async () => {
  const client = newClient();
  const CRLF_PAYLOAD = (obj) => `event: payload\r\ndata: ${JSON.stringify(obj)}\r\n\r\n`;
  const CRLF_DONE = `event: done\r\ndata: {}\r\n\r\n`;
  const restore = installFetch(() =>
    makeSseResponse({ frames: [CRLF_PAYLOAD({ messageId: 'm-crlf' }), CRLF_DONE] }));

  const chunks = [];
  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 500,
      postTransportGraceMs: 30,
      onChunk: (p) => { chunks.push(p); },
    });
    assert.equal(result.outcome, 'completed-unconfirmed');
    assert.deepEqual(chunks, [{ messageId: 'm-crlf' }]);
  } finally { restore(); }
});

// Stream that ends without a trailing blank line must still flush the last frame.
test('SSE: trailing buffer without final blank-line is processed at EOF', async () => {
  const client = newClient();
  const restore = installFetch(() =>
    // Note: the last frame has only ONE trailing \n — server closed early.
    makeSseResponse({ frames: [`event: payload\ndata: ${JSON.stringify({ messageId: 'm-tail' })}\n`] }));

  const chunks = [];
  try {
    await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 500,
      postTransportGraceMs: 30,
      onChunk: (p) => { chunks.push(p); },
    });
    assert.deepEqual(chunks, [{ messageId: 'm-tail' }]);
  } finally { restore(); }
});

// Multibyte UTF-8 (CJK / emoji) split across chunk boundaries must not lose bytes.
test('SSE: UTF-8 multi-byte split across chunks survives EOF flush', async () => {
  const client = newClient();
  // '楪' UTF-8 = E6 A5 AA. We'll feed the SSE bytes split mid-character.
  const payload = JSON.stringify({ messageId: 'm-cjk', name: '楪同学' });
  const fullFrame = `event: payload\ndata: ${payload}\n\n`;
  const fullBytes = new TextEncoder().encode(fullFrame);
  // Split so the last chunk ends inside '楪同学' bytes.
  const splitAt = fullBytes.length - 4;
  const chunkA = fullBytes.slice(0, splitAt);
  const chunkB = fullBytes.slice(splitAt);

  const restore = installFetch(() => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(chunkA);
      controller.enqueue(chunkB);
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));

  const chunks = [];
  try {
    await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 500,
      postTransportGraceMs: 30,
      onChunk: (p) => { chunks.push(p); },
    });
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].name, '楪同学', 'multi-byte UTF-8 must round-trip');
  } finally { restore(); }
});

// Local validation errors (PAYLOAD_TOO_LARGE_LOCAL) must throw synchronously,
// not get buried inside outcome:'send-failed'.
test('deliver(): PAYLOAD_TOO_LARGE_LOCAL throws out instead of becoming send-failed', async () => {
  const client = newClient({ maxPayloadBytes: 10 });
  const restore = installFetch(() => makeJsonResponse({ success: true }));

  try {
    await assert.rejects(
      () => client.deliver({ huge: 'x'.repeat(100) }, {
        delivery: { mode: 'transport-only' },
        timeoutMs: 1000,
      }),
      (err) => err.code === 'PAYLOAD_TOO_LARGE_LOCAL'
    );
  } finally { restore(); }
});

// transport-only mode + cancel must return promptly, not linger for cancel-grace.
test('cancelled outcome: transport-only mode does NOT linger waiting for observation', async () => {
  const client = newClient();
  const restore = installFetch((_url, init) =>
    makeSseResponse({ frames: [], hangForever: true, signal: init.signal }));

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);

  try {
    const t0 = Date.now();
    const result = await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 60_000,
      postTransportGraceMs: 5000,
      signal: ac.signal,
    });
    const elapsed = Date.now() - t0;
    assert.equal(result.outcome, 'cancelled');
    // We should return well under the 2.5s cancel grace (5000/2),
    // because transport-only has no observation channel to wait on.
    assert.ok(elapsed < 500, `expected prompt return, took ${elapsed}ms`);
  } finally { restore(); }
});

// deliver() must forward opts.authorization (parity with sendInstant).
test('deliver(): opts.authorization is sent as Authorization header', async () => {
  const client = newClient();
  let seenAuthHeader = null;
  const restore = installFetch((_url, init) => {
    seenAuthHeader = init.headers?.['Authorization'] ?? init.headers?.['authorization'] ?? null;
    return makeJsonResponse({ success: true });
  });

  try {
    await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 500,
      postTransportGraceMs: 30,
      authorization: 'Bearer test-token-xyz',
    });
    assert.equal(seenAuthHeader, 'Bearer test-token-xyz');
  } finally { restore(); }
});

// Content-Type dispatch must accept structured-suffix JSON variants.
test('deliver(): application/problem+json is accepted as a JSON response', async () => {
  const client = newClient();
  const body = { type: 'about:blank', title: 'Bad Request' };
  const restore = installFetch(() => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/problem+json' },
  }));

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 500,
      postTransportGraceMs: 30,
    });
    assert.equal(result.outcome, 'completed-unconfirmed');
    assert.deepEqual(result.detail.transportResponse, body);
  } finally { restore(); }
});

// Signal listener cleanup: a long-lived signal reused across many deliver()
// calls must not accumulate stale 'abort' listeners.
test('deliver(): caller signal listeners are removed on terminal outcome', async () => {
  const client = newClient();
  const restore = installFetch(() => makeJsonResponse({ success: true }));

  const ac = new AbortController();
  let listenerCount = 0;
  const realAdd = ac.signal.addEventListener.bind(ac.signal);
  const realRemove = ac.signal.removeEventListener.bind(ac.signal);
  ac.signal.addEventListener = (...args) => { listenerCount++; return realAdd(...args); };
  ac.signal.removeEventListener = (...args) => { listenerCount--; return realRemove(...args); };

  try {
    for (let i = 0; i < 10; i++) {
      await client.deliver({}, {
        delivery: { mode: 'transport-only' },
        timeoutMs: 500,
        postTransportGraceMs: 30,
        signal: ac.signal,
      });
    }
    assert.equal(listenerCount, 0, `expected 0 net listeners after 10 calls, got ${listenerCount}`);
  } finally { restore(); }
});

// The transport IIFE must not mutate detail.transportResponse after deliver()
// has already returned — observed mode wins → caller-held detail stays clean.
test('deliver(): late JSON transport response does NOT mutate already-returned detail', async () => {
  const client = newClient();
  let resolveFetch;
  const gate = new Promise(r => { resolveFetch = r; });
  const restore = installFetch(async () => {
    await gate;
    return makeJsonResponse({ success: true, data: { messagesSent: 7 } });
  });

  const observation = deferred();

  try {
    setTimeout(() => observation.resolve({ messageId: 'm-fast' }), 20);
    // Let the fetch fire well AFTER deliver() returns.
    setTimeout(() => resolveFetch(), 100);

    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 5000,
    });
    assert.equal(result.outcome, 'delivered');
    // Snapshot detail right after return.
    const snapshot = { ...result.detail };

    // Now wait long enough for the gated fetch to resolve.
    await new Promise(r => setTimeout(r, 200));

    // The detail object we received must NOT have grown a transportResponse
    // field from the still-running IIFE.
    assert.deepEqual(result.detail, snapshot, 'detail must not mutate post-return');
    assert.equal(result.detail.transportResponse, undefined);
  } finally { restore(); }
});

// ─── Codex review fixes — regression tests ──────────────────────

// transport-only post-transport grace must short-circuit (no observation
// channel to wait on after transport ends).
test('transport-only: post-transport grace does NOT linger after transport ends', async () => {
  const client = newClient();
  const restore = installFetch(() =>
    makeJsonResponse({ success: true })); // immediate JSON response

  try {
    const t0 = Date.now();
    const result = await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 60_000, // big timeout; default grace would be 5s
    });
    const elapsed = Date.now() - t0;
    assert.equal(result.outcome, 'completed-unconfirmed');
    // Default grace = max(5000, 6000) = 6000ms; we must NOT wait it out.
    assert.ok(elapsed < 500, `expected prompt return, took ${elapsed}ms`);
  } finally { restore(); }
});

// abort fired DURING async _buildInstantRequest must prevent the fetch.
test('deliver(): abort during async build prevents fetch dispatch', async () => {
  const client = newClient();
  let fetchCalled = false;
  const restore = installFetch(() => {
    fetchCalled = true;
    return makeJsonResponse({ success: true });
  });

  const ac = new AbortController();
  // Fire abort in a microtask scheduled BEFORE _buildInstantRequest finishes.
  // The encrypted/plaintext path is await-ed, so we have a microtask window.
  Promise.resolve().then(() => ac.abort());

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 1000,
      signal: ac.signal,
    });
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.detail.cancelledByCaller, true);
    assert.equal(fetchCalled, false, 'fetch must not be dispatched after mid-build abort');
  } finally { restore(); }
});

// abort fired DURING post-transport grace must surface as 'cancelled',
// not be silently downgraded to timeout / completed-unconfirmed.
test('deliver(): abort during post-transport grace returns cancelled', async () => {
  const client = newClient();
  // Transport ends immediately with a clean SSE done frame.
  const restore = installFetch(() =>
    makeSseResponse({ frames: [SSE_DONE_FRAME] }));

  const observation = deferred(); // never resolves
  const ac = new AbortController();

  try {
    // Schedule abort to fire ~30ms after deliver() starts — well inside
    // the default grace window for a 30s timeout (grace ≈ 5000ms).
    setTimeout(() => ac.abort(), 30);

    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 30_000,
      signal: ac.signal,
    });
    assert.equal(result.outcome, 'cancelled');
    assert.equal(result.detail.cancelledByCaller, true);
  } finally { restore(); }
});

// SSE CRLF split exactly on a chunk boundary: chunk1 ends with '\r',
// chunk2 starts with '\n'. The real line ending is '\r\n' (one terminator),
// must NOT be split into '\r' + '\n' which would falsely terminate the frame.
test('SSE: real CRLF split exactly across chunk boundary stays a single line ending', async () => {
  const client = newClient();
  const payload = JSON.stringify({ messageId: 'm-seam' });
  const chunkA = new TextEncoder().encode(`event: payload\r`);
  const chunkB = new TextEncoder().encode(`\ndata: ${payload}\r\n\r\n`);

  const restore = installFetch(() => new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(chunkA);
      // Force chunkB to arrive in a separate read.
      await new Promise(r => setTimeout(r, 5));
      controller.enqueue(chunkB);
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));

  const chunks = [];
  try {
    await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 500,
      onChunk: (p) => { chunks.push(p); },
    });
    assert.deepEqual(chunks, [{ messageId: 'm-seam' }]);
  } finally { restore(); }
});

// wrappedOnChunk catching a delayed throw must not mutate caller-held detail
// after deliver() has already returned via a different winner.
test('deliver(): late onChunk throw does NOT mutate already-returned detail.chunkHandlerError', async () => {
  const client = newClient();
  // Hold the stream open with one payload frame, then never close — let
  // observed win first; onChunk will throw AFTER deliver() returns.
  let onChunkFired;
  const onChunkGate = new Promise(r => { onChunkFired = r; });

  const restore = installFetch((_url, init) =>
    makeSseResponse({
      frames: [SSE_PAYLOAD_FRAME({ messageId: 'm-chunk' })],
      hangForever: true,
      signal: init.signal,
    }));

  const observation = deferred();
  setTimeout(() => observation.resolve({ messageId: 'm-fast' }), 10);

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'observed', observed: observation.promise },
      timeoutMs: 5000,
      onChunk: async () => {
        // Park the onChunk call until after deliver() returns, then throw.
        await new Promise(r => setTimeout(r, 80));
        onChunkFired();
        throw new Error('post-return onChunk bug');
      },
    });
    assert.equal(result.outcome, 'delivered');
    const snapshot = { ...result.detail };

    // Wait for the deferred onChunk throw to land.
    await onChunkGate;
    await new Promise(r => setTimeout(r, 20));

    assert.deepEqual(result.detail, snapshot, 'detail must not mutate post-return');
    assert.equal(result.detail.chunkHandlerError, undefined);
  } finally { restore(); }
});

// Content-Type with parameters must be parsed as a media type, not
// substring-searched (so the parameter value can't trick the classifier).
test('Content-Type: parameter value containing media-type string is not mis-classified', async () => {
  const client = newClient();
  // Body is JSON but a parameter mentions text/event-stream — naive substring
  // would mis-classify as SSE.
  const body = { success: true, data: { messagesSent: 1 } };
  const restore = installFetch(() => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json; note=text/event-stream' },
  }));

  try {
    const result = await client.deliver({}, {
      delivery: { mode: 'transport-only' },
      timeoutMs: 500,
    });
    assert.equal(result.outcome, 'completed-unconfirmed');
    assert.deepEqual(result.detail.transportResponse, body);
  } finally { restore(); }
});
