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
 * 发送后回执：finish 的 pushPayloads 逐段发完（或中途发挂）后，可选的
 * ctx.onAfterSend?.({ task, sentCount, total, error }) 会被调用（见
 * notifyAfterSend），宿主用它把「真的发出去了几段」写回自己的存储——发送前
 * 的 hook 写的副作用，在推送全挂时会变成「云端记得说过、用户没收到」。载荷
 * 带 task（任务行本身）：tick 内多个任务并发投递时，hook 靠它区分回执属于
 * 哪条任务。
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
 * 工具声明：onBeforeFire 的返回值里可以带 `tools`（OpenAI 的 tools 数组，
 * 另有可选的 `toolChoice`），本次 fire 的每一轮 LLM 请求都原样带上它们——
 * 补完那轮模型仍可能再发起调用。库不看 tools 的内容，执行照旧是
 * executeToolCalls 的事。
 *
 * 自排后续任务：fireCtx 和每轮的 sessionCtx 上都挂着 scheduleTask，宿主用它
 * 在这次 fire 里给同一个用户再建一条定时任务（「这条发完，一个半小时后我再
 * 接着说一句」）。写口在 sessionCtx 上也给，是因为要不要接着说往往是看完
 * LLM 输出才定的，那时 onBeforeFire 早已返回。凭据（pushSubscription /
 * apiKey）和投递配置从当前任务继承、宿主全程看不到（与 buildHookTask 屏蔽
 * 凭据同一个原则），宿主只提供「什么时候、说什么方向」。
 *
 * 新任务不继承 completePrompt / messages，两者都置 null：fire-time hook 每次
 * 现场重组 prompt，把排程时冻结的旧 prompt 带过去，会在新任务万一走回老链路
 * （onBeforeFire 返回 null、或那次部署没配 hooks）时静默顶替宿主的意图——
 * 与其发一条来路不明的旧文案，不如让它当场失败、走既有的重试/标记逻辑。
 *
 * 护栏（几条都是这个能力能不能上线的关键）：
 *   - firstSendTime 至少比现在晚 MIN_SCHEDULE_LEAD_MS（60 秒）。cron 每分钟
 *     一跳，排在 60 秒内等于让下一跳立刻捡走，容易变成自己触发自己的紧密循环。
 *   - messageType 只收 auto / prompted / fixed，不收 instant。instant 的语义是
 *     「建行的那一刻就投递」，那条路径归 POST /schedule-message 管；从 fire 里
 *     造这么一行，投递时机反而说不清（这里不投，要等 cron 捞到才发）。
 *   - 单次 fire 的建任务上限默认 DEFAULT_MAX_SCHEDULED_TASKS_PER_FIRE 条，
 *     factory 配置 ctx.maxScheduledTasksPerFire 可覆盖（0 表示不许自排）。模型
 *     自排后续本质上是个可以无限延伸的链：没有上限的话，一次 fire 里连排十条、
 *     或者每条任务都排下一条，就成了谁也没按下停止键的循环。
 *   - uuid 冲突不抛错，返回 { created: false, reason: 'duplicate' }。fire 失败
 *     会整条重跑（run-tick 的重试语义），宿主传一个由「任务 id + 触发时刻」推
 *     出来的确定性 uuid 就天然幂等，不会每重试一次多排一条。
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
import { decryptFromStorage, encryptForStorage } from './encryption.js';
import { isUniqueViolation } from './db-errors.js';
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

// 一次 fire 里最多能给自己排几条后续任务（ctx.maxScheduledTasksPerFire 可覆盖）。
export const DEFAULT_MAX_SCHEDULED_TASKS_PER_FIRE = 2;
// 自排任务的最小提前量：cron 一分钟一跳，比这更近等于让下一跳立刻捡走。
export const MIN_SCHEDULE_LEAD_MS = 60_000;

// 自排任务允许的类型。instant 归 POST /schedule-message 那条同步路径管。
const SCHEDULABLE_MESSAGE_TYPES = new Set(['auto', 'prompted', 'fixed']);
// 与 validateScheduleMessagePayload 同一套；run-tick 只认得这三种，别的值会让
// 任务发完之后推进不到下一次。
const SCHEDULABLE_RECURRENCE_TYPES = new Set(['none', 'daily', 'weekly']);

