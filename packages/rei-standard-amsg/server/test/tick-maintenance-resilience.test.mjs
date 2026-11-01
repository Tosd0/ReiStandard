/**
 * cron 一跳的收尾清理与 D1 限额报错的机读代码。
 *
 * 要钉住两件事：投递或某项清理出错时，其余清理照跑；D1 的存储与每日额度报错
 * 带固定代码，宿主不用匹配英文原文就能提示用户。
 * 存储满的文案来自线上 D1 实测，每日额度的文案来自 Cloudflare 文档。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runScheduledTick } from '../src/server/lib/run-tick.js';
import { summarizeErrorCause } from '../src/server/lib/errors.js';

function fakeDb(overrides = {}) {
  const calls = [];
  const step = (name) => async () => { calls.push(name); return 0; };
  return {
    calls,
    getPendingTasks: async () => [],
    cleanupOldTasks: step('cleanupOldTasks'),
    cleanupOutbox: step('cleanupOutbox'),
    cleanupClientState: step('cleanupClientState'),
    ...overrides
  };
}

const ALL_CLEANUPS = ['cleanupOldTasks', 'cleanupOutbox', 'cleanupClientState'];

describe('runScheduledTick 的收尾清理', () => {
  test('正常一跳把三项清理都跑完', async () => {
    const db = fakeDb();
    const summary = await runScheduledTick({ db });
    assert.equal(summary.totalTasks, 0);
    assert.deepEqual(db.calls, ALL_CLEANUPS);
  });

  test('捞任务失败：清理照跑，原错误继续抛给上层', async () => {
    const failure = new Error('D1_ERROR: Network connection lost.');
    const db = fakeDb({ getPendingTasks: async () => { throw failure; } });
    await assert.rejects(runScheduledTick({ db }), (error) => error === failure);
    assert.deepEqual(db.calls, ALL_CLEANUPS);
  });

  test('清旧任务失败：其余清理照跑，这一跳的投递结果不丢', async () => {
    const db = fakeDb({
      cleanupOldTasks: async () => { throw new Error('D1_ERROR: Network connection lost.'); }
    });
    const summary = await runScheduledTick({ db });
    assert.equal(summary.totalTasks, 0);
    assert.deepEqual(db.calls, ['cleanupOutbox', 'cleanupClientState']);
  });
});

describe('summarizeErrorCause 的 D1 限额代码', () => {
  const cases = [
    ['D1_ERROR: Exceeded maximum DB size', 'D1_STORAGE_FULL'],
    [
      "Your account has exceeded D1's free tier daily row read limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.",
      'D1_DAILY_READ_LIMIT'
    ],
    [
      "Your account has exceeded D1's free tier daily row write limit. Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.",
      'D1_DAILY_WRITE_LIMIT'
    ]
  ];

  for (const [message, code] of cases) {
    test(`${code} 带上代码，原文照留`, () => {
      const cause = summarizeErrorCause(new Error(message), 'request');
      assert.equal(cause.code, code);
      assert.equal(cause.message, message);
    });
  }

  test('错误自带 code 时不覆盖', () => {
    const error = Object.assign(new Error('D1_ERROR: Exceeded maximum DB size'), { code: 'CUSTOM' });
    assert.equal(summarizeErrorCause(error, 'tick').code, 'CUSTOM');
  });

  test('认不出来的错误不带 code', () => {
    const cause = summarizeErrorCause(new Error('D1_ERROR: no such table: message_outbox'), 'tick');
    assert.equal('code' in cause, false);
  });
});
