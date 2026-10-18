import { test } from 'node:test';
import assert from 'node:assert/strict';

test('every shared push builder / guard is re-exported unchanged', async () => {
  const shared = await import('@rei-standard/amsg-shared');
  const instant = await import('../src/index.js');
  const names = Object.keys(shared).filter((name) => /^(build|is)\w+Push$/.test(name));
  assert.ok(names.includes('buildResultPush'));
  for (const name of names) assert.equal(instant[name], shared[name], name);
});
