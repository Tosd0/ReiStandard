// 孤儿 GC：mark-and-sweep。总原则「宁可留孤儿，绝不删活图」——
//   1) 任一 refSource 迭代抛错 → 整轮放弃；
//   2) 新鲜豁免：id 反解创建时间距今不足 minAgeMs 的不删（挡住 put 之后、
//      引用落盘之前的竞态窗口）；
//   3) 反解不出时间的存量 id 按「老」处理：老数据早该被引用了，扫不到即真孤儿。
//   4) 入参传错（refSources 不是可迭代对象、混进非字符串）→ 吵着抛 TypeError，不静默当空处理。
// 宿主义务：refSources 必须枚举全部可能含令牌的持久化面，漏一个面就会删活图。

import { extractRefs, parseIdTimestamp } from './token.js';

const DEFAULT_MIN_AGE_MS = 72 * 3600 * 1000;

/**
 * @typedef {Object} GcOptions
 * @property {Iterable<string> | AsyncIterable<string>} refSources 全部可能含令牌的持久化面；吐字符串
 * @property {number} [minAgeMs] 新鲜豁免窗口，默认 72h；0 = 关掉第二道阀（只应出现在测试里）
 * @property {number} [now] 注入的当前时间（测试用），默认 Date.now()
 */
/**
 * @typedef {Object} GcResult
 * @property {number} deleted 实际删除数
 * @property {number} kept 保留数 = 被引用的 + 新鲜豁免的 + 删除失败的
 * @property {boolean} aborted 安全阀触发（来源出错 / keys 读不出）→ 整轮放弃，一个都没删
 */

/**
 * @param {{ adapter: import('./store.js').StorageAdapter, prefix: string }} ctx
 * @param {GcOptions} opts
 * @returns {Promise<GcResult>}
 * @throws {TypeError} refSources 缺失/是裸字符串/不可迭代/吐出非字符串——都是编程错误，吵着抛，不静默
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
    return { deleted: 0, kept: 0, aborted: true };
  }
  if (nonStringChunk) throw new TypeError('gc: refSources 只能吐字符串（整行对象请自己 JSON.stringify 后再吐）');

  // sweep：不在集合里的删，新鲜的豁免。keys 读不出来也放弃。
  let ids;
  try {
    ids = await adapter.keys();
  } catch {
    return { deleted: 0, kept: 0, aborted: true };
  }

  let deleted = 0;
  let kept = 0;
  // 串行删除是刻意的——GC 是后台活儿，并行只会压满 IDB。
  for (const id of ids) {
    if (used.has(id)) { kept++; continue; }
    const ts = parseIdTimestamp(id);
    if (ts !== null && now - ts < minAgeMs) { kept++; continue; }
    try {
      await adapter.delete(id);
      deleted++;
    } catch {
      kept++; // 删失败按保留计，下轮再试
    }
  }
  return { deleted, kept, aborted: false };
}
