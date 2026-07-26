/**
 * Server-side agentic fire loop.
 *
 * When the host configures fire-time hooks, an LLM task stops replaying
 * the completePrompt frozen at schedule time. At fire time instead:
 *
 *   onBeforeFire(fireCtx) → fresh messages (may read client_state) | { skip: true }
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
 * SessionContext — a console.log(ctx) in a hook must not leak keys).
 *
 * client_state 读写：fireCtx 和每轮的 sessionCtx 上都挂着 readState /
 * writeState，读到和写出的都是客户端 `GET/PUT /client-state` 那套数据。写口
 * 在 sessionCtx 上也给，是因为「这条内容太大、塞不进 push」往往到工具跑完、
 * 组 pushPayloads 时才知道，那时 onBeforeFire 早已返回。
 *
 * scratch：每次 fire 新建一个普通对象，onBeforeFire 的 fireCtx 与同一次
 * fire 每轮的 sessionCtx 都持有同一个引用，hook 之间借它传工具上下文，
 * 不用再自己维护 Map<sessionId, state>。fire 结束（finish / skip-push /
 * 抛错 / 轮数超限）后随调用栈丢弃；库不读不写、不落库、不打日志。
 *
 * Budget guards, both factory-level (ctx.maxToolIterations /
 * ctx.totalTimeoutMs) and per-fire (onBeforeFire may return
 * { messages, maxToolIterations?, totalTimeoutMs? } to override for one
 * task — e.g. a task the host knows runs slow tools): maxToolIterations
 * caps LLM rounds; totalTimeoutMs is a wall-time ceiling checked before
 * each round so a cron tick can never hang forever. Both exhaustions
 * surface as ordinary task failures → the existing retry / mark-failed
 * semantics apply.
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
import {
  DEFAULT_MAX_STATE_VALUE_BYTES,
  INTERNAL_STATE_CHAR_RE,
  chunkNamespaceFor,
  resolveClientStateEntries,
} from './state-chunks.js';
import {
  MAX_STATE_ENTRIES_PER_BATCH,
  MAX_NAMESPACE_CHARS,
  MAX_KEY_CHARS,
  stateValueBytes,
  writeClientStateEntries,
} from './client-state-store.js';

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
 *
 * @param {Object} decryptedPayload
 * @returns {boolean}
 */
export function taskNeedsLlm(decryptedPayload) {
  const type = decryptedPayload.messageType;
  if (type === 'prompted' || type === 'auto') return true;
  if (type === 'instant') {
    return !!(decryptedPayload.apiUrl && decryptedPayload.apiKey && decryptedPayload.primaryModel);
  }
  return false;
}

/**
 * Frozen, credential-free view of the task for hook authors.
 *
 * nextSendAt 是这条任务原本的触发时刻。run-tick 领取任务时写的是 lease_until，
 * next_send_at 那一列不动，所以这里给出去的和库里的是同一个值——宿主拿它当
 * 时间锚点（窗口判断、缓存键）时对得上。
 */
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
    'AGENTIC_BAD_BEFORE_FIRE: onBeforeFire must return ChatMessage[] | { messages, maxToolIterations?, totalTimeoutMs? } | { skip: true } | null'
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
 * @param {Object} args.decryptedPayload - decrypted task payload (has credentials; they stop here)
 * @param {string} args.userKey - per-user storage key (for readState decryption)
 * @param {Object} args.ctx - processor ctx ({ db, webpush, vapid, hooks, maxToolIterations, totalTimeoutMs })
 * @returns {Promise<{ handled: false } | { handled: true, result: { success: true, messagesSent: number, status: 'finished'|'skipped', iterations: number } }>}
 *   `handled: false` → caller falls back to the legacy frozen-prompt path
 *   (onBeforeFire returned null).
 *   `onBeforeFire` may also return `{ skip: true }` to complete the fire
 *   before the first LLM call → `status: 'skipped', iterations: 0`, same
 *   success handling as the post-LLM skip-push path.
 *   Failures (timeout / loop exceeded / config errors) throw — the caller's
 *   existing error handling turns them into task retry/failure.
 */
