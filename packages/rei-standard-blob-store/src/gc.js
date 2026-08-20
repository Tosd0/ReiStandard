// 孤儿 GC：mark-and-sweep。总原则「宁可留孤儿，绝不删活图」——
//   1) 任一 refSource 迭代抛错 → 整轮放弃；
//   2) 新鲜豁免：id 反解创建时间距今不足 minAgeMs 的不删（挡住 put 之后、
//      引用落盘之前的竞态窗口）；
//   3) 反解不出时间的存量 id 按「老」处理：老数据早该被引用了，扫不到即真孤儿。
//   4) 入参传错（refSources 不是可迭代对象、混进非字符串；minAgeMs/now 不是非负有限数字）
//      → 吵着抛 TypeError，不静默当空处理。
//   5) 超出令牌字符集 [A-Za-z0-9_] 的 id（如 UUID 带 `-`）一律保留：extractRefs 按该字符集
//      划边界，这类 id 结构上不可能被 mark 到，「无引用」对它们不构成孤儿证据。
//      代价是这类存量 id 永不回收——想回收先迁移成本包生成的格式。
//   6) 边界歧义豁免：存储 id 与某个在用 id 互为前缀时不删。这是令牌被拼进复合键
//     （`${token}_thumb` 提出的 id 比真实 id 长）或引用面文本在令牌中间被切开
//     （只提出半截 id）时留下的痕迹——真实 id 都进不了 mark 集，但前缀关系还在。
//      这是兜底不是许可：切在前缀边界上时连痕迹都没有，宿主仍须守边界义务（见 README）。
// 宿主义务：refSources 必须枚举全部可能含令牌的持久化面，且吐出令牌逐字可见的明文
//（压缩/加密/编码过的面先还原再吐）——面漏了或令牌不可见，都会删活图。
// 另外两条同级义务（详见 README「孤儿 GC 与宿主义务」）：一张 blob 表只能配一个前缀
//（mark 只认本 store 前缀、sweep 扫整张表，多前缀共表会互删活图）；GC 一轮进行中
// 引用不得在面间搬家（mark 不是一致性快照，瞬间从所有面消失就会被误判孤儿）。

import { extractRefs, parseIdTimestamp } from './token.js';

const DEFAULT_MIN_AGE_MS = 72 * 3600 * 1000;

// 与 extractRefs 的 id 边界字符集保持一致（见 token.js）
const ID_CHARSET = /^[A-Za-z0-9_]+$/;

/**
 * @typedef {Object} GcOptions
 * @property {(Iterable<string> | AsyncIterable<string>) & object} refSources 全部可能含令牌的持久化面；吐字符串。`& object` 把裸字符串挡在类型层——string 本身满足 Iterable<string>，而那恰是会「逐字符迭代、什么都标记不到」的最危险误用
 * @property {number} [minAgeMs] 新鲜豁免窗口，默认 72h；0 = 关掉第二道阀（只应出现在测试里）。只接受非负有限数字，NaN/null/Infinity 直接抛 TypeError（见 runGc 里的护栏）
 * @property {number} [now] 注入的当前时间（测试用），默认 Date.now()。同款只接受非负有限数字
 */
/**
 * @typedef {Object} GcResult
 * @property {number} deleted 实际删除数
 * @property {number} kept 保留数 = 被引用的 + 新鲜豁免的 + 删除失败的 + 超出令牌字符集豁免的 + 边界歧义豁免的
 * @property {number} keptBoundary kept 里被边界歧义豁免（安全阀 6）拦下的那部分，单独计数。
 *   它接近库存量时，多半是某个引用面里混进了杂散的令牌前缀文本（比如把 'blobref:b_' 当例子
 *   写进了会被扫到的文案）——提出来的短 id 是每个 SDK 生成 id 的前缀，GC 从此整轮空转，
 *   而 deleted:0 与「本来就没垃圾」同形，这个计数是宿主唯一能察觉的信号。
 * @property {boolean} aborted 安全阀触发（来源出错 / keys 读不出）→ 整轮放弃，一个都没删
 */

/**
 * @param {{ adapter: import('./store.js').StorageAdapter, prefix: string }} ctx
 * @param {GcOptions} opts
 * @returns {Promise<GcResult>}
 * @throws {TypeError} refSources 缺失/是裸字符串/不可迭代/吐出非字符串，或 minAgeMs/now 传成 NaN、null 等非「非负有限数字」——都是编程错误，吵着抛，不静默
 */
