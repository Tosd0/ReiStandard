# amsg-server 单用户/Cloudflare「满血后台消息」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让单用户 / Cloudflare 部署的 worker 在定时任务触发时，能现场组装 prompt 并在服务端跑多轮工具循环（onBeforeFire / onLLMOutput / executeToolCalls hooks + `client_state` 状态表），不配 hooks 的既有部署行为逐字节不变。

**Architecture:** ① hook 契约的纯函数部分（SessionContext 构建、decision 校验、toolCalls 提取）下沉到零依赖的 `@rei-standard/amsg-shared`，`amsg-instant` 改为从 shared 复用同一实现（消灭现有 "keep in sync" 手工同步）；② server 新增 `lib/agentic-fire.js` 驱动服务端循环（推送/工具执行路径与 instant 不同，循环本身不共享）；③ `client_state` 表只进 SQLite/D1 schema（单用户专用），端点只挂在单用户路由上，Netlify 多租户路径零改动。

**Tech Stack:** Node 20 `node:test` + better-sqlite3 D1 shim；tsup 构建；changesets（pre 模式 `next` tag）；纯 Web Crypto（红线：新代码禁 `node:` 内置）。

**关键契约事实（与交接 prompt 的差异，已按实际代码修正）：**

- amsg-instant 实际的 decision 联合是 **4 种**：`finish` / `tool-request` / `continue` / `skip-push`，且 instant 的 `tool-request` 带的是 `pushPayloads`（toolCalls 藏在 tool_request push 里），不是交接 prompt 写的 `{ decision: 'tool-request', toolCalls }`。
- 本次 server 端两种形状**都接受**：`{ decision:'tool-request', toolCalls }`（交接 prompt 的服务端形状）和 `{ decision:'tool-request', pushPayloads:[toolRequestPush] }`（instant classifier 原样复用）。校验器用 `inlineToolCalls: true` 选项区分 flavor。
- server 端额外支持 `continue`（nextHistory），使 instant classifier 可以真正原样复用。
- SessionContext 实际含 `charId?`（可选），交接 prompt 漏了。
- server 无 outbound log 表；「写 outbound log」按现状语义落实为 processSingleMessage 返回值携带 `{ status, iterations, messagesSent }` 并进 run-tick summary（不新增表）。
- 任务字段里没有 `promptHint` / `charId` 列——宿主自定义字段走 `metadata` 透传，文档中说明。

---

## File Structure

| 包 | 文件 | 动作 | 职责 |
|---|---|---|---|
| shared | `shared/src/index.js` | 修改（追加） | `buildSessionContext` / `extractAssistantMessage` / `assertValidDecision(decision, {inlineToolCalls})` / `extractToolCallsFromDecision`（shared 是单文件包，遵循现状追加，不拆文件） |
| shared | `shared/test/agentic-contract.test.mjs` | 新建 | 上述四个函数的单测 |
| instant | `instant/src/session-context.js` | 修改 | 保留 typedef JSDoc，函数体改为 re-export from shared |
| instant | `instant/src/message-processor.js` | 修改 | 删本地 `assertValidDecision`/`VALID_DECISIONS`，改 import shared |
| server | `server/src/server/adapters/schema.sqlite.js` | 修改 | 追加 `CLIENT_STATE_TABLE_SQL` |
| server | `server/src/server/adapters/d1.js` | 修改 | initSchema/dropSchema 覆盖 client_state；新增 `upsertClientState` / `getClientState` / `clearClientState` |
| server | `server/src/server/adapters/interface.js` | 修改 | DbAdapter typedef 增加三个可选方法 |
| server | `server/src/server/handlers/client-state.js` | 新建 | PUT/GET/DELETE 三端点 |
| server | `server/src/server/single-user.js` | 修改 | 挂载 clientState handler；ctx 透传 hooks/maxToolIterations/totalTimeoutMs |
| server | `server/src/server/cloudflare/single-user-worker.js` | 修改 | 路由表 +3 条；scheduled() 把 hooks/上限传进 tick ctx；工厂 JSDoc |
| server | `server/src/server/lib/llm.js` | 新建 | 从 message-processor 移出 `callLlm`（原 `_callAI`，加 `requireContent` 选项）、`buildAiRequestBody`、`normalizeAiApiUrl` |
| server | `server/src/server/lib/message-processor.js` | 修改 | 改用 llm.js；插入 agentic 分支；re-export `normalizeAiApiUrl` 保持兼容 |
| server | `server/src/server/lib/agentic-fire.js` | 新建 | `runAgenticFire` 循环 + `taskNeedsLlm` |
| server | `server/test/client-state.test.mjs` | 新建 | 端点 + adapter 测试 |
| server | `server/test/agentic-fire.test.mjs` | 新建 | 循环全部行为 + 凭据隐藏 + 老链路回退 |
| server | `server/test/message-processor.test.mjs` | 修改 | 老链路回归守卫（防有人删老链路） |
| server | `server/test/single-user-worker.test.mjs` | 修改 | serverToken 401 全端点测试补 client-state 三条 |
| server | `server/examples/cloudflare-single-user/README.md` | 修改 | 端点表 + hooks「这是啥/啥时候用」段 |
| root | `.changeset/amsg-shared-agentic-contract.md`、`.changeset/amsg-server-agentic-fire.md` | 新建 | shared minor + instant patch；server minor |

红线自查项（每个 task 收尾都要过一遍）：新代码无 `node:` import、无 Buffer；无下游业务词（SullyOS 等）；hook ctx 无 apiKey/pushSubscription/vapid/masterKey。

---

### Task 1: shared — agentic 契约纯函数 + 测试

**Files:**
- Modify: `packages/rei-standard-amsg/shared/src/index.js`（文件末尾追加）
- Test: `packages/rei-standard-amsg/shared/test/agentic-contract.test.mjs`

- [ ] **Step 1.1: 写失败测试** `shared/test/agentic-contract.test.mjs`：

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionContext,
  extractAssistantMessage,
  assertValidDecision,
  extractToolCallsFromDecision,
} from '../src/index.js';

describe('buildSessionContext', () => {
  const args = {
    sessionId: 's1', messages: [{ role: 'user', content: 'hi' }],
    llmResponse: { choices: [{ message: { role: 'assistant', content: 'yo' } }] },
    iteration: 0, contactName: 'Rei',
  };

  test('shape + frozen + no credentials', () => {
    const ctx = buildSessionContext(args);
    assert.equal(ctx.sessionId, 's1');
    assert.equal(ctx.llmOutputText, 'yo');
    assert.equal(ctx.iteration, 0);
    assert.deepEqual(ctx.metadata, {});
    assert.ok(Object.isFrozen(ctx));
    for (const k of ['apiKey', 'apiUrl', 'pushSubscription', 'vapid', 'masterKey']) {
      assert.equal(k in ctx, false, `${k} must not be on ctx`);
    }
  });

  test('llmOutputText is "" for pure tool-call responses', () => {
    const ctx = buildSessionContext({ ...args, llmResponse: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] } }] } });
    assert.equal(ctx.llmOutputText, '');
  });
});

describe('extractAssistantMessage', () => {
  test('keeps the whole message object (tool_calls survive)', () => {
    const msg = { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'f', arguments: '{}' } }] };
    assert.equal(extractAssistantMessage({ choices: [{ message: msg }] }), msg);
  });
  test('malformed response → placeholder', () => {
    assert.deepEqual(extractAssistantMessage(null), { role: 'assistant', content: '' });
    assert.deepEqual(extractAssistantMessage({ choices: [] }), { role: 'assistant', content: '' });
  });
});

describe('assertValidDecision (instant flavor, default options)', () => {
  test('accepts the four valid tags', () => {
    assertValidDecision({ decision: 'finish', pushPayloads: [{ message: 'x' }] });
    assertValidDecision({ decision: 'tool-request', pushPayloads: [{ toolCalls: [{ id: 't' }] }] });
    assertValidDecision({ decision: 'continue', nextHistory: [] });
    assertValidDecision({ decision: 'skip-push' });
  });
  test('rejects null / unknown tag / singular pushPayload', () => {
    assert.throws(() => assertValidDecision(null), /invalid decision/);
    assert.throws(() => assertValidDecision({ decision: 'idk' }), /invalid decision tag/);
    assert.throws(() => assertValidDecision({ decision: 'finish', pushPayload: {} }), /pushPayload \(singular\) is removed in 0\.8\.0/);
  });
  test('finish/tool-request require non-empty pushPayloads; entries validated', () => {
    assert.throws(() => assertValidDecision({ decision: 'finish' }), /requires a pushPayloads array/);
    assert.throws(() => assertValidDecision({ decision: 'finish', pushPayloads: [] }), /skip-push/);
    assert.throws(() => assertValidDecision({ decision: 'finish', pushPayloads: [{ splitPattern: 'x' }] }), /splitPattern is removed/);
    assert.throws(() => assertValidDecision({ decision: 'finish', pushPayloads: [{ messageId: '' }] }), /messageId/);
    // instant flavor不吃 inline toolCalls：
    assert.throws(() => assertValidDecision({ decision: 'tool-request', toolCalls: [{ id: 't' }] }), /requires a pushPayloads array/);
  });
  test('continue requires nextHistory array', () => {
    assert.throws(() => assertValidDecision({ decision: 'continue' }), /nextHistory/);
  });
});

