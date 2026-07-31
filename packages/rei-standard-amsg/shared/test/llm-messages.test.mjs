import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LLM_MESSAGES_ERROR,
  validateLlmMessagesShape,
} from '../src/index.js';

// ─── validateLlmMessagesShape ───────────────────────────────────────────
// instant 的 validateMessagesArray 与 server 的 validateLlmMessagesArray
// 都是本函数的薄封装（只做错误文案映射），这里覆盖形状规则本身。

test('validateLlmMessagesShape: non-array / empty array', () => {
  assert.deepEqual(validateLlmMessagesShape(undefined), { code: LLM_MESSAGES_ERROR.MESSAGES_NOT_ARRAY });
  assert.deepEqual(validateLlmMessagesShape('hi'), { code: LLM_MESSAGES_ERROR.MESSAGES_NOT_ARRAY });
  assert.deepEqual(validateLlmMessagesShape([]), { code: LLM_MESSAGES_ERROR.MESSAGES_NOT_ARRAY });
});

test('validateLlmMessagesShape: plain conversation passes', () => {
  assert.equal(validateLlmMessagesShape([
    { role: 'system', content: 'you are Rei' },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: 'hello' },
  ]), null);
});

test('validateLlmMessagesShape: non-object / invalid role / bad content carry index', () => {
  assert.deepEqual(validateLlmMessagesShape([{ role: 'user', content: 'x' }, null]),
    { code: LLM_MESSAGES_ERROR.MESSAGE_NOT_OBJECT, index: 1 });
  assert.deepEqual(validateLlmMessagesShape([{ role: 'robot', content: 'x' }]),
    { code: LLM_MESSAGES_ERROR.INVALID_ROLE, index: 0 });
  assert.deepEqual(validateLlmMessagesShape([{ role: 'user', content: '' }]),
    { code: LLM_MESSAGES_ERROR.CONTENT_EMPTY_STRING, index: 0 });
  assert.deepEqual(validateLlmMessagesShape([{ role: 'user', content: [] }]),
    { code: LLM_MESSAGES_ERROR.CONTENT_EMPTY_ARRAY, index: 0 });
  assert.deepEqual(validateLlmMessagesShape([{ role: 'user', content: 42 }]),
    { code: LLM_MESSAGES_ERROR.CONTENT_INVALID_TYPE, index: 0 });
});

test('validateLlmMessagesShape: assistant + tool_calls may omit content', () => {
  const toolCalls = [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }];
  assert.equal(validateLlmMessagesShape([{ role: 'assistant', content: null, tool_calls: toolCalls }]), null);
  assert.equal(validateLlmMessagesShape([{ role: 'assistant', content: '', tool_calls: toolCalls }]), null);
  assert.equal(validateLlmMessagesShape([{ role: 'assistant', tool_calls: toolCalls }]), null);
});

test('validateLlmMessagesShape: empty tool_calls falls through to content rules', () => {
  // tool_calls: [] 不是 carrier —— 空 content 的 assistant 仍然被拒
  assert.deepEqual(validateLlmMessagesShape([{ role: 'assistant', content: '', tool_calls: [] }]),
    { code: LLM_MESSAGES_ERROR.CONTENT_EMPTY_STRING, index: 0 });
});

test('validateLlmMessagesShape: malformed tool_call carries both indices', () => {
  assert.deepEqual(validateLlmMessagesShape([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c' }] }, // 缺 function
  ]), { code: LLM_MESSAGES_ERROR.TOOL_CALL_MALFORMED, index: 1, toolCallIndex: 0 });
});

test('validateLlmMessagesShape: tool messages need tool_call_id, allow empty content', () => {
  assert.equal(validateLlmMessagesShape([{ role: 'tool', tool_call_id: 'call_1', content: '' }]), null);
  assert.deepEqual(validateLlmMessagesShape([{ role: 'tool', content: 'result' }]),
    { code: LLM_MESSAGES_ERROR.TOOL_CALL_ID_MISSING, index: 0 });
  assert.deepEqual(validateLlmMessagesShape([{ role: 'tool', tool_call_id: 'c', content: 42 }]),
    { code: LLM_MESSAGES_ERROR.TOOL_CONTENT_INVALID, index: 0 });
});
