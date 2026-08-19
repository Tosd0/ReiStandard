import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFIX, genId, parseIdTimestamp, extractRefs } from '../src/token.js';

test('genId 形如 b_<ts36>_<seq36>_<rand>，且互不相同', () => {
  const a = genId();
  const b = genId();
  assert.match(a, /^b_[0-9a-z]+_[0-9a-z]+_[0-9a-z]{6}$/);
  assert.notEqual(a, b);
  const seqA = a.split('_')[2];
  const seqB = b.split('_')[2];
  assert.equal(parseInt(seqB, 36), parseInt(seqA, 36) + 1);
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

test('parseIdTimestamp 对反解出未来时间戳的外来 id 返回 null（防止 GC 新鲜豁免永久生效）', () => {
  assert.equal(parseIdTimestamp('b_deadbeefcafe_x'), null);
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

test('extractRefs 空前缀是配置错误，抛 TypeError', () => {
  assert.throws(() => extractRefs('abc', ''), TypeError);
});

test('extractRefs 非字符串输入返回空数组', () => {
  assert.deepEqual(extractRefs(null), []);
  assert.deepEqual(extractRefs(undefined), []);
  assert.deepEqual(extractRefs(123), []);
});

test('extractRefs 无匹配时返回空数组', () => {
  assert.deepEqual(extractRefs('no tokens in this string'), []);
});

test('extractRefs 提取值切掉前缀后交给 parseIdTimestamp 能还原出贴近当前的时间（前缀切割的接缝）', () => {
  const id = genId();
  const before = Date.now();
  const json = JSON.stringify({ wallpaper: DEFAULT_PREFIX + id });
  const [ref] = extractRefs(json);
  const bareId = ref.slice(DEFAULT_PREFIX.length);
  const ts = parseIdTimestamp(bareId);
  assert.ok(ts !== null && ts >= before - 1000 && ts <= Date.now() + 1000);
});