describe('assertValidDecision ({ inlineToolCalls: true }, server flavor)', () => {
  test('tool-request with inline toolCalls and no pushPayloads is valid', () => {
    assertValidDecision({ decision: 'tool-request', toolCalls: [{ id: 't1' }] }, { inlineToolCalls: true });
  });
  test('inline toolCalls must be a non-empty array of objects', () => {
    assert.throws(() => assertValidDecision({ decision: 'tool-request', toolCalls: [] }, { inlineToolCalls: true }), /non-empty/);
    assert.throws(() => assertValidDecision({ decision: 'tool-request', toolCalls: ['x'] }, { inlineToolCalls: true }), /plain object/);
  });
  test('tool-request with pushPayloads still valid (instant classifier reuse)', () => {
    assertValidDecision({ decision: 'tool-request', pushPayloads: [{ toolCalls: [{ id: 't' }] }] }, { inlineToolCalls: true });
  });
  test('tool-request with neither toolCalls nor pushPayloads → error', () => {
    assert.throws(() => assertValidDecision({ decision: 'tool-request' }, { inlineToolCalls: true }), /requires a pushPayloads array/);
  });
});

describe('extractToolCallsFromDecision', () => {
  test('prefers decision.toolCalls', () => {
    const tc = [{ id: 't1' }];
    assert.equal(extractToolCallsFromDecision({ decision: 'tool-request', toolCalls: tc }), tc);
  });
  test('falls back to flattening pushPayloads[].toolCalls', () => {
    const out = extractToolCallsFromDecision({
      decision: 'tool-request',
      pushPayloads: [{ toolCalls: [{ id: 'a' }] }, { message: 'no tools here' }, { toolCalls: [{ id: 'b' }] }],
    });
    assert.deepEqual(out.map((t) => t.id), ['a', 'b']);
  });
  test('nothing extractable → []', () => {
    assert.deepEqual(extractToolCallsFromDecision({ decision: 'finish', pushPayloads: [{}] }), []);
    assert.deepEqual(extractToolCallsFromDecision(null), []);
  });
});
```

- [ ] **Step 1.2: 跑测试确认失败**：`npm test -w @rei-standard/amsg-shared` → 期望 import 报错（无这些导出）。
- [ ] **Step 1.3: 实现**——`shared/src/index.js` 末尾追加（错误信息与 instant 现有实现逐字节一致，port 时以 `instant/src/message-processor.js:696-758` 与 `instant/src/session-context.js` 为准）：

```js
// ─── Agentic-loop hook contract ──────────────────────────────────────────────
// Shared by @rei-standard/amsg-instant (client-executed tools via
// /continue) and @rei-standard/amsg-server (server-executed tools at
// fire time). Single source of truth so the two packages' onLLMOutput
// contracts cannot drift.

/**
 * @typedef {Object} ChatMessage
 * @property {'system' | 'user' | 'assistant' | 'tool'} role
 * @property {string | unknown[] | null} [content]
 * @property {Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>} [tool_calls]
 * @property {string} [tool_call_id]
 * @property {string} [name]
 */

/**
 * @typedef {Object} SessionContext
 * @property {string}                   sessionId
 * @property {string}                   [charId]
 * @property {ChatMessage[]}            messages       - Including the just-appended assistant turn.
 * @property {unknown}                  llmResponse    - Full LLM response (choices, usage, …).
 * @property {string}                   llmOutputText  - May be '' for pure tool-call responses.
 * @property {number}                   iteration      - 0-indexed: the round that just finished.
 * @property {Record<string, unknown>}  metadata
 * @property {string}                   contactName
 * @property {string}                   [avatarUrl]
 */

/**
 * Build the frozen SessionContext handed to onLLMOutput. Credentials
 * (apiKey / apiUrl / pushSubscription / vapid / masterKey) are
 * intentionally NOT part of the shape: a console.log(ctx) from a hook
 * must not leak keys, and a third-party hook must not be able to
 * exfiltrate them. Frozen so a hook cannot mutate the live history.
 */
export function buildSessionContext({ sessionId, messages, llmResponse, iteration, contactName, avatarUrl, charId, metadata }) {
  const llmOutputText = readLlmOutputText(llmResponse);
  const ctx = {
    sessionId,
    charId,
    messages,
    llmResponse,
    llmOutputText,
    iteration,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    contactName,
    avatarUrl: avatarUrl || undefined,
  };
  return Object.freeze(ctx);
}

