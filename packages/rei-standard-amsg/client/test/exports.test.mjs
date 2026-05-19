import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ReiClient,
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

import {
  MESSAGE_KIND as SHARED_MESSAGE_KIND,
  MESSAGE_TYPE as SHARED_MESSAGE_TYPE,
  PUSH_SOURCE as SHARED_PUSH_SOURCE,
} from '@rei-standard/amsg-shared';

test('MESSAGE_KIND re-export matches shared (CONTENT/REASONING/TOOL_REQUEST/ERROR)', () => {
  assert.deepEqual(MESSAGE_KIND, SHARED_MESSAGE_KIND);
  assert.equal(MESSAGE_KIND.CONTENT, 'content');
  assert.equal(MESSAGE_KIND.REASONING, 'reasoning');
  assert.equal(MESSAGE_KIND.TOOL_REQUEST, 'tool_request');
  assert.equal(MESSAGE_KIND.ERROR, 'error');
});

test('MESSAGE_TYPE re-export matches shared (INSTANT/FIXED/PROMPTED/AUTO)', () => {
  assert.deepEqual(MESSAGE_TYPE, SHARED_MESSAGE_TYPE);
  assert.ok('INSTANT' in MESSAGE_TYPE);
  assert.ok('FIXED' in MESSAGE_TYPE);
  assert.ok('PROMPTED' in MESSAGE_TYPE);
  assert.ok('AUTO' in MESSAGE_TYPE);
});

test('PUSH_SOURCE re-export matches shared (INSTANT/SCHEDULED)', () => {
  assert.deepEqual(PUSH_SOURCE, SHARED_PUSH_SOURCE);
  assert.ok('INSTANT' in PUSH_SOURCE);
  assert.ok('SCHEDULED' in PUSH_SOURCE);
});

test('buildContentPush + isContentPush + isReasoningPush', () => {
  const result = buildContentPush({
    messageType: 'instant',
    source: 'instant',
    messageId: 'm',
    sessionId: 's',
    message: 'hi',
  });
  assert.equal(result.messageKind, 'content');
  assert.equal(isContentPush(result), true);
  assert.equal(isReasoningPush(result), false);
});

test('all four builders + matching type guards re-export correctly', () => {
  const COMMON = {
    messageType: 'instant',
    source: 'instant',
    messageId: 'm',
    sessionId: 's',
  };
  const cases = [
    { build: buildContentPush, args: { ...COMMON, message: 'hi' }, kind: 'content', guard: isContentPush },
    { build: buildReasoningPush, args: { ...COMMON, reasoningContent: 'think' }, kind: 'reasoning', guard: isReasoningPush },
    { build: buildToolRequestPush, args: { ...COMMON, toolCalls: [{ id: 'c0' }] }, kind: 'tool_request', guard: isToolRequestPush },
    { build: buildErrorPush, args: { ...COMMON, code: 'X', message: 'm' }, kind: 'error', guard: isErrorPush },
  ];
  const allGuards = [isContentPush, isReasoningPush, isToolRequestPush, isErrorPush];

  for (const c of cases) {
    const push = c.build(c.args);
    assert.equal(push.messageKind, c.kind);
    assert.equal(c.guard(push), true);
    // Each push satisfies exactly one of the four guards.
    const hits = allGuards.filter((g) => g(push)).length;
    assert.equal(hits, 1, `${c.kind} push should match exactly one guard`);
  }
});

test('ReiClient constructs without throwing', () => {
  assert.doesNotThrow(() => {
    new ReiClient({
      baseUrl: 'https://example.com',
      userId: 'u',
      instantEncryption: false,
    });
  });
});