// Same pacing as the legacy path / amsg-instant.
const SLEEP_BETWEEN_MESSAGES_MS = 1500;

// Task-payload fields that must never reach hook code.
const CREDENTIAL_PAYLOAD_KEYS = new Set(['apiKey', 'pushSubscription']);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 默认 messageId / sessionId 里掺的名义触发时刻后缀（`@<epoch-ms>`）。
 *
 * 循环任务跨天复用同一条任务行，id 只用 task.id 的话，离线设备一次性收到
 * 多天积压的推送（push TTL 有四周）时会在 service worker 端互相去重、在
 * 收件箱按 messageId 覆盖，几天的消息只剩一条。掺入名义触发时刻后每个
 * occurrence 一套 id；同一 occurrence 的重试仍是同一套——重投已送达的段
 * 会被去重，这正是想要的。行上没有可解析的 next_send_at（比如直接喂进来
 * 的内存任务对象）时返回 ''，等价于旧格式。
 *
 * @param {{ next_send_at?: string }} task
 * @returns {string}
 */
export function occurrenceSuffix(task) {
  const occurrenceMs = Date.parse(task && task.next_send_at);
  return Number.isFinite(occurrenceMs) ? `@${occurrenceMs}` : '';
}

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
      // 归一成「有就是非空数组，否则 undefined」，让下面每轮的透传判断能直接
      // 用真值。真正决定请求体带不带 tools 的规则住在 llm.js 的
      // buildAiRequestBody（那边有测试钉着），这层只是不把空数组往下传。
      tools: Array.isArray(result.tools) && result.tools.length > 0 ? result.tools : undefined,
      toolChoice: result.toolChoice,
    };
  }
  throw new TypeError(
    'AGENTIC_BAD_BEFORE_FIRE: onBeforeFire must return ChatMessage[] | { messages, maxToolIterations?, totalTimeoutMs?, tools?, toolChoice? } | { skip: true } | null'
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
 * @param {Object} args.ctx - processor ctx ({ db, webpush, vapid, hooks, maxToolIterations, totalTimeoutMs, maxScheduledTasksPerFire })
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

  const maxScheduledTasksPerFire =
    Number.isInteger(ctx.maxScheduledTasksPerFire) && ctx.maxScheduledTasksPerFire >= 0
      ? ctx.maxScheduledTasksPerFire
      : DEFAULT_MAX_SCHEDULED_TASKS_PER_FIRE;
  // 本次 fire 已经用掉的建任务额度。校验通过、真的要写库时才 +1，参数不合法的
  // 调用不占额度；uuid 撞车（那条任务其实已经建出来了）照样占。
  let scheduledTaskCount = 0;

  /**
   * scheduleTask(options) —— 在这次 fire 里给**同一个用户**再建一条定时任务。
   *
   * 典型用法：角色发完这条，想过一个半小时再接着说一句。以前只能写进
   * client_state 等客户端上线重放，用户一直不上线这条链就断了；建成任务行之后，
   * 到点由 cron 直接触发，跟别的定时消息一样。
   *
   * 凭据与投递配置（pushSubscription / apiUrl / apiKey / primaryModel /
   * maxTokens / temperature / splitPattern）以及 contactName / avatarUrl /
   * messageSubtype / userMessage 从当前任务继承，宿主只说「什么时候、说什么
   * 方向」——hook 全程看不到凭据。completePrompt / messages 不继承（都置 null），
   * 见文件头。
   *
   * @param {Object} options
   * @param {string} options.firstSendTime      - 必填，ISO 8601；至少比现在晚 60 秒
   * @param {'none'|'daily'|'weekly'} [options.recurrenceType='none']
   * @param {'auto'|'prompted'|'fixed'} [options.messageType]  - 默认继承当前任务
   * @param {Object} [options.metadata]         - 整体替换（不是深合并）当前任务的 metadata
   * @param {string} [options.contactName]      - 默认继承
   * @param {string|null} [options.avatarUrl]   - 默认继承
   * @param {string} [options.messageSubtype]   - 默认继承
   * @param {string|null} [options.userMessage] - 默认继承；messageType 'fixed' 时必须有
   * @param {string} [options.uuid]             - 默认 randomUUID()；传确定性 uuid 可做重试幂等
   * @returns {Promise<{ created: true, id: number|null, uuid: string, nextSendAt: string }
   *   | { created: false, reason: 'duplicate', uuid: string }>}
   */
  const scheduleTask = async (options) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new TypeError('scheduleTask(options) 需要一个对象，至少包含 { firstSendTime }');
    }

    // ---- 触发时刻 ----
    if (typeof options.firstSendTime !== 'string' || !options.firstSendTime.trim()) {
      throw new RangeError('scheduleTask: firstSendTime 必填，且必须是 ISO 8601 字符串');
    }
    const firstSendAt = new Date(options.firstSendTime);
    if (Number.isNaN(firstSendAt.getTime())) {
      throw new RangeError(`scheduleTask: firstSendTime 解析不出合法时间：${options.firstSendTime}`);
    }
    const earliest = nowFn() + MIN_SCHEDULE_LEAD_MS;
    if (firstSendAt.getTime() < earliest) {
      throw new RangeError(
        `scheduleTask: firstSendTime 至少要比现在晚 ${MIN_SCHEDULE_LEAD_MS / 1000} 秒` +
        `（最早可排 ${new Date(earliest).toISOString()}，收到 ${firstSendAt.toISOString()}）` +
        '——cron 一分钟一跳，排得更近等于让下一跳立刻捡走'
      );
    }
    const nextSendAt = firstSendAt.toISOString();

    // ---- 类型 ----
    const inheritedType = options.messageType == null;
    const messageType = inheritedType ? decryptedPayload.messageType : options.messageType;
    if (messageType === 'instant') {
      throw new TypeError(
        "scheduleTask: messageType 不能是 'instant'——instant 的语义是「建行的那一刻就投递」，" +
        '那条路径归 POST /schedule-message 管；从 fire 里建一条 instant，投递时机反而说不清。' +
        (inheritedType ? '（这个 instant 是从当前任务继承来的，显式传 auto / prompted / fixed 覆盖它。）' : '')
      );
    }
    if (!SCHEDULABLE_MESSAGE_TYPES.has(messageType)) {
      throw new TypeError(
        `scheduleTask: messageType 只能是 auto / prompted / fixed，收到 ${JSON.stringify(messageType)}`
      );
    }

    const recurrenceType = options.recurrenceType == null ? 'none' : options.recurrenceType;
    if (!SCHEDULABLE_RECURRENCE_TYPES.has(recurrenceType)) {
      throw new TypeError(
        `scheduleTask: recurrenceType 只能是 none / daily / weekly，收到 ${JSON.stringify(recurrenceType)}`
      );
    }

    // ---- 继承 + 覆盖 ----
    const contactName = options.contactName === undefined ? decryptedPayload.contactName : options.contactName;
    if (typeof contactName !== 'string' || !contactName.trim()) {
      throw new TypeError('scheduleTask: contactName 必须是非空字符串（默认继承当前任务）');
    }
    const userMessage = options.userMessage === undefined
      ? (decryptedPayload.userMessage ?? null)
      : options.userMessage;
    if (messageType === 'fixed' && (typeof userMessage !== 'string' || !userMessage.trim())) {
      throw new TypeError(
        "scheduleTask: messageType 'fixed' 必须有 userMessage（自己传，或从当前任务继承到）" +
        '——固定文本任务没有正文，就是一条永远发空的任务'
      );
    }
    const metadata = options.metadata === undefined ? (decryptedPayload.metadata || {}) : options.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new TypeError('scheduleTask: metadata 必须是普通对象（整体替换当前任务的 metadata，不做深合并）');
    }
    const uuid = options.uuid == null ? randomUUID() : options.uuid;
    if (typeof uuid !== 'string' || !uuid.trim()) {
      throw new TypeError('scheduleTask: uuid 必须是非空字符串');
    }

    // ---- 额度 ----
    if (scheduledTaskCount >= maxScheduledTasksPerFire) {
      throw new RangeError(
        `scheduleTask: 单次 fire 最多建 ${maxScheduledTasksPerFire} 条任务` +
        `（factory 配置 maxScheduledTasksPerFire 可调），这是第 ${scheduledTaskCount + 1} 条`
      );
    }
    // readState 在适配器不支持时降级成空数组；建任务不一样，静默成功会让宿主
    // 以为后续那条已经排上了，其实谁也不会触发它。
    if (!ctx.db || typeof ctx.db.createTask !== 'function') {
      throw new Error('AGENTIC_SCHEDULE_UNSUPPORTED: 当前数据库适配器不支持建任务（缺 createTask）');
    }
    scheduledTaskCount++;

    // 字段构成与 POST /schedule-message 落库的那份保持一致，只是走库内部、不经 HTTP。
    const fullTaskData = {
      contactName,
      avatarUrl: options.avatarUrl === undefined ? (decryptedPayload.avatarUrl || null) : (options.avatarUrl || null),
      messageType,
      messageSubtype: (options.messageSubtype === undefined ? decryptedPayload.messageSubtype : options.messageSubtype) || 'chat',
      userMessage: userMessage || null,
      firstSendTime: nextSendAt,
      recurrenceType,
      apiUrl: decryptedPayload.apiUrl || null,
      apiKey: decryptedPayload.apiKey || null,
      primaryModel: decryptedPayload.primaryModel || null,
      // 见文件头：fire-time hook 每次现场重组 prompt，旧 prompt 带过去只会在新
      // 任务走回老链路时顶替宿主的意图。
      completePrompt: null,
      messages: null,
      maxTokens: decryptedPayload.maxTokens ?? null,
      temperature: decryptedPayload.temperature ?? null,
      splitPattern: decryptedPayload.splitPattern ?? null,
      pushSubscription: decryptedPayload.pushSubscription,
      metadata,
    };

    const encryptedPayload = await encryptForStorage(JSON.stringify(fullTaskData), userKey);

    let created;
    try {
      created = await ctx.db.createTask({
        user_id: task.user_id,
        uuid,
        encrypted_payload: encryptedPayload,
        next_send_at: nextSendAt,
        message_type: messageType,
      });
    } catch (error) {
      // 撞 uuid 不算错：fire 失败会整条重跑，宿主用确定性 uuid（任务 id + 触发
      // 时刻推出来的那种）就天然幂等，重试不会多排一条。
      if (isUniqueViolation(error)) return { created: false, reason: 'duplicate', uuid };
      throw error;
    }
    if (!created) {
      throw new Error('AGENTIC_SCHEDULE_FAILED: createTask 没有返回新建的任务行');
    }
    return {
      created: true,
      id: created.id ?? null,
      uuid: created.uuid ?? uuid,
      nextSendAt: created.next_send_at ?? nextSendAt,
    };
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
    scheduleTask,
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

  // Same sessionId scheme as the legacy path: pinned to (task id + 名义触发
  // 时刻)，同一 occurrence 的重试复用同一个 session，不同 occurrence 各一个
  // （见 occurrenceSuffix）。
  const sessionId = task.id != null ? `sess_task_${task.id}${occurrenceSuffix(task)}` : `sess_${randomUUID()}`;
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
      {
        ...decryptedPayload,
        messages,
        ...(normalized.tools ? { tools: normalized.tools, toolChoice: normalized.toolChoice } : {}),
      },
      { requireContent: false, timeoutMs: roundTimeoutMs }
    );

    const assistantMessage = extractAssistantMessage(llmResponse);
    messages = [...messages, assistantMessage];

    // 共享的 SessionContext（与 amsg-instant 同形状）之上，再挂两个状态访问器
    // 和 scheduleTask：大内容要不要旁路存、要不要给自己排条后续，往往到工具跑完、
    // 组 push 时才知道，而那正是 onLLMOutput / executeToolCalls 的位置，
    // onBeforeFire 早就返回了。
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
      scheduleTask,
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
    // results stay valid for OpenAI-compatible APIs. Merge rather than pick
    // one side: when a native tool_call and a synthesized one land in the
    // same round, both need their id on the assistant turn, or the half
    // that's missing leaves an orphan role:'tool' and a strict relay
    // rejects the next round.
    //
    // Contract for onLLMOutput: the toolCalls it returns must cover every
    // native tool_call the model declared. A native call left out still
    // gets declared on the assistant turn (it came from the model) but has
    // no matching role:'tool' result, and a strict relay rejects the next
    // round over the unanswered id. Drop a call on purpose → return a
    // result for it saying so, don't just omit it.
    const nativeCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
    const nativeIds = new Set(nativeCalls.map((tc) => tc && tc.id));
    const synthesized = toolCalls.filter((tc) => !nativeIds.has(tc && tc.id));
    const assistantWithTools = synthesized.length === 0
      ? assistantMessage
      : { ...assistantMessage, tool_calls: [...nativeCalls, ...synthesized] };
    messages = [...messages.slice(0, -1), assistantWithTools, ...toolResults];
  }

  throw new Error(`AGENTIC_LOOP_EXCEEDED: no finish/skip-push decision within ${maxToolIterations} LLM round(s)`);
}

