import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionContext,
  extractAssistantMessage,
  assertValidDecision,
  extractToolCallsFromDecision,
} from '../src/index.js';

describe('buildSessionContext', () => {
  const args = {
    sessionId: 's1', messages: [{ role: 'user', content: 'hi' }],
    llmResponse: { choices: [{ message: { role: 'assistant', content: 'yo' } }] },
    iteration: 0, contactName: 'Rei',
  };

  test('shape + frozen + no credentials', () => {
    const ctx = buildSessionContext(args);
    assert.equal(ctx.sessionId, 's1');
    assert.equal(ctx.llmOutputText, 'yo');
    assert.equal(ctx.iteration, 0);
    assert.deepEqual(ctx.metadata, {});
    assert.equal(ctx.contactName, 'Rei');
    assert.ok(Object.isFrozen(ctx));
    for (const k of ['apiKey', 'apiUrl', 'pushSubscription', 'vapid', 'masterKey']) {
      assert.equal(k in ctx, false, `${k} must not be on ctx`);
    }
  });

  test('llmOutputText is "" for pure tool-call responses', () => {
    const ctx = buildSessionContext({
      ...args,
      llmResponse: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] } }] },
    });
    assert.equal(ctx.llmOutputText, '');
  });
});

describe('extractAssistantMessage', () => {
  test('keeps the whole message object (tool_calls survive)', () => {
    const msg = { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] };
    assert.equal(extractAssistantMessage({ choices: [{ message: msg }] }), msg);
  });
  test('malformed response → placeholder', () => {
    assert.deepEqual(extractAssistantMessage(null), { role: 'assistant', content: '' });
    assert.deepEqual(extractAssistantMessage({ choices: [] }), { role: 'assistant', content: '' });
  });
});

describe('assertValidDecision (instant flavor, default options)', () => {
  test('accepts the four valid tags', () => {
    assertValidDecision({ decision: 'finish', pushPayloads: [{ message: 'x' }] });
    assertValidDecision({ decision: 'tool-request', pushPayloads: [{ toolCalls: [{ id: 't' }] }] });
    assertValidDecision({ decision: 'continue', nextHistory: [] });
    assertValidDecision({ decision: 'skip-push' });
  });
  test('rejects null / unknown tag / singular pushPayload', () => {
    assert.throws(() => assertValidDecision(null), /invalid decision/);
    assert.throws(() => assertValidDecision({ decision: 'idk' }), /invalid decision tag/);
    assert.throws(() => assertValidDecision({ decision: 'finish', pushPayload: {} }), /pushPayload \(singular\) is removed in 0\.8\.0/);
  });
  test('finish/tool-request require non-empty pushPayloads; entries validated', () => {
    assert.throws(() => assertValidDecision({ decision: 'finish' }), /requires a pushPayloads array/);
    assert.throws(() => assertValidDecision({ decision: 'finish', pushPayloads: [] }), /skip-push/);
    assert.throws(() => assertValidDecision({ decision: 'finish', pushPayloads: [{ splitPattern: 'x' }] }), /splitPattern is removed/);
    assert.throws(() => assertValidDecision({ decision: 'finish', pushPayloads: [{ messageId: '' }] }), /messageId/);
    // instant flavor does NOT accept inline toolCalls without pushPayloads
    assert.throws(() => assertValidDecision({ decision: 'tool-request', toolCalls: [{ id: 't' }] }), /requires a pushPayloads array/);
  });
  test('continue requires nextHistory array', () => {
    assert.throws(() => assertValidDecision({ decision: 'continue' }), /nextHistory/);
  });
});

describe('assertValidDecision ({ inlineToolCalls: true }, server flavor)', () => {
  test('tool-request with inline toolCalls and no pushPayloads is valid', () => {
    assertValidDecision({ decision: 'tool-request', toolCalls: [{ id: 't1' }] }, { inlineToolCalls: true });
  });
  test('inline toolCalls must be a non-empty array of objects', () => {
    assert.throws(() => assertValidDecision({ decision: 'tool-request', toolCalls: [] }, { inlineToolCalls: true }), /non-empty/);
    assert.throws(() => assertValidDecision({ decision: 'tool-request', toolCalls: ['x'] }, { inlineToolCalls: true }), /plain object/);
  });
  test('tool-request with pushPayloads still valid (instant classifier reuse)', () => {
    assertValidDecision({ decision: 'tool-request', pushPayloads: [{ toolCalls: [{ id: 't' }] }] }, { inlineToolCalls: true });
  });
  test('tool-request with both toolCalls and pushPayloads validates both', () => {
    assertValidDecision(
      { decision: 'tool-request', toolCalls: [{ id: 't' }], pushPayloads: [{ toolCalls: [{ id: 't' }] }] },
      { inlineToolCalls: true }
    );
    assert.throws(
      () => assertValidDecision(
        { decision: 'tool-request', toolCalls: [{ id: 't' }], pushPayloads: [{ messageId: '' }] },
        { inlineToolCalls: true }
      ),
      /messageId/
    );
  });
  test('tool-request with neither toolCalls nor pushPayloads → error', () => {
    assert.throws(() => assertValidDecision({ decision: 'tool-request' }, { inlineToolCalls: true }), /requires a pushPayloads array/);
  });
  test('finish still requires pushPayloads even with inlineToolCalls', () => {
    assert.throws(() => assertValidDecision({ decision: 'finish' }, { inlineToolCalls: true }), /requires a pushPayloads array/);
  });
});

describe('extractToolCallsFromDecision', () => {
  test('prefers decision.toolCalls', () => {
    const tc = [{ id: 't1' }];
    assert.equal(extractToolCallsFromDecision({ decision: 'tool-request', toolCalls: tc }), tc);
  });
  test('falls back to flattening pushPayloads[].toolCalls', () => {
    const out = extractToolCallsFromDecision({
      decision: 'tool-request',
      pushPayloads: [{ toolCalls: [{ id: 'a' }] }, { message: 'no tools here' }, { toolCalls: [{ id: 'b' }] }],
    });
    assert.deepEqual(out.map((t) => t.id), ['a', 'b']);
  });
  test('nothing extractable → []', () => {
    assert.deepEqual(extractToolCallsFromDecision({ decision: 'finish', pushPayloads: [{}] }), []);
    assert.deepEqual(extractToolCallsFromDecision(null), []);
  });
});
