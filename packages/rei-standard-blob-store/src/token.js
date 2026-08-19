// 令牌与 id：`<prefix><id>`。id 形如 b_<毫秒时间戳 base36>_<进程内序号>_<随机 6 位>，
// 时间戳可反解，GC 的新鲜豁免靠它。id 对消费者不透明——宿主存量的其他格式照常读写，
// 只是 parseIdTimestamp 反解不出、GC 按「老」处理（见 gc.js）。

export const DEFAULT_PREFIX = 'blobref:';

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
 * @returns {number | null}
 */
export function parseIdTimestamp(id) {
  const m = /^b_([0-9a-z]+)_/.exec(id);
  if (!m) return null;
  const ts = parseInt(m[1], 36);
  if (!Number.isFinite(ts)) return null;
  if (ts > Date.now() + 24 * 3600 * 1000) return null;
  return ts;
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
  while ((i = str.indexOf(prefix, i)) !== -1) {
    let j = i + prefix.length;
    while (j < str.length && /[A-Za-z0-9_]/.test(str[j])) j++;
    if (j > i + prefix.length) refs.push(str.slice(i, j));
    i = j; // prefix 非空时 j 必然 > i，向前推进，不会死循环
  }
  return refs;
}
