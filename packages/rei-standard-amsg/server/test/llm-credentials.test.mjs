/**
 * 用户级 LLM 凭据（llm_credentials 表 + /llm-credentials 端点 + credRefs）。
 *
 * 回归守卫的核心场景：
 *   - 端点加密往返；GET 永不回凭据本体
 *   - 排程：credRefs.chat 单独可建任务；与内联混传被拒；引用不存在被点名拒掉
 *   - fire：按引用现读表里的凭据；行没了退回内联；都没有 → CREDENTIAL_MISSING
 *     且走常规重试（不是 permanent）
 *   - 自排链跟随换 Key（灵魂测试）：子任务复制的是引用，表里换了值子任务用新值
 *   - 泄漏防线：hook ctx / push payload 摸不到解析后的 apiKey
 *   - update-message：credRefs 整体替换 + 存在性检查
 *   - examples/schema.sql 与代码里的建表语句列一致
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { createSingleUserServer } from '../src/server/single-user.js';
import { createD1Adapter } from '../src/server/adapters/d1.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import {
  deriveUserEncryptionKey,
  encryptPayload,
  encryptForStorage,
  decryptFromStorage,
} from '../src/server/lib/encryption.js';
import { processSingleMessage } from '../src/server/lib/message-processor.js';
import { saveLlmCredentials } from '../src/server/lib/llm-credentials-store.js';
import { SQLITE_REQUIRED_SCHEMA } from '../src/server/adapters/schema.sqlite.js';
import { seedPushSubscription, withPushSubscriptionStore, encryptTestSubscription } from './helpers/push-subscription.mjs';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

const ENC_HEADERS = {
  'X-User-Id': USER,
  'X-Payload-Encrypted': 'true',
  'X-Encryption-Version': '1',
};

const CRED_ID = 'char:c1/chat';
const CRED_VALUE = {
  apiUrl: 'https://cred.example.com/v1/chat/completions',
  apiKey: 'sk-from-table',
  primaryModel: 'table-model',
};

function makeWorker(d1, extra = {}) {
  return createSingleUserCloudflareWorker(() => ({
    db: createD1Adapter(d1),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} },
    ...extra,
  }));
}

async function encBody(obj) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  return JSON.stringify(await encryptPayload(obj, userKey));
}

async function freshWorker() {
  const d1 = createTestD1();
  const adapter = createD1Adapter(d1);
  await adapter.initSchema();
  await seedPushSubscription(adapter, USER, MASTER_KEY);
  return { d1, adapter, worker: makeWorker(d1), env: { DB: d1 } };
}

async function putCredentials(worker, env, credentials) {
  return worker.fetch(
    new Request('https://w.dev/llm-credentials', {
      method: 'PUT',
      headers: ENC_HEADERS,
      body: await encBody({ credentials }),
    }),
    env
  );
}

async function listCredentials(worker, env) {
  return worker.fetch(
    new Request('https://w.dev/llm-credentials', { method: 'GET', headers: { 'X-User-Id': USER } }),
    env
  );
}

async function deleteCredentials(worker, env, body) {
  return worker.fetch(
    new Request('https://w.dev/llm-credentials', {
      method: 'DELETE',
      headers: ENC_HEADERS,
      body: await encBody(body),
    }),
    env
  );
}

// LLM fetch stub（带 headers 捕获——要断言请求真的用了表里那份凭据）。
function stubLlm(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: true, async json() { return r; } };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const contentRound = { choices: [{ message: { role: 'assistant', content: '你好。' } }] };

/** 直接喂给 processSingleMessage 的 fire ctx（真适配器）。 */
function fireCtx(adapter, { hooks, pushSpy } = {}) {
  return {
    masterKey: MASTER_KEY,
    db: adapter,
    webpush: { async sendNotification(sub, p) { if (pushSpy) pushSpy(sub, JSON.parse(p)); } },
    vapid: { email: 'v@example.com', publicKey: 'pub', privateKey: 'priv' },
    hooks: hooks || null,
    _agenticSleep: async () => {},
  };
}

