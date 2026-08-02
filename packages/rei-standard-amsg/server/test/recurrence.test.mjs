import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  advanceOccurrence,
  planNextOccurrence,
  nextFutureOccurrence,
  isValidTimeZoneId,
  MAX_LISTED_SKIPPED_OCCURRENCES,
} from '../src/server/lib/recurrence.js';

const DAY = 24 * 60 * 60 * 1000;

/** 某个时刻在某个时区的墙钟读数，形如 '2026-03-09 08:00:00'。 */
function wallClock(epochMs, tzId) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tzId,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const v = {};
  for (const p of parts) if (p.type !== 'literal') v[p.type] = p.value;
  return `${v.year}-${v.month}-${v.day} ${v.hour}:${v.minute}:${v.second}`;
}

describe('isValidTimeZoneId', () => {
  test('认得 IANA id，认不得乱写的', () => {
    assert.equal(isValidTimeZoneId('America/New_York'), true);
    assert.equal(isValidTimeZoneId('Asia/Tokyo'), true);
    assert.equal(isValidTimeZoneId('UTC'), true);
    assert.equal(isValidTimeZoneId('Nowhere/Fake'), false);
    assert.equal(isValidTimeZoneId(''), false);
    assert.equal(isValidTimeZoneId(null), false);
    assert.equal(isValidTimeZoneId(42), false);
  });
});

describe('循环推进按墙钟走', () => {
  // 这是这批改动的核心回归守卫：固定 +86400000ms 的推进跨过夏令时切换点之后，
  // 用户设的「每天早八点」会永久变成早九点，而且再也回不去。
  test('daily 跨春令时切换点：纽约的墙钟时刻不变（固定 +24h 会漂一小时）', () => {
    // 2026-03-08 是美国的春令时切换日（当地 2:00 → 3:00）。
    // 3 月 7 日 08:00 EST（UTC-5）= 13:00Z。
    const before = Date.parse('2026-03-07T13:00:00.000Z');
    assert.equal(wallClock(before, 'America/New_York'), '2026-03-07 08:00:00');

    const after = advanceOccurrence(before, 'daily', 1, 'America/New_York');
    assert.equal(wallClock(after, 'America/New_York'), '2026-03-08 08:00:00');
    // 切换之后 UTC 偏移变成 -4，所以真实间隔是 23 小时，不是 24。
    assert.equal(after - before, 23 * 60 * 60 * 1000);
    // 固定加法会落在 09:00，这一行就是「旧实现下会挂」的那个断言。
    assert.equal(wallClock(before + DAY, 'America/New_York'), '2026-03-08 09:00:00');
  });

  test('daily 跨秋令时切换点：墙钟同样不变，真实间隔 25 小时', () => {
    // 2026-11-01 是美国的秋令时切换日（当地 2:00 → 1:00）。
    // 10 月 31 日 08:00 EDT（UTC-4）= 12:00Z。
    const before = Date.parse('2026-10-31T12:00:00.000Z');
    assert.equal(wallClock(before, 'America/New_York'), '2026-10-31 08:00:00');

    const after = advanceOccurrence(before, 'daily', 1, 'America/New_York');
    assert.equal(wallClock(after, 'America/New_York'), '2026-11-01 08:00:00');
    assert.equal(after - before, 25 * 60 * 60 * 1000);
  });

  test('weekly 跨切换点：+7 天同一墙钟', () => {
    const before = Date.parse('2026-03-04T13:00:00.000Z'); // 2026-03-04 08:00 EST
    const after = advanceOccurrence(before, 'weekly', 1, 'America/New_York');
    assert.equal(wallClock(after, 'America/New_York'), '2026-03-11 08:00:00');
  });

  test('伦敦的夏令时同样认（Europe/London）', () => {
    // 2026-03-29 01:00 UTC 起英国进入 BST。3 月 28 日 08:00 = 08:00Z。
    const before = Date.parse('2026-03-28T08:00:00.000Z');
    assert.equal(wallClock(before, 'Europe/London'), '2026-03-28 08:00:00');
    const after = advanceOccurrence(before, 'daily', 1, 'Europe/London');
    assert.equal(wallClock(after, 'Europe/London'), '2026-03-29 08:00:00');
    assert.equal(after - before, 23 * 60 * 60 * 1000);
  });

  test('没有夏令时的时区（Asia/Tokyo）与不带 tzId 的结果一致', () => {
    const base = Date.parse('2026-03-07T13:00:00.000Z');
    assert.equal(advanceOccurrence(base, 'daily', 1, 'Asia/Tokyo'), base + DAY);
    assert.equal(advanceOccurrence(base, 'daily', 1, null), base + DAY);
    assert.equal(advanceOccurrence(base, 'weekly', 1, null), base + 7 * DAY);
  });

  test('不带 tzId 就是固定周期加法（老行为逐字保留）', () => {
    const base = Date.parse('2026-03-07T13:00:00.000Z');
    assert.equal(nextFutureOccurrence(base, 'daily', base + 10, null), new Date(base + DAY).toISOString());
    assert.equal(
      nextFutureOccurrence(base, 'daily', base + 3 * DAY + 5 * 60_000, null),
      new Date(base + 4 * DAY).toISOString()
    );
  });

  test('春令时那天不存在的墙钟（纽约 02:30）落到切换之后，不会倒退', () => {
    const before = Date.parse('2026-03-07T07:30:00.000Z'); // 2026-03-07 02:30 EST
    assert.equal(wallClock(before, 'America/New_York'), '2026-03-07 02:30:00');
    const after = advanceOccurrence(before, 'daily', 1, 'America/New_York');
    assert.ok(after > before, '推进之后必须是更晚的时刻');
    assert.equal(wallClock(after, 'America/New_York'), '2026-03-08 03:30:00');
  });
});

