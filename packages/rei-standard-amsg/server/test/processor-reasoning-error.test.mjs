/**
 * 思考过程没发出去时的可见性。
 *
 * 思考过程是正文之外的附赠内容，它发不出去不算这条消息失败——但也不能一声不吭：
 * 丢掉这个字段的话，一条被静默丢弃的 ReasoningPush 在 tick 汇总、调用方响应里
 * 全都看不见，而这个字段存在的意义就是提供这份可见性。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processMessagesByUuid } from '../src/server/lib/message-processor.js';
import { runScheduledTick } from '../src/server/lib/run-tick.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const VAPID = { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' };

const LLM_TASK_PAYLOAD = {
  contactName: 'Rei',
  messageType: 'prompted',
  recurrenceType: 'none',
  completePrompt: 'x',
  apiUrl: 'https://api.example.com/v1/chat/completions',
  apiKey: 's',
  primaryModel: 'm',
};

/** 让 LLM 那一跳回一句正文 + 一段思考过程。 */
function stubLlm(content, reasoningContent) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content, reasoning_content: reasoningContent } }] };
    },
  });
  return () => { globalThis.fetch = originalFetch; };
}

/** 只拒收思考过程那一条，正文照收。 */
function webpushRejectingReasoning(sent) {
  return {
    async sendNotification(_sub, payload) {
      const push = JSON.parse(payload);
      if (push.messageKind === 'reasoning' || push.messageKind === '_multipart') {
        throw new Error('push service rejected the reasoning push');
      }
      sent.push(push);
    },
  };
}

async function seedTask(adapter, uuid, payload = LLM_TASK_PAYLOAD) {
  await seedPushSubscription(adapter, USER, MASTER_KEY);
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  await adapter.createTask({
    user_id: USER,
    uuid,
    encrypted_payload: await encryptForStorage(JSON.stringify(payload), userKey),
    next_send_at: new Date(Date.now() - 30_000).toISOString(),
    message_type: payload.messageType,
  });
}

describe('思考过程没发出去时的可见性', () => {
  it('processMessagesByUuid 的返回值带上 reasoningError（正文仍算成功）', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    await seedTask(adapter, 'instant-reasoning', { ...LLM_TASK_PAYLOAD, messageType: 'instant' });

    const sent = [];
    const restore = stubLlm('回答。', '先想想再回答');
    let result;
    try {
      result = await processMessagesByUuid('instant-reasoning', {
        db: adapter,
        masterKey: MASTER_KEY,
        vapid: VAPID,
        webpush: webpushRejectingReasoning(sent),
      }, 2, USER, MASTER_KEY);
    } finally {
      restore();
    }

    assert.equal(result.success, true, '正文送到了，这条 instant 消息就是成功的');
    assert.equal(result.messagesSent, 1);
    assert.equal(sent.length, 1, '正文照发');
    assert.ok(
      result.reasoningError,
      `思考过程被丢掉了，返回值里得说出来：${JSON.stringify(result)}`
    );
  });

  it('tick 汇总里列出「正文送到了、思考过程没送到」的任务', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    await seedTask(adapter, 'scheduled-reasoning');

    const sent = [];
    const restore = stubLlm('回答。', '先想想再回答');
    let summary;
    try {
      summary = await runScheduledTick({
        db: adapter,
        masterKey: MASTER_KEY,
        vapid: VAPID,
        webpush: webpushRejectingReasoning(sent),
      });
    } finally {
      restore();
    }

    assert.equal(summary.successCount, 1, '正文送到了，任务照常记成功');
    assert.equal(summary.failedCount, 0, '附赠内容没发成不该被报成投递失败');
    assert.equal(
      summary.details.reasoningSkippedTasks.length, 1,
      `汇总里得看得见这条：${JSON.stringify(summary.details)}`
    );
    assert.ok(summary.details.reasoningSkippedTasks[0].taskId != null, '得说清是哪条任务');
    assert.ok(summary.details.reasoningSkippedTasks[0].reason, '得说清为什么没发成');
  });

  it('思考过程正常送达时，汇总里不会多出这一条', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    await seedTask(adapter, 'all-good');

    const sent = [];
    const restore = stubLlm('回答。', '先想想再回答');
    let summary;
    try {
      summary = await runScheduledTick({
        db: adapter,
        masterKey: MASTER_KEY,
        vapid: VAPID,
        webpush: { async sendNotification(_sub, payload) { sent.push(JSON.parse(payload)); } },
        // 思考过程发出去之后有一次 1.5 秒的停顿，测试里不用真等。
        _pushSleep: async () => {},
      });
    } finally {
      restore();
    }

    assert.equal(summary.successCount, 1);
    assert.equal(summary.details.reasoningSkippedTasks.length, 0);
    assert.deepEqual(sent.map((push) => push.messageKind), ['reasoning', 'content']);
  });
});