/** 手搓一条任务行（processSingleMessage 直接吃行对象）。 */
async function makeTaskRow(payloadOverrides = {}) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const payload = {
    contactName: 'Rei',
    messageType: 'auto',
    completePrompt: 'frozen prompt',
    recurrenceType: 'none',
    metadata: { charId: 'char-1' },
    ...payloadOverrides,
  };
  return {
    task: {
      id: 7, user_id: USER, uuid: 'u7',
      encrypted_payload: await encryptForStorage(JSON.stringify(payload), userKey),
      next_send_at: '2020-01-01T00:00:00.000Z', retry_count: 0,
    },
    payload,
  };
}

async function seedCred(adapter, credId = CRED_ID, value = CRED_VALUE) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  await saveLlmCredentials({ db: adapter, userId: USER, userKey, credentials: [{ credId, value }] });
}

function futureIso(ms = 3600_000) {
  return new Date(Date.now() + ms).toISOString();
}

async function scheduleTask(worker, env, payloadOverrides = {}) {
  return worker.fetch(
    new Request('https://w.dev/schedule-message', {
      method: 'POST',
      headers: ENC_HEADERS,
      body: await encBody({
        contactName: 'Rei',
        messageType: 'prompted',
        completePrompt: 'p',
        firstSendTime: futureIso(),
        ...payloadOverrides,
      }),
    }),
    env
  );
}

describe('PUT/GET/DELETE /llm-credentials', () => {
  test('登记 → 对账 → 覆盖 → 删除；GET 永不回凭据本体', async () => {
    const { d1, worker, env } = await freshWorker();

    const put = await putCredentials(worker, env, [
      { credId: 'global/embed', value: { apiUrl: 'https://e.example.com', apiKey: 'sk-embed', primaryModel: 'embed-1' } },
      { credId: CRED_ID, value: CRED_VALUE },
    ]);
    assert.equal(put.status, 200);
    assert.equal((await put.json()).data.upserted, 2);

    const listed = await (await listCredentials(worker, env)).json();
    // 按 cred_id 排序稳定输出；只有 credId + updatedAt 两个字段。
    assert.deepEqual(listed.data.credentials.map((c) => c.credId), [CRED_ID, 'global/embed']);
    for (const entry of listed.data.credentials) {
      assert.deepEqual(Object.keys(entry).sort(), ['credId', 'updatedAt']);
    }
    // 响应整体摸不到任何凭据本体。
    const rawList = JSON.stringify(listed);
    for (const secret of ['sk-from-table', 'sk-embed', 'cred.example.com', 'table-model']) {
      assert.ok(!rawList.includes(secret), `GET 响应不该出现 ${secret}`);
    }

    // 落库是密文。
    const row = await d1.prepare('SELECT encrypted_value FROM llm_credentials WHERE user_id = ? AND cred_id = ?')
      .bind(USER, CRED_ID).first();
    assert.ok(!row.encrypted_value.includes('sk-from-table'));

    // 覆盖同一行：行数不变。
    await putCredentials(worker, env, [{ credId: CRED_ID, value: { ...CRED_VALUE, apiKey: 'sk-v2' } }]);
    const after = await (await listCredentials(worker, env)).json();
    assert.equal(after.data.credentials.length, 2);

    // 删指定 → 删全部。
    const delOne = await (await deleteCredentials(worker, env, { credIds: [CRED_ID] })).json();
    assert.equal(delOne.data.deleted, 1);
    const delAll = await (await deleteCredentials(worker, env, { all: true })).json();
    assert.equal(delAll.data.deleted, 1);
    const empty = await (await listCredentials(worker, env)).json();
    assert.deepEqual(empty.data.credentials, []);
  });

  test('形状校验：坏 credId / 缺 value 字段 / all 与 credIds 混传都打回', async () => {
    const { worker, env } = await freshWorker();

    const badId = await putCredentials(worker, env, [{ credId: 'x'.repeat(129), value: CRED_VALUE }]);
    assert.equal(badId.status, 400);

    const badValue = await putCredentials(worker, env, [{ credId: 'ok', value: { apiUrl: 'u', apiKey: 'k' } }]);
    assert.equal(badValue.status, 400);

    const mixed = await deleteCredentials(worker, env, { all: true, credIds: ['a'] });
    assert.equal(mixed.status, 400);
  });
});