function readLlmOutputText(llmResponse) {
  if (!llmResponse || typeof llmResponse !== 'object') return '';
  const choices = llmResponse.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const content = choices[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * Extract choices[0].message whole — tool_calls / reasoning_content /
 * refusal survive into the next round. Malformed response → minimal
 * placeholder so the hook still reacts via llmOutputText === ''.
 * @returns {ChatMessage}
 */
export function extractAssistantMessage(llmResponse) {
  const message =
    llmResponse && typeof llmResponse === 'object' &&
    Array.isArray(llmResponse.choices) && llmResponse.choices[0]?.message;
  if (message && typeof message === 'object') return message;
  return { role: 'assistant', content: '' };
}

const VALID_DECISIONS = new Set(['finish', 'tool-request', 'continue', 'skip-push']);

/**
 * Assert the hook returned a structurally valid decision.
 *
 * Flavors:
 * - default (amsg-instant): 'tool-request' must carry pushPayloads —
 *   the tool_request push goes to the client, which executes and
 *   POSTs /continue.
 * - { inlineToolCalls: true } (amsg-server fire-time loop): the host
 *   executes tools in-process, so 'tool-request' may instead carry a
 *   non-empty `toolCalls` array directly; pushPayloads then optional.
 *   pushPayloads-shaped tool-requests stay valid so a classifier
 *   written for instant drops in unchanged.
 *
 * @param {unknown} decision
 * @param {{ inlineToolCalls?: boolean }} [options]
 */
export function assertValidDecision(decision, options = {}) {
  const inlineToolCalls = options.inlineToolCalls === true;

  if (!decision || typeof decision !== 'object') {
    throw new TypeError(`onLLMOutput returned invalid decision: ${stringifyDecisionForError(decision)}`);
  }
  const tag = decision.decision;
  if (typeof tag !== 'string' || !VALID_DECISIONS.has(tag)) {
    throw new TypeError(`onLLMOutput returned invalid decision tag: ${stringifyDecisionForError(tag)}`);
  }

  const hasSingular = Object.prototype.hasOwnProperty.call(decision, 'pushPayload');
  const hasPlural = Object.prototype.hasOwnProperty.call(decision, 'pushPayloads');

  if (hasSingular) {
    throw new TypeError(
      hasPlural
        ? 'pushPayload (singular) is removed in 0.8.0, use pushPayloads'
        : 'pushPayload (singular) is removed in 0.8.0, use pushPayloads: [yourPayload]'
    );
  }

  if (tag === 'continue') {
    if (!Array.isArray(decision.nextHistory)) {
      throw new TypeError('decision:"continue" requires a nextHistory array');
    }
    return;
  }

  if (tag === 'skip-push') return;

  if (tag === 'tool-request' && inlineToolCalls && Object.prototype.hasOwnProperty.call(decision, 'toolCalls')) {
    const toolCalls = decision.toolCalls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      throw new TypeError('decision:"tool-request" toolCalls must be a non-empty array when set');
    }
    for (let i = 0; i < toolCalls.length; i++) {
      const t = toolCalls[i];
      if (!t || typeof t !== 'object' || Array.isArray(t)) {
        throw new TypeError(`toolCalls[${i}] must be a plain object, got ${stringifyDecisionForError(t)}`);
      }
    }
    if (!hasPlural) return;
    // pushPayloads also present → validate them below too.
  }

  if (!hasPlural || !Array.isArray(decision.pushPayloads)) {
    throw new TypeError(`decision:"${tag}" requires a pushPayloads array`);
  }
  const pushes = decision.pushPayloads;
  if (pushes.length === 0) {
    throw new TypeError('pushPayloads: [] — use decision: skip-push to skip notification entirely');
  }
  for (let i = 0; i < pushes.length; i++) {
    const p = pushes[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new TypeError(`pushPayloads[${i}] must be a plain object, got ${stringifyDecisionForError(p)}`);
    }
    if (Object.prototype.hasOwnProperty.call(p, 'splitPattern')) {
      throw new TypeError(`pushPayloads[${i}].splitPattern is removed in 0.8.0; caller is responsible for splitting`);
    }
    if (Object.prototype.hasOwnProperty.call(p, 'messageId')) {
      const id = p.messageId;
      if (typeof id !== 'string' || id === '') {
        throw new TypeError(`pushPayloads[${i}].messageId must be a non-empty string when set, got ${stringifyDecisionForError(id)}`);
      }
    }
  }
}

/**
 * Pull the toolCalls out of a 'tool-request' decision, whichever shape
 * it came in: `decision.toolCalls` directly (server flavor), or
 * embedded in tool_request pushPayloads (instant classifier flavor).
 * @returns {Array<Record<string, unknown>>}
 */
export function extractToolCallsFromDecision(decision) {
  if (!decision || typeof decision !== 'object') return [];
  if (Array.isArray(decision.toolCalls) && decision.toolCalls.length > 0) {
    return decision.toolCalls;
  }
  if (!Array.isArray(decision.pushPayloads)) return [];
  const out = [];
  for (const push of decision.pushPayloads) {
    if (push && typeof push === 'object' && Array.isArray(push.toolCalls)) {
      out.push(...push.toolCalls);
    }
  }
  return out;
}

function stringifyDecisionForError(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
```

注意：shared/src/index.js 里如已有同名私有 helper（如 `stringifyForError`），复用之、删掉重复定义。
- [ ] **Step 1.4: 跑测试确认通过**：`npm test -w @rei-standard/amsg-shared` → PASS。
- [ ] **Step 1.5: 构建 shared**（后续包的测试解析 shared 走 dist）：`npm run build -w @rei-standard/amsg-shared` → exit 0。
- [ ] **Step 1.6: Commit**：`git add packages/rei-standard-amsg/shared && git commit -m "feat(amsg-shared): 新增 agentic 循环契约工具（SessionContext/decision 校验/toolCalls 提取）"`

### Task 2: instant — 改为复用 shared 实现（行为不变）

**Files:**
- Modify: `packages/rei-standard-amsg/instant/src/session-context.js`
- Modify: `packages/rei-standard-amsg/instant/src/message-processor.js`

- [ ] **Step 2.1**: `instant/src/session-context.js` — 保留文件头注释与 `@typedef ChatMessage` / `@typedef SessionContext` JSDoc 块（index.js:108 的 `import('./session-context.js').SessionContext` 类型引用依赖它们），把 `buildSessionContext`、`readLlmOutputText`、`extractAssistantMessage` 三个函数实现整体删除，替换为：

```js
// Implementation moved to @rei-standard/amsg-shared so amsg-server's
// fire-time loop shares the exact same contract. Typedefs stay here for
// the package's own d.ts generation.
export { buildSessionContext, extractAssistantMessage } from '@rei-standard/amsg-shared';
```

- [ ] **Step 2.2**: `instant/src/message-processor.js` — 删除本地 `VALID_DECISIONS` 常量（约 line 45）、`assertValidDecision` 函数（约 line 696-750）；`stringifyForError` 若仅被 assertValidDecision 使用也一并删（先 grep 确认无其他调用点）；在顶部 `@rei-standard/amsg-shared` import 块中加入 `assertValidDecision`。
- [ ] **Step 2.3**: 跑 instant 全套测试：`npm test -w @rei-standard/amsg-instant` → 全 PASS（agentic-loop.test.mjs / pushpayloads-array.test.mjs 断言的错误消息由 shared 的逐字 port 保证）。再 `npm run build -w @rei-standard/amsg-instant` 确认 dts 构建不炸。
- [ ] **Step 2.4: Commit**：`git commit -am "refactor(amsg-instant): SessionContext 与 decision 校验改为复用 amsg-shared 同一实现"`

### Task 3: server — client_state 表 + D1 adapter 方法

**Files:**
- Modify: `server/src/server/adapters/schema.sqlite.js`、`server/src/server/adapters/d1.js`、`server/src/server/adapters/interface.js`
- Test: `server/test/client-state.test.mjs`（adapter 部分）

- [ ] **Step 3.1: 失败测试**（`server/test/client-state.test.mjs` 先写 adapter 段）：

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';

describe('D1 adapter client_state', () => {
  test('initSchema creates client_state; upsert is last-write-wins on updatedAt', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();

    let r = await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'k1', value: 'enc-v1', updatedAt: 100 },
      { namespace: 'notes', key: 'k2', value: 'enc-v2', updatedAt: 100 },
    ]);
    assert.deepEqual(r, { upserted: 2, skipped: 0 });

    // 旧于库内 → 跳过；≥ 库内 → 覆盖
    r = await adapter.upsertClientState(USER, [
      { namespace: 'notes', key: 'k1', value: 'enc-old', updatedAt: 50 },
      { namespace: 'notes', key: 'k2', value: 'enc-new', updatedAt: 200 },
    ]);
    assert.deepEqual(r, { upserted: 1, skipped: 1 });

    const rows = await adapter.getClientState(USER, 'notes');
    assert.deepEqual(
      rows.map((x) => [x.key, x.value, x.updated_at]),
      [['k1', 'enc-v1', 100], ['k2', 'enc-new', 200]]
    );
    // namespace 隔离
    assert.deepEqual(await adapter.getClientState(USER, 'other'), []);
  });

  test('clearClientState wipes only that user', async () => {
    const adapter = createD1Adapter(createTestD1());
    await adapter.initSchema();
    const OTHER = '660e8400-e29b-41d4-a716-446655440000';
    await adapter.upsertClientState(USER, [{ namespace: 'n', key: 'k', value: 'v', updatedAt: 1 }]);
    await adapter.upsertClientState(OTHER, [{ namespace: 'n', key: 'k', value: 'v', updatedAt: 1 }]);
    assert.equal(await adapter.clearClientState(USER), 1);
    assert.deepEqual(await adapter.getClientState(USER, 'n'), []);
    assert.equal((await adapter.getClientState(OTHER, 'n')).length, 1);
  });
});
```

- [ ] **Step 3.2**: 跑 `npm test -w @rei-standard/amsg-server -- test/client-state.test.mjs`（或 `node --test test/client-state.test.mjs`）→ 期望 FAIL（方法不存在）。
- [ ] **Step 3.3: 实现** — `schema.sqlite.js` 末尾追加：

```js
// client_state: cloud mirror of client-side state for the single-user
// deployment. One live copy per (user, namespace, key) — not per-task
// snapshots. The client is the only writer (batch upsert, last-write-wins
// on updated_at); fire-time hooks are the reader. `value` holds
// encryptForStorage ciphertext. `updated_at` is a caller-supplied epoch-ms
// INTEGER (unlike scheduled_messages' ISO TEXT) so conflict resolution
// compares without parsing. Single-user/SQLite only — no Postgres mirror.
export const CLIENT_STATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS client_state (
    user_id TEXT NOT NULL,
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, namespace, key)
  )
`;
```

`d1.js`：import 加 `CLIENT_STATE_TABLE_SQL`；`initSchema()` 里 `await this._db.prepare(SQLITE_TABLE_SQL).run();` 之后加 `await this._db.prepare(CLIENT_STATE_TABLE_SQL).run();`（返回值形状不动）；`dropSchema()` 加 `await this._db.prepare('DROP TABLE IF EXISTS client_state').run();`；类末尾（`getTaskStatus` 之后）加：

```js
  // ── client_state (single-user cloud state mirror) ──────────────────────

  /**
   * Batch upsert. Last-write-wins per (namespace, key): an entry older
   * than the stored row (updatedAt strictly lower) is skipped; equal or
   * newer overwrites. Values arrive pre-encrypted (handler encrypts).
   * @param {string} userId
   * @param {Array<{ namespace: string, key: string, value: string, updatedAt: number }>} entries
   * @returns {Promise<{ upserted: number, skipped: number }>}
   */
  async upsertClientState(userId, entries) {
    let upserted = 0;
    let skipped = 0;
    for (const entry of entries) {
      const res = await this._db.prepare(
        `INSERT INTO client_state (user_id, namespace, key, value, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, namespace, key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= client_state.updated_at`
      ).bind(userId, entry.namespace, entry.key, entry.value, entry.updatedAt).run();
      if (res.meta.changes > 0) upserted++; else skipped++;
    }
    return { upserted, skipped };
  }

  /**
   * All entries of one namespace (values still encrypted).
   * @returns {Promise<Array<{ namespace: string, key: string, value: string, updated_at: number }>>}
   */
  async getClientState(userId, namespace) {
    const res = await this._db.prepare(
      `SELECT namespace, key, value, updated_at
       FROM client_state
       WHERE user_id = ? AND namespace = ?
       ORDER BY key ASC`
    ).bind(userId, namespace).all();
    return res.results || [];
  }

  /** Wipe every entry of this user. @returns {Promise<number>} rows deleted */
  async clearClientState(userId) {
    const res = await this._db.prepare('DELETE FROM client_state WHERE user_id = ?').bind(userId).run();
    return res.meta.changes || 0;
  }
```

`interface.js` DbAdapter typedef 末尾追加三个**可选**属性（pg/neon 不实现，Netlify 路径不受影响）：

```js
 * @property {(userId: string, entries: Array<{namespace: string, key: string, value: string, updatedAt: number}>) => Promise<{upserted: number, skipped: number}>} [upsertClientState]
 *   (optional; single-user/D1 only) Batch upsert of client state, last-write-wins on updatedAt.
 * @property {(userId: string, namespace: string) => Promise<Array<{namespace: string, key: string, value: string, updated_at: number}>>} [getClientState]
 *   (optional; single-user/D1 only) All entries of one namespace, values still encrypted.
 * @property {(userId: string) => Promise<number>} [clearClientState]
 *   (optional; single-user/D1 only) Delete every entry of this user; returns rows deleted.
```

- [ ] **Step 3.4**: 跑 Step 3.1 测试 → PASS。若 `schema-sqlite.test.mjs` / `d1-adapter.test.mjs` 有对表清单或 initSchema 返回值的钉死断言导致挂掉，按新事实更新那条断言（只允许这类调整，别的红了要查自己）。全量：`npm test -w @rei-standard/amsg-server`。
- [ ] **Step 3.5: Commit**：`git commit -am "feat(amsg): 单用户模式新增 client_state 状态表与 D1 读写方法"`

### Task 4: server — /client-state 三端点 + 路由

**Files:**
- Create: `server/src/server/handlers/client-state.js`
- Modify: `server/src/server/single-user.js`、`server/src/server/cloudflare/single-user-worker.js`
- Test: `server/test/client-state.test.mjs`（追加端点段）、`server/test/single-user-worker.test.mjs`（401 列表）

- [ ] **Step 4.1: 失败测试**（追加到 `client-state.test.mjs`）：

```js
import { createSingleUserCloudflareWorker } from '../src/server/cloudflare/single-user-worker.js';
import { deriveUserEncryptionKey, encryptPayload, decryptPayload } from '../src/server/lib/encryption.js';

const MASTER_KEY = 'a'.repeat(64);

function makeWorker(d1, extra = {}) {
  return createSingleUserCloudflareWorker((env) => ({
    db: createD1Adapter(env.DB),
    masterKey: MASTER_KEY,
    vapid: { email: 'mailto:x@example.com', publicKey: 'pub', privateKey: 'priv' },
    webpush: { async sendNotification() {} },
    ...extra,
  }));
}

const ENC_HEADERS = { 'X-User-Id': USER, 'X-Payload-Encrypted': 'true', 'X-Encryption-Version': '1' };

async function putState(worker, env, entries, headers = ENC_HEADERS) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const body = JSON.stringify(await encryptPayload({ entries }, userKey));
  return worker.fetch(new Request('https://w.dev/client-state', { method: 'PUT', headers, body }), env);
}

describe('/client-state endpoints', () => {
  test('PUT upsert → GET decrypted roundtrip → DELETE wipes', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const putRes = await putState(worker, env, [
      { namespace: 'notes', key: 'k1', value: JSON.stringify({ a: 1 }), updatedAt: 100 },
      { namespace: 'notes', key: 'k2', value: 'plain text', updatedAt: 100 },
    ]);
    assert.equal(putRes.status, 200);
    assert.deepEqual((await putRes.json()).data, { upserted: 2, skipped: 0 });

    // 再 PUT：一条旧的被跳过
    const putRes2 = await putState(worker, env, [
      { namespace: 'notes', key: 'k1', value: 'stale', updatedAt: 50 },
    ]);
    assert.deepEqual((await putRes2.json()).data, { upserted: 0, skipped: 1 });

    const getRes = await worker.fetch(new Request('https://w.dev/client-state?namespace=notes', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.encrypted, true);
    const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
    const data = await decryptPayload(getBody.data, userKey);
    assert.deepEqual(
      data.entries.map((e) => [e.namespace, e.key, e.value, e.updatedAt]),
      [['notes', 'k1', JSON.stringify({ a: 1 }), 100], ['notes', 'k2', 'plain text', 100]]
    );

    const delRes = await worker.fetch(new Request('https://w.dev/client-state', {
      method: 'DELETE', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(delRes.status, 200);
    assert.equal((await delRes.json()).data.deleted, 2);

    const getRes2 = await worker.fetch(new Request('https://w.dev/client-state?namespace=notes', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    const data2 = await decryptPayload((await getRes2.json()).data, userKey);
    assert.deepEqual(data2.entries, []);
  });

  test('value 超过 200KB → 413 且带明确错误码', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);
    const res = await putState(worker, env, [
      { namespace: 'n', key: 'big', value: 'x'.repeat(200 * 1024 + 1), updatedAt: 1 },
    ]);
    assert.equal(res.status, 413);
    assert.equal((await res.json()).error.code, 'STATE_VALUE_TOO_LARGE');
  });

  test('校验：entries 非数组/空 400；缺 namespace 参数 400；GET 存的是密文', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1);
    const env = { DB: d1 };
    await worker.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), env);

    const bad = await putState(worker, env, 'not-an-array');
    assert.equal(bad.status, 400);
    const empty = await putState(worker, env, []);
    assert.equal(empty.status, 400);

    const noNs = await worker.fetch(new Request('https://w.dev/client-state', {
      method: 'GET', headers: { 'X-User-Id': USER },
    }), env);
    assert.equal(noNs.status, 400);
    assert.equal((await noNs.json()).error.code, 'NAMESPACE_REQUIRED');

    // 落库的是 encryptForStorage 密文（不是明文）
    await putState(worker, env, [{ namespace: 'n', key: 'k', value: 'SECRET-PLAINTEXT', updatedAt: 1 }]);
    const adapter = createD1Adapter(d1);
    const raw = await adapter.getClientState(USER, 'n');
    assert.equal(raw.length, 1);
    assert.notEqual(raw[0].value, 'SECRET-PLAINTEXT');
    assert.match(raw[0].value, /^[0-9a-f]+:[0-9a-f]+:/); // iv:authTag:cipher 格式
  });

  test('PUT 未加密请求体 → 400 ENCRYPTION_REQUIRED；serverToken 配置后三端点未带 token 全 401', async () => {
    const d1 = createTestD1();
    const worker = makeWorker(d1, { serverToken: 's3cret' });
    const env = { DB: d1 };
    for (const [method, url] of [
      ['PUT', 'https://w.dev/client-state'],
      ['GET', 'https://w.dev/client-state?namespace=n'],
      ['DELETE', 'https://w.dev/client-state'],
    ]) {
      const res = await worker.fetch(new Request(url, { method, headers: { 'X-User-Id': USER } }), env);
      assert.equal(res.status, 401, `${method} 未带 token 必须 401`);
    }

    const worker2 = makeWorker(createTestD1());
    const env2 = { DB: worker2 && d1 }; // 用独立 d1
    const d1b = createTestD1();
    const worker3 = makeWorker(d1b);
    await worker3.fetch(new Request('https://w.dev/init-tenant', { method: 'POST' }), { DB: d1b });
    const plain = await worker3.fetch(new Request('https://w.dev/client-state', {
      method: 'PUT', headers: { 'X-User-Id': USER }, body: JSON.stringify({ entries: [] }),
    }), { DB: d1b });
    assert.equal(plain.status, 400);
    assert.equal((await plain.json()).error.code, 'ENCRYPTION_REQUIRED');
  });
});
```

（最后一个测试里 `worker2/env2` 两行是笔误示例——实现时直接删掉，用 `worker3/d1b` 那段即可。）
- [ ] **Step 4.2**: 跑该文件 → 期望端点段 FAIL（404）。
- [ ] **Step 4.3: 实现 handler** `server/src/server/handlers/client-state.js`（完整新文件）：

```js
/**
 * Handler: client-state
 *
 * Cloud mirror of client-side state for the single-user deployment. The
 * client batch-syncs entries up (PUT) whenever convenient — e.g. in the
 * few-seconds window before iOS backgrounds the page — and fire-time
 * hooks read them back via ctx.readState(namespace). One live copy per
 * (user, namespace, key); the client is the only writer.
 *
 *   PUT    /client-state                 batch upsert, last-write-wins on updatedAt
 *   GET    /client-state?namespace=<ns>  one namespace's entries (decrypted, response re-encrypted)
 *   DELETE /client-state                 wipe every entry of this user
 *
 * Auth & crypto follow the existing endpoints exactly: X-Client-Token is
 * all-or-nothing via resolveTenant, PUT bodies must be encrypted
 * (X-Payload-Encrypted / X-Encryption-Version), values are stored as
 * encryptForStorage ciphertext under the per-user key, and GET responses
 * ride the existing encrypted-response envelope.
 */

