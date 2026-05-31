import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MESSAGE_KIND,
  MESSAGE_TYPE,
  PUSH_SOURCE,
  buildContentPush,
  buildReasoningPush,
  buildToolRequestPush,
  buildErrorPush,
  isContentPush,
  isReasoningPush,
  isToolRequestPush,
  isErrorPush,
  chunkReasoningByUtf8Bytes,
} from '../src/index.js';

const COMMON = Object.freeze({
  messageType: 'instant',
  source: 'instant',
  messageId: 'msg_test_0',
  sessionId: 'sess_test_0',
});

test('MESSAGE_KIND constant enumerates all four kinds', () => {
  assert.deepEqual(
    new Set(Object.values(MESSAGE_KIND)),
    new Set(['content', 'reasoning', 'tool_request', 'error']),
  );
});

test('MESSAGE_TYPE constant enumerates the four dispatch types', () => {
  assert.deepEqual(
    new Set(Object.values(MESSAGE_TYPE)),
    new Set(['instant', 'fixed', 'prompted', 'auto']),
  );
});

test('PUSH_SOURCE constant enumerates the two source values', () => {
  assert.deepEqual(
    new Set(Object.values(PUSH_SOURCE)),
    new Set(['instant', 'scheduled']),
  );
});

test('buildContentPush returns a ContentPush with messageKind:"content"', () => {
  const push = buildContentPush({
    ...COMMON,
    message: 'hello',
    messageIndex: 1,
    totalMessages: 2,
  });
  assert.equal(push.messageKind, 'content');
  assert.equal(push.message, 'hello');
  assert.equal(push.messageIndex, 1);
  assert.equal(push.totalMessages, 2);
  assert.ok(typeof push.timestamp === 'string' && push.timestamp.length > 0);
  assert.ok(isContentPush(push));
  assert.equal(isReasoningPush(push), false);
});

test('buildContentPush rejects missing message', () => {
  assert.throws(
    () => buildContentPush({ ...COMMON, message: undefined }),
    /must be a string/,
  );
});

test('buildContentPush forwards passthrough metadata without mutating', () => {
  const metadata = { app: 'test', nested: { k: 1 } };
  const push = buildContentPush({ ...COMMON, message: 'hi', metadata });
  assert.equal(push.metadata, metadata);
});

test('buildReasoningPush returns a ReasoningPush without index/total/chunk fields by default', () => {
  const push = buildReasoningPush({
    ...COMMON,
    reasoningContent: 'thinking out loud',
  });
  assert.equal(push.messageKind, 'reasoning');
  assert.equal(push.reasoningContent, 'thinking out loud');
  // None of the multi-part axes are present when the caller didn't
  // explicitly pass them — keeps the single-shot wire byte-for-byte
  // compatible with pre-byte-chunking ReasoningPush callers.
  assert.ok(!('messageIndex' in push));
  assert.ok(!('totalMessages' in push));
  assert.ok(!('chunkIndex' in push));
  assert.ok(!('totalChunks' in push));
  assert.ok(isReasoningPush(push));
});

test('buildReasoningPush carries chunkIndex / totalChunks when explicitly passed', () => {
  const push = buildReasoningPush({
    ...COMMON,
    reasoningContent: 'first 2000 bytes…',
    chunkIndex: 1,
    totalChunks: 3,
  });
  assert.equal(push.chunkIndex, 1);
  assert.equal(push.totalChunks, 3);
});

test('buildReasoningPush carries both messageIndex/totalMessages and chunkIndex/totalChunks (cascade)', () => {
  // The cascade case: sentence-split produced 3 segments, segment 2
  // was itself oversized and got byte-chunked into 5 sub-pushes.
  const push = buildReasoningPush({
    ...COMMON,
    reasoningContent: 'middle of sentence 2…',
    messageIndex: 2,
    totalMessages: 3,
    chunkIndex: 1,
    totalChunks: 5,
  });
  assert.equal(push.messageIndex, 2);
  assert.equal(push.totalMessages, 3);
  assert.equal(push.chunkIndex, 1);
  assert.equal(push.totalChunks, 5);
});