describe('POST /schedule-message with credRefs', () => {
  test('只带 credRefs.chat 能建 prompted 任务，credRefs 原样进 payload', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedCred(adapter);

    const res = await scheduleTask(worker, env, { credRefs: { chat: CRED_ID } });
    assert.equal(res.status, 201);
    const { data } = await res.json();

    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const row = await adapter.getTaskByUuid(data.uuid, USER);
    const stored = JSON.parse(await decryptFromStorage(row.encrypted_payload, userKey));
    assert.deepEqual(stored.credRefs, { chat: CRED_ID });
    assert.equal(stored.apiKey, null);
  });

  test('credRefs.chat 与内联三件套混传 → 400', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedCred(adapter);

    const res = await scheduleTask(worker, env, {
      credRefs: { chat: CRED_ID },
      apiUrl: 'https://inline.example.com', apiKey: 'sk-inline', primaryModel: 'm',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'INVALID_PARAMETERS');
  });

  test('credRefs.chat 与单个内联字段（仅 apiKey）混传 → 同样 400', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedCred(adapter);

    const res = await scheduleTask(worker, env, {
      credRefs: { chat: CRED_ID },
      apiKey: 'sk-inline',
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, 'INVALID_PARAMETERS');
  });

  test('仅非 chat purpose 的 credRefs + 内联三件套 → 合法组合，正常建任务', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedCred(adapter, 'char:c1/emotion', { ...CRED_VALUE, apiKey: 'sk-emotion' });

    const res = await scheduleTask(worker, env, {
      credRefs: { emotion: 'char:c1/emotion' },
      apiUrl: 'https://inline.example.com', apiKey: 'sk-inline', primaryModel: 'inline-model',
    });
    assert.equal(res.status, 201);
    const { data } = await res.json();
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const row = await adapter.getTaskByUuid(data.uuid, USER);
    const stored = JSON.parse(await decryptFromStorage(row.encrypted_payload, userKey));
    assert.deepEqual(stored.credRefs, { emotion: 'char:c1/emotion' });
    assert.equal(stored.apiKey, 'sk-inline');
  });

  test('引用不存在 → 409 CREDENTIAL_NOT_FOUND 且点名', async () => {
    const { worker, env } = await freshWorker();
    const res = await scheduleTask(worker, env, { credRefs: { chat: 'char:ghost/chat' } });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'CREDENTIAL_NOT_FOUND');
    assert.deepEqual(body.error.details.missingCredIds, ['char:ghost/chat']);
  });

  test('适配器不支持凭据存储时带 credRefs → 501', async () => {
    const encrypted = await encryptTestSubscription(USER, MASTER_KEY);
    const server = createSingleUserServer({
      db: withPushSubscriptionStore({}, encrypted),
      masterKey: MASTER_KEY,
      vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
      webpush: { async sendNotification() {} },
    });
    const result = await server.handlers.scheduleMessage.POST(ENC_HEADERS, await encBody({
      contactName: 'Rei', messageType: 'prompted', completePrompt: 'p',
      firstSendTime: futureIso(), credRefs: { chat: CRED_ID },
    }));
    assert.equal(result.status, 501);
    assert.equal(result.body.error.code, 'LLM_CREDENTIALS_NOT_SUPPORTED');
  });
});