describe('planNextOccurrence', () => {
  test('停摆几天：快进到未来第一个名义时刻，并报出跳过了哪几次', () => {
    const base = Date.parse('2026-06-01T09:00:00.000Z');
    const now = base + 3 * DAY + 5 * 60_000;
    const plan = planNextOccurrence(base, 'daily', now, null);

    assert.equal(plan.nextMs, base + 4 * DAY);
    assert.equal(plan.skippedCount, 4); // 名义那次 + 之后三次
    assert.deepEqual(plan.skippedOccurrences, [base, base + DAY, base + 2 * DAY, base + 3 * DAY]);
    assert.equal(plan.skippedTruncated, false);
  });

  test('刚过一点点：只跳过名义那一次', () => {
    const base = Date.parse('2026-06-01T09:00:00.000Z');
    const plan = planNextOccurrence(base, 'daily', base + 61 * 60_000, null);
    assert.equal(plan.nextMs, base + DAY);
    assert.equal(plan.skippedCount, 1);
    assert.deepEqual(plan.skippedOccurrences, [base]);
  });

  test('停摆很久：列表截断成首末两个，计数仍然准', () => {
    const base = Date.parse('2026-01-01T09:00:00.000Z');
    const missed = MAX_LISTED_SKIPPED_OCCURRENCES + 20;
    const now = base + missed * DAY - 60_000; // 第 missed 次还没到
    const plan = planNextOccurrence(base, 'daily', now, null);

    assert.equal(plan.skippedCount, missed);
    assert.equal(plan.skippedTruncated, true);
    assert.equal(plan.skippedOccurrences.length, 2);
    assert.equal(plan.skippedOccurrences[0], base);
    assert.equal(plan.skippedOccurrences[1], base + (missed - 1) * DAY);
    assert.equal(plan.nextMs, base + missed * DAY);
  });

  test('带 tzId 停摆跨切换点：快进落点的墙钟仍是原来的钟点', () => {
    const base = Date.parse('2026-03-01T13:00:00.000Z'); // 2026-03-01 08:00 EST
    const now = Date.parse('2026-04-01T00:00:00.000Z');
    const plan = planNextOccurrence(base, 'daily', now, 'America/New_York');

    assert.ok(plan.nextMs > now);
    assert.equal(wallClock(plan.nextMs, 'America/New_York').slice(11), '08:00:00');
    // 中间那 31 天一次不落地被计数（跨了夏令时也不会多算少算一天）。
    assert.equal(plan.skippedCount, 31);
  });

  test('周任务停摆一个月：按周推进，落点仍在未来', () => {
    const base = Date.parse('2026-06-01T09:00:00.000Z');
    const now = base + 30 * DAY;
    const plan = planNextOccurrence(base, 'weekly', now, null);
    assert.equal(plan.nextMs, base + 35 * DAY);
    assert.equal(plan.skippedCount, 5);
  });

  test('认不出来的 tzId 不会把推进卡住：退回 UTC 加法', () => {
    const base = Date.parse('2026-06-01T09:00:00.000Z');
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      assert.equal(advanceOccurrence(base, 'daily', 1, 'Nowhere/Fake'), base + DAY);
    } finally {
      console.warn = origWarn;
    }
  });
});
