// 内容查重：把库里的 Blob 按内容哈希（SHA-256）分组，回答「哪些令牌指着同一份内容」。
// 用处有两个：存量合并（把重复令牌在引用面上改写成同一个）、迁移期防再生（新图 put 前
// 先查哈希，命中就复用已有令牌）。
//
// 纯只读——不删、不改、不写。合并引用是宿主自己的事（引用面长什么样只有宿主知道），
// 合并完剩下的 Blob 自然变成孤儿，下一轮孤儿 GC 收掉（见 gc.js）。
//
// 错误哲学与 gc.js 同族：adapter.keys() 读不出来就放弃整轮（aborted: true），
// 绝不把「读不到」说成「没有重复」——宿主拿着一份假的「没有重复」会以为清干净了。
// 单条 blob 读失败或算不出哈希只跳过这一条（计入 skipped），整轮照常出结果。

import { parseIdTimestamp } from './token.js';

// 与 extractRefs 的 id 边界字符集保持一致（见 token.js；gc.js / store.js 的同名常量同源）
const ID_CHARSET = /^[A-Za-z0-9_]+$/;

/**
 * @typedef {Object} DuplicateGroup
 * @property {string} canonical 这份内容留下来的那个令牌（含前缀）：组内创建时间最早的一个
 * @property {string[]} duplicates 组内其余令牌（含前缀），同样按创建时间升序
 * @property {number} size 这份内容单份占的字节数
 * @property {number} wastedBytes 这一组多存的字节 = size × duplicates.length
 */

/**
 * @typedef {Object} ContentScanOptions
 * @property {(done: number, total: number) => void} [onProgress] 每处理完一条回调一次（被跳过的也算），
 *   `total` 是 `keys()` 返回的条数。整库扫描要逐条读 Blob，界面上一般得有个进度条。
 *   回调里抛错会让整轮 reject——扫描是只读的，抛出去不会留下半拉状态
 */

/**
 * @typedef {Object} ContentScanResult
 * @property {Map<string, string[]>} byHash 内容哈希（小写 hex）→ 该内容的全部令牌（含前缀），
 *   组内按 id 创建时间升序。迁移期拿它当 cache 用：新图算完哈希一查，命中就复用已有令牌
 * @property {DuplicateGroup[]} duplicateGroups 只含组内多于一个令牌的，按 `wastedBytes` 从大到小排
 * @property {number} scanned 成功读到并算出哈希的条数
 * @property {number} skipped 跳过的条数：id 超出令牌字符集、Blob 读不出来、哈希算不出来。
 *   它等于全库条数时别读成「没有重复」：非安全上下文里根本没有 crypto.subtle，每条都会算不出哈希
 * @property {number} wastedBytes 全库因重复多占的字节数 = 各组 `wastedBytes` 之和
 * @property {boolean} aborted `keys()` 读不出来 → 整轮放弃，结果为空。为 true 时其余字段全是零值，
 *   别把它当成「库里没有重复」
 */

/**
 * 算 Blob 内容的 SHA-256，返回小写 hex 串。
 * 走 `globalThis.crypto.subtle`——浏览器里它只在安全上下文（https / localhost）里有，
 * 拿不到直接抛：算不出哈希时返回个假值，宿主会拿它去合并引用，那是要破图的。
 * @param {Blob} blob
 * @returns {Promise<string>}
 * @throws {TypeError} 入参不是 Blob（鸭子判定，跨 realm 的 instanceof 不可靠，与 put 同款）
 * @throws {Error} 当前环境没有 crypto.subtle
 */
export async function hashBlob(blob) {
  if (!blob || typeof blob.arrayBuffer !== 'function') {
    throw new TypeError('hashBlob: 需要 Blob');
  }
  return hashBytes(await blob.arrayBuffer());
}

/**
 * ArrayBuffer → SHA-256 hex。扫描时 Blob 已经被读成 buffer 了，走这条免得再读一遍。
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>}
 */
async function hashBytes(buffer) {
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) throw new Error('hashBlob: 当前环境没有 crypto.subtle（浏览器里它只在 https / localhost 这类安全上下文可用）');
  const bytes = new Uint8Array(await subtle.digest('SHA-256', buffer));
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * 扫全库、按内容分组。语义见文件头与 ContentScanResult。
 * @param {{ adapter: import('./store.js').StorageAdapter, prefix: string }} ctx
 * @param {ContentScanOptions} [opts]
 * @returns {Promise<ContentScanResult>}
 * @throws {TypeError} onProgress 传了但不是函数——编程错误，吵着抛
 */