import { deriveUserEncryptionKey, decryptPayload, encryptPayload, encryptForStorage, decryptFromStorage } from '../lib/encryption.js';
import { getHeader, isPlainObject, parseEncryptedBody } from '../lib/request.js';
import { isValidUUIDv4 } from '../lib/validation.js';

// One value may hold a serialized state chunk, but must stay well under
// D1's per-row limits — reject early with a clear error instead of an
// opaque DB failure.
export const MAX_STATE_VALUE_BYTES = 200 * 1024;
// "a few dozen entries in one background-window request" is the design
// load; 200 bounds a single request with generous headroom.
export const MAX_STATE_ENTRIES_PER_REQUEST = 200;
const MAX_NAMESPACE_CHARS = 128;
const MAX_KEY_CHARS = 256;

const utf8 = new TextEncoder();

function err(status, code, message, details) {
  const error = details === undefined ? { code, message } : { code, message, details };
  return { status, body: { success: false, error } };
}

function requireUserId(headers) {
  const userId = getHeader(headers, 'x-user-id');
  if (!userId) return { error: err(400, 'USER_ID_REQUIRED', '缺少用户标识符') };
  if (!isValidUUIDv4(userId)) return { error: err(400, 'INVALID_USER_ID_FORMAT', 'X-User-Id 必须是 UUID v4 格式') };
  return { userId };
}

function validateEntry(entry, index) {
  if (!isPlainObject(entry)) return err(400, 'INVALID_STATE_ENTRY', `entries[${index}] 必须是对象`);
  if (typeof entry.namespace !== 'string' || !entry.namespace.trim() || entry.namespace.length > MAX_NAMESPACE_CHARS) {
    return err(400, 'INVALID_STATE_NAMESPACE', `entries[${index}].namespace 必须是 1-${MAX_NAMESPACE_CHARS} 字符的字符串`);
  }
  if (typeof entry.key !== 'string' || !entry.key.trim() || entry.key.length > MAX_KEY_CHARS) {
    return err(400, 'INVALID_STATE_KEY', `entries[${index}].key 必须是 1-${MAX_KEY_CHARS} 字符的字符串`);
  }
  if (typeof entry.value !== 'string') {
    return err(400, 'INVALID_STATE_VALUE', `entries[${index}].value 必须是字符串（宿主自行序列化）`);
  }
  const bytes = utf8.encode(entry.value).length;
  if (bytes > MAX_STATE_VALUE_BYTES) {
    return err(413, 'STATE_VALUE_TOO_LARGE', `entries[${index}].value 超过单条上限`, { index, key: entry.key, bytes, maxBytes: MAX_STATE_VALUE_BYTES });
  }
  if (!Number.isInteger(entry.updatedAt) || entry.updatedAt <= 0) {
    return err(400, 'INVALID_STATE_UPDATED_AT', `entries[${index}].updatedAt 必须是正整数（epoch 毫秒）`);
  }
  return null;
}

