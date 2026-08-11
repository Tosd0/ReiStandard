/**
 * ReasoningPush 的投递隔离与分片兜底，外加 pushStatusCode 的来源约束。
 *
 * 思考过程是正文之外的附赠内容：它发不出去只影响它自己。分片兜底让一条
 * push 装不下的思考过程也能真正送达。pushStatusCode 只描述推送那一步的
 * 结果，别的来路的 statusCode 不该冒充它（run-tick 拿它判终态）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { base64UrlToBytes, concatBytes, utf8Decode } from '@rei-standard/amsg-shared';
import { processSingleMessage } from '../src/server/lib/message-processor.js';
import { measurePushPayload, MAX_PUSH_PAYLOAD_BYTES } from '../src/server/lib/webpush-webcrypto.js';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { encryptTestSubscription, withPushSubscriptionStore } from './helpers/push-subscription.mjs';

const TEST_USER_ID = '550e8400-e29b-41d4-a716-446655440000';
const TEST_MASTER_KEY = 'a'.repeat(64);
const ENCRYPTED_PUSH_SUB = await encryptTestSubscription(TEST_USER_ID, TEST_MASTER_KEY);

async function createEncryptedTask(payload) {
  const userKey = await deriveUserEncryptionKey(TEST_USER_ID, TEST_MASTER_KEY);
  return {
    id: 1,
    user_id: TEST_USER_ID,
    encrypted_payload: await encryptForStorage(JSON.stringify(payload), userKey)
  };
}

function createContext(sendNotificationSpy = async () => {}) {
  return {
    masterKey: TEST_MASTER_KEY,
    webpush: {
      async sendNotification(...args) {
        await sendNotificationSpy(...args);
      }
    },
    vapid: { email: 'vapid@example.com', publicKey: 'public', privateKey: 'private' },
    db: withPushSubscriptionStore({}, ENCRYPTED_PUSH_SUB)
  };
}

/** 让 LLM 那一跳回一段带 reasoning_content 的响应。 */
function stubLlm(content, reasoningContent) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content, reasoning_content: reasoningContent } }] };
    }
  });
  return () => { globalThis.fetch = originalFetch; };
}

const LLM_TASK_PAYLOAD = {
  contactName: 'Rei',
  messageType: 'prompted',
  completePrompt: 'x',
  apiUrl: 'https://api.example.com/v1/chat/completions',
  apiKey: 's',
  primaryModel: 'm'
};

/** 把一组 `_multipart` 分片拼回原来的 push 对象。 */
function restoreFromChunks(chunks) {
  const ordered = [...chunks].sort((a, b) => a.multipart.index - b.multipart.index);
  const merged = concatBytes(...ordered.map(part => base64UrlToBytes(part.chunk)));
  return JSON.parse(utf8Decode(merged));
}

describe('ReasoningPush 投递隔离', () => {
  it('思考过程发不出去时，正文一条不少地照发', async () => {
    const task = await createEncryptedTask(LLM_TASK_PAYLOAD);
    const restore = stubLlm('第一句。第二句。', '先想想再回答');

    const pushed = [];
    const ctx = createContext(async (_sub, payload) => {
      const parsed = JSON.parse(payload);
      if (parsed.messageKind === 'reasoning') {
        const error = new Error('payload too large');
        error.code = 'PUSH_PAYLOAD_TOO_LARGE';
        throw error;
      }
      pushed.push(parsed);
    });

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, true, '思考过程发挂了不该把整条消息带走');
      assert.equal(result.messagesSent, 2);
      assert.equal(pushed.length, 2, '两句正文都要发出去');
      assert.deepEqual(pushed.map(p => p.messageKind), ['content', 'content']);
      assert.equal(pushed[0].message, '第一句。');
      assert.equal(pushed[1].message, '第二句。');
    } finally {
      restore();
    }
  });

  it('思考过程发挂了，正文那一步的失败仍照常上报', async () => {
    const task = await createEncryptedTask(LLM_TASK_PAYLOAD);
    const restore = stubLlm('正文。', '想一想');

    const ctx = createContext(async (_sub, payload) => {
      const parsed = JSON.parse(payload);
      const error = new Error(parsed.messageKind === 'reasoning' ? 'reasoning 挂了' : 'subscription gone');
      if (parsed.messageKind !== 'reasoning') error.statusCode = 410;
      throw error;
    });

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, false);
      assert.equal(result.pushStatusCode, 410, '正文那条的推送状态码要透出来');
    } finally {
      restore();
    }
  });
});