export async function runContentScan({ adapter, prefix }, opts) {
  const { onProgress } = opts || {};
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new TypeError('scanContent: onProgress 只能不传，或者传一个函数');
  }

  let ids;
  try {
    ids = await adapter.keys();
  } catch {
    return { byHash: new Map(), duplicateGroups: [], scanned: 0, skipped: 0, wastedBytes: 0, aborted: true };
  }

  const total = ids.length;
  const now = Date.now(); // 一轮扫描共用一个钟，免得排序时前后两条按不同的「现在」判时间戳合不合理
  /** @type {Map<string, { size: number, entries: Array<{ id: string, ts: number | null }> }>} */
  const buckets = new Map();
  let scanned = 0;
  let skipped = 0;
  let done = 0;

  // 串行是刻意的：算哈希要把整个 Blob 读进内存，并行会把 IDB 和内存峰值一起压满。
  for (const id of ids) {
    try {
      // 字符集外的 id 整条跳过：extractRefs 按该字符集划边界，这类 id 在引用面上提不全，
      // 宿主没法把指向它的引用可靠地改写成 canonical，合并进去就是破图（与 gc.js 安全阀 5 同源）
      if (!ID_CHARSET.test(id)) { skipped++; continue; }
      const blob = await adapter.get(id);
      // keys() 之后、读到之前被删掉了，或者适配器吐了个不是 Blob 的东西
      if (!blob || typeof blob.arrayBuffer !== 'function') { skipped++; continue; }
      const buffer = await blob.arrayBuffer();
      const hash = await hashBytes(buffer);
      let bucket = buckets.get(hash);
      // 大小取 buffer 的实际字节数：同一哈希必然同样大，第一条记下来就够
      if (!bucket) { bucket = { size: buffer.byteLength, entries: [] }; buckets.set(hash, bucket); }
      bucket.entries.push({ id, ts: parseIdTimestamp(id, now) });
      scanned++;
    } catch {
      skipped++; // 单条读失败 / 算不出哈希只丢这一条，整轮照常出结果
    } finally {
      done++;
      onProgress?.(done, total);
    }
  }

  /** @type {Map<string, string[]>} */
  const byHash = new Map();
  /** @type {DuplicateGroup[]} */
  const duplicateGroups = [];
  let wastedBytes = 0;
  for (const [hash, bucket] of buckets) {
    bucket.entries.sort(compareByAge);
    const tokens = bucket.entries.map((e) => prefix + e.id);
    byHash.set(hash, tokens);
    if (tokens.length > 1) {
      // canonical 取最老的那个：它存在得最久、被引用的面最广，宿主改写引用时万一漏了一处，
      // 漏的那处多半还指着它，图仍然在。反过来留最新的当 canonical，漏改的引用指向的是
      // 即将变孤儿的老 Blob——老 Blob 享受不到 GC 的新鲜豁免，一轮扫描下来就成死链了。
      const duplicates = tokens.slice(1);
      const groupWasted = bucket.size * duplicates.length;
      wastedBytes += groupWasted;
      duplicateGroups.push({ canonical: tokens[0], duplicates, size: bucket.size, wastedBytes: groupWasted });
    }
  }
  // 浪费最多的排前面：宿主要在界面上列「这些重复占了多少」，先看到的就该是最值得合并的
  duplicateGroups.sort((a, b) => (b.wastedBytes - a.wastedBytes) || compareId(a.canonical, b.canonical));

  return { byHash, duplicateGroups, scanned, skipped, wastedBytes, aborted: false };
}

/**
 * 组内排序：创建时间早的在前。反解不出时间的排到最后——没有时间可比，就没有「它最老」的
 * 证据，让这种 id 当 canonical 只是猜。时间相同、或两边都反解不出时按 id 字面比，
 * 结果因此与 adapter.keys() 的返回顺序无关，换个后端 canonical 不会跟着变。
 * @param {{ id: string, ts: number | null }} a
 * @param {{ id: string, ts: number | null }} b
 */
function compareByAge(a, b) {
  const ta = a.ts === null ? Infinity : a.ts;
  const tb = b.ts === null ? Infinity : b.ts;
  if (ta !== tb) return ta < tb ? -1 : 1;
  return compareId(a.id, b.id);
}

/**
 * 字面比较，只为让顺序确定下来（不牵扯 locale）。
 * @param {string} a
 * @param {string} b
 */
function compareId(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
