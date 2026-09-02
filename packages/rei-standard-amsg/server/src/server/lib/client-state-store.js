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
 * （或删除）不生效，陈旧批次盖不掉新数据。唯一的例外是库里那行「来自未来」
 * （`updated_at` 晚于服务端当前时刻）——那种行只可能出自跑偏的设备时钟，不当
 * 比较基准，写入放行，详见 adapters/d1.js 的 `upsertClientState`。
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
 * @param {() => number} [args.now] - 取服务端当前时刻（测试可注入假时钟）。适配器
 *   拿它认出库里「来自未来」的脏行。
 * @returns {Promise<{ upserted: number, skipped: number, deleted: number, skippedEntries: Array<{ namespace: string, key: string }> }>}
 *   `upserted` / `skipped` / `deleted` 按逻辑条目计（切片行不计），三者之和等于
 *   条目数。`deleted` 是删除之后 key 已不在库里的条数——删掉了、或本来就没有，
 *   两种都算；被 last-write-wins 拦下的删除（库里那行更新）计入 `skipped`。
 *   `skippedEntries` 逐条列出被拦下的 key，写入与删除都在里面（适配器不回
 *   outcomes / cleanupOutcomes 时分不清是哪条：写入按物理行计数兜底，删除一律
 *   按「已删」计）。
 */
export async function writeClientStateEntries({ db, userId, userKey, entries, now }) {
  const nowFn = typeof now === 'function' ? now : Date.now;
  // 整批取一次，两处共用：下面钳护栏值的上限是它，传给适配器认「库里那行来自未来」
  // 的判据也是它。分两次取的话，同一批里会出现「按 t1 钳自己、却拿 t2 去判别人是不是
  // 来自未来」的错位，而且同批条目彼此的钳制基准也不一致。
  const at = nowFn();
  const physicalRows = [];
  const cleanups = [];
  const rootRowIndexes = [];
  const rootRowEntries = [];
  /** 删除条目：它的根行删除在 cleanups 里的下标，结局从适配器的 cleanupOutcomes 里取。 */
  const deletions = [];

  for (const entry of entries) {
    // 条件写护栏：带 version 的条目按 version 比新旧（见文件头）。
    //
    // 钳到服务端当前时刻：调用方报上来的值只在「不超过现在」的范围内可信。设备时钟
    // 领先时不钳的话，那台设备写下的行会一直压着别人——哪怕它的内容更旧，别人也盖不
    // 过去，而这个偏差是持续的，不像网络抖动会自己过去。钳完按到达顺序排，更接近真相。
    //
    // 这不动正常路径：钳制只在值大于「现在」时才生效，而正常的时间戳都落在过去，
    // `min` 取的就是原值——慢包后到仍然拿着自己构建时刻那个较小的值，照样被拦，
    // 「旧不盖新」一个字没变。version 那种单调递增版本号同理（要大到 1.7e12
    // 才碰得到这条线）。
    const rawGuardAt = Number.isInteger(entry.version) && entry.version > 0 ? entry.version : entry.updatedAt;
    const guardAt = Math.min(rawGuardAt, at);
    // 不管写还是删，都先清掉这个 key 上一次写入留下的切片行（同一批里先删后写）。
    cleanups.push({
      namespace: chunkNamespaceFor(entry.namespace),
      keyPrefix: chunkKeyPrefixFor(entry.key),
      updatedAt: guardAt,
    });

    if (entry.value === null) {
      // 根行按精确 key 删——用前缀会连带删掉同前缀的兄弟 key（'note' 删掉 'notes'）。
      deletions.push({ cleanupIndex: cleanups.length, entry });
      cleanups.push({
        namespace: entry.namespace,
        key: entry.key,
        updatedAt: guardAt,
      });
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

  // 服务端自己的钟一次取定，整批共用：条件写靠它判断库里那行是不是来自未来
  // （设备时钟跑偏留下的脏行），是就放行覆盖。
  const result = await db.upsertClientState(userId, physicalRows, cleanups, at);
  let upserted = 0;
  let skipped = 0;
  let deleted = 0;
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

  // 删除条目的结局与写入同一个规矩：库里那行比这次的护栏值新，删除就不生效，
  // 计入 skipped 并进 skippedEntries；删掉了、或本来就没有这个 key，都算 deleted。
  // 适配器不回 cleanupOutcomes（老形状）时分不出被拦下的那条，一律按已删计。
  const cleanupOutcomes = Array.isArray(result.cleanupOutcomes) && result.cleanupOutcomes.length === cleanups.length
    ? result.cleanupOutcomes
    : null;
  for (const { cleanupIndex, entry } of deletions) {
    if (cleanupOutcomes && cleanupOutcomes[cleanupIndex] === false) {
      skipped++;
      skippedEntries.push({ namespace: entry.namespace, key: entry.key });
    } else {
      deleted++;
    }
  }
  return { upserted, skipped, deleted, skippedEntries };
}