describe('ReasoningPush 分片兜底', () => {
  it('一条装不下的思考过程切成 _multipart 分片，收齐能还原', async () => {
    // 单条 push 明文上限约 3993 字节；一个汉字 3 字节，2000 字必然超。
    const longReasoning = '想'.repeat(2000);
    const task = await createEncryptedTask(LLM_TASK_PAYLOAD);
    const restore = stubLlm('回答。', longReasoning);

    const pushed = [];
    const ctx = createContext(async (_sub, payload) => {
      pushed.push({ raw: payload, parsed: JSON.parse(payload) });
    });

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, true);
      assert.equal(result.messagesSent, 1);

      const chunks = pushed.filter(p => p.parsed.messageKind === '_multipart');
      assert.ok(chunks.length >= 2, `思考过程应被切片，实际发了 ${chunks.length} 片`);
      assert.equal(
        pushed.some(p => p.parsed.messageKind === 'reasoning'),
        false,
        '超限的思考过程不该再作为整条 push 发出去'
      );

      // 每一片自己都得装得进单条 push，否则切了也白切。
      for (const chunk of chunks) {
        assert.ok(
          measurePushPayload(chunk.raw).withinLimit,
          `分片 ${chunk.parsed.multipart.index} 有 ${measurePushPayload(chunk.raw).bytes} 字节，超过 ${MAX_PUSH_PAYLOAD_BYTES}`
        );
        assert.equal(chunk.parsed.multipart.originalMessageKind, 'reasoning');
        assert.equal(chunk.parsed.multipart.total, chunks.length);
      }

      const restored = restoreFromChunks(chunks.map(c => c.parsed));
      assert.equal(restored.messageKind, 'reasoning');
      assert.equal(restored.reasoningContent, longReasoning);
      assert.equal(restored.taskId, 1, '分片还原出来的仍是补齐了任务身份的那条 push');

      // 正文排在分片之后，照常发。
      const contentPushes = pushed.filter(p => p.parsed.messageKind === 'content');
      assert.equal(contentPushes.length, 1);
      assert.equal(contentPushes[0].parsed.message, '回答。');
    } finally {
      restore();
    }
  });

  it('思考过程超出分片传输的总量上限时不发分片，正文照发', async () => {
    // 分片传输的默认总量上限 256_000 字节；90_000 个汉字是 270_000 字节。
    const hugeReasoning = '想'.repeat(90_000);
    const task = await createEncryptedTask(LLM_TASK_PAYLOAD);
    const restore = stubLlm('回答。', hugeReasoning);

    const pushed = [];
    const ctx = createContext(async (_sub, payload) => {
      pushed.push(JSON.parse(payload));
    });

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, true);
      assert.equal(result.messagesSent, 1);
      assert.deepEqual(pushed.map(p => p.messageKind), ['content']);
    } finally {
      restore();
    }
  });
});

