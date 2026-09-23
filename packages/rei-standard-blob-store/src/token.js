// 令牌与 id：`<prefix><id>`。id 形如 b_<毫秒时间戳 base36>_<进程内序号>_<随机 6 位>，
// 时间戳可反解，GC 的新鲜豁免靠它。id 对消费者不透明——宿主存量的其他格式照常读写，
// 只是 parseIdTimestamp 反解不出、GC 按「老」处理（见 gc.js）。

export const DEFAULT_PREFIX = 'blobref:';

// id 的合法字符集，全包只此一份。extractRefs 逐字符扫 ID_CHAR 来划令牌在文本里的边界，
// 要整串判定的地方（gc / content-scan / store）走下面的 isIdCharset——两种用法同源。
const ID_CHAR = /[A-Za-z0-9_]/;
const ID_CHARSET = new RegExp(`^${ID_CHAR.source}+$`);

let seq = 0;

/**
 * 生成新 blob id。
 * @returns {string}
 */
export function genId() {
  return `b_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

/**
 * 反解 id 里的创建时间（毫秒时间戳）。格式不匹配、或时间明显不合理（未来 24 小时之后）时返回 null。
 * 反解出的时间戳如果落在未来（超出当前时刻 24 小时），说明这不是本包生成的 id
 * （多半是宿主存量的其他格式撞上了 `b_` 前缀），同样返回 null——交给 GC 按「老」处理，
 * 避免这类外来 id 被新鲜豁免永久保护、造成泄漏。
 * @param {string} id
 * @param {number} [now] 注入的当前时间（测试用；GC 会把它的时钟传进来，避免两个钟不一致），默认 Date.now()
 * @returns {number | null}
 */
export function parseIdTimestamp(id, now = Date.now()) {
  const m = /^b_([0-9a-z]+)_/.exec(id);
  if (!m) return null;
  const ts = parseInt(m[1], 36);
  if (!Number.isFinite(ts)) return null;
  if (ts > now + 24 * 3600 * 1000) return null;
  return ts;
}

/**
 * 整个 id 是否非空且完整落在令牌字符集内。
 * 字符集外的 id（比如存量数据直接拿带 `-` 的 UUID 当 id）在引用面上提不全——
 * extractRefs 扫到越界字符就收尾，提出来的只是半截。所以 GC 只能豁免这类 id、
 * content-scan 只能跳过、restore 干脆拒收，判定都落在这个函数上。
 * @param {string} id
 * @returns {boolean}
 */
export function isIdCharset(id) {
  return ID_CHARSET.test(id);
}

/**
 * 从任意字符串提取全部令牌。prefix 之后取最长的 [A-Za-z0-9_] 段作为 id，
 * 所以 JSON 串里内嵌的令牌（后随引号）也能正确截断。
 * 返回值含前缀；喂给 parseIdTimestamp 前需先切掉前缀。
 * @param {string} str
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function extractRefs(str, prefix = DEFAULT_PREFIX) {
  if (typeof str !== 'string') return [];
  // 空前缀是配置错误——静默返回 [] 会被 GC 当成「无人引用」，整库清场；非字符串那条保持返回 []（数据问题，答「没有 ref」是实话）。
  if (!prefix) throw new TypeError('extractRefs: prefix 不能为空');
  const refs = [];
  let i = 0;
  let runEnd = 0; // 已扫过的词字符 run 终点。全词字符前缀（如 'img_'）会让每个匹配点都落在同一条 run 里，不记这个终点就会逐点重扫整条 run、退化成 O(n²)
  while ((i = str.indexOf(prefix, i)) !== -1) {
    let j = i + prefix.length;
    if (j < runEnd) j = runEnd; // i 落在上一条已扫 run 内：[j, runEnd) 都是词字符，直接续用终点
    while (j < str.length && ID_CHAR.test(str[j])) j++;
    runEnd = j;
    if (j > i + prefix.length) refs.push(str.slice(i, j));
    // 只跳过 prefix 本身、不跳过整个 id 段：'blobref:blobref:b_x' 里第二个令牌
    // 紧贴在第一个 id 段（恰好是字面 'blobref'）之后，跳过 id 段就漏提了。
    // 多提只会多保（GC 方向安全）；prefix 非空所以必然前进，不会死循环。
    i += prefix.length;
  }
  return refs;
}
