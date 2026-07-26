/**
 * client_state 的落库实现，所有写入方共用。
 *
 * 写入方有两个：HTTP 的 `PUT /client-state`（客户端批量把本地状态同步上来）
 * 和 fire-time hook 的 `ctx.writeState()`（服务端在组消息时把大内容旁路存下
 * 来，见 lib/agentic-fire.js）。加密、大值分块、旧切片清理都在这里一份，
 * 两条路径写出来的行完全同构，读回时也就不用区分是谁写的。
 *
 * 读回在 lib/state-chunks.js 的 resolveClientStateEntries。
 */

import { encryptForStorage } from './encryption.js';
import {
  STATE_CHUNK_SLICE_BYTES,
  chunkNamespaceFor,
  chunkKeyFor,
  chunkKeyPrefixFor,
  buildChunkedRootValue,
  splitStateValue,
} from './state-chunks.js';

const utf8 = new TextEncoder();

// 一次写入的条目上限。客户端一次后台窗口传几十条是设计负载，200 留足余量，
// 同时给 D1 的一次 batch 定个上界。
export const MAX_STATE_ENTRIES_PER_BATCH = 200;
// namespace / key 的字符长度上限，HTTP 与 hook 两条写入路径共用一套。
export const MAX_NAMESPACE_CHARS = 128;
export const MAX_KEY_CHARS = 256;

/** value 的 UTF-8 字节数——各处限额判断用的都是这个口径。 */
export function stateValueBytes(value) {
  return utf8.encode(value).length;
}

/**
 * 把逻辑条目写进 client_state。条目要么是覆盖写（`value` 是字符串），要么是
 * 删除（`value` 为 `null`）：
 *
 *   - 覆盖写：≤ 200KB 单行存；超过的切片跨行存（见 lib/state-chunks.js）。
 *     同一批里先清掉这个 key 上次写入留下的切片行，所以覆盖成更小的值、或者
 *     块数变少，都不会留下尾巴。
 *   - 删除：根行按精确 key 删，切片行按 key 前缀删，一个 key 的数据清干净。
 *
 * 两者都受同一套 last-write-wins 约束：`updatedAt` 比库里已有值旧的写入
 * （或删除）不生效，陈旧批次盖不掉新数据。
 *
 * 条目本身的合法性（namespace / key 字符、value 大小）由调用方先校验好：
 * HTTP handler 逐条拒绝并把原因回给客户端，`writeState()` 直接抛错给 hook。
 *
 * @param {Object} args
 * @param {{ upsertClientState: Function }} args.db
 * @param {string} args.userId
 * @param {CryptoKey|string} args.userKey - 该用户的存储密钥（value 用它加密）
 * @param {Array<{ namespace: string, key: string, value: string|null, updatedAt: number }>} args.entries
 * @returns {Promise<{ upserted: number, skipped: number, deleted: number }>}
 *   `upserted` / `skipped` 按逻辑条目计（切片行不计）；`deleted` 是请求删除的
 *   key 数，不代表这些 key 原本一定存在。
 */
export async function writeClientStateEntries({ db, userId, userKey, entries }) {
  const physicalRows = [];
  const cleanups = [];
  const rootRowIndexes = [];
  let deleted = 0;

  for (const entry of entries) {
    // 不管写还是删，都先清掉这个 key 上一次写入留下的切片行（同一批里先删后写）。
    cleanups.push({
      namespace: chunkNamespaceFor(entry.namespace),
      keyPrefix: chunkKeyPrefixFor(entry.key),
      updatedAt: entry.updatedAt,
    });

    if (entry.value === null) {
      // 根行按精确 key 删——用前缀会连带删掉同前缀的兄弟 key（'note' 删掉 'notes'）。
      cleanups.push({
        namespace: entry.namespace,
        key: entry.key,
        updatedAt: entry.updatedAt,
      });
      deleted++;
      continue;
    }

    rootRowIndexes.push(physicalRows.length);
    if (stateValueBytes(entry.value) <= STATE_CHUNK_SLICE_BYTES) {
      physicalRows.push({
        namespace: entry.namespace,
        key: entry.key,
        value: await encryptForStorage(entry.value, userKey),
        updatedAt: entry.updatedAt,
      });
    } else {
      const slices = splitStateValue(entry.value);
      physicalRows.push({
        namespace: entry.namespace,
        key: entry.key,
        value: buildChunkedRootValue(slices.length),
        updatedAt: entry.updatedAt,
      });
      const encryptedSlices = await Promise.all(slices.map((slice) => encryptForStorage(slice, userKey)));
      for (let c = 0; c < encryptedSlices.length; c++) {
        physicalRows.push({
          namespace: chunkNamespaceFor(entry.namespace),
          key: chunkKeyFor(entry.key, c),
          value: encryptedSlices[c],
          updatedAt: entry.updatedAt,
        });
      }
    }
  }

  if (physicalRows.length === 0 && cleanups.length === 0) {
    return { upserted: 0, skipped: 0, deleted: 0 };
  }

  const result = await db.upsertClientState(userId, physicalRows, cleanups);
  let upserted = 0;
  let skipped = 0;
  if (Array.isArray(result.outcomes) && result.outcomes.length === physicalRows.length) {
    // 逻辑计数：一条条目的 upserted/skipped 看它的根行，切片行不计数。
    for (const rootIndex of rootRowIndexes) {
      if (result.outcomes[rootIndex]) upserted++; else skipped++;
    }
  } else {
    // 自定义 adapter 只回老形状 { upserted, skipped } 时按物理行计数兜底。
    upserted = result.upserted;
    skipped = result.skipped;
  }
  return { upserted, skipped, deleted };
}
