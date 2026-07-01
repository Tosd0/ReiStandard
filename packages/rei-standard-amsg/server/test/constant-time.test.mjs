import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constantTimeEqual } from '../src/server/lib/constant-time.js';

test('constantTimeEqual matches equal strings', async () => {
  assert.equal(await constantTimeEqual('secret-token', 'secret-token'), true);
});

test('constantTimeEqual rejects different strings', async () => {
  assert.equal(await constantTimeEqual('secret-token', 'wrong-token'), false);
});

test('constantTimeEqual rejects different lengths', async () => {
  assert.equal(await constantTimeEqual('abc', 'abcd'), false);
});

test('constantTimeEqual handles empty / non-string safely', async () => {
  assert.equal(await constantTimeEqual('', ''), true);
  assert.equal(await constantTimeEqual('x', ''), false);
  // Non-string inputs are coerced via String() rather than throwing.
  assert.equal(await constantTimeEqual(null, null), true);
  assert.equal(await constantTimeEqual(null, 'x'), false);
});
