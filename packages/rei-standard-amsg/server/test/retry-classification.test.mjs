/**
 * 「重试也好不了」的判定：定时任务的退避阶梯和 instant 任务的三轮重试用同一
 * 份口径（lib/errors.js 的 isPermanentDeliveryFailure），fire-time hook 的契约
 * 违约算确定性失败。
 *
 * 投递是先跑 LLM 再推送——每多试一轮都要把整轮生成和 hook 里的计费调用重跑
 * 一遍，所以判错方向的代价是真金白银。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processSingleMessage, processMessagesByUuid } from '../src/server/lib/message-processor.js';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { encryptTestSubscription, withPushSubscriptionStore } from './helpers/push-subscription.mjs';

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_MASTER_KEY = 'a'.repeat(64);
const ENCRYPTED_PUSH_SUB = await encryptTestSubscription(TEST_USER_ID, TEST_MASTER_KEY);

const INSTANT_PAYLOAD = {
  contactName: 'Rei',
  messageType: 'instant',
  userMessage: '你好。'
};

async function encryptTask(payload) {
  const userKey = await deriveUserEncryptionKey(TEST_USER_ID, TEST_MASTER_KEY);
  return {
    id: 1,
    uuid: 'task-uuid',
    user_id: TEST_USER_ID,
    next_send_at: null,
    encrypted_payload: await encryptForStorage(JSON.stringify(payload), userKey)
  };
}

/** 记着 getTaskByUuid 被叫了几次——重试轮数就藏在这个数里。 */
function createUuidDb(task, pushSubscription) {
  const lookups = { count: 0 };
  const writes = [];
  const base = {
    async getTaskByUuid() {
      lookups.count++;
      return task;
    },
    async getTaskByUuidOnly() {
      lookups.count++;
      return task;
    },
    async updateTaskById(_id, fields) { writes.push(fields); return task; },
    async deleteTaskById() { return true; }
  };
  return { db: withPushSubscriptionStore(base, pushSubscription), lookups, writes };
}

function createCtx(db, sendNotification = async () => {}) {
  return {
    masterKey: TEST_MASTER_KEY,
    webpush: { async sendNotification(...args) { await sendNotification(...args); } },
    vapid: { email: 'vapid@example.com', publicKey: 'public', privateKey: 'private' },
    db
  };
}

describe('instant 任务的重试判定', () => {
  it('用户没登记推送订阅：一次判死，不再重试', async () => {
    const task = await encryptTask(INSTANT_PAYLOAD);
    // 订阅存储里没有这个用户的行 → PUSH_SUBSCRIPTION_MISSING。
    const { db, lookups } = createUuidDb(task, null);

    const result = await processMessagesByUuid('task-uuid', createCtx(db), 2, TEST_USER_ID, TEST_MASTER_KEY);

    assert.equal(result.success, false);
    assert.equal(result.error.permanent, true);
    assert.equal(result.error.retriesAttempted, 0, '重试也好不了的错误不该排退避阶梯');
    assert.equal(lookups.count, 1, '只该跑一轮');
  });

  it('推送服务回 410 说订阅没了：一次判死，不再重试', async () => {
    const task = await encryptTask(INSTANT_PAYLOAD);
    const { db, lookups } = createUuidDb(task, ENCRYPTED_PUSH_SUB);

    const result = await processMessagesByUuid(
      'task-uuid',
      createCtx(db, async () => {
        const error = new Error('subscription gone');
        error.statusCode = 410;
        throw error;
      }),
      2,
      TEST_USER_ID,
      TEST_MASTER_KEY
    );

    assert.equal(result.success, false);
    assert.equal(result.error.permanent, true);
    assert.equal(lookups.count, 1);
  });

  // 记录口径跟定时任务那条路对齐：reason 是给用户看的人话（措辞随时会变），
  // errorCode / pushStatus 是给下游判定用的。缺了它们，客户端判断「要不要引导
  // 用户重建订阅」就只能回去正则匹配 reason，正是这套字段要消灭的用法。
  it('终审失败写的 last_error 带上 errorCode / pushStatus', async () => {
    const task = await encryptTask(INSTANT_PAYLOAD);
    const { db, writes } = createUuidDb(task, ENCRYPTED_PUSH_SUB);

    await processMessagesByUuid(
      'task-uuid',
      createCtx(db, async () => {
        const error = new Error('subscription gone');
        error.statusCode = 410;
        throw error;
      }),
      2,
      TEST_USER_ID,
      TEST_MASTER_KEY
    );

    const failed = writes.find((fields) => fields.status === 'failed');
    assert.ok(failed, '终审失败要把行标 failed');
    const lastError = JSON.parse(failed.last_error);
    assert.equal(lastError.pushStatus, 410, '410 = 订阅已注销，客户端按它判断要不要引导重建');
    assert.ok(lastError.reason, '给用户看的那句话照旧留着');
  });

  it('普通的推送失败照常重试满', async () => {
    const task = await encryptTask(INSTANT_PAYLOAD);
    const { db, lookups } = createUuidDb(task, ENCRYPTED_PUSH_SUB);

    const result = await processMessagesByUuid(
      'task-uuid',
      createCtx(db, async () => {
        // 没有 statusCode、没有 code：说不清是什么毛病，那就该再试试。
        throw new Error('network hiccup');
      }),
      2,
      TEST_USER_ID,
      TEST_MASTER_KEY
    );

    assert.equal(result.success, false);
    assert.equal(result.error.permanent, undefined);
    assert.equal(result.error.retriesAttempted, 2);
    assert.equal(lookups.count, 3);
  });
});

