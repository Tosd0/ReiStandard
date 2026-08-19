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

test('全词字符前缀（img_）的对抗输入下 extractRefs 保持线性：记忆化 run 终点，不逐点重扫成 O(n²)', () => {
  const s = 'img_'.repeat(20000); // 80KB。O(n²) 时此规模实测要数秒，线性则毫秒级
  const t0 = process.hrtime.bigint();
  const refs = extractRefs(s, 'img_');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // 记忆化不改变提取结果：每个匹配点提出「该点到 run 尾」，最后一个匹配点后面没有 id 字符、不提
  assert.equal(refs.length, 19999);
  assert.equal(refs[0], s);
  assert.equal(refs[1], s.slice(4));
  assert.ok(ms < 1500, `extractRefs 花了 ${ms}ms，疑似退化回 O(n²)`);
});

test('extractRefs 不漏提紧跟在字面前缀文本之后的令牌（双前缀串里第二个才是真令牌）', () => {
  // 宿主拼重前缀（prefix + token）会产出这种串：第一段提出来的 'blobref:blobref'
  // 是死引用，第二段才对应真实 id——漏提它，被引用的 blob 就成了 GC 眼里的孤儿。
  assert.deepEqual(
    extractRefs('blobref:blobref:b_123_0_abcdef'),
    ['blobref:blobref', 'blobref:b_123_0_abcdef'],
  );
});

test('parseIdTimestamp：注入钟落后创建时刻一小时仍能反解（跨设备时钟偏差不吞新鲜豁免）', () => {
  // 「未来 24h 容忍窗」的下界方向：快钟一方生成的 id，在慢钟一方跑 GC 时时间戳落在
  // 「未来」，但只要在容忍窗内就必须照常反解——否则被判外来 → 按「老」处理 → 新鲜豁免
  // 失守，put→引用落盘之间的竞态窗内会被删。收紧成 ts > now 的实现会在这里挂。
  const ts = 1755600000000;
  const id = `b_${ts.toString(36)}_0_aaaaaa`;
  assert.equal(parseIdTimestamp(id, ts - 3600 * 1000), ts);
});

test('parseIdTimestamp：b_ 出现在中间的宿主存量 id（thumb_…）不从中间误解析出时间戳', () => {
  // 正则丢了 ^ 锚点的话，'thumb_<近期ts36>_x' 会从第 3 个字符起匹配出一个「新」时间戳、
  // 错误吃到新鲜豁免——泄漏方向的错，但存量 id 该老老实实按「老」参与 GC。
  const ts = 1755600000000;
  assert.equal(parseIdTimestamp(`thumb_${ts.toString(36)}_0_aaaaaa`, ts), null);
});

test('未来容忍窗的上界：+23.5h 的时间戳仍反解成功（窗的规格是 24h，悄悄缩窗会没收跨设备快钟 id 的新鲜豁免）', () => {
  const now = 1755600000000;
  const ts = now + 23.5 * 3600 * 1000;
  assert.equal(parseIdTimestamp(`b_${ts.toString(36)}_0_aaaaaa`, now), ts);
  assert.equal(parseIdTimestamp(`b_${(now + 25 * 3600 * 1000).toString(36)}_0_aaaaaa`, now), null);
});
