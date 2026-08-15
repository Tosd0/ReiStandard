/**
 * `ctx.emitResult(payload)`：把一条不是聊天内容的结果送给客户端。
 *
 * 以前宿主只能自己拼——`db.appendOutboxMessages` 加 `encryptForStorage` 手工组
 * 一行，落什么列、怎么加密全靠照着库里的实现抄。收编成正式能力之后，这几条行
 * 为要钉住：
 *   - 落进收件箱 **且** 推一条 Web Push：推送负责及时，收件箱负责到达；
 *   - 推送发不出去不算失败——行还在，客户端下次补收拿得到；
 *   - 行上带 task_uuid，取消 / 顶替时还没送到的结果跟聊天分段一起撤；
 *   - 默认弹通知（标题正文可自定义，也可以让它别弹）；
 *   - 同一次触发重跑时 messageId 不变，收件箱不会补出第二条。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { processSingleMessage } from '../src/server/lib/message-processor.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { seedPushSubscription } from './helpers/push-subscription.mjs';
import { discardUndeliveredPushesForTask } from '../src/server/lib/outbox-store.js';
import {
  deriveUserEncryptionKey,
  decryptFromStorage,
  encryptForStorage,
} from '../src/server/lib/encryption.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);
const NEXT_SEND_AT = '2020-01-01T00:00:00.000Z';
const OCCURRENCE_MS = Date.parse(NEXT_SEND_AT);

async function makeTask(payloadOverrides = {}) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const payload = {
    contactName: 'Rei',
    messageType: 'auto',
    completePrompt: 'frozen prompt',
    apiUrl: 'https://api.example.com/v1/chat/completions',
    apiKey: 'sk-secret',
    primaryModel: 'model-x',
    recurrenceType: 'daily',
    metadata: { charId: 'char-1' },
    ...payloadOverrides,
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

/** 一个只在 onBeforeFire 里 emit 然后 skip 的 hook 组合（不碰 LLM）。 */
function emittingHooks(emit) {
  return {
    onBeforeFire: async (ctx) => {
      await emit(ctx);
      return { skip: true };
    },
    onLLMOutput: async () => ({ decision: 'skip-push' }),
  };
}