export async function runAgenticFire({ task, decryptedPayload, userKey, ctx }) {
  const hooks = ctx.hooks;
  if (typeof hooks.onLLMOutput !== 'function') {
    throw new Error('AGENTIC_CONFIG_ERROR: hooks.onBeforeFire requires hooks.onLLMOutput to classify LLM rounds');
  }

  // Injectable seams for tests only (fake clock / no real 1500ms pacing).
  const nowFn = typeof ctx._agenticNow === 'function' ? ctx._agenticNow : Date.now;
  const sleep = typeof ctx._agenticSleep === 'function' ? ctx._agenticSleep : defaultSleep;

  const readState = async (namespace) => {
    if (typeof namespace !== 'string' || !namespace.trim()) {
      throw new TypeError('readState(namespace) requires a non-empty string');
    }
    if (!ctx.db || typeof ctx.db.getClientState !== 'function') return [];
    const rows = await ctx.db.getClientState(task.user_id, namespace);
    // 分块存储的值在这里拼回原文（见 state-chunks.js）；块不齐全的 key 视为
    // 不存在 —— hook 作者拿到的与客户端写入的一致，永远不会是半截数据。
    return resolveClientStateEntries(
      rows,
      () => ctx.db.getClientState(task.user_id, chunkNamespaceFor(namespace)),
      (value) => decryptFromStorage(value, userKey)
    );
  };

  const maxStateValueBytes = Number.isInteger(ctx.maxStateValueBytes) && ctx.maxStateValueBytes > 0
    ? ctx.maxStateValueBytes
    : DEFAULT_MAX_STATE_VALUE_BYTES;

  /**
   * writeState(namespace, entries) —— readState 的写入口，落库走的是
   * `PUT /client-state` 那条路径的同一份实现（加密、大值分块、切片清理，见
   * lib/client-state-store.js），所以 hook 写下的东西客户端 `GET /client-state`
   * 能原样读回，反过来也一样。
   *
   * 典型用法是「大内容旁路」：一条 Web Push 的正文只有 4KB 出头（见
   * lib/webpush-webcrypto.js 的 MAX_PUSH_PAYLOAD_BYTES），塞不下的内容先写进
   * client_state，push 里只带一个引用键，客户端上线后按键取回。
   *
   * @param {string} namespace
   * @param {Array<{ key: string, value: string|null, updatedAt?: number }>} entries
   *   `value` 是字符串 → 整条覆盖写（不是追加，宿主自己负责序列化）；
   *   `value` 为 `null` → 删掉这个 key（含它的切片行）。
   *   `updatedAt` 默认取当前时刻，语义与客户端同步一致：比库里已有值旧的写入
   *   （或删除）不生效，客户端后写的数据不会被这次 fire 盖回去。
   * @returns {Promise<{ upserted: number, skipped: number, deleted: number }>}
   *
   * 谁清、什么时候清：库不做 TTL 也不自动回收，写进去的东西一直在，直到有人
   * 覆盖或删除它。旁路内容建议放在固定的少量 key 上（例如每个角色一个），下次
   * 写同一个 key 直接覆盖，存量天然有上限；一次性的大内容在确认客户端取走后，
   * 用 `{ key, value: null }` 删掉。`DELETE /client-state` 仍然是清空这个用户
   * 全部状态的兜底。
   */
  const writeState = async (namespace, entries) => {
    if (typeof namespace !== 'string' || !namespace.trim()) {
      throw new TypeError('writeState(namespace, entries) requires a non-empty string namespace');
    }
    if (namespace.length > MAX_NAMESPACE_CHARS || INTERNAL_STATE_CHAR_RE.test(namespace)) {
      throw new TypeError(
        `writeState: namespace 必须是 1-${MAX_NAMESPACE_CHARS} 字符且不含控制字符（\\u0000-\\u001f 为库内部保留）`
      );
    }
    if (!Array.isArray(entries)) {
      throw new TypeError('writeState(namespace, entries) requires an array of { key, value }');
    }
    if (entries.length === 0) return { upserted: 0, skipped: 0, deleted: 0 };
    if (entries.length > MAX_STATE_ENTRIES_PER_BATCH) {
      throw new RangeError(`writeState: 单次最多 ${MAX_STATE_ENTRIES_PER_BATCH} 条，收到 ${entries.length} 条`);
    }
    // readState 在适配器不支持时返回空数组（读不到状态，hook 走自己的兜底）。
    // 写不一样：静默成功会让 push 带上一个指向不存在数据的引用键，所以这里报错。
    if (!ctx.db || typeof ctx.db.upsertClientState !== 'function') {
      throw new Error('AGENTIC_STATE_WRITE_UNSUPPORTED: 当前数据库适配器不支持 client_state 写入');
    }

    const now = nowFn();
    const normalized = entries.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new TypeError(`writeState: entries[${index}] 必须是对象`);
      }
      if (typeof entry.key !== 'string' || !entry.key.trim() || entry.key.length > MAX_KEY_CHARS) {
        throw new TypeError(`writeState: entries[${index}].key 必须是 1-${MAX_KEY_CHARS} 字符的字符串`);
      }
      if (INTERNAL_STATE_CHAR_RE.test(entry.key)) {
        throw new TypeError(`writeState: entries[${index}].key 不能包含控制字符（\\u0000-\\u001f 为库内部保留）`);
      }
      if (entry.value !== null && typeof entry.value !== 'string') {
        throw new TypeError(`writeState: entries[${index}].value 必须是字符串（宿主自行序列化），或 null 表示删除`);
      }
      if (typeof entry.value === 'string') {
        const bytes = stateValueBytes(entry.value);
        if (bytes > maxStateValueBytes) {
          throw new RangeError(`writeState: entries[${index}].value 为 ${bytes} 字节，超过单条上限 ${maxStateValueBytes} 字节`);
        }
      }
      if (entry.updatedAt !== undefined && (!Number.isInteger(entry.updatedAt) || entry.updatedAt <= 0)) {
        throw new TypeError(`writeState: entries[${index}].updatedAt 必须是正整数（epoch 毫秒）`);
      }
      return {
        namespace,
        key: entry.key,
        value: entry.value,
        updatedAt: entry.updatedAt ?? now,
      };
    });

    return writeClientStateEntries({ db: ctx.db, userId: task.user_id, userKey, entries: normalized });
  };

  // 单次 fire 的宿主便签：onBeforeFire 的 fireCtx 和同一次 fire 每轮的
  // sessionCtx（onLLMOutput / executeToolCalls）拿到同一个对象引用，fire 结束
  // （finish / skip-push / 抛错 / 轮数超限）随调用栈丢弃。库自己不读不写、
  // 不落库、不打日志、不跨 fire 共享 —— 重试产生的新 fire 拿到的是新对象。
  const scratch = {};

  const fireCtx = Object.freeze({
    task: buildHookTask(task, decryptedPayload),
    userId: task.user_id,
    readState,
    writeState,
    now: new Date(nowFn()),
    scratch,
  });

  const before = await hooks.onBeforeFire(fireCtx);
  if (before == null) return { handled: false };

  // Pre-LLM skip: the host judged this fire moot before generation (e.g. the
  // conversation moved on after the task was scheduled). Shaped exactly like
  // the post-LLM 'skipped' result, so run-tick's success handling (delete
  // once-off / advance recurrence) applies unchanged — and zero tokens spent.
  if (typeof before === 'object' && before.skip === true) {
    return { handled: true, result: { success: true, messagesSent: 0, status: 'skipped', iterations: 0 } };
  }

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

  // Same sessionId scheme as the legacy path: pinned to the task id so a
  // retried task reuses the same session and clients can group/dedupe.
  const sessionId = task.id != null ? `sess_task_${task.id}` : `sess_${randomUUID()}`;
  let messages = normalized.messages.slice();

  for (let iteration = 0; iteration < maxToolIterations; iteration++) {
    if (nowFn() >= deadline) {
      throw new Error(`AGENTIC_TOTAL_TIMEOUT: fire chain exceeded ${totalTimeoutMs}ms after ${iteration} LLM round(s)`);
    }

    // Shrink each round's fetch timeout to the remaining wall-time budget
    // (capped at the legacy 300s single-call ceiling) — a hung LLM request
    // must not outlive totalTimeoutMs waiting for its own 300s abort.
    const roundTimeoutMs = Math.max(1, Math.min(300_000, deadline - nowFn()));
    const { response: llmResponse } = await callLlm(
      { ...decryptedPayload, messages },
      { requireContent: false, timeoutMs: roundTimeoutMs }
    );

    const assistantMessage = extractAssistantMessage(llmResponse);
    messages = [...messages, assistantMessage];

    // 共享的 SessionContext（与 amsg-instant 同形状）之上，再挂两个状态访问器：
    // 大内容要不要旁路存，往往到工具跑完、组 push 时才知道，而那正是
    // onLLMOutput / executeToolCalls 的位置，onBeforeFire 早就返回了。
    const sessionCtx = Object.freeze({
      ...buildSessionContext({
        sessionId,
        messages,
        llmResponse,
        iteration,
        contactName: decryptedPayload.contactName,
        avatarUrl: decryptedPayload.avatarUrl || undefined,
        charId: decryptedPayload.charId,
        metadata: decryptedPayload.metadata,
        scratch,
      }),
      readState,
      writeState,
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
 * stamp missing ids, pace with the same 1500ms spacing. Ids are
 * deterministic per (task, index) so a retried task reuses the same ids
 * and clients can dedupe.
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
