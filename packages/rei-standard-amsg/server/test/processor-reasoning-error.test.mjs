/**
 * 思考过程没发出去时的可见性。
 *
 * 思考过程是正文之外的附赠内容，它发不出去不算这条消息失败——但也不能一声不吭：
 * 丢掉这个字段的话，一条被静默丢弃的 ReasoningPush 在 tick 汇总、调用方响应里
 * 全都看不见，而这个字段存在的意义就是提供这份可见性。
 *
 * 有收件箱的部署上思考过程只落行、不推送（见 lib/push-policy.js），推送这条路
 * 上的失败根本不会发生。所以这一组用例都站在没有收件箱的适配器上（withoutOutbox，
 * 与内置 pg / neon 现在的形态一致）——那时推送是这条内容唯一的腿。有收件箱时的
 * 行为在文件末尾单独钉。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { processMessagesByUuid } from '../src/server/lib/message-processor.js';
import { runScheduledTick } from '../src/server/lib/run-tick.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { deriveUserEncryptionKey, decryptFromStorage, encryptForStorage } from '../src/server/lib/encryption.js';
import { seedPushSubscription } from './helpers/push-subscription.mjs';
import { withoutOutbox } from './helpers/no-outbox.mjs';

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
        db: withoutOutbox(adapter),
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
        db: withoutOutbox(adapter),
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
        db: withoutOutbox(adapter),
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

/**
 * 回归守卫：思考过程默认不占推送通道。
 *
 * 它在 SW 那边本来就是静默送给页面的，推过去只会白违约一次 `userVisibleOnly`
 * 的约定——Firefox 对不弹通知的 push 有配额、超了退订，iOS 给新订阅几天宽限期、
 * 过后一条就吊销订阅，而且掉订阅是静默发生的，事后极难查。内容在收件箱里一个
 * 字不少，客户端上线 `GET /outbox?since=` 补拉即可。
 */
describe('思考过程默认只落收件箱、不推送', () => {
  /** 收件箱里这个用户的行（payload 已解密）。 */
  async function readOutbox(adapter) {
    const rows = await adapter.listUnackedOutbox(USER, 0, 50);
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    return Promise.all(rows.map(async (row) => ({
      row,
      push: JSON.parse(await decryptFromStorage(row.payload, userKey)),
    })));
  }

  it('默认只推正文；思考过程留在收件箱里等补拉', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    await seedTask(adapter, 'default-quiet-reasoning');

    const sent = [];
    const restore = stubLlm('回答。', '先想想再回答');
    let summary;
    try {
      summary = await runScheduledTick({
        db: adapter,
        masterKey: MASTER_KEY,
        vapid: VAPID,
        webpush: { async sendNotification(_sub, payload) { sent.push(JSON.parse(payload)); } },
      });
    } finally {
      restore();
    }

    assert.equal(summary.successCount, 1);
    assert.deepEqual(
      sent.map((push) => push.messageKind), ['content'],
      '思考过程不该占推送通道'
    );
    assert.equal(
      summary.details.reasoningSkippedTasks.length, 0,
      '按策略不推不是「没发成」，不该进汇总的失败清单'
    );

    const outbox = await readOutbox(adapter);
    assert.deepEqual(
      outbox.map((o) => o.push.messageKind).sort(), ['content', 'reasoning'],
      '两条都得在收件箱里，客户端才补得回来'
    );
    const reasoning = outbox.find((o) => o.push.messageKind === 'reasoning');
    assert.equal(
      reasoning.row.delivered_at, null,
      '没推出去就不能标 delivered——标了客户端补收就跳过它了'
    );
    assert.equal(reasoning.push.reasoningContent, '先想想再回答', '内容一个字不少');
  });

  it('收件箱落不下时照旧推送：那时推送是它唯一的腿', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    await seedTask(adapter, 'no-outbox-reasoning');

    const sent = [];
    const restore = stubLlm('回答。', '先想想再回答');
    try {
      // 适配器不支持 message_outbox（内置 pg / neon 与自定义适配器的现实情况）。
      await runScheduledTick({
        db: withoutOutbox(adapter),
        masterKey: MASTER_KEY,
        vapid: VAPID,
        webpush: { async sendNotification(_sub, payload) { sent.push(JSON.parse(payload)); } },
        _pushSleep: async () => {},
      });
    } finally {
      restore();
    }

    assert.deepEqual(
      sent.map((push) => push.messageKind), ['reasoning', 'content'],
      '没有收件箱兜底就不能省这一推，省了内容就真没了'
    );
  });
});
