// 孤儿 GC：mark-and-sweep。总原则「宁可留孤儿，绝不删活图」——
//   1) 任一 refSource 迭代抛错 → 整轮放弃；
//   2) 新鲜豁免：id 反解创建时间距今不足 minAgeMs 的不删（挡住 put 之后、
//      引用落盘之前的竞态窗口）；
//   3) 反解不出时间的存量 id 按「老」处理：老数据早该被引用了，扫不到即真孤儿。
// 宿主义务：refSources 必须枚举全部可能含令牌的持久化面，漏一个面就会删活图。

import { extractRefs, parseIdTimestamp } from './token.js';

const DEFAULT_MIN_AGE_MS = 72 * 3600 * 1000;

/**
 * @param {{ adapter: import('./store.js').StorageAdapter, prefix: string }} ctx
 * @param {{ refSources: Iterable<string> | AsyncIterable<string>, minAgeMs?: number, now?: number }} opts
 * @returns {Promise<{ deleted: number, kept: number, aborted: boolean }>}
 */
export async function runGc({ adapter, prefix }, opts) {
  const { refSources, minAgeMs = DEFAULT_MIN_AGE_MS, now = Date.now() } = opts || {};
  if (!refSources) throw new Error('gc: refSources is required');

  // mark：汇总在用 id。任何一个来源出错都放弃整轮。
  const used = new Set();
  try {
    for await (const chunk of refSources) {
      if (typeof chunk !== 'string') continue;
      for (const ref of extractRefs(chunk, prefix)) used.add(ref.slice(prefix.length));
    }
  } catch {
    return { deleted: 0, kept: 0, aborted: true };
  }

  // sweep：不在集合里的删，新鲜的豁免。keys 读不出来也放弃。
  let ids;
  try {
    ids = await adapter.keys();
  } catch {
    return { deleted: 0, kept: 0, aborted: true };
  }

  let deleted = 0;
  let kept = 0;
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
