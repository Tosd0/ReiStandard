import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFIX, genId, parseIdTimestamp, extractRefs } from '../src/token.js';

test('genId 形如 b_<ts36>_<seq36>_<rand>，且互不相同', () => {
  const a = genId();
  const b = genId();
  assert.match(a, /^b_[0-9a-z]+_[0-9a-z]+_[0-9a-z]{6}$/);
  assert.notEqual(a, b);
});

test('parseIdTimestamp 反解出的时间贴近当前', () => {
  const before = Date.now();
  const ts = parseIdTimestamp(genId());
  assert.ok(ts !== null && ts >= before - 1000 && ts <= Date.now() + 1000);
});

test('parseIdTimestamp 对非本格式 id 返回 null', () => {
  assert.equal(parseIdTimestamp('img_abc_0_xyz123'), null); // 宿主存量格式
  assert.equal(parseIdTimestamp('随便什么'), null);
  assert.equal(parseIdTimestamp(''), null);
});

test('extractRefs 从 JSON 串里提取令牌并在引号处截断', () => {
  const id = genId();
  const json = JSON.stringify({ wallpaper: DEFAULT_PREFIX + id, note: 'no ref here' });
  assert.deepEqual(extractRefs(json), [DEFAULT_PREFIX + id]);
});

test('extractRefs 提取多个令牌、支持自定义前缀、裸前缀不算', () => {
  const s = `x blobref:b_1_2_aaaaaa,blobref:img_old blobref: end`;
  assert.deepEqual(extractRefs(s), ['blobref:b_1_2_aaaaaa', 'blobref:img_old']);
  assert.deepEqual(extractRefs('pic:abc_1', 'pic:'), ['pic:abc_1']);
});