describe('fire 时的凭据解析', () => {
  test('credRefs.chat → LLM 请求用表里的 apiUrl / apiKey / model', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, USER, MASTER_KEY);
    await seedCred(adapter);

    const { task } = await makeTaskRow({ credRefs: { chat: CRED_ID } });
    const llm = stubLlm([contentRound]);
    try {
      const result = await processSingleMessage(task, fireCtx(adapter));
      assert.equal(result.success, true);
      assert.equal(llm.calls.length, 1);
      assert.equal(llm.calls[0].url, CRED_VALUE.apiUrl);
      assert.equal(llm.calls[0].headers.Authorization, `Bearer ${CRED_VALUE.apiKey}`);
      assert.equal(llm.calls[0].body.model, CRED_VALUE.primaryModel);
    } finally {
      llm.restore();
    }
  });

  test('表行在、任务也有内联（update-message 补引用的存量任务）→ 表里的赢', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, USER, MASTER_KEY);
    await seedCred(adapter);

    const { task } = await makeTaskRow({
      credRefs: { chat: CRED_ID },
      apiUrl: 'https://stale.example.com', apiKey: 'sk-stale', primaryModel: 'stale-model',
    });
    const llm = stubLlm([contentRound]);
    try {
      await processSingleMessage(task, fireCtx(adapter));
      assert.equal(llm.calls[0].headers.Authorization, `Bearer ${CRED_VALUE.apiKey}`);
    } finally {
      llm.restore();
    }
  });

  test('表行被删、任务还有内联 → 退回内联兜底', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, USER, MASTER_KEY);
    // 刻意不 seed 凭据行。

    const { task } = await makeTaskRow({
      credRefs: { chat: CRED_ID },
      apiUrl: 'https://inline.example.com/v1/chat/completions', apiKey: 'sk-inline', primaryModel: 'inline-model',
    });
    const llm = stubLlm([contentRound]);
    try {
      const result = await processSingleMessage(task, fireCtx(adapter));
      assert.equal(result.success, true);
      assert.equal(llm.calls[0].headers.Authorization, 'Bearer sk-inline');
    } finally {
      llm.restore();
    }
  });

  test('表行没了、也没内联 → CREDENTIAL_MISSING，常规重试（非 permanent）', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, USER, MASTER_KEY);

    const { task } = await makeTaskRow({ credRefs: { chat: CRED_ID } });
    const llm = stubLlm([contentRound]);
    try {
      const result = await processSingleMessage(task, fireCtx(adapter));
      assert.equal(result.success, false);
      assert.equal(result.errorCode, 'CREDENTIAL_MISSING');
      assert.ok(!result.permanent, 'CREDENTIAL_MISSING 应走常规重试，用户补传后自愈');
      assert.equal(llm.calls.length, 0);
    } finally {
      llm.restore();
    }
  });

  test('空凭据 auto（只带 emotion 引用、无内联）→ CREDENTIAL_MISSING，不静默', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, USER, MASTER_KEY);

    const { task } = await makeTaskRow({ credRefs: { emotion: 'char:c1/emotion' } });
    const llm = stubLlm([contentRound]);
    try {
      const result = await processSingleMessage(task, fireCtx(adapter));
      assert.equal(result.success, false);
      assert.equal(result.errorCode, 'CREDENTIAL_MISSING');
      assert.ok(!result.permanent);
      assert.equal(llm.calls.length, 0);
    } finally {
      llm.restore();
    }
  });

  test('空凭据 auto 走 agentic 路径 → onBeforeFire 照常被调，仍 CREDENTIAL_MISSING', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, USER, MASTER_KEY);

    const { task } = await makeTaskRow({ credRefs: { emotion: 'char:c1/emotion' } });
    let beforeFireCalled = false;
    const hooks = {
      onBeforeFire: async () => { beforeFireCalled = true; return [{ role: 'user', content: 'U' }]; },
      onLLMOutput: async () => ({ decision: 'skip-push' }),
    };
    const llm = stubLlm([contentRound]);
    try {
      const result = await processSingleMessage(task, fireCtx(adapter, { hooks }));
      // 空凭据不是「不需要 LLM」：任务照常进 fire 链，在凭据解析处响亮失败。
      assert.equal(beforeFireCalled, true);
      assert.equal(result.success, false);
      assert.equal(result.errorCode, 'CREDENTIAL_MISSING');
      assert.equal(llm.calls.length, 0);
    } finally {
      llm.restore();
    }
  });

  test('instant 无凭据 + userMessage（带 emotion 引用）→ 纯推送路由不变，不走 LLM', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, USER, MASTER_KEY);

    const { task } = await makeTaskRow({
      messageType: 'instant',
      userMessage: '在吗',
      credRefs: { emotion: 'char:c1/emotion' },
    });
    const pushes = [];
    const llm = stubLlm([contentRound]);
    try {
      const result = await processSingleMessage(task, fireCtx(adapter, { pushSpy: (_s, p) => pushes.push(p) }));
      assert.equal(result.success, true);
      assert.equal(llm.calls.length, 0);
      assert.ok(pushes.length >= 1);
    } finally {
      llm.restore();
    }
  });
});