export function createClientStateHandler(ctx) {
  async function PUT(headers, body) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers);
    if (!tenantResult.ok) return tenantResult.error;
    const { db, masterKey } = tenantResult.context;

    if (getHeader(headers, 'x-payload-encrypted') !== 'true') {
      return err(400, 'ENCRYPTION_REQUIRED', '请求体必须加密');
    }
    const gate = requireUserId(headers);
    if (gate.error) return gate.error;
    const { userId } = gate;
    if (getHeader(headers, 'x-encryption-version') !== '1') {
      return err(400, 'UNSUPPORTED_ENCRYPTION_VERSION', '加密版本不支持');
    }

    const parsedBody = parseEncryptedBody(body);
    if (!parsedBody.ok) return { status: 400, body: { success: false, error: parsedBody.error } };

    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    let payload;
    try {
      payload = await decryptPayload(parsedBody.data, userKey);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return err(400, 'INVALID_PAYLOAD_FORMAT', '解密后的数据不是有效 JSON');
      }
      return err(400, 'DECRYPTION_FAILED', '请求体解密失败');
    }
    if (!isPlainObject(payload)) return err(400, 'INVALID_PAYLOAD_FORMAT', '解密后的数据必须是 JSON 对象');

    const entries = payload.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      return err(400, 'INVALID_STATE_ENTRIES', 'entries 必须是非空数组');
    }
    if (entries.length > MAX_STATE_ENTRIES_PER_REQUEST) {
      return err(400, 'TOO_MANY_STATE_ENTRIES', `单次最多 ${MAX_STATE_ENTRIES_PER_REQUEST} 条`, { count: entries.length });
    }
    for (let i = 0; i < entries.length; i++) {
      const invalid = validateEntry(entries[i], i);
      if (invalid) return invalid;
    }

    if (typeof db.upsertClientState !== 'function') {
      return err(501, 'CLIENT_STATE_NOT_SUPPORTED', '当前数据库适配器不支持 client_state');
    }

    const encryptedEntries = await Promise.all(entries.map(async (entry) => ({
      namespace: entry.namespace,
      key: entry.key,
      value: await encryptForStorage(entry.value, userKey),
      updatedAt: entry.updatedAt,
    })));

    const { upserted, skipped } = await db.upsertClientState(userId, encryptedEntries);
    return { status: 200, body: { success: true, data: { upserted, skipped } } };
  }

  async function GET(url, headers) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers);
    if (!tenantResult.ok) return tenantResult.error;
    const { db, masterKey } = tenantResult.context;

    const gate = requireUserId(headers);
    if (gate.error) return gate.error;
    const { userId } = gate;

    const namespace = new URL(url, 'https://dummy').searchParams.get('namespace') || '';
    if (!namespace.trim()) return err(400, 'NAMESPACE_REQUIRED', '必须提供 namespace 查询参数');

    if (typeof db.getClientState !== 'function') {
      return err(501, 'CLIENT_STATE_NOT_SUPPORTED', '当前数据库适配器不支持 client_state');
    }

    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    const rows = await db.getClientState(userId, namespace);
    const decrypted = await Promise.all(rows.map(async (row) => ({
      namespace: row.namespace,
      key: row.key,
      value: await decryptFromStorage(row.value, userKey),
      updatedAt: row.updated_at,
    })));

    const encryptedResponse = await encryptPayload({ namespace, entries: decrypted }, userKey);
    return { status: 200, body: { success: true, encrypted: true, version: 1, data: encryptedResponse } };
  }

  async function DELETE(url, headers) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers);
    if (!tenantResult.ok) return tenantResult.error;
    const { db } = tenantResult.context;

    const gate = requireUserId(headers);
    if (gate.error) return gate.error;
    const { userId } = gate;

    if (typeof db.clearClientState !== 'function') {
      return err(501, 'CLIENT_STATE_NOT_SUPPORTED', '当前数据库适配器不支持 client_state');
    }

    const deleted = await db.clearClientState(userId);
    return { status: 200, body: { success: true, data: { deleted } } };
  }

  return { PUT, GET, DELETE };
}
```

- [ ] **Step 4.4: 挂载与路由**——`single-user.js` import `createClientStateHandler`，handlers 加 `clientState: createClientStateHandler(ctx)`；`single-user-worker.js` 路由表在 vapid-public-key 分支后追加：

```js
      } else if (method === 'PUT' && pathname.endsWith('/client-state')) {
        result = await server.handlers.clientState.PUT(headers, await request.text());
      } else if (method === 'GET' && pathname.endsWith('/client-state')) {
        result = await server.handlers.clientState.GET(url, headers);
      } else if (method === 'DELETE' && pathname.endsWith('/client-state')) {
        result = await server.handlers.clientState.DELETE(url, headers);
```

并把文件头注释的路由清单加上三条。`single-user-worker.test.mjs` 的 `serverToken set → every exposed route rejects…` 测试 `routes` 数组补：

```js
    ['PUT', 'https://w.dev/client-state'],
    ['GET', 'https://w.dev/client-state?namespace=n'],
    ['DELETE', 'https://w.dev/client-state']
```

- [ ] **Step 4.5**: 全量 server 测试 → PASS。
- [ ] **Step 4.6: Commit**：`git commit -am "feat(amsg): 单用户 worker 新增 /client-state 批量同步端点（PUT/GET/DELETE）"`

### Task 5: server — 抽出 lib/llm.js（callLlm 支持 requireContent）

**Files:**
- Create: `server/src/server/lib/llm.js`
- Modify: `server/src/server/lib/message-processor.js`

- [ ] **Step 5.1**: 新建 `lib/llm.js`，把 message-processor.js 的 `_callAI`（333-369 行）、`buildAiRequestBody`（381-415 行）、`normalizeAiApiUrl`（429-465 行）**原样移入**（连注释），仅两处改动：文件头注释 + `_callAI` 更名 `callLlm` 并加选项：

```js
/**
 * OpenAI-compatible LLM call for the server-side fire chain.
 * Extracted from message-processor.js so the agentic fire loop
 * (lib/agentic-fire.js) can call the LLM without a circular import.
 */

export async function callLlm(payload, options = {}) {
  // Tool rounds legitimately return no content (pure tool_calls), so the
  // agentic loop passes { requireContent: false } — same precedent as
  // amsg-instant's callLlmRaw. Default true keeps the legacy single-shot
  // path byte-identical.
  const requireContent = options.requireContent !== false;
  const normalizedApiUrl = normalizeAiApiUrl(payload.apiUrl);
  const requestBody = buildAiRequestBody(payload);

  const aiResponse = await fetch(normalizedApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${payload.apiKey}`
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(300000)
  });

  if (!aiResponse.ok) {
    if (aiResponse.status === 405) {
      throw new Error(
        `AI API error: 405 Method Not Allowed. ` +
        `apiUrl must point to a full chat endpoint (for example: /chat/completions). ` +
        `Received: ${normalizedApiUrl}`
      );
    }
    throw new Error(
      `AI API error: ${aiResponse.status} ${aiResponse.statusText || 'Unknown Error'}. ` +
      `Request URL: ${normalizedApiUrl}`
    );
  }

  const aiData = await aiResponse.json();
  const rawContent = aiData?.choices?.[0]?.message?.content;
  if (requireContent && (typeof rawContent !== 'string' || !rawContent.trim())) {
    throw new Error('AI API error: response missing choices[0].message.content');
  }
  return { response: aiData, content: typeof rawContent === 'string' ? rawContent.trim() : '' };
}
```

（`buildAiRequestBody` / `normalizeAiApiUrl` 保持 export，一字不改。）
- [ ] **Step 5.2**: message-processor.js 删除这三个函数，顶部加 `import { callLlm } from './llm.js';`，两处 `_callAI(decryptedPayload)` 调用改 `callLlm(decryptedPayload)`，文件末尾加兼容 re-export：`export { normalizeAiApiUrl } from './llm.js';`
- [ ] **Step 5.3**: 全量 server 测试 → PASS（message-processor.test.mjs 的 normalizeAiApiUrl 直接单测经 re-export 继续工作）。
- [ ] **Step 5.4: Commit**：`git commit -am "refactor(amsg): LLM 调用抽到 lib/llm.js，工具轮允许空 content"`

### Task 6: server — agentic fire 循环 + processSingleMessage 接入

**Files:**
- Create: `server/src/server/lib/agentic-fire.js`
- Modify: `server/src/server/lib/message-processor.js`
- Test: `server/test/agentic-fire.test.mjs`

- [ ] **Step 6.1: 失败测试** `server/test/agentic-fire.test.mjs`（通过 `processSingleMessage` 集成面测试；fetch 换桩模式抄 message-processor.test.mjs）：

测试清单（每条一个 `test()`，共用 helper）：

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { processSingleMessage } from '../src/server/lib/message-processor.js';
import { deriveUserEncryptionKey, encryptForStorage } from '../src/server/lib/encryption.js';
import { createTestD1 } from './helpers/sqlite-d1.mjs';
import { createD1Adapter } from '../src/server/adapters/d1.js';

const USER = '550e8400-e29b-41d4-a716-446655440000';
const MASTER_KEY = 'a'.repeat(64);

async function makeTask(payloadOverrides = {}) {
  const userKey = await deriveUserEncryptionKey(USER, MASTER_KEY);
  const payload = {
    contactName: 'Rei', messageType: 'auto', completePrompt: 'frozen prompt',
    apiUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'sk-secret',
    primaryModel: 'model-x', recurrenceType: 'daily',
    pushSubscription: { endpoint: 'https://push.example.com/sub', keys: { p256dh: 'k', auth: 'a' } },
    metadata: { charId: 'char-1' },
    ...payloadOverrides,
  };
  return {
    task: { id: 7, user_id: USER, uuid: 'u7', encrypted_payload: await encryptForStorage(JSON.stringify(payload), userKey), next_send_at: '2020-01-01T00:00:00.000Z', retry_count: 0 },
    payload,
  };
}

function makeCtx({ hooks, maxToolIterations, totalTimeoutMs, db, pushSpy } = {}) {
  return {
    masterKey: MASTER_KEY,
    webpush: { async sendNotification(sub, payload) { if (pushSpy) pushSpy(sub, payload); } },
    vapid: { email: 'v@example.com', publicKey: 'pub', privateKey: 'priv' },
    db: db || {},
    hooks: hooks || null,
    maxToolIterations,
    totalTimeoutMs,
    _agenticSleep: async () => {},   // 测试不真睡 1.5s
  };
}

// fetch 桩：按调用序返回脚本化 LLM 响应
function stubLlm(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return { ok: true, async json() { return r; } };
  };
  return { calls, restore() { globalThis.fetch = original; } };
}

const TOOL_CALL = { id: 'call_1', type: 'function', function: { name: 'lookup_notes', arguments: '{"q":"recent"}' } };
const toolRound = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [TOOL_CALL] } }] };
const finishRound = { choices: [{ message: { role: 'assistant', content: '最终回复' } }] };
```

1. **happy path（两轮，spec 测试 2）**：onBeforeFire 返回 `[{role:'system',content:'S'},{role:'user',content:'U'}]`；LLM 第 1 轮 `toolRound` → onLLMOutput 第 1 次返回 `{decision:'tool-request', toolCalls:[TOOL_CALL]}` → executeToolCalls 返回 `[{tool_call_id:'call_1', role:'tool', content:'{"notes":[]}'}]` → LLM 第 2 轮 `finishRound` → onLLMOutput 第 2 次返回 `{decision:'finish', pushPayloads:[{messageKind:'content',message:'A'},{messageKind:'content',message:'B'}]}`。断言：`result.success===true`、`result.status==='finished'`、`result.iterations===2`、`result.messagesSent===2`；LLM 第 1 轮请求 messages 就是 onBeforeFire 的返回（不是 frozen prompt）；第 2 轮请求 messages 末尾是 `assistant(tool_calls)` + tool result；推送 2 条且 JSON 解析后 `messageIndex`/`totalMessages` 被盖写为 1/2、2/2，`sessionId==='sess_task_7'`、messageId 自动补齐非空。
2. **instant classifier 形状复用**：onLLMOutput 第 1 次返回 `{decision:'tool-request', pushPayloads:[{messageKind:'tool_request', toolCalls:[TOOL_CALL]}]}`（不带顶层 toolCalls）→ executeToolCalls 收到 `[TOOL_CALL]`；且 tool_request push **没有**被 webpush 发送（pushSpy 只收到 finish 的推送）。
3. **maxToolIterations 工厂级上限（spec 测试 3 前半）**：LLM 永远 `toolRound`、onLLMOutput 永远 tool-request；`makeCtx({maxToolIterations:3})` → `result.success===false`、`/AGENTIC_LOOP_EXCEEDED/.test(result.error)`；LLM 调用 3 次、executeToolCalls 2 次（最后一轮短路不执行）。
4. **onBeforeFire 覆盖（spec 测试 3 后半）**：ctx maxToolIterations 5，onBeforeFire 返回 `{messages:[...], maxToolIterations:1}` → LLM 恰 1 次、executeToolCalls 0 次、LOOP_EXCEEDED。
5. **totalTimeoutMs**：ctx 加 `_agenticNow` 假时钟（fetch 桩每次调用把假时钟 +100_000ms），`totalTimeoutMs:250_000` → 第 3 轮前超时，`/AGENTIC_TOTAL_TIMEOUT/.test(result.error)`；onBeforeFire 返回 `{messages, totalTimeoutMs:150_000}` 时第 2 轮前就断。
6. **skip-push**：onLLMOutput 返回 `{decision:'skip-push'}` → `{success:true, status:'skipped', messagesSent:0}`、无推送。
7. **continue**：第 1 次返回 `{decision:'continue', nextHistory:[{role:'user',content:'重来'}]}` → 第 2 轮 LLM 请求 messages 等于 nextHistory；第 2 次 finish 正常收尾。
8. **executeToolCalls 抛错回填**：executeToolCalls 抛 `new Error('boom')` → 第 2 轮 LLM 请求里有 `{tool_call_id:'call_1', role:'tool', content:/Tool execution failed: boom/}`，链路不失败（第 2 轮 finish 成功）。
9. **凭据不泄露（spec 测试 5）**：捕获 onBeforeFire 的 `fireCtx` 与 onLLMOutput 的 `sessionCtx`，断言：`fireCtx.task` 无 `apiKey`/`pushSubscription`，`fireCtx` 无 `vapid`/`masterKey` 键；`sessionCtx` 的键集合 ⊆ `['sessionId','charId','messages','llmResponse','llmOutputText','iteration','metadata','contactName','avatarUrl']` 且无凭据键；两者都 `Object.isFrozen`。
10. **readState**：真 D1 —— `createD1Adapter(createTestD1())` + initSchema，预置 `upsertClientState(USER, [{namespace:'notes', key:'k', value: await encryptForStorage('hello', userKey), updatedAt: 1}])`；onBeforeFire 内 `await ctx.readState('notes')` → `[{namespace:'notes', key:'k', value:'hello', updatedAt:1}]`（已解密）。
11. **onBeforeFire 返回 null → 老链路**：LLM 恰 1 次且请求体 `messages === [{role:'user',content:'frozen prompt'}]`、`temperature===0.8`；onLLMOutput 从未被调。
12. **fixed 任务 + hooks → onBeforeFire 不被调**：`makeTask({messageType:'fixed', userMessage:'hi', apiUrl:null, apiKey:null, primaryModel:null})` → fetch 0 次、onBeforeFire 0 次、推送 1 条 'hi'。
13. **onBeforeFire 配了但 onLLMOutput 没配 → 失败**：`result.success===false`、`/AGENTIC_CONFIG_ERROR/.test(result.error)`。
14. **tool-request 但 executeToolCalls 没配 → 失败**：`/AGENTIC_CONFIG_ERROR/`。

- [ ] **Step 6.2**: 跑该文件 → FAIL（模块不存在）。
- [ ] **Step 6.3: 实现** `server/src/server/lib/agentic-fire.js`（完整新文件）：

```js
/**
 * Server-side agentic fire loop.
 *
 * When the host configures fire-time hooks, an LLM task stops replaying
 * the completePrompt frozen at schedule time. At fire time instead:
 *
 *   onBeforeFire(fireCtx) → fresh messages (may read client_state)
 *     → callLlm → onLLMOutput(sessionCtx) → decision
 *         ├─ 'finish'       → push decision.pushPayloads, done
 *         ├─ 'skip-push'    → record, done (task counts as delivered)
 *         ├─ 'continue'     → replace history, next round
 *         └─ 'tool-request' → executeToolCalls IN the worker — the client
 *                             is offline at fire time, so unlike
 *                             amsg-instant nothing is pushed back for the
 *                             client to execute — then append the
 *                             assistant turn + tool results, next round
 *
 * The decision contract is shared with @rei-standard/amsg-instant
 * (assertValidDecision / buildSessionContext live in
 * @rei-standard/amsg-shared), so a classifier written for instant's
 * onLLMOutput drops in unchanged: 'tool-request' may carry `toolCalls`
 * directly, or tool_request pushPayloads that embed them — both work.
 *
 * Credential hiding: hook ctx objects never contain apiKey /
 * pushSubscription / vapid / masterKey (same rationale as instant's
 * SessionContext).
 *
 * Budget guards, both factory-level (ctx) and per-fire (onBeforeFire
 * return value overrides): maxToolIterations caps LLM rounds;
 * totalTimeoutMs is a wall-time ceiling checked before each round so a
 * cron tick can never hang forever. Both exhaustions surface as ordinary
 * task failures → existing retry/mark-failed semantics apply.
 */

