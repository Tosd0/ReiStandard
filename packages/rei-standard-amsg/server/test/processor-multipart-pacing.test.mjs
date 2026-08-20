/**
 * 思考过程分片的发送节奏，以及宿主收窄的分片限额能不能传到发送端。
 *
 * 接收端的重组窗口从「它收到第一片」起算，窗口一到就写死墓碑：之后到的分片被
 * 静默丢掉，推送服务重投也救不回来。所以整批分片的发送跨度必须落在窗口里——固
 * 定 1.5 秒一片的节奏几十片就把 60 秒的窗口用光了，而发送端这边每一片都发成
 * 功，任务照样记成成功，用户那边整条思考过程凭空消失。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MULTIPART_TTL_MS } from '@rei-standard/amsg-shared';
import { processSingleMessage } from '../src/server/lib/message-processor.js';
import { MAX_PUSH_PAYLOAD_BYTES, measurePushPayload } from '../src/server/lib/webpush-webcrypto.js';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { createSingleUserServer } from '../src/server/single-user.js';
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { encryptTestSubscription, seedPushSubscription, withPushSubscriptionStore } from './helpers/push-subscription.mjs';
import { withoutOutbox } from './helpers/no-outbox.mjs';

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_MASTER_KEY = 'a'.repeat(64);
const ENCRYPTED_PUSH_SUB = await encryptTestSubscription(TEST_USER_ID, TEST_MASTER_KEY);

const LLM_TASK_PAYLOAD = {
  contactName: 'Rei',
  messageType: 'prompted',
  recurrenceType: 'none',
  completePrompt: 'x',
  apiUrl: 'https://api.example.com/v1/chat/completions',
  apiKey: 's',
  primaryModel: 'm',
};

async function createEncryptedTask(payload) {
  const userKey = await deriveUserEncryptionKey(TEST_USER_ID, TEST_MASTER_KEY);
  return {
    id: 1,
    user_id: TEST_USER_ID,
    encrypted_payload: await encryptForStorage(JSON.stringify(payload), userKey),
  };
}

/** 让 LLM 那一跳回一段带 reasoning_content 的响应。 */
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

/**
 * 虚拟时钟：发送节奏的等待走它，测试就不用真等几十秒。记的是「发送端打算隔多久
 * 发下一条」，也正是接收端那个窗口要装下的跨度。
 */
function createVirtualClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => { now += ms; },
  };
}

/**
 * 发一条带超长思考过程的消息，记下每条 push 发出去的（虚拟）时刻。
 *
 * @param {{ reasoningChars: number, multipart?: Object }} options
 */
async function deliverWithClock({ reasoningChars, multipart }) {
  const task = await createEncryptedTask(LLM_TASK_PAYLOAD);
  const restore = stubLlm('回答。', 'x'.repeat(reasoningChars));
  const clock = createVirtualClock();
  /** @type {Array<{ at: number, push: Object }>} */
  const sent = [];

  const ctx = {
    masterKey: TEST_MASTER_KEY,
    webpush: {
      async sendNotification(_sub, payload) {
        sent.push({ at: clock.now(), push: JSON.parse(payload) });
      },
    },
    vapid: { email: 'vapid@example.com', publicKey: 'public', privateKey: 'private' },
    db: withPushSubscriptionStore({}, ENCRYPTED_PUSH_SUB),
    _pushSleep: clock.sleep,
    ...(multipart ? { multipart } : {}),
  };

  try {
    const result = await processSingleMessage(task, ctx);
    const chunks = sent.filter((entry) => entry.push.messageKind === '_multipart');
    return { result, sent, chunks };
  } finally {
    restore();
  }
}

describe('思考过程分片的发送节奏', () => {
  it('几十片也要在接收端的重组窗口内发完', async () => {
    // 每片装 1800 字节原文，10 万字节的思考过程要切 ~60 片。固定 1.5 秒一片的
    // 话整批要发 88 秒，而接收端的窗口默认只有 60 秒——迟到的分片撞上墓碑，整条
    // 思考过程再也拼不回来。
    const { result, chunks } = await deliverWithClock({ reasoningChars: 108_000 });

    assert.equal(result.success, true);
    assert.ok(chunks.length >= 40, `这段思考过程该被切成几十片，实际 ${chunks.length} 片`);

    const span = chunks[chunks.length - 1].at - chunks[0].at;
    assert.ok(
      span < DEFAULT_MULTIPART_TTL_MS,
      `整批分片发了 ${span}ms，超过接收端 ${DEFAULT_MULTIPART_TTL_MS}ms 的重组窗口，后面的分片会被当成过期丢掉`
    );
    // 窗口里还要装每一片自己的网络耗时和推送服务的排队，所以只用一半。
    assert.ok(
      span <= DEFAULT_MULTIPART_TTL_MS / 2,
      `整批分片发了 ${span}ms，掐着窗口边缘发，网络一慢就拼不回来`
    );
  });

  it('片数不多时保持原来的 1.5 秒节奏', async () => {
    // 6000 字节 ≈ 4 片，1.5 秒一片一共 4.5 秒，离窗口远得很，没必要收紧。
    const { chunks } = await deliverWithClock({ reasoningChars: 6_000 });

    assert.ok(chunks.length >= 2 && chunks.length <= 10, `期望是个位数分片，实际 ${chunks.length} 片`);
    for (let i = 1; i < chunks.length; i++) {
      assert.equal(chunks[i].at - chunks[i - 1].at, 1500, '片数不多时节奏不该变');
    }
  });

  it('窗口被宿主调窄到装不下时，一片都不发（正文照发）', async () => {
    // 宿主把 installReiSW 的重组窗口设成 5 秒，同样的值传给服务端。~60 片怎么
    // 排都装不进去：发一半的下场是用户那边整条思考过程凭空消失，还不如不发。
    const { result, sent, chunks } = await deliverWithClock({
      reasoningChars: 108_000,
      multipart: { ttlMs: 5_000 },
    });

    assert.equal(result.success, true, '思考过程发不出去不影响正文');
    assert.equal(chunks.length, 0, '既然装不进窗口，一片都不该发出去');
    assert.match(result.reasoningError || '', /重组窗口/);
    assert.ok(sent.some((entry) => entry.push.messageKind === 'content'), '正文照发');
  });
});