/**
 * ctx.onAfterSend?.({ task, sentCount, total, error }) —— 推送发出（或发挂）
 * 之后的可选 hook。发送前的 hook（onBeforeFire / onLLMOutput）只能在推送发出
 * 前写副作用，LLM 成功但推送全挂时会「云端记得说过、用户没收到」；宿主要把
 * 「真的发出去了几段」写回自己的存储，就挂这个。task 是任务行本身（tick 内
 * 最多 8 个任务并发投递，回执要靠它对号入座）。全部成功时 error 为 null；
 * 第 k 段失败时 sentCount = k、error 带原始错误，且 hook 会在错误往上抛之前
 * 调用完。hook 自身抛错只 console.warn，不影响主流程。
 */
async function notifyAfterSend(ctx, info) {
  if (typeof ctx.onAfterSend !== 'function') return;
  try {
    await ctx.onAfterSend(info);
  } catch (hookError) {
    console.warn('[amsg-server] onAfterSend hook 抛错（已忽略）:', hookError && hookError.message);
  }
}

/**
 * Deliver the hook's pushPayloads sequentially. Mirrors instant's
 * sendPushesSequentially: force-overwrite messageIndex/totalMessages,
 * stamp missing ids, pace with the same 1500ms spacing. Ids are
 * deterministic per (task, occurrence, index) so a retried occurrence
 * reuses the same ids and clients can dedupe (see occurrenceSuffix)。
 * 调用方显式带了 messageId / sessionId 时以调用方为准，只有缺省值掺
 * occurrence。
 */
