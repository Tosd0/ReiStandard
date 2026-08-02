/**
 * 循环任务的下一次触发时刻。
 *
 * 任务行可以带一个 IANA 时区 id（`tzId`，例如 `America/New_York`）。带了的
 * 话 daily / weekly 按**那个时区的墙钟**推进：日期 +1 天 / +7 天，钟点原样
 * 保留。用户设的「每天早八点」在夏令时切换前后都还是早八点，而按固定
 * 86400000ms 推进的话，跨过切换点之后墙钟会永久差一小时。
 *
 * 没带 `tzId` 的任务按 UTC 推进（等价于固定 24h / 7×24h 加法）。
 *
 * 时区换算全部走 `Intl.DateTimeFormat`，不手搓偏移加减：偏移量本身随日期
 * 变化，任何写死的数字都会在某个日期上算错。
 *
 * 两个边界情况，按下面的规则收敛：
 *   - 春令时那天被跳过的墙钟（例如纽约 2:30 不存在）：落到切换之后的等价
 *     时刻（当地 3:30）。
 *   - 秋令时那天重复出现的墙钟（当地 1:30 出现两次）：取其中一个，不重复
 *     触发两次。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 快进时最多逐条列出多少个被跳过的名义时刻，超了只给首末两个。 */
export const MAX_LISTED_SKIPPED_OCCURRENCES = 32;

// 收敛用的硬上限：正常情况下修正循环最多跑一两轮（估算误差不会超过一个
// 周期）。真跑满了就退回纯毫秒加法，保证函数一定往前走、不会转不出来。
const MAX_ADJUST_STEPS = 32;

const formatterCache = new Map();

function formatterFor(tzId) {
  let formatter = formatterCache.get(tzId);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tzId,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tzId, formatter);
  }
  return formatter;
}

/**
 * 这个字符串能不能当 IANA 时区 id 用。建任务 / 改任务时校验，运行时不再猜。
 *
 * @param {unknown} tzId
 * @returns {boolean}
 */
export function isValidTimeZoneId(tzId) {
  if (typeof tzId !== 'string' || !tzId.trim()) return false;
  try {
    formatterFor(tzId);
    return true;
  } catch {
    return false;
  }
}

/** Date.UTC 把 0-99 年映射到 1900+，这里还原成字面年份。 */
function utcFromParts(year, month, day, hour, minute, second, ms) {
  const t = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  if (year >= 0 && year < 100) {
    const d = new Date(t);
    d.setUTCFullYear(year);
    return d.getTime();
  }
  return t;
}

/** 某个时刻在该时区的墙钟读数（年月日时分秒）。 */
function wallPartsOf(epochMs, tzId) {
  const parts = formatterFor(tzId).formatToParts(new Date(epochMs));
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return out;
}

