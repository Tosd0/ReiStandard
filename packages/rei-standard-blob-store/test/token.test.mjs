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

test('parseIdTimestamp 的「未来 24h」判定用注入的 now，不偷用真实时钟（与 GC 注入的钟保持一致）', () => {
  const ts = Date.now();
  const id = `b_${ts.toString(36)}_0_aaaaaa`;
  // 相对注入时钟，ts 落在 25 小时之后 → 判为外来 id 返回 null。
  // 内部若误用 Date.now()，ts 就是「现在」、不在未来，会错误地返回 ts。
  assert.equal(parseIdTimestamp(id, ts - 25 * 3600 * 1000), null);
  assert.equal(parseIdTimestamp(id, ts), ts);
});

test('extractRefs 不漏提紧跟在字面前缀文本之后的令牌（双前缀串里第二个才是真令牌）', () => {
  // 宿主拼重前缀（prefix + token）会产出这种串：第一段提出来的 'blobref:blobref'
  // 是死引用，第二段才对应真实 id——漏提它，被引用的 blob 就成了 GC 眼里的孤儿。
  assert.deepEqual(
    extractRefs('blobref:blobref:b_123_0_abcdef'),
    ['blobref:blobref', 'blobref:b_123_0_abcdef'],
  );
});