test('buildReasoningPush rejects empty reasoningContent', () => {
  assert.throws(
    () => buildReasoningPush({ ...COMMON, reasoningContent: '' }),
    /non-empty string/,
  );
});

// ─── notification directive validation ─────────────────────────────────

test('buildContentPush threads notification through verbatim', () => {
  const notification = {
    title: 'Custom',
    body: 'Hello',
    icon: 'https://cdn.example/icon.png',
    badge: 'https://cdn.example/badge.png',
    tag: 'thread-42',
    renotify: true,
    requireInteraction: false,
    silent: true,
  };
  const push = buildContentPush({ ...COMMON, message: 'hi', notification });
  assert.deepEqual(push.notification, notification);
  // Reference passthrough — not deep-cloned, same as `metadata`.
  assert.equal(push.notification, notification);
});

test('buildContentPush omits notification key when arg is undefined', () => {
  const push = buildContentPush({ ...COMMON, message: 'hi' });
  assert.ok(!('notification' in push));
});

test('buildContentPush rejects non-object notification', () => {
  for (const bad of [null, 'string', 42, true, [1, 2]]) {
    assert.throws(
      () => buildContentPush({ ...COMMON, message: 'hi', notification: bad }),
      /'notification' must be a plain object/,
      `value ${JSON.stringify(bad)} should reject`,
    );
  }
});

test('buildContentPush rejects non-string notification.{title,body,icon,badge,tag}', () => {
  for (const field of ['title', 'body', 'icon', 'badge', 'tag']) {
    assert.throws(
      () => buildContentPush({ ...COMMON, message: 'hi', notification: { [field]: 42 } }),
      new RegExp(`'notification\\.${field}' must be a string`),
      `notification.${field}: 42 should reject`,
    );
  }
});

test('buildContentPush rejects non-boolean notification.{renotify,requireInteraction,silent}', () => {
  for (const field of ['renotify', 'requireInteraction', 'silent']) {
    assert.throws(
      () => buildContentPush({ ...COMMON, message: 'hi', notification: { [field]: 'yes' } }),
      new RegExp(`'notification\\.${field}' must be a boolean`),
      `notification.${field}: "yes" should reject`,
    );
  }
});

test('buildContentPush tolerates unknown notification fields (SW forward-compat)', () => {
  // The SW reads a known set of fields; anything else is ignored at
  // its end. Builder shouldn't gatekeep beyond shape — typed args are
  // a TS-side helper, not a wire validator.
  const push = buildContentPush({
    ...COMMON,
    message: 'hi',
    notification: { title: 'ok', futureField: 'whatever' },
  });
  assert.equal(push.notification.futureField, 'whatever');
});

test('buildToolRequestPush threads notification through (for demoted prefix chunks)', () => {
  const notification = { title: 'pre-tool narration', tag: 'tool-call-42' };
  const push = buildToolRequestPush({
    ...COMMON,
    toolCalls: [{ id: 'c1', type: 'function', function: { name: 'x' } }],
    notification,
  });
  assert.deepEqual(push.notification, notification);
});

test('buildToolRequestPush rejects malformed notification', () => {
  assert.throws(
    () => buildToolRequestPush({
      ...COMMON,
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'x' } }],
      notification: 'not-an-object',
    }),
    /'notification' must be a plain object/,
  );
});

test('buildToolRequestPush requires a non-empty toolCalls array', () => {
  const push = buildToolRequestPush({
    ...COMMON,
    toolCalls: [{ id: 'call_0', type: 'function', function: { name: 'noop', arguments: '{}' } }],
  });
  assert.equal(push.messageKind, 'tool_request');
  assert.equal(push.toolCalls.length, 1);
  assert.ok(isToolRequestPush(push));

  assert.throws(
    () => buildToolRequestPush({ ...COMMON, toolCalls: [] }),
    /non-empty array/,
  );
});

