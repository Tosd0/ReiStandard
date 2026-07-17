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
 * SessionContext — a console.log(ctx) in a hook must not leak keys).
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
 * @param {Object} args.decryptedPayload - decrypted task payload (has credentials; they stop here)
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

  // Injectable seams for tests only (fake clock / no real 1500ms pacing).
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

  // Same sessionId scheme as the legacy path: pinned to the task id so a
  // retried task reuses the same session and clients can group/dedupe.
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