async function sendHookPushPayloads(pushPayloads, decryptedPayload, ctx, sessionId, task, sleep) {
  const total = pushPayloads.length;
  let sentCount = 0;
  try {
    if (!ctx.vapid || !ctx.vapid.email || !ctx.vapid.publicKey || !ctx.vapid.privateKey) {
      throw new Error('VAPID configuration missing - push notifications cannot be sent');
    }
    const pushSubscription = decryptedPayload.pushSubscription;
    const messageIdBase = task.id != null ? `msg_task_${task.id}${occurrenceSuffix(task)}` : `msg_${randomUUID()}`;

    for (let i = 0; i < total; i++) {
      const push = { ...pushPayloads[i] };
      if (typeof push.messageId !== 'string' || !push.messageId) push.messageId = `${messageIdBase}_hook_${i}`;
      if (typeof push.sessionId !== 'string' || !push.sessionId) push.sessionId = sessionId;
      if (typeof push.timestamp !== 'string' || !push.timestamp) push.timestamp = new Date().toISOString();
      push.messageIndex = i + 1;
      push.totalMessages = total;

      await ctx.webpush.sendNotification(pushSubscription, JSON.stringify(push));
      sentCount++;
      if (i < total - 1) await sleep(SLEEP_BETWEEN_MESSAGES_MS);
    }
  } catch (error) {
    // 部分失败也要让宿主知道已经发出去了几段——先通知，再把错误往上抛。
    await notifyAfterSend(ctx, { task, sentCount, total, error });
    throw error;
  }
  await notifyAfterSend(ctx, { task, sentCount, total, error: null });
  return total;
}
