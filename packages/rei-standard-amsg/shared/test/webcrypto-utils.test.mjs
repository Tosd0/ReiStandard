import { test } from 'node:test';
import assert from 'node:assert/strict';

import { concatBytes } from '../src/webcrypto-utils.js';

test('concatBytes: honours byteOffset / byteLength of subarray and DataView inputs', () => {
  const backing = new Uint8Array([1, 2, 3, 4, 5]);
  const sub = backing.subarray(2, 4);               // [3, 4]
  const view = new DataView(backing.buffer, 1, 2);  // [2, 3]
  assert.deepEqual(
    Array.from(concatBytes(sub, view, backing.buffer.slice(0, 1))),
    [3, 4, 2, 3, 1],
  );
});