describe('自排链与泄漏防线', () => {
  test('灵魂测试：自排子任务复制引用，表里换 Key 后子任务用新值', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, USER, MASTER_KEY);
    await seedCred(adapter);

    // 父任务带 credRefs，用 hook 在 fire 里给自己排一条后续。
    const { task, payload } = await makeTaskRow({ credRefs: { chat: CRED_ID } });
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async (sessionCtx) => {
        await sessionCtx.scheduleTask({ firstSendTime: futureIso(120_000) });
        return { decision: 'skip-push' };
      },
    };
    const llm = stubLlm([contentRound]);
    let childRow;
    try {
      const result = await processSingleMessage(task, fireCtx(adapter, { hooks }));
      assert.equal(result.success, true);

      const { tasks } = await adapter.listTasks(USER, {});
      assert.equal(tasks.length, 1);
      childRow = tasks[0];
      const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
      const childPayload = JSON.parse(await decryptFromStorage(childRow.encrypted_payload, userKey));
      // 复制的是引用，不是凭据本体（旧行为在这里挂：内联复制 → apiKey 非空）。
      assert.deepEqual(childPayload.credRefs, payload.credRefs);
      assert.equal(childPayload.apiUrl, null);
      assert.equal(childPayload.apiKey, null);
      assert.equal(childPayload.primaryModel, null);
    } finally {
      llm.restore();
    }

    // 换 Key：只覆盖表里那一行。
    await seedCred(adapter, CRED_ID, { ...CRED_VALUE, apiKey: 'sk-rotated' });

    // 子任务到点：用的必须是新 Key（旧行为在这里挂：冻结的旧 Key）。
    const llm2 = stubLlm([contentRound]);
    try {
      const result = await processSingleMessage(childRow, fireCtx(adapter));
      assert.equal(result.success, true);
      assert.equal(llm2.calls[0].headers.Authorization, 'Bearer sk-rotated');
    } finally {
      llm2.restore();
    }
  });

  test('空壳后代守卫：父只带 emotion 引用 + 内联 → 子任务引用与内联都复制、fire 正常', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, USER, MASTER_KEY);

    const inline = {
      apiUrl: 'https://inline.example.com/v1/chat/completions',
      apiKey: 'sk-inline',
      primaryModel: 'inline-model',
    };
    const { task, payload } = await makeTaskRow({
      credRefs: { emotion: 'char:c1/emotion' },
      ...inline,
    });
    const hooks = {
      onBeforeFire: async () => [{ role: 'user', content: 'U' }],
      onLLMOutput: async (sessionCtx) => {
        await sessionCtx.scheduleTask({ firstSendTime: futureIso(120_000) });
        return { decision: 'skip-push' };
      },
    };
    const llm = stubLlm([contentRound]);
    let childRow;
    try {
      const result = await processSingleMessage(task, fireCtx(adapter, { hooks }));
      assert.equal(result.success, true);
      // 父自己的 fire 用内联聊天凭据（emotion 引用 + 内联是合法组合）。
      assert.equal(llm.calls[0].headers.Authorization, 'Bearer sk-inline');

      const { tasks } = await adapter.listTasks(USER, {});
      assert.equal(tasks.length, 1);
      childRow = tasks[0];
      const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
      const childPayload = JSON.parse(await decryptFromStorage(childRow.encrypted_payload, userKey));
      // 引用与内联**都**要在（旧行为在这里挂：内联被一刀切置空，产出既无
      // chat 引用又无内联的空壳后代）。
      assert.deepEqual(childPayload.credRefs, payload.credRefs);
      assert.equal(childPayload.apiUrl, inline.apiUrl);
      assert.equal(childPayload.apiKey, inline.apiKey);
      assert.equal(childPayload.primaryModel, inline.primaryModel);
    } finally {
      llm.restore();
    }

    // 子任务到点照常生成（老路径，无 hooks）。
    const llm2 = stubLlm([contentRound]);
    try {
      const result = await processSingleMessage(childRow, fireCtx(adapter));
      assert.equal(result.success, true);
      assert.equal(llm2.calls[0].headers.Authorization, 'Bearer sk-inline');
    } finally {
      llm2.restore();
    }
  });

  test('hook ctx 与 push payload 摸不到解析后的 apiKey；credRefs 对 hook 可见', async () => {
    const d1 = createTestD1();
    const adapter = createD1Adapter(d1);
    await adapter.initSchema();
    await seedPushSubscription(adapter, USER, MASTER_KEY);
    await seedCred(adapter);

    const { task } = await makeTaskRow({ credRefs: { chat: CRED_ID } });
    let capturedFireCtx = null;
    let capturedSessionCtx = null;
    const hooks = {
      onBeforeFire: async (fc) => { capturedFireCtx = fc; return [{ role: 'user', content: 'U' }]; },
      onLLMOutput: async (sc) => {
        capturedSessionCtx = sc;
        return { decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'A' }] };
      },
    };
    const pushes = [];
    const llm = stubLlm([contentRound]);
    try {
      await processSingleMessage(task, fireCtx(adapter, { hooks, pushSpy: (_s, p) => pushes.push(p) }));
    } finally {
      llm.restore();
    }

    // 引用（只是名字）对 hook 可见——宿主对账要用；凭据本体一个字都不能有。
    assert.deepEqual(capturedFireCtx.task.credRefs, { chat: CRED_ID });
    assert.equal('apiKey' in capturedFireCtx.task, false);
    for (const dump of [JSON.stringify(pushes), JSON.stringify(capturedSessionCtx.metadata ?? null)]) {
      assert.ok(!dump.includes(CRED_VALUE.apiKey), '解析后的 apiKey 不得出现在 hook 可见对象 / push 里');
      assert.ok(!dump.includes(CRED_VALUE.apiUrl), '解析后的 apiUrl 不得出现在 hook 可见对象 / push 里');
    }
  });
});