test('buildErrorPush replaces the legacy {type:"error"} envelope', () => {
  const push = buildErrorPush({
    ...COMMON,
    code: 'HOOK_THREW',
    message: 'onLLMOutput threw',
    iteration: 3,
  });
  assert.equal(push.messageKind, 'error');
  assert.equal(push.code, 'HOOK_THREW');
  assert.equal(push.message, 'onLLMOutput threw');
  assert.equal(push.iteration, 3);
  // The legacy `type: 'error'` field MUST NOT be present.
  assert.ok(!('type' in push), `legacy 'type' field leaked into ErrorPush: ${JSON.stringify(push)}`);
  assert.ok(isErrorPush(push));
});

test('type guards narrow correctly across union members', () => {
  const content = buildContentPush({ ...COMMON, message: 'x' });
  const reasoning = buildReasoningPush({ ...COMMON, reasoningContent: 'y' });
  const tool = buildToolRequestPush({ ...COMMON, toolCalls: [{ id: 'a' }] });
  const error = buildErrorPush({ ...COMMON, code: 'E', message: 'm' });

  for (const push of [content, reasoning, tool, error]) {
    const matches = [
      isContentPush(push),
      isReasoningPush(push),
      isToolRequestPush(push),
      isErrorPush(push),
    ].filter(Boolean).length;
    assert.equal(matches, 1, `exactly one guard should match ${push.messageKind}`);
  }
});

test('builders forbid the package from writing into metadata', () => {
  // Builders accept caller metadata as-is. Confirm the builder does not
  // inject any package-owned keys at the top of metadata.
  const metadata = {};
  buildContentPush({ ...COMMON, message: 'x', metadata });
  buildReasoningPush({ ...COMMON, reasoningContent: 'y', metadata });
  buildErrorPush({ ...COMMON, code: 'E', message: 'm', metadata });
  buildToolRequestPush({ ...COMMON, toolCalls: [{ id: 'c0' }], metadata });
  assert.deepEqual(Object.keys(metadata), [], 'builders must not mutate caller metadata');
});

test('builders never write through a frozen metadata (catches future "merge" regressions)', () => {
  // Deeper guarantee than "no observable key was added": if a future
  // change ever switches to `Object.assign(metadata, ...)` or
  // `metadata.something = ...`, freezing the input makes the write
  // throw in strict mode. This locks the no-mutate invariant in.
  const frozen = Object.freeze({ caller: 'owns this' });
  assert.doesNotThrow(() => buildContentPush({ ...COMMON, message: 'x', metadata: frozen }));
  assert.doesNotThrow(() => buildReasoningPush({ ...COMMON, reasoningContent: 'y', metadata: frozen }));
  assert.doesNotThrow(() => buildToolRequestPush({ ...COMMON, toolCalls: [{ id: 'c0' }], metadata: frozen }));
  assert.doesNotThrow(() => buildErrorPush({ ...COMMON, code: 'E', message: 'm', metadata: frozen }));
});

test('required fields reject empty string (not just undefined) for ID-shaped fields', () => {
  // The shared `requireField` treats `''` as missing for every required
  // field. Pinning the behavior here so a future refactor that loosens
  // it must update this test deliberately.
  assert.throws(() => buildContentPush({ ...COMMON, messageId: '', message: 'x' }), /'messageId' is required/);
  assert.throws(() => buildContentPush({ ...COMMON, sessionId: '', message: 'x' }), /'sessionId' is required/);
  assert.throws(() => buildReasoningPush({ ...COMMON, messageId: '', reasoningContent: 'y' }), /'messageId' is required/);
  assert.throws(() => buildErrorPush({ ...COMMON, code: '', message: 'm' }), /'code' is required/);
});

// ─── chunkReasoningByUtf8Bytes ──────────────────────────────────────────

test('chunkReasoningByUtf8Bytes — empty string returns []', () => {
  assert.deepEqual(chunkReasoningByUtf8Bytes('', 100), []);
});

test('chunkReasoningByUtf8Bytes — text under threshold returns single chunk', () => {
  const text = 'hello world'; // 11 bytes ASCII
  assert.deepEqual(chunkReasoningByUtf8Bytes(text, 100), [text]);
});