describe('fire-time hook 的契约违约', () => {
  const HOOK_TASK_PAYLOAD = {
    contactName: 'Rei',
    messageType: 'prompted',
    completePrompt: 'x',
    apiUrl: 'https://api.example.com/v1/chat/completions',
    apiKey: 's',
    primaryModel: 'm'
  };

  function stubLlm(response) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, async json() { return response; } });
    return () => { globalThis.fetch = originalFetch; };
  }

  const FINISH_ROUND = { choices: [{ message: { role: 'assistant', content: '回复' } }] };

  async function fireWith(hooks, extraCtx = {}) {
    const task = await encryptTask(HOOK_TASK_PAYLOAD);
    const ctx = {
      ...createCtx(withPushSubscriptionStore({}, ENCRYPTED_PUSH_SUB)),
      hooks,
      _agenticSleep: async () => {},
      ...extraCtx
    };
    const restore = stubLlm(FINISH_ROUND);
    try {
      return await processSingleMessage(task, ctx);
    } finally {
      restore();
    }
  }

  it('配了 onBeforeFire 却没配 onLLMOutput → 走重试阶梯，不判终态', async () => {
    const result = await fireWith({ onBeforeFire: async () => [{ role: 'user', content: 'U' }] });

    assert.equal(result.success, false);
    assert.notEqual(
      result.permanent,
      true,
      '坏的是整个部署不是这条任务：判终态会把这段时间里每条一次性任务都永久标 failed，配置改好也捞不回来'
    );
    assert.equal(result.errorCode, 'AGENTIC_CONFIG_ERROR', 'code 照旧带出来，宿主要分流读得到');
  });

  it('onBeforeFire 返回库不认的形状 → 确定性失败', async () => {
    const result = await fireWith({
      onBeforeFire: async () => 42,
      onLLMOutput: async () => ({ decision: 'skip-push' })
    });

    assert.equal(result.success, false);
    assert.equal(result.permanent, true);
    assert.equal(result.errorCode, 'AGENTIC_BAD_BEFORE_FIRE');
  });

  it('onLLMOutput 返回库不认的决策 → 确定性失败', async () => {
    const result = await fireWith({
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => ({ decision: 'nonsense' })
    });

    assert.equal(result.success, false);
    assert.equal(result.permanent, true);
    assert.equal(result.errorCode, 'AGENTIC_BAD_DECISION');
  });

  it('轮数用尽也没等到 finish → 确定性失败（每重试一轮就是一整个循环）', async () => {
    const result = await fireWith(
      {
        onBeforeFire: async () => [{ role: 'user', content: 'U' }],
        onLLMOutput: async () => ({ decision: 'continue', nextHistory: [{ role: 'user', content: 'again' }] })
      },
      { maxToolIterations: 2 }
    );

    assert.equal(result.success, false);
    assert.equal(result.permanent, true);
    assert.equal(result.errorCode, 'AGENTIC_LOOP_EXCEEDED');
  });

  it('整体超时仍是可重试的：慢一次不等于永远慢', async () => {
    let now = 0;
    const result = await fireWith(
      {
        onBeforeFire: async () => [{ role: 'user', content: 'U' }],
        onLLMOutput: async () => {
          now += 10_000;
          return { decision: 'continue', nextHistory: [{ role: 'user', content: 'again' }] };
        }
      },
      { totalTimeoutMs: 5_000, maxToolIterations: 4, _agenticNow: () => now }
    );

    assert.equal(result.success, false);
    assert.match(result.error, /AGENTIC_TOTAL_TIMEOUT/);
    assert.notEqual(result.permanent, true, '超时该留在退避阶梯里');
  });
});
