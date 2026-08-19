// 令牌与 id：`<prefix><id>`。id 形如 b_<毫秒时间戳 base36>_<进程内序号>_<随机 6 位>，
// 时间戳可反解，GC 的新鲜豁免靠它。id 对消费者不透明——宿主存量的其他格式照常读写，
// 只是 parseIdTimestamp 反解不出、GC 按「老」处理（见 gc.js）。

export const DEFAULT_PREFIX = 'blobref:';

let seq = 0;

/** 生成新 blob id。 */
export function genId() {
  return `b_${Date.now().toString(36)}_${(seq++).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 反解 id 里的创建时间（毫秒时间戳）。只认识本包生成的 `b_` 格式，其余返回 null。
 * @param {string} id
 * @returns {number | null}
 */
export function parseIdTimestamp(id) {
  const m = /^b_([0-9a-z]+)_/.exec(id);
  if (!m) return null;
  const ts = parseInt(m[1], 36);
  return Number.isFinite(ts) ? ts : null;
}

/**
 * 从任意字符串提取全部令牌。prefix 之后取最长的 [A-Za-z0-9_] 段作为 id，
 * 所以 JSON 串里内嵌的令牌（后随引号）也能正确截断。
 * @param {string} str
 * @param {string} [prefix]
 * @returns {string[]}
 */
export function extractRefs(str, prefix = DEFAULT_PREFIX) {
  const refs = [];
  let i = 0;
  while ((i = str.indexOf(prefix, i)) !== -1) {
    let j = i + prefix.length;
    while (j < str.length && /[A-Za-z0-9_]/.test(str[j])) j++;
    if (j > i + prefix.length) refs.push(str.slice(i, j));
    i = j; // 裸前缀（j 停在 prefix 尾）也前进，不会死循环
  }
  return refs;
}
