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

/** 已经就「这个 namespace 的 TTL 配得不对」告过警的键（每个只说一次）。 */
const warnedInvalidTtl = new Set();

/**
 * 把 `clientStateTtl` 配置（`{ 命名空间: 天数 }`）算成清理指令。
 *
 * 一个命名空间出两条：它自己，加上它的切片命名空间（大值分块存在那儿，见
 * lib/state-chunks.js）。两边共用同一个截止时刻——同一次写入的根行和切片行
 * `updated_at` 相同，所以要么一起留、要么一起走，不会留下半截数据。
 *
 * 天数不是正数的条目跳过并告警（每个键只说一次）：配错了就该看得见，但不能
 * 让 cron 每分钟刷一条。
 *
 * @param {Record<string, number>|null|undefined} ttl - `{ 命名空间: 天数 }`；天数可带小数
 * @param {number} now - 当前时刻（epoch 毫秒）
 * @returns {Array<{ namespace: string, updatedBefore: number }>}
 *   `updatedBefore` 是 epoch 毫秒：这个命名空间下 `updated_at` 早于它的条目该清掉。
 */
export function planClientStateCleanup(ttl, now) {
  if (!ttl || typeof ttl !== 'object' || Array.isArray(ttl)) return [];
  const targets = [];
  for (const [namespace, days] of Object.entries(ttl)) {
    if (!namespace) continue;
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
      if (!warnedInvalidTtl.has(namespace)) {
        warnedInvalidTtl.add(namespace);
        console.warn(
          `[amsg-server] clientStateTtl['${namespace}'] 不是正数（收到 ${JSON.stringify(days)}），`
          + '这个命名空间不做清理'
        );
      }
      continue;
    }
    const updatedBefore = now - days * 24 * 60 * 60 * 1000;
    targets.push({ namespace, updatedBefore });
    targets.push({ namespace: chunkNamespaceFor(namespace), updatedBefore });
  }
  return targets;
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
 * 条件写护栏：条目可带可选的 `version`（毫秒时间戳或单调递增整数）。带了它，
 * 比较用的就是这个值而不是 `updatedAt`——同一个 key 有多个写入方时（例如
 * fire_pack 由常规 flush 和 instant-chat 两条路径写），谁的**内容**新谁赢，
 * 而不是谁的请求后到谁赢：慢网下晚到的旧包带着旧 `version`，盖不掉先到的新
 * 包。护栏值落在行的 updated_at 列上（client_state 的比较列本来就是它），
 * 没带 `version` 的写入照旧按 `updatedAt` 比。
 *
 * 条目本身的合法性（namespace / key 字符、value 大小）由调用方先校验好：
 * HTTP handler 逐条拒绝并把原因回给客户端，`writeState()` 直接抛错给 hook。
 *
 * @param {Object} args
 * @param {{ upsertClientState: Function }} args.db
 * @param {string} args.userId
 * @param {CryptoKey|string} args.userKey - 该用户的存储密钥（value 用它加密）
 * @param {Array<{ namespace: string, key: string, value: string|null, updatedAt: number, version?: number }>} args.entries
 *   `version`（可选）：条件写护栏值，见文件头。带了它，这条的 last-write-wins
 *   比较用它（写进行的 updated_at 列）；没带照旧用 `updatedAt`。
 * @returns {Promise<{ upserted: number, skipped: number, deleted: number, skippedEntries: Array<{ namespace: string, key: string }> }>}
 *   `upserted` / `skipped` 按逻辑条目计（切片行不计）；`deleted` 是请求删除的
 *   key 数，不代表这些 key 原本一定存在。`skippedEntries` 逐条列出被
 *   last-write-wins 拦下的 key（适配器不回 outcomes 时为空数组——分不清是哪条）。
 */
export async function writeClientStateEntries({ db, userId, userKey, entries }) {
  const physicalRows = [];
  const cleanups = [];
  const rootRowIndexes = [];
  const rootRowEntries = [];
  let deleted = 0;

  for (const entry of entries) {
    // 条件写护栏：带 version 的条目按 version 比新旧（见文件头）。
    const guardAt = Number.isInteger(entry.version) && entry.version > 0 ? entry.version : entry.updatedAt;
    // 不管写还是删，都先清掉这个 key 上一次写入留下的切片行（同一批里先删后写）。
    cleanups.push({
      namespace: chunkNamespaceFor(entry.namespace),
      keyPrefix: chunkKeyPrefixFor(entry.key),
      updatedAt: guardAt,
    });

    if (entry.value === null) {
      // 根行按精确 key 删——用前缀会连带删掉同前缀的兄弟 key（'note' 删掉 'notes'）。
      cleanups.push({
        namespace: entry.namespace,
        key: entry.key,
        updatedAt: guardAt,
      });
      deleted++;
      continue;
    }

    rootRowIndexes.push(physicalRows.length);
    rootRowEntries.push(entry);
    if (stateValueBytes(entry.value) <= STATE_CHUNK_SLICE_BYTES) {
      physicalRows.push({
        namespace: entry.namespace,
        key: entry.key,
        value: await encryptForStorage(entry.value, userKey),
        updatedAt: guardAt,
      });
    } else {
      const slices = splitStateValue(entry.value);
      physicalRows.push({
        namespace: entry.namespace,
        key: entry.key,
        value: buildChunkedRootValue(slices.length),
        updatedAt: guardAt,
      });
      const encryptedSlices = await Promise.all(slices.map((slice) => encryptForStorage(slice, userKey)));
      for (let c = 0; c < encryptedSlices.length; c++) {
        physicalRows.push({
          namespace: chunkNamespaceFor(entry.namespace),
          key: chunkKeyFor(entry.key, c),
          value: encryptedSlices[c],
          updatedAt: guardAt,
        });
      }
    }
  }

  if (physicalRows.length === 0 && cleanups.length === 0) {
    return { upserted: 0, skipped: 0, deleted: 0, skippedEntries: [] };
  }

  const result = await db.upsertClientState(userId, physicalRows, cleanups);
  let upserted = 0;
  let skipped = 0;
  const skippedEntries = [];
  if (Array.isArray(result.outcomes) && result.outcomes.length === physicalRows.length) {
    // 逻辑计数：一条条目的 upserted/skipped 看它的根行，切片行不计数。
    for (let i = 0; i < rootRowIndexes.length; i++) {
      if (result.outcomes[rootRowIndexes[i]]) {
        upserted++;
      } else {
        skipped++;
        // 被拦下的 key 逐条回报：写入方（尤其带 version 护栏的）要靠它知道
        // 「这个 key 库里已有更新的数据」，而不是只拿到一个总数去猜。
        const entry = rootRowEntries[i];
        skippedEntries.push({ namespace: entry.namespace, key: entry.key });
      }
    }
  } else {
    // 自定义 adapter 只回老形状 { upserted, skipped } 时按物理行计数兜底。
    upserted = result.upserted;
    skipped = result.skipped;
  }
  return { upserted, skipped, deleted, skippedEntries };
}