/** 该时区在这一刻的偏移量（毫秒）：墙钟当成 UTC 读出来减去真实时刻。 */
function tzOffsetMsAt(epochMs, tzId) {
  const p = wallPartsOf(epochMs, tzId);
  const wallAsUtc = utcFromParts(p.year, p.month, p.day, p.hour, p.minute, p.second, 0);
  return wallAsUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * 墙钟读数 → 真实时刻。先按「把墙钟当成 UTC」猜一个偏移落一次，再用落点处的
 * 真实偏移修正一次；修正后的落点偏移与修正前一致，就说明这个墙钟真实存在、
 * 收敛到位了。
 *
 * 对不上的唯一情形是春令时被跳过的那一小时（例如纽约 2026-03-08 02:30 根本
 * 不存在）：此时取第一次的落点——它在切换之后，等价于「往后顺延一个空档」，
 * 时间只会往前走，不会倒退回昨天。
 */
function epochFromWallParts({ year, month, day, hour, minute, second, ms }, tzId) {
  const wallAsUtc = utcFromParts(year, month, day, hour, minute, second, ms);
  const firstGuess = wallAsUtc - tzOffsetMsAt(wallAsUtc, tzId);
  const refined = wallAsUtc - tzOffsetMsAt(firstGuess, tzId);
  if (tzOffsetMsAt(refined, tzId) !== tzOffsetMsAt(firstGuess, tzId)) return firstGuess;
  return refined;
}

function periodDaysOf(recurrenceType) {
  return recurrenceType === 'weekly' ? 7 : 1;
}

/**
 * 从名义触发时刻往后推 `periods` 个周期。
 *
 * @param {number} occurrenceMs - 名义触发时刻（epoch 毫秒）
 * @param {'daily'|'weekly'} recurrenceType
 * @param {number} periods - 推几个周期（≥ 1）
 * @param {string|null} [tzId] - IANA 时区 id；缺省按 UTC 推进
 * @returns {number} 推进之后的时刻（epoch 毫秒）
 */
export function advanceOccurrence(occurrenceMs, recurrenceType, periods, tzId) {
  const days = periodDaysOf(recurrenceType) * periods;
  if (!tzId) return occurrenceMs + days * DAY_MS;

  try {
    const p = wallPartsOf(occurrenceMs, tzId);
    const shiftedDate = new Date(utcFromParts(p.year, p.month, p.day, 0, 0, 0, 0) + days * DAY_MS);
    return epochFromWallParts(
      {
        year: shiftedDate.getUTCFullYear(),
        month: shiftedDate.getUTCMonth() + 1,
        day: shiftedDate.getUTCDate(),
        hour: p.hour,
        minute: p.minute,
        second: p.second,
        ms: occurrenceMs - Math.floor(occurrenceMs / 1000) * 1000,
      },
      tzId
    );
  } catch (error) {
    // 运行时才发现这个 tzId 认不出来（运行时 ICU 数据缺这个区之类）。任务
    // 照常推进比整条挂掉有用得多，退回 UTC 加法并留一行日志。
    console.warn(`[amsg-server] 时区 ${tzId} 换算失败，本次按 UTC 推进：`, error && error.message);
    return occurrenceMs + days * DAY_MS;
  }
}

/**
 * 从名义触发时刻往后推，找到第一个在 `nowMs` 之后的 occurrence，并顺带
 * 报出中间跳过了哪些。
 *
 * 推进基准永远是名义时刻本身（不是「现在」），所以停摆多久都不会漂到别的
 * 钟点上。
 *
 * @param {number} occurrenceMs
 * @param {'daily'|'weekly'} recurrenceType
 * @param {number} nowMs
 * @param {string|null} [tzId]
 * @returns {{ nextMs: number, skippedCount: number, skippedOccurrences: number[], skippedTruncated: boolean }}
 *   `skippedCount` 含传进来的这一次（它自己就是没发出去的那一次）。
 *   `skippedOccurrences` 最多列 {@link MAX_LISTED_SKIPPED_OCCURRENCES} 个，
 *   超了只给首末两个并把 `skippedTruncated` 置 true。
 */
export function planNextOccurrence(occurrenceMs, recurrenceType, nowMs, tzId) {
  const periodMs = periodDaysOf(recurrenceType) * DAY_MS;

  // 先按固定周期估一个跨度，再修正——停摆几个月的 daily 任务不必一天一天
  // 地走 Intl 换算。DST 最多让估算差一个周期，修正循环跑一两轮就到位。
  let periods = nowMs > occurrenceMs ? Math.max(1, Math.floor((nowMs - occurrenceMs) / periodMs)) : 1;
  let cursor = advanceOccurrence(occurrenceMs, recurrenceType, periods, tzId);

  for (let step = 0; step < MAX_ADJUST_STEPS && periods > 1; step++) {
    const previous = advanceOccurrence(occurrenceMs, recurrenceType, periods - 1, tzId);
    if (previous <= nowMs) break;
    periods -= 1;
    cursor = previous;
  }
  for (let step = 0; step < MAX_ADJUST_STEPS && cursor <= nowMs; step++) {
    periods += 1;
    cursor = advanceOccurrence(occurrenceMs, recurrenceType, periods, tzId);
  }
  if (cursor <= nowMs) {
    // 兜底：无论如何都要给出一个未来时刻。
    periods = Math.ceil((nowMs - occurrenceMs + 1) / periodMs);
    cursor = occurrenceMs + periods * periodMs;
  }

  const skippedCount = periods;
  let skippedOccurrences;
  let skippedTruncated = false;
  if (skippedCount <= MAX_LISTED_SKIPPED_OCCURRENCES) {
    skippedOccurrences = [occurrenceMs];
    for (let i = 1; i < skippedCount; i++) {
      skippedOccurrences.push(advanceOccurrence(occurrenceMs, recurrenceType, i, tzId));
    }
  } else {
    skippedOccurrences = [occurrenceMs, advanceOccurrence(occurrenceMs, recurrenceType, skippedCount - 1, tzId)];
    skippedTruncated = true;
  }

  return { nextMs: cursor, skippedCount, skippedOccurrences, skippedTruncated };
}

/**
 * 下一次触发时刻的 ISO 字符串（写库用）。
 *
 * @param {number} occurrenceMs
 * @param {'daily'|'weekly'} recurrenceType
 * @param {number} nowMs
 * @param {string|null} [tzId]
 * @returns {string}
 */
export function nextFutureOccurrence(occurrenceMs, recurrenceType, nowMs, tzId) {
  return new Date(planNextOccurrence(occurrenceMs, recurrenceType, nowMs, tzId).nextMs).toISOString();
}