describe('pushStatusCode 的来源', () => {
  it('推送服务回的状态码照常透出来', async () => {
    const task = await createEncryptedTask({
      contactName: 'Rei',
      messageType: 'fixed',
      userMessage: '固定消息'
    });

    const ctx = createContext(async () => {
      const error = new Error('subscription gone');
      error.statusCode = 410;
      throw error;
    });

    const result = await processSingleMessage(task, ctx);
    assert.equal(result.success, false);
    assert.equal(result.pushStatusCode, 410);
  });

  it('fire-time hook 那条投递链上的推送失败，状态码同样透出来', async () => {
    const task = await createEncryptedTask(LLM_TASK_PAYLOAD);
    const restore = stubLlm('回答。', null);

    const ctx = createContext(async () => {
      const error = new Error('subscription gone');
      error.statusCode = 410;
      throw error;
    });
    ctx._agenticSleep = async () => {};
    ctx.hooks = {
      async onBeforeFire() {
        return [{ role: 'user', content: 'hi' }];
      },
      async onLLMOutput() {
        return { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: '回答。' }] };
      }
    };

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, false);
      assert.equal(result.pushStatusCode, 410, 'hook 投递的这条链也得认推送服务回的状态码');
    } finally {
      restore();
    }
  });

  it('宿主 hook 抛的错误带 statusCode 时，不当成推送状态码', async () => {
    const task = await createEncryptedTask(LLM_TASK_PAYLOAD);

    const ctx = createContext();
    ctx.hooks = {
      async onBeforeFire() {
        // Node 生态的 HTTP 库习惯把上游状态码挂成 statusCode，宿主 hook 里
        // 转手抛出来的这种错误跟推送服务没有关系。
        const error = new Error('宿主自己的上游回了 404');
        error.statusCode = 404;
        throw error;
      },
      async onLLMOutput() {
        return { decision: 'finish', pushPayloads: [] };
      }
    };

    const result = await processSingleMessage(task, ctx);
    assert.equal(result.success, false);
    assert.match(result.error, /404/);
    assert.equal(
      result.pushStatusCode,
      null,
      'hook 抛的 404 被当成推送状态码的话，run-tick 会把任务判成订阅失效、永久 failed'
    );
  });
});

describe('ReasoningPush 的取消信号与限额对齐', () => {
  // 取消不是「思考过程没发成」，是整条任务的中止信号。吞掉它的话，日志会说
  // 「正文照常发送」，而实际上下一条 push 就把整条任务中止掉了——正好说反。
  it('分片发到一半任务被取消：信号往上抛，不被当成思考过程发失败', async () => {
    const task = await createEncryptedTask(LLM_TASK_PAYLOAD);
    const restore = stubLlm('正文。', 'x'.repeat(MAX_PUSH_PAYLOAD_BYTES * 2));

    let calls = 0;
    const ctx = createContext(async () => {
      calls++;
      if (calls === 2) {
        const error = new Error('任务在投递期间被取消或顶替');
        error.code = 'TASK_CANCELLED';
        throw error;
      }
    });

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, false, '取消要如实报成没送达');
      assert.equal(result.errorCode, 'TASK_CANCELLED');
    } finally {
      restore();
    }
  });

  // 接收端的限额是宿主可配的（installReiSW 的 multipart）。发送端不跟着走的
  // 话，切出来的分片到了那边会被逐片拒收，一条也拼不回来——而发送端这边两道
  // 门槛全都过了，看不出任何异常。
  it('宿主收窄 multipart 限额时，发送端跟着收窄（宁可不发也不发一堆收不了的）', async () => {
    const task = await createEncryptedTask(LLM_TASK_PAYLOAD);
    const restore = stubLlm('正文。', 'x'.repeat(MAX_PUSH_PAYLOAD_BYTES * 4));

    const sent = [];
    const ctx = {
      ...createContext(async (_sub, payload) => { sent.push(JSON.parse(payload)); }),
      // 接收端只肯收 2 片，这段思考过程远不止 2 片。
      multipart: { maxChunks: 2 },
    };

    try {
      const result = await processSingleMessage(task, ctx);
      assert.equal(result.success, true, '思考过程发不出去不影响正文');
      assert.ok(result.reasoningError, `发不出去要说出原因：${JSON.stringify(result)}`);
      assert.match(result.reasoningError, /2 片上限/);
      assert.equal(
        sent.filter((push) => push.messageKind === '_multipart').length, 0,
        '既然对面收不了，一片都不该发出去',
      );
      assert.ok(sent.some((push) => push.messageKind === 'content'), '正文照发');
    } finally {
      restore();
    }
  });
});
