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

test('buildReasoningPush returns a ReasoningPush without index/total fields', () => {
  const push = buildReasoningPush({
    ...COMMON,
    reasoningContent: 'thinking out loud',
  });
  assert.equal(push.messageKind, 'reasoning');
  assert.equal(push.reasoningContent, 'thinking out loud');
  assert.ok(!('messageIndex' in push));
  assert.ok(!('totalMessages' in push));
  assert.ok(isReasoningPush(push));
});

test('buildReasoningPush rejects empty reasoningContent', () => {
  assert.throws(
    () => buildReasoningPush({ ...COMMON, reasoningContent: '' }),
    /non-empty string/,
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