export async function runGc({ adapter, prefix }, opts) {
  const { refSources, minAgeMs = DEFAULT_MIN_AGE_MS, now = Date.now() } = opts || {};
  if (typeof refSources === 'string') {
    throw new TypeError('gc: refSources 要的是吐字符串的可迭代对象，不是单个字符串（会被逐字符迭代、什么都标记不到）；只有一段就传 [str]');
  }
  if (!refSources) throw new TypeError('gc: refSources is required');
  // 用 in 探测而不是读属性：惰性可迭代对象「取迭代器时才抛错」属于来源坏了，
  // 该走下面的安全阀 abort，不能被这里的探测动作提前引爆。
  if (!(Symbol.asyncIterator in Object(refSources)) && !(Symbol.iterator in Object(refSources))) {
    throw new TypeError('gc: refSources 必须是（异步）可迭代对象');
  }
  // 数字参数与 refSources 同款待遇：不是「不传（走默认）或非负有限数字」就吵着抛。
  // NaN（宿主拿 undefined 参与乘法算 minAgeMs 最常见）/ null 会让 `now - ts < minAgeMs`
  // 恒为 false——新鲜豁免静默关闭，恰好在它要挡的竞态窗口（已 put、引用未落盘）里
  // 删活图，且 aborted:false、结果毫无异样。解构默认值只救 undefined，救不了这些。
  for (const [name, value] of [['minAgeMs', minAgeMs], ['now', now]]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError(`gc: ${name} 只能不传（走默认）或传非负有限数字，拿到 ${String(value)}——NaN/null 这类值会让新鲜豁免静默失效，不能带病跑`);
    }
  }

  // mark：汇总在用 id。任何一个来源出错都放弃整轮。
  const used = new Set();
  let nonStringChunk = false;
  try {
    for await (const chunk of refSources) {
      if (chunk == null) continue; // localStorage.getItem 合法吐 null
      if (typeof chunk !== 'string') { nonStringChunk = true; break; } // break 会自动调用迭代器的 .return()，不留悬空游标
      for (const ref of extractRefs(chunk, prefix)) used.add(ref.slice(prefix.length));
    }
  } catch {
    return { deleted: 0, kept: 0, keptBoundary: 0, aborted: true };
  }
  if (nonStringChunk) throw new TypeError('gc: refSources 只能吐字符串（整行对象请自己 JSON.stringify 后再吐）');

  // sweep：不在集合里的删，新鲜的豁免。keys 读不出来也放弃。
  let ids;
  try {
    ids = await adapter.keys();
  } catch {
    return { deleted: 0, kept: 0, keptBoundary: 0, aborted: true };
  }

  let deleted = 0;
  let kept = 0;
  let keptBoundary = 0;
  const usedIds = [...used]; // 安全阀 6 要线性扫，循环外物化一次
  // 串行删除是刻意的——GC 是后台活儿，并行只会压满 IDB。
  for (const id of ids) {
    if (used.has(id)) { kept++; continue; }
    if (!ID_CHARSET.test(id)) { kept++; continue; } // 安全阀 5：mark 不可能命中的 id，无引用不构成证据
    const ts = parseIdTimestamp(id, now);
    if (ts !== null && now - ts < minAgeMs) { kept++; continue; }
    // 安全阀 6：与某个在用 id 互为前缀 = 令牌边界出过事（复合键拼接 / 分块切开）的痕迹，不删。
    // 放在最后一道：只有走到「要删」的 id 才付这趟 O(在用数) 的线性扫。
    // 单独计数：一个杂散的超短「在用」id（如文案里的 'blobref:b_'）会让这道阀拦下全库、
    // GC 静默整体失效——keptBoundary 暴涨是宿主该去排查引用面的信号（见 GcResult）。
    if (usedIds.some((u) => u.startsWith(id) || id.startsWith(u))) { kept++; keptBoundary++; continue; }
    try {
      await adapter.delete(id);
      deleted++;
    } catch {
      kept++; // 删失败按保留计，下轮再试
    }
  }
  return { deleted, kept, keptBoundary, aborted: false };
}
