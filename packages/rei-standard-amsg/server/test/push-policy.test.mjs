/**
 * 不会弹通知的 payload 不占推送通道（见 lib/push-policy.js）。
 *
 * 订阅是按 `userVisibleOnly: true` 建的，每条 push 都欠用户一次可见反馈。
 * `reasoning` / `tool_request` / `error` 到了 SW 那边本来就是静默送给页面的，
 * 推过去只是白违约一次——Firefox 对这类 push 有配额、超了退订，iOS 给新订阅几
 * 天宽限期、过后一条就吊销订阅，而且掉订阅是静默发生的，服务端只看得到后续推
 * 送返回 410。这些内容整批都落在 message_outbox 里，客户端上线补拉一条不少。
 *
 * 这一组把下面几件事钉住：
 *   - 只推会弹的那些，其余只落收件箱且 delivered_at 留空（补收的前提）；
 *   - 没落进收件箱时照旧推送——那时推送是这条内容唯一的腿；
 *   - 宿主给某一条配了 `notification: { show: 'always' }` 就照推，逐条说了算。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { processSingleMessage } from '../src/server/lib/message-processor.js';
import { shouldSendPush } from '../src/server/lib/push-policy.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { seedPushSubscription } from './helpers/push-subscription.mjs';
import {
  deriveUserEncryptionKey,
  decryptFromStorage,
  encryptForStorage,
} from '../src/server/lib/encryption.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const NEXT_SEND_AT = '2020-01-01T00:00:00.000Z';

const TOOL_CALL = {
  id: 'call_1',
  type: 'function',
  function: { name: 'lookup_notes', arguments: '{"q":"recent"}' },
};

async function makeTask() {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const payload = {
    contactName: 'Rei',
    messageType: 'auto',
    completePrompt: 'frozen prompt',
    apiUrl: 'https://api.example.com/v1/chat/completions',
    apiKey: 'sk-secret',
    primaryModel: 'model-x',
    recurrenceType: 'daily',
  };
  return {
    id: 7,
    user_id: USER,
    uuid: 'u7',
    encrypted_payload: await encryptForStorage(JSON.stringify(payload), userKey),
    next_send_at: NEXT_SEND_AT,
    retry_count: 0,
  };
}

/** 一轮就收尾的 hook：正文一条、工具请求一条（工具请求那条 SW 侧不弹）。 */
function mixedKindHooks() {
  return {
    onBeforeFire: async () => [{ role: 'user', content: 'U' }],
    onLLMOutput: async () => ({
      decision: 'finish',
      pushPayloads: [
        { messageKind: 'content', message: '查完了' },
        { messageKind: 'tool_request', message: '', toolCalls: [TOOL_CALL] },
      ],
    }),
  };
}

function stubLlm() {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() { return { choices: [{ message: { role: 'assistant', content: '查完了' } }] }; },
  });
  return () => { globalThis.fetch = original; };
}

async function bootstrap() {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  await seedPushSubscription(adapter, USER, MASTER_KEY);
  const pushes = [];
  const afterSend = [];
  return {
    adapter,
    pushes,
    afterSend,
    ctx: {
      db: adapter,
      masterKey: MASTER_KEY,
      vapid: { email: 'v@example.com', publicKey: 'pub', privateKey: 'priv' },
      webpush: {
        async sendNotification(_sub, payload) { pushes.push(JSON.parse(payload)); },
      },
      onAfterSend: async (info) => { afterSend.push(info); },
      _agenticSleep: async () => {},
    },
  };
}

/** 收件箱里这个用户的行（payload 已解密）。 */
async function readOutbox(adapter) {
  const rows = await adapter.listUnackedOutbox(USER, 0, 50);
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return Promise.all(rows.map(async (row) => ({
    row,
    push: JSON.parse(await decryptFromStorage(row.payload, userKey)),
  })));
}

describe('不会弹通知的 payload 不推送', () => {
  test('正文照推，工具请求只落收件箱等补拉', async () => {
    const { adapter, ctx, pushes, afterSend } = await bootstrap();
    const restore = stubLlm();
    try {
      const result = await processSingleMessage(await makeTask(), { ...ctx, hooks: mixedKindHooks() });
      assert.equal(result.success, true);
    } finally {
      restore();
    }

    assert.deepEqual(
      pushes.map((push) => push.messageKind), ['content'],
      '工具请求在 SW 侧本来就不弹，推过去只是白违约一次'
    );

    const outbox = await readOutbox(adapter);
    assert.deepEqual(
      outbox.map((o) => o.push.messageKind), ['content', 'tool_request'],
      '两条都得在收件箱里，客户端才补得回来'
    );
    const toolRequest = outbox.find((o) => o.push.messageKind === 'tool_request');
    assert.equal(
      toolRequest.row.delivered_at, null,
      '没推出去就不能标 delivered——标了客户端补收会跳过它'
    );
    assert.deepEqual(toolRequest.push.toolCalls, [TOOL_CALL], '内容一个字不少');

    // 回执：这批两段都走完了（sentCount === total），其中一段占了推送通道。
    assert.equal(afterSend.length, 1);
    assert.equal(afterSend[0].total, 2);
    assert.equal(afterSend[0].sentCount, 2, '跳过推送不该让整批看起来像半途失败');
    assert.equal(afterSend[0].pushedCount, 1);
  });

  test('宿主给它配了要弹，就照推', async () => {
    const { adapter, ctx, pushes, afterSend } = await bootstrap();
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async () => ({
        decision: 'finish',
        pushPayloads: [{
          messageKind: 'tool_request',
          message: '',
          toolCalls: [TOOL_CALL],
          notification: { show: 'always', title: '需要继续处理', body: '点开应用继续' },
        }],
      }),
    };
    const restore = stubLlm();
    try {
      await processSingleMessage(await makeTask(), { ...ctx, hooks });
    } finally {
      restore();
    }

    assert.deepEqual(
      pushes.map((push) => push.messageKind), ['tool_request'],
      '这条会弹，值得占推送通道'
    );
    assert.equal(afterSend[0].pushedCount, 1);
    const outbox = await readOutbox(adapter);
    assert.ok(outbox[0].row.delivered_at, '推出去了就该标 delivered');
  });
});

describe('shouldSendPush 的判定', () => {
  const reasoning = { messageKind: 'reasoning', reasoningContent: '想想' };
  const content = { messageKind: 'content', message: '在' };

  test('落进收件箱了，不弹的就不推', () => {
    assert.equal(shouldSendPush(reasoning, { outboxed: true }), false);
    assert.equal(shouldSendPush(content, { outboxed: true }), true);
  });

  test('没落进收件箱就照推：那时推送是它唯一的腿', () => {
    assert.equal(shouldSendPush(reasoning, { outboxed: false }), true);
  });

  test('when-hidden 照推：前台不弹只有 SW 当场才知道', () => {
    const whenHidden = { messageKind: 'content', notification: { show: 'when-hidden' } };
    assert.equal(shouldSendPush(whenHidden, { outboxed: true }), true);
  });

  test('宿主给思考过程配了要弹，就照推', () => {
    const loud = { messageKind: 'reasoning', notification: { show: 'always' } };
    assert.equal(shouldSendPush(loud, { outboxed: true }), true);
  });
});