import {
  assertValidDecision,
  buildSessionContext,
  extractAssistantMessage,
  extractToolCallsFromDecision,
} from '@rei-standard/amsg-shared';
import { randomUUID } from './webcrypto-utils.js';
import { decryptFromStorage } from './encryption.js';
import { callLlm } from './llm.js';

export const DEFAULT_MAX_TOOL_ITERATIONS = 5;
export const DEFAULT_TOTAL_TIMEOUT_MS = 240_000;

// Same pacing as the legacy path / amsg-instant.
const SLEEP_BETWEEN_MESSAGES_MS = 1500;

// Task-payload fields that must never reach hook code.
const CREDENTIAL_PAYLOAD_KEYS = new Set(['apiKey', 'pushSubscription']);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Does this task need the LLM at fire time? Fixed text never does, so it
 * always stays on the legacy path regardless of hooks.
 */
export function taskNeedsLlm(decryptedPayload) {
  const type = decryptedPayload.messageType;
  if (type === 'prompted' || type === 'auto') return true;
  if (type === 'instant') {
    return !!(decryptedPayload.apiUrl && decryptedPayload.apiKey && decryptedPayload.primaryModel);
  }
  return false;
}

/** Frozen, credential-free view of the task for hook authors. */
function buildHookTask(task, decryptedPayload) {
  const safe = {};
  for (const [key, value] of Object.entries(decryptedPayload)) {
    if (!CREDENTIAL_PAYLOAD_KEYS.has(key)) safe[key] = value;
  }
  return Object.freeze({
    ...safe,
    id: task.id ?? null,
    uuid: task.uuid ?? null,
    nextSendAt: task.next_send_at ?? null,
    retryCount: task.retry_count ?? 0,
  });
}

function normalizeBeforeFireResult(result) {
  if (Array.isArray(result)) {
    return { messages: result };
  }
  if (result && typeof result === 'object' && Array.isArray(result.messages)) {
    return {
      messages: result.messages,
      maxToolIterations: result.maxToolIterations,
      totalTimeoutMs: result.totalTimeoutMs,
    };
  }
  throw new TypeError(
    'AGENTIC_BAD_BEFORE_FIRE: onBeforeFire must return ChatMessage[] | { messages, maxToolIterations?, totalTimeoutMs? } | null'
  );
}

function firstPositiveInt(values, fallback) {
  for (const v of values) {
    if (Number.isInteger(v) && v > 0) return v;
  }
  return fallback;
}

function firstPositiveNumber(values, fallback) {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  return fallback;
}