describe('maxChunkBytes 的上限校验', () => {
  // 每片原文经 base64url 膨胀 4/3、再套上分片信封之后，必须仍装得进单条 push
  // 的明文上限（约 3993 字节）。配得太大的话每一片都会被推送服务拒收——原来的
  // 下场是每次触发时思考过程静默丢失，只留一条跟配置对不上号的推送错误。

  it('配超过上限 → 配置错误响亮失败，一片都不切', async () => {
    // 3000 字节原文 → base64 后 4000 字符，信封一套就超限。
    const { result, chunks } = await deliverWithClock({
      reasoningChars: 20_000,
      multipart: { maxChunkBytes: 3000 },
    });

    assert.equal(result.success, false, '配置错误不能靠「思考过程静默丢掉」糊过去');
    assert.equal(result.errorCode, 'MULTIPART_CHUNK_BYTES_TOO_LARGE');
    assert.match(result.error, /maxChunkBytes/);
    assert.match(result.error, /最大 \d+/, '错误信息要把当前配置下的上限说出来');
    assert.equal(chunks.length, 0);
  });

  it('收窄到上限之内照常切片，且每一片的信封都装得进单条 push', async () => {
    const { result, chunks } = await deliverWithClock({
      reasoningChars: 20_000,
      multipart: { maxChunkBytes: 2600 },
    });

    assert.equal(result.success, true);
    assert.ok(chunks.length >= 2, `该切成多片，实际 ${chunks.length} 片`);
    for (const { push } of chunks) {
      const { bytes, withinLimit } = measurePushPayload(JSON.stringify(push));
      assert.ok(withinLimit, `分片信封 ${bytes} 字节，超过单条 push 的 ${MAX_PUSH_PAYLOAD_BYTES} 字节上限`);
    }
  });
});

describe('宿主配的分片限额传得到发送端', () => {
  it('createSingleUserServer 把 multipart 放到 ctx 上（instant 消息也走这份 ctx）', () => {
    const multipart = { maxChunkBytes: 900, maxChunks: 32, maxTotalBytes: 64_000, ttlMs: 120_000 };
    const { ctx } = createSingleUserServer({
      db: {},
      masterKey: TEST_MASTER_KEY,
      multipart,
    });
    assert.deepEqual(ctx.multipart, multipart);
  });

  it('Cloudflare worker 的 cron 投递按宿主收窄的 maxChunks 走', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, TEST_USER_ID, TEST_MASTER_KEY);
    const userKey = await deriveUserEncryptionKey(TEST_USER_ID, TEST_MASTER_KEY);
    await adapter.createTask({
      user_id: TEST_USER_ID,
      uuid: 'narrowed-multipart',
      encrypted_payload: await encryptForStorage(JSON.stringify(LLM_TASK_PAYLOAD), userKey),
      next_send_at: new Date(Date.now() - 30_000).toISOString(),
      message_type: 'prompted',
    });

    const sent = [];
    const worker = createSingleUserCloudflareWorker((env) => ({
      // 有收件箱时思考过程只落行、不推送（见 lib/push-policy.js），这条用例要
      // 验的是分片限额，得站在没有收件箱的部署上——那时推送是它唯一的腿。
      db: withoutOutbox(createD1Adapter(env.DB)),
      masterKey: TEST_MASTER_KEY,
      vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
      webpush: { async sendNotification(_sub, payload) { sent.push(JSON.parse(payload)); } },
      // 页面那边 installReiSW({ multipart: { maxChunks: 2 } })，服务端拿到同一份。
      multipart: { maxChunks: 2 },
    }));

    const restore = stubLlm('回答。', 'x'.repeat(20_000));
    let result;
    try {
      result = await worker.scheduled({}, { DB: d1 });
    } finally {
      restore();
    }

    assert.equal(result.ok, true);
    assert.equal(result.summary.successCount, 1, '正文送到了，这条任务就是成功的');
    assert.equal(
      sent.filter((push) => push.messageKind === '_multipart').length, 0,
      '接收端只肯收 2 片，发送端就不该发出一批对面收不了的分片'
    );
    assert.equal(sent.filter((push) => push.messageKind === 'content').length, 1);
    assert.equal(result.summary.details.reasoningSkippedTasks.length, 1, '思考过程没发出去要在汇总里看得见');
  });
});