test('chunkReasoningByUtf8Bytes — text exactly at threshold returns single chunk', () => {
  const text = 'a'.repeat(100); // 100 bytes ASCII
  assert.deepEqual(chunkReasoningByUtf8Bytes(text, 100), [text]);
});

test('chunkReasoningByUtf8Bytes — ASCII over threshold splits into N chunks (joined = original)', () => {
  const text = 'a'.repeat(250); // 250 bytes ASCII
  const chunks = chunkReasoningByUtf8Bytes(text, 100);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 100);
  assert.equal(chunks[1].length, 100);
  assert.equal(chunks[2].length, 50);
  assert.equal(chunks.join(''), text);
});

test('chunkReasoningByUtf8Bytes — pure CJK boundaries always at codepoint (寿)', () => {
  // '寿' = 3 UTF-8 bytes. 1000 chars × 3 = 3000 bytes total.
  // maxBytes 999 = 333 chars exactly. With maxBytes 1000 = 333.33 →
  // 333 chars (999 bytes) per chunk, rest trails. Either way every
  // boundary must hit a codepoint edge — no half-character.
  const text = '寿'.repeat(1000);
  const chunks = chunkReasoningByUtf8Bytes(text, 999);
  assert.ok(chunks.length >= 3);
  // Reconstruction safety — every chunk decodes cleanly + concat matches.
  assert.equal(chunks.join(''), text);
  // No chunk exceeds the byte cap.
  const encoder = new TextEncoder();
  for (const c of chunks) {
    assert.ok(encoder.encode(c).byteLength <= 999, `chunk byte len ${encoder.encode(c).byteLength}`);
  }
});

test('chunkReasoningByUtf8Bytes — pure emoji (4-byte chars) never cuts inside surrogate', () => {
  // '🙂' = 4 UTF-8 bytes (U+1F642, outside the BMP).
  // 500 × 4 = 2000 bytes total. maxBytes 1003 → not a multiple of 4,
  // so the splitter MUST walk back to the previous lead byte for at
  // least one boundary. Joined chunks must still round-trip exactly.
  const text = '🙂'.repeat(500);
  const chunks = chunkReasoningByUtf8Bytes(text, 1003);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks.join(''), text);
  const encoder = new TextEncoder();
  for (const c of chunks) {
    assert.ok(encoder.encode(c).byteLength <= 1003);
  }
});

test('chunkReasoningByUtf8Bytes — mixed ASCII + CJK + emoji round-trips at various caps', () => {
  const text = 'Hello 你好 🙂 worldこんにちは🌏'.repeat(20);
  for (const cap of [50, 100, 256, 500, 1024]) {
    const chunks = chunkReasoningByUtf8Bytes(text, cap);
    assert.equal(chunks.join(''), text, `cap=${cap}`);
    const encoder = new TextEncoder();
    for (const c of chunks) {
      assert.ok(encoder.encode(c).byteLength <= cap, `cap=${cap}, chunk too big`);
    }
  }
});

test('chunkReasoningByUtf8Bytes — rejects maxBytes < 4 (no valid cut for 4-byte chars)', () => {
  assert.throws(() => chunkReasoningByUtf8Bytes('hi', 3), /maxBytes must be an integer ≥ 4/);
  assert.throws(() => chunkReasoningByUtf8Bytes('hi', 0), /maxBytes must be an integer ≥ 4/);
  assert.throws(() => chunkReasoningByUtf8Bytes('hi', -1), /maxBytes must be an integer ≥ 4/);
  assert.throws(() => chunkReasoningByUtf8Bytes('hi', 1.5), /maxBytes must be an integer ≥ 4/);
});

test('chunkReasoningByUtf8Bytes — rejects non-string text', () => {
  assert.throws(() => chunkReasoningByUtf8Bytes(null, 100), /text must be a string/);
  assert.throws(() => chunkReasoningByUtf8Bytes(undefined, 100), /text must be a string/);
  assert.throws(() => chunkReasoningByUtf8Bytes(42, 100), /text must be a string/);
});