/**
 * Try the hook-driven fire path for one task.
 *
 * @param {Object} args
 * @param {import('../adapters/interface.js').TaskRow} args.task
 * @param {Object} args.decryptedPayload - already decrypted task payload (has credentials; they stop here)
 * @param {string} args.userKey - per-user storage key (for readState decryption)
 * @param {Object} args.ctx - processor ctx ({ db, webpush, vapid, hooks, maxToolIterations, totalTimeoutMs })
 * @returns {Promise<{ handled: false } | { handled: true, result: { success: true, messagesSent: number, status: 'finished'|'skipped', iterations: number } }>}
 *   `handled: false` → caller falls back to the legacy frozen-prompt path.
 *   Failures (timeout / loop exceeded / config errors) throw — the caller's
 *   existing error handling turns them into task retry/failure.
 */
export async function runAgenticFire({ task, decryptedPayload, userKey, ctx }) {
  const hooks = ctx.hooks;
  if (typeof hooks.onLLMOutput !== 'function') {
    throw new Error('AGENTIC_CONFIG_ERROR: hooks.onBeforeFire requires hooks.onLLMOutput to classify LLM rounds');
  }

  const nowFn = typeof ctx._agenticNow === 'function' ? ctx._agenticNow : Date.now;
  const sleep = typeof ctx._agenticSleep === 'function' ? ctx._agenticSleep : defaultSleep;

  const readState = async (namespace) => {
    if (typeof namespace !== 'string' || !namespace.trim()) {
      throw new TypeError('readState(namespace) requires a non-empty string');
    }
    if (!ctx.db || typeof ctx.db.getClientState !== 'function') return [];
    const rows = await ctx.db.getClientState(task.user_id, namespace);
    return Promise.all(rows.map(async (row) => ({
      namespace: row.namespace,
      key: row.key,
      value: await decryptFromStorage(row.value, userKey),
      updatedAt: row.updated_at,
    })));
  };

  const fireCtx = Object.freeze({
    task: buildHookTask(task, decryptedPayload),
    userId: task.user_id,
    readState,
    now: new Date(nowFn()),
  });

  const before = await hooks.onBeforeFire(fireCtx);
  if (before == null) return { handled: false };

  const normalized = normalizeBeforeFireResult(before);
  const maxToolIterations = firstPositiveInt(
    [normalized.maxToolIterations, ctx.maxToolIterations],
    DEFAULT_MAX_TOOL_ITERATIONS
  );
  const totalTimeoutMs = firstPositiveNumber(
    [normalized.totalTimeoutMs, ctx.totalTimeoutMs],
    DEFAULT_TOTAL_TIMEOUT_MS
  );
  const deadline = nowFn() + totalTimeoutMs;

  const sessionId = task.id != null ? `sess_task_${task.id}` : `sess_${randomUUID()}`;
  let messages = normalized.messages.slice();

  for (let iteration = 0; iteration < maxToolIterations; iteration++) {
    if (nowFn() >= deadline) {
      throw new Error(`AGENTIC_TOTAL_TIMEOUT: fire chain exceeded ${totalTimeoutMs}ms after ${iteration} LLM round(s)`);
    }

    const { response: llmResponse } = await callLlm(
      { ...decryptedPayload, messages },
      { requireContent: false }
    );

    const assistantMessage = extractAssistantMessage(llmResponse);
    messages = [...messages, assistantMessage];

    const sessionCtx = buildSessionContext({
      sessionId,
      messages,
      llmResponse,
      iteration,
      contactName: decryptedPayload.contactName,
      avatarUrl: decryptedPayload.avatarUrl || undefined,
      charId: decryptedPayload.charId,
      metadata: decryptedPayload.metadata,
    });

    const decision = await hooks.onLLMOutput(sessionCtx);
    assertValidDecision(decision, { inlineToolCalls: true });

    if (decision.decision === 'continue') {
      messages = decision.nextHistory.slice();
      continue;
    }

    if (decision.decision === 'skip-push') {
      return { handled: true, result: { success: true, messagesSent: 0, status: 'skipped', iterations: iteration + 1 } };
    }

    if (decision.decision === 'finish') {
      const messagesSent = await sendHookPushPayloads(decision.pushPayloads, decryptedPayload, ctx, sessionId, task, sleep);
      return { handled: true, result: { success: true, messagesSent, status: 'finished', iterations: iteration + 1 } };
    }

    // 'tool-request' — execute right here in the worker.
    const toolCalls = extractToolCallsFromDecision(decision);
    if (toolCalls.length === 0) {
      throw new Error('AGENTIC_EMPTY_TOOL_REQUEST: tool-request decision carried no toolCalls (neither decision.toolCalls nor pushPayloads[].toolCalls)');
    }
    if (typeof hooks.executeToolCalls !== 'function') {
      throw new Error('AGENTIC_CONFIG_ERROR: onLLMOutput returned tool-request but hooks.executeToolCalls is not configured');
    }
    if (iteration === maxToolIterations - 1) {
      // No LLM round left to consume the results — executing tools now
      // would only burn external calls. Fall straight to the exceeded error.
      break;
    }

    let toolResults;
    try {
      toolResults = await hooks.executeToolCalls(toolCalls, sessionCtx);
      if (!Array.isArray(toolResults)) {
        throw new TypeError('executeToolCalls must resolve to an array of { tool_call_id, role: "tool", content }');
      }
    } catch (error) {
      // Feed the failure back as tool results and let the LLM talk its way
      // out, instead of failing the whole fire.
      toolResults = toolCalls.map((toolCall) => ({
        tool_call_id: toolCall && typeof toolCall === 'object' && typeof toolCall.id === 'string' ? toolCall.id : '',
        role: 'tool',
        content: `Tool execution failed: ${error?.message ?? String(error)}`,
      }));
    }

    // Text-protocol classifiers synthesize toolCalls the raw assistant
    // message doesn't carry; stamp them on so the appended role:'tool'
    // results stay valid for OpenAI-compatible APIs.
    const assistantWithTools = Array.isArray(assistantMessage.tool_calls) && assistantMessage.tool_calls.length > 0
      ? assistantMessage
      : { ...assistantMessage, tool_calls: toolCalls };
    messages = [...messages.slice(0, -1), assistantWithTools, ...toolResults];
  }

  throw new Error(`AGENTIC_LOOP_EXCEEDED: no finish/skip-push decision within ${maxToolIterations} LLM round(s)`);
}

/**
 * Deliver the hook's pushPayloads sequentially. Mirrors instant's
 * sendPushesSequentially: force-overwrite messageIndex/totalMessages,
 * stamp ids, pace with the same 1500ms spacing. Ids are deterministic
 * per (task, index) so a retried task reuses the same ids and clients
 * can dedupe.
 */
async function sendHookPushPayloads(pushPayloads, decryptedPayload, ctx, sessionId, task, sleep) {
  if (!ctx.vapid || !ctx.vapid.email || !ctx.vapid.publicKey || !ctx.vapid.privateKey) {
    throw new Error('VAPID configuration missing - push notifications cannot be sent');
  }
  const pushSubscription = decryptedPayload.pushSubscription;
  const total = pushPayloads.length;
  const messageIdBase = task.id != null ? `msg_task_${task.id}` : `msg_${randomUUID()}`;

  for (let i = 0; i < total; i++) {
    const push = { ...pushPayloads[i] };
    if (typeof push.messageId !== 'string' || !push.messageId) push.messageId = `${messageIdBase}_hook_${i}`;
    if (typeof push.sessionId !== 'string' || !push.sessionId) push.sessionId = sessionId;
    if (typeof push.timestamp !== 'string' || !push.timestamp) push.timestamp = new Date().toISOString();
    push.messageIndex = i + 1;
    push.totalMessages = total;

    await ctx.webpush.sendNotification(pushSubscription, JSON.stringify(push));
    if (i < total - 1) await sleep(SLEEP_BETWEEN_MESSAGES_MS);
  }
  return total;
}
```

- [ ] **Step 6.4: message-processor 接入**——`processSingleMessage` 里 `const decryptedPayload = ...` 之后、`let messageContent` 之前插入：

```js
    // Fire-time hooks: when the host configured onBeforeFire and the task
    // needs the LLM, offer the agentic path first. onBeforeFire → null
    // falls straight through to the frozen-prompt chain below, and
    // deployments without hooks never enter this branch — legacy behavior
    // is byte-identical.
    if (ctx.hooks && typeof ctx.hooks.onBeforeFire === 'function' && taskNeedsLlm(decryptedPayload)) {
      const agentic = await runAgenticFire({ task, decryptedPayload, userKey, ctx });
      if (agentic.handled) return agentic.result;
    }