async function bootstrap({ webpush, seedSubscription = true } = {}) {
  const adapter = createD1Adapter(createTestD1());
  await adapter.initSchema();
  if (seedSubscription) await seedPushSubscription(adapter, USER, MASTER_KEY);
  const pushes = [];
  return {
    adapter,
    pushes,
    ctx: {
      db: adapter,
      masterKey: MASTER_KEY,
      vapid: { email: 'v@example.com', publicKey: 'pub', privateKey: 'priv' },
      webpush: webpush || {
        async sendNotification(_sub, payload) { pushes.push(JSON.parse(payload)); },
      },
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

describe('ctx.emitResult', () => {
  test('一条结果同时落进收件箱并推出去，身份字段由库补齐', async () => {
    const { adapter, ctx, pushes } = await bootstrap();
    const task = await makeTask();
    let returned;
    const hooks = emittingHooks(async (fireCtx) => {
      returned = await fireCtx.emitResult({
        resultKind: 'fire-pack',
        packId: 'pack_42',
        entries: [{ id: 1 }],
      });
    });

    const result = await processSingleMessage(task, { ...ctx, hooks });
    assert.equal(result.success, true);

    // 推送这一路
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].messageKind, 'result');
    assert.equal(pushes[0].resultKind, 'fire-pack');
    assert.equal(pushes[0].packId, 'pack_42');
    assert.deepEqual(pushes[0].entries, [{ id: 1 }]);
    // 任务身份由库覆盖写（描述的是任务行的事实，不是内容）
    assert.equal(pushes[0].taskId, 7);
    assert.equal(pushes[0].taskUuid, 'u7');
    assert.equal(pushes[0].recurrenceType, 'daily');
    assert.equal(pushes[0].occurrenceMs, OCCURRENCE_MS);
    // 默认弹一下：跑完了就该叫人回来看
    assert.equal(pushes[0].notification.show, 'always');

    // 收件箱这一路：同一份内容，且已经标了送达
    const outbox = await readOutbox(adapter);
    assert.equal(outbox.length, 1);
    assert.deepEqual(outbox[0].push, pushes[0]);
    assert.equal(outbox[0].row.task_uuid, 'u7');
    assert.ok(outbox[0].row.delivered_at, '推送成功了就该标 delivered');

    assert.equal(returned.messageId, `msg_task_7@${OCCURRENCE_MS}_result_0`);
    assert.equal(returned.pushed, true);
  });

  test('宿主自定义通知：标题正文照用，说了别弹就干脆不推', async () => {
    const { adapter, ctx, pushes } = await bootstrap();
    let quiet;
    const hooks = emittingHooks(async (fireCtx) => {
      await fireCtx.emitResult({
        resultKind: 'fire-pack',
        notification: { title: '生成完毕', body: '点开看看' },
      });
      quiet = await fireCtx.emitResult({
        resultKind: 'ledger-entry',
        notification: { show: false },
      });
    });

    await processSingleMessage(await makeTask(), { ...ctx, hooks });

    // 会弹的那条照推，文案原样。
    assert.equal(pushes.length, 1, '说了别弹的那条不占推送通道');
    assert.equal(pushes[0].resultKind, 'fire-pack');
    assert.equal(pushes[0].notification.title, '生成完毕');
    assert.equal(pushes[0].notification.body, '点开看看');
    assert.equal(pushes[0].notification.show, 'always', '宿主没表态才补默认值');

    // 不弹的那条只落收件箱：内容一个字不少，delivered_at 空着等客户端补收。
    const outbox = await readOutbox(adapter);
    assert.equal(outbox.length, 2, '两条都在收件箱里');
    const ledger = outbox.find(o => o.push.resultKind === 'ledger-entry');
    assert.equal(ledger.push.notification.show, false);
    assert.equal(ledger.row.delivered_at, null, '没推就不能标 delivered，不然客户端补收拿不到');
    assert.equal(quiet.pushed, false);
  });

  test('推送发不出去不算失败：行还在收件箱等补收', async () => {
    const { adapter, ctx } = await bootstrap({
      webpush: { async sendNotification() { throw new Error('推送服务 500'); } },
    });
    let returned;
    const hooks = emittingHooks(async (fireCtx) => {
      returned = await fireCtx.emitResult({ resultKind: 'fire-pack' });
    });

    const result = await processSingleMessage(await makeTask(), { ...ctx, hooks });
    assert.equal(result.success, true, 'fire 本身没挂');
    assert.equal(returned.pushed, false);

    const outbox = await readOutbox(adapter);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].row.delivered_at, null, '没送到才是最该补收的那种');
  });

  test('还没送到的结果，取消这条任务时跟着撤掉', async () => {
    const { adapter, ctx } = await bootstrap({
      webpush: { async sendNotification() { throw new Error('推送服务 500'); } },
    });
    const hooks = emittingHooks(async (fireCtx) => {
      await fireCtx.emitResult({ resultKind: 'fire-pack' });
    });
    await processSingleMessage(await makeTask(), { ...ctx, hooks });
    assert.equal((await readOutbox(adapter)).length, 1);

    // `DELETE /message` 与 supersedesUuid 走的就是这一支
    await discardUndeliveredPushesForTask({ db: adapter, userId: USER, taskUuid: 'u7' });

    assert.deepEqual(await readOutbox(adapter), [], '取消了就别再补收回去');
  });

  test('落行之后才发现任务被取消 → 自己把这一行撤掉，别等客户端补收回去', async () => {
    // 取消动作发生在这条结果落库之前，取消侧扫不到它——这一行只能由 emitResult
    // 自己撤，否则「取消接口回了成功，东西还是来了」。
    const { adapter, ctx } = await bootstrap({
      webpush: {
        async sendNotification() {
          const error = new Error('任务在投递期间被取消或顶替，推送已中止');
          error.code = 'TASK_CANCELLED';
          throw error;
        },
      },
    });
    let thrown = null;
    const hooks = emittingHooks(async (fireCtx) => {
      try {
        await fireCtx.emitResult({ resultKind: 'fire-pack' });
      } catch (error) {
        thrown = error;
      }
    });

    await processSingleMessage(await makeTask(), { ...ctx, hooks });

    assert.equal(thrown && thrown.code, 'TASK_CANCELLED', '取消这个信号照旧往上抛');
    assert.deepEqual(await readOutbox(adapter), [], '落进去的那一行也撤掉了');
  });

  test('同一次触发重跑：messageId 不变，收件箱不会补出第二条', async () => {
    const { adapter, ctx } = await bootstrap();
    const hooks = emittingHooks(async (fireCtx) => {
      await fireCtx.emitResult({ resultKind: 'fire-pack', attempt: 'first' });
    });
    const task = await makeTask();

    await processSingleMessage(task, { ...ctx, hooks });
    await processSingleMessage(task, { ...ctx, hooks });

    const outbox = await readOutbox(adapter);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].row.message_id, `msg_task_7@${OCCURRENCE_MS}_result_0`);
  });

  test('适配器没有收件箱 → 响亮报错，不静默只发推送', async () => {
    const { ctx } = await bootstrap();
    // 把收件箱的写入侧摘掉，其余照旧
    const noOutbox = new Proxy(ctx.db, {
      get(target, prop) {
        if (prop === 'appendOutboxMessages' || prop === 'markOutboxDelivered') return undefined;
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
      has(target, prop) {
        if (prop === 'appendOutboxMessages' || prop === 'markOutboxDelivered') return false;
        return prop in target;
      },
    });

    let thrown = null;
    const hooks = emittingHooks(async (fireCtx) => {
      try {
        await fireCtx.emitResult({ resultKind: 'fire-pack' });
      } catch (error) {
        thrown = error;
      }
    });

    await processSingleMessage(await makeTask(), { ...ctx, db: noOutbox, hooks });
    assert.ok(thrown, 'emitResult 该抛');
    assert.equal(thrown.code, 'OUTBOX_UNSUPPORTED');
  });

  test('payload 必须是对象，且要给这类结果起个名字', async () => {
    const { ctx } = await bootstrap();
    const errors = [];
    const hooks = emittingHooks(async (fireCtx) => {
      for (const bad of [null, 'text', ['a'], {}, { resultKind: '' }]) {
        await assert.rejects(() => fireCtx.emitResult(bad), (error) => {
          errors.push(error.message);
          return true;
        });
      }
    });

    await processSingleMessage(await makeTask(), { ...ctx, hooks });
    assert.equal(errors.length, 5);
    assert.ok(errors.slice(3).every((message) => /resultKind/.test(message)));
  });
});