describe('PUT /update-message with credRefs', () => {
  test('整体替换 + 存在性检查；与内联混传被拒', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedCred(adapter);
    await seedCred(adapter, 'char:c1/chat-v2', { ...CRED_VALUE, apiKey: 'sk-v2' });

    const created = await (await scheduleTask(worker, env, { credRefs: { chat: CRED_ID } })).json();
    const uuid = created.data.uuid;

    async function putUpdate(updates) {
      return worker.fetch(
        new Request(`https://w.dev/update-message?id=${uuid}`, {
          method: 'PUT', headers: ENC_HEADERS, body: await encBody(updates),
        }),
        env
      );
    }

    // 整体替换成新引用。
    const ok = await putUpdate({ credRefs: { chat: 'char:c1/chat-v2' } });
    assert.equal(ok.status, 200);
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const row = await adapter.getTaskByUuid(uuid, USER);
    const stored = JSON.parse(await decryptFromStorage(row.encrypted_payload, userKey));
    assert.deepEqual(stored.credRefs, { chat: 'char:c1/chat-v2' });

    // 引用不存在 → 409 点名。
    const missing = await putUpdate({ credRefs: { chat: 'char:ghost/chat' } });
    assert.equal(missing.status, 409);
    assert.equal((await missing.json()).error.code, 'CREDENTIAL_NOT_FOUND');

    // 与内联混传 → 400。
    const mixed = await putUpdate({ credRefs: { chat: CRED_ID }, apiKey: 'sk-inline' });
    assert.equal(mixed.status, 400);
  });

  // 泄漏密钥轮换的场景：任务存了 credRefs.chat，客户端按「凭据刷新」用内联字段
  // PUT。fire 时解析以凭据表那行为准，内联只是表行缺失的兜底——这次更新落了库
  // 也不会生效。回 200 的话调用方以为轮换成功，永远不会去改真正生效的那份。
  test('任务已存 credRefs.chat：内联凭据刷新被拒（409），存量 payload 不动', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedCred(adapter);

    const created = await (await scheduleTask(worker, env, { credRefs: { chat: CRED_ID } })).json();
    const uuid = created.data.uuid;

    const res = await worker.fetch(
      new Request(`https://w.dev/update-message?id=${uuid}`, {
        method: 'PUT', headers: ENC_HEADERS,
        body: await encBody({ apiUrl: 'https://new.example.com/v1', apiKey: 'sk-rotated', primaryModel: 'm-new' }),
      }),
      env
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error.code, 'TASK_USES_CRED_REFS');
    assert.match(body.error.message, /llm-credentials/, '错误信息要把正确的轮换入口指出来');

    // 库里一个字没动：credRefs 还在，内联也没被塞进去。
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const row = await adapter.getTaskByUuid(uuid, USER);
    const stored = JSON.parse(await decryptFromStorage(row.encrypted_payload, userKey));
    assert.deepEqual(stored.credRefs, { chat: CRED_ID });
    assert.equal(stored.apiKey ?? null, null, '被拒的内联 Key 不能落库');
  });

  // 只有非 chat 引用的任务不在此列：fire 时的 chat 凭据用的就是内联那份，刷新
  // 它是真的生效。
  test('任务只有非 chat 的 credRefs：内联凭据刷新照常 200', async () => {
    const { adapter, worker, env } = await freshWorker();
    await seedCred(adapter, 'char:c1/emotion');

    const created = await (await scheduleTask(worker, env, {
      credRefs: { emotion: 'char:c1/emotion' },
      apiUrl: 'https://old.example.com/v1', apiKey: 'sk-old', primaryModel: 'm-old',
    })).json();
    const uuid = created.data.uuid;

    const res = await worker.fetch(
      new Request(`https://w.dev/update-message?id=${uuid}`, {
        method: 'PUT', headers: ENC_HEADERS,
        body: await encBody({ apiKey: 'sk-rotated' }),
      }),
      env
    );
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));

    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const row = await adapter.getTaskByUuid(uuid, USER);
    const stored = JSON.parse(await decryptFromStorage(row.encrypted_payload, userKey));
    assert.equal(stored.apiKey, 'sk-rotated');
  });
});

describe('schema 一致性', () => {
  test('examples/schema.sql 的 llm_credentials 与代码里的建表语句列一致', async () => {
    const sql = await readFile(
      fileURLToPath(new URL('../examples/cloudflare-single-user/schema.sql', import.meta.url)),
      'utf8'
    );
    const match = /CREATE TABLE IF NOT EXISTS llm_credentials \(([^;]+)\);/.exec(sql);
    assert.ok(match, 'examples/schema.sql 应有 llm_credentials 建表语句');
    // 按括号深度切顶层逗号（PRIMARY KEY (a, b) 里的逗号不算），滤掉表级约束行
    // ——与 schema.sqlite.js 的 parseColumnNames 同一套切法。
    const parts = [];
    let depth = 0;
    let current = '';
    for (const ch of match[1]) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
      current += ch;
    }
    parts.push(current);
    const columns = parts
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)$/i.test(name));
    assert.deepEqual(columns, SQLITE_REQUIRED_SCHEMA.tables.llm_credentials);
  });
});