```

顶部 import：`import { runAgenticFire, taskNeedsLlm } from './agentic-fire.js';`
- [ ] **Step 6.5**: 跑 agentic-fire.test.mjs → 全 PASS；再全量 server 测试 → PASS。
- [ ] **Step 6.6: Commit**：`git commit -am "feat(amsg): fire 时刻 hooks 与服务端多轮工具循环（onBeforeFire/onLLMOutput/executeToolCalls）"`

### Task 7: server — 工厂/ctx 线缆 + 老链路回归守卫 + worker 级 e2e

**Files:**
- Modify: `server/src/server/cloudflare/single-user-worker.js`、`server/src/server/single-user.js`
- Test: `server/test/agentic-fire.test.mjs`（worker e2e 段）、`server/test/message-processor.test.mjs`（守卫）

- [ ] **Step 7.1: 失败测试**——
(a) agentic-fire.test.mjs 追加 worker 级 e2e：真 D1 seed 一个到期 `message_type:'auto'` 任务（recurrenceType:'daily'），`createSingleUserCloudflareWorker` 配 `hooks`（onBeforeFire 读 readState 组 messages；LLM 桩一轮 finish 单 push）+ `maxToolIterations: 4` + `totalTimeoutMs: 60_000`，跑 `worker.scheduled({}, env)` → 断言推送 1 条、任务被顺延（`next_send_at` +24h、retry_count 0）。再跑一个 hooks 返回 null 的 worker → 走冻结 prompt（fetch 请求体 messages 为 completePrompt 单条）。
(b) message-processor.test.mjs 追加两条守卫（防「以后有人删老链路」，spec 测试 1）：

```js
describe('legacy frozen-prompt chain regression guards', () => {
  it('no hooks configured → auto task replays the frozen completePrompt in a single LLM call', async () => {
    const task = await createEncryptedTask({
      contactName: 'Rei', messageType: 'auto', completePrompt: 'FROZEN',
      apiUrl: 'https://api.example.com/v1/chat/completions', apiKey: 'secret', primaryModel: 'model-x',
      pushSubscription: { endpoint: 'https://push.example.com/sub' }
    });
    const requestBodies = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, options) => {
      requestBodies.push(JSON.parse(options.body));
      return { ok: true, async json() { return { choices: [{ message: { content: 'hello world' } }] }; } };
    };
    let pushes = 0;
    try {
      const result = await processSingleMessage(task, createContext(async () => { pushes++; }));
      assert.equal(result.success, true);
      assert.equal(requestBodies.length, 1);
      assert.deepEqual(requestBodies[0].messages, [{ role: 'user', content: 'FROZEN' }]);
      assert.equal(requestBodies[0].temperature, 0.8);
      assert.equal(pushes, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('hooks configured but onBeforeFire returns null → identical legacy behavior, hook loop untouched', async () => {
    // 同上，但 ctx 带 hooks: { onBeforeFire: async () => null, onLLMOutput: 计数器 }
    // 断言与上一条完全一致，且 onLLMOutput 计数为 0。
  });
});
```

（第二条按第一条展开写全，别留伪代码。）
- [ ] **Step 7.2: 实现**——`single-user-worker.js` `scheduled()` 的 tick 调用改为：

```js
      await runScheduledTick({
        db: cfg.db,
        masterKey: cfg.masterKey,
        vapid,
        webpush: cfg.webpush,
        // Fire-time hooks (optional; see lib/agentic-fire.js). runScheduledTick
        // spreads its ctx into processSingleMessage, so these ride along.
        hooks: cfg.hooks || null,
        maxToolIterations: cfg.maxToolIterations,
        totalTimeoutMs: cfg.totalTimeoutMs
      });
```

`single-user.js` 的 ctx 加同样三项（in-server instant path 经 processMessagesByUuid 用的是 handler ctx）：

```js
    webpush: config.webpush || null,
    tenantManager,
    // Fire-time hooks (optional): the in-server instant path fires through
    // processMessagesByUuid with this ctx, so instant-type tasks can take
    // the agentic path too.
    hooks: config.hooks || null,
    maxToolIterations: config.maxToolIterations,
    totalTimeoutMs: config.totalTimeoutMs
```

`run-tick.js` 无需改动（`{ ...ctx, db, masterKey }` 自动透传）。工厂 JSDoc（single-user-worker.js 文件头 + single-user.js `@param`）补 `hooks` / `maxToolIterations` / `totalTimeoutMs` 三个可选 config 字段说明。
- [ ] **Step 7.3**: 全量 server 测试 → PASS。
- [ ] **Step 7.4: Commit**：`git commit -am "feat(amsg): 单用户工厂接受 hooks/maxToolIterations/totalTimeoutMs 并接入 fire 链"`

### Task 8: 文档 + changesets

**Files:**
- Modify: `server/examples/cloudflare-single-user/README.md`
- Create: `.changeset/amsg-shared-agentic-contract.md`、`.changeset/amsg-server-agentic-fire.md`

- [ ] **Step 8.1**: README `## 端点` 表补三行（PUT/GET/DELETE /client-state，一句话说明）；新增一节（平铺直叙、中性示例、无下游业务词，语气对齐现有 README）：

```markdown
## Fire 时刻 hooks（服务端工具循环）

这是啥：默认情况下，AI 类任务的 prompt 在排程那一刻就冻结进数据库，cron 到点后拿冻结文本调一次 LLM 就推送。配置 hooks 后，worker 会在**触发那一刻**现场组装 prompt，需要查资料时直接在 worker 里执行工具、多轮循环，最后把成品推送出去——全程不需要客户端在线。

啥时候用：任务触发时间离排程时间很远（比如每周提醒）、希望消息基于最新状态生成，或者生成时需要查云端同步的数据（配合 `/client-state` 端点）。

（随后给一个完整中性 worker.js 示例：onBeforeFire 读 readState('notes') 组 messages；onLLMOutput 解析 llmResponse.choices[0].message.tool_calls → tool-request / 否则按句切分 buildContentPush → finish；executeToolCalls 按 function.name 分发到一个演示性的 lookupNotes 函数。示例中注明：maxToolIterations 默认 5、totalTimeoutMs 默认 240000，工厂级可配，onBeforeFire 返回 { messages, maxToolIterations, totalTimeoutMs } 可按次放宽；onBeforeFire 返回 null 则该次走冻结 prompt 老链路；宿主自定义任务字段放 metadata 里透传。）
```

同时在 `## 客户端` 之后补一小段 `/client-state` 的用法说明（批量 upsert body 形状、单条 value ≤200KB、last-write-wins）。
- [ ] **Step 8.2**: changeset 两个文件——

`.changeset/amsg-shared-agentic-contract.md`:
```md
---
"@rei-standard/amsg-shared": minor
"@rei-standard/amsg-instant": patch
---

amsg-shared 新增 agentic 循环契约工具：`buildSessionContext`、`extractAssistantMessage`、`assertValidDecision`（支持 `inlineToolCalls` 服务端口味）、`extractToolCallsFromDecision`。amsg-instant 的 SessionContext 构建与 decision 校验改为从 amsg-shared 复用同一实现，对外行为不变。
```

`.changeset/amsg-server-agentic-fire.md`:
```md
---
"@rei-standard/amsg-server": minor
---

单用户 / Cloudflare 模式新增「fire 时刻现场生成」能力：

- 新表 `client_state`（init-tenant 幂等建表）+ 三个端点：`PUT /client-state` 批量上传状态（按 updatedAt last-write-wins）、`GET /client-state?namespace=` 读取、`DELETE /client-state` 清空。value 用 per-user key 加密落库，鉴权与加密头沿用现有端点。
- `createSingleUserCloudflareWorker` 的 config 接受可选 `hooks: { onBeforeFire, onLLMOutput, executeToolCalls }` 与 `maxToolIterations`（默认 5）、`totalTimeoutMs`（默认 240000）。配置后，AI 类任务在触发时由 onBeforeFire 现场组装 messages（可经 ctx.readState 读 client_state），worker 内执行多轮工具循环后推送成品；onLLMOutput 契约与 @rei-standard/amsg-instant 的同名 hook 一致，instant 的 classifier 可直接复用。
- 不配 hooks、或 onBeforeFire 返回 null 时，任务照走排程时冻结的 completePrompt 老链路；固定文本任务永远走老链路。hook ctx 不含 apiKey / pushSubscription / VAPID。
```

- [ ] **Step 8.3: Commit**：`git commit -am "docs(amsg): 单用户 hooks 与 /client-state 文档、changesets"`

### Task 9: 全量验收

- [ ] **Step 9.1**: 逐包测试 + 构建：`npm run build -w @rei-standard/amsg-shared -w @rei-standard/amsg-instant -w @rei-standard/amsg-server` → exit 0；`npm test -w @rei-standard/amsg-shared -w @rei-standard/amsg-instant -w @rei-standard/amsg-server` → 全 PASS。
- [ ] **Step 9.2**: 根 CI：`npm run ci`（check:esm && check:pm && build && test 全 workspace，覆盖多租户回归与 client/sw 包）→ exit 0。
- [ ] **Step 9.3**: 免 flag 打包验收（验收标准 1）：

```bash
cd packages/rei-standard-amsg/server/examples/cloudflare-single-user
npx esbuild worker.js --bundle --format=esm --target=es2022 \
  --platform=neutral --conditions=worker,browser,import,default --outfile=/tmp/amsg-neutral.js
grep -c 'node:' /tmp/amsg-neutral.js   # 期望输出 0（grep 退出码 1 = 零匹配，即通过）
```

- [ ] **Step 9.4**: 中性检查（验收标准 4）：`grep -rin "sully" packages/rei-standard-amsg/{shared,instant,server}/src packages/rei-standard-amsg/server/examples .changeset` → 无输出。
- [ ] **Step 9.5**: exports 检查（验收标准 5）：`git diff origin/main -- packages/rei-standard-amsg/server/package.json` 确认 `exports` 的 `./cloudflare` 子路径未动；版本号本身不手改（changesets 在 release 流程里做 `2.6.0-next.3` 的 bump）。
- [ ] **Step 9.6**: push 分支并开 PR（base: main），PR 描述按仓库惯例中文、聚焦「改了什么/改后是怎样的」。

## Self-Review 结论

- Spec 覆盖：任务 1（client_state 表+端点）→ Task 3/4；任务 2（hook 契约+循环）→ Task 1/2/5/6；任务 3（run-tick/message-processor 接入）→ Task 6/7；任务 4 的 5 条测试 → Task 3.1/4.1/6.1（#1→7.1b+11+12、#2→6.1#1、#3→6.1#3/4/5、#4→3.1+4.1、#5→6.1#9）；验收 1-5 → Task 9。
- 「outbound log」按无表现状落实为返回值/summary 记录（见文件头「关键契约事实」），若楪同学想要持久化表需另开需求。
- 类型一致性：`callLlm` / `runAgenticFire` / `taskNeedsLlm` / `upsertClientState(userId, entries)` 签名在各 task 间一致；`inlineToolCalls` 选项名全文统一。
