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
 * ctx.onAfterSend?.({ task, sentCount, pushedCount, total, error, usage,
 * usageTotal, llmCalls, outboxed, scratch, readState, writeState }) 会被调用
 * （见 notifyAfterSend），宿主用它把「真的
 * 发出去了几段」写回自己的存储——发送前的 hook 写的副作用，在推送全挂时会变成「云端
 * 记得说过、用户没收到」。载荷带 task（任务行本身）：tick 内多个任务并发
 * 投递时，hook 靠它区分回执属于哪条任务；带 scratch（与本次 fire 的
 * onBeforeFire / onLLMOutput 同一个引用），前面几个 hook 记下的东西这里直
 * 接读；带 readState / writeState / emitResult，回执要落进 client_state、或者
 * 要给客户端补一条结果时，不用另想办法。
 *
 * 收尾回执：onAfterSend 只走「有 push 要发」这条路。**只要 onBeforeFire 被
 * 调用过**，无论结局是发完、跳过（skip / skip-push）还是抛错，可选的
 * ctx.onFireSettled?.({ task, status, skipReason, sentCount, pushedCount,
 * total, iterations, error, usage, usageTotal, llmCalls, outboxed, scratch,
 * readState, writeState }) 都会被调用一次（见 notifyFireSettled）。「开始时占
 * 点什么、结束时放掉」的写法挂这个才不会漏。
 *
 * 失败之后的重试：LLM 上游明确拒了这次请求（401 / 403 / 400 …）一跳终审，
 * 错误上带 `permanent: true`（见 lib/errors.js 的 isPermanentLlmFailure）。
 * finish 的整批落进 outbox 之后推送才失败的，重试那一跳只补推送、不再调这里
 * 的任何 hook，也不再调 LLM（见 lib/message-processor.js 的
 * redeliverCommittedBatch）；回执上的 `outboxed: true` 就是在说这件事。
 *
 * The decision contract is shared with @rei-standard/amsg-instant
 * (assertValidDecision / buildSessionContext live in
 * @rei-standard/amsg-shared), so a classifier written for instant's
 * onLLMOutput drops in unchanged: 'tool-request' may carry `toolCalls`
 * directly, or tool_request pushPayloads that embed them — both work.
 *
 * Credential hiding: hook ctx objects never contain apiKey / vapid /
 * masterKey (same rationale as instant's SessionContext — a
 * console.log(ctx) in a hook must not leak keys). 推送订阅根本不在任务
 * payload 里（它是用户级的一份，见 lib/push-subscription-store.js），投递
 * 时才现读，也不会经过 hook。
 *
 * client_state 读写：fireCtx 和每轮的 sessionCtx 上都挂着 readState /
 * writeState，读到和写出的都是客户端 `GET/PUT /client-state` 那套数据。写口
 * 在 sessionCtx 上也给，是因为「这条内容太大、塞不进 push」往往到工具跑完、
 * 组 pushPayloads 时才知道，那时 onBeforeFire 早已返回。
 *
 * 自定义结果：同样这几个位置上还挂着 emitResult(payload)，把一条**不是聊天
 * 内容**的结果送给客户端——整理好的一份数据、一条账目、后台生成的产物。它同
 * 时落进服务端收件箱并推一条 Web Push：推送负责及时（生成完当场弹一下），
 * 收件箱负责到达（客户端下次 `GET /outbox?since=` 一定拿得到）。客户端因此
 * 不必为每种结果各写一套轮询。实现见 lib/result-emitter.js。
 *
 * scratch：每次 fire 新建一个普通对象，onBeforeFire 的 fireCtx、同一次 fire
 * 每轮的 sessionCtx、以及发送后的 onAfterSend 都持有同一个引用，hook 之间借
 * 它传上下文，不用再自己维护 Map<sessionId, state>。fire 结束（finish /
 * skip-push / 抛错 / 轮数超限）后随调用栈丢弃；库不读不写、不落库、不打日志。
 *
 * 任务身份：sessionCtx 上直接带 taskId（任务行 id）、taskUuid、occurrenceMs
 * （本次触发的名义时刻，epoch 毫秒）。sessionId 是给日志和去重用的不透明
 * 字符串，别去拆它拿这些值。
 *
 * 工具声明：onBeforeFire 的返回值里可以带 `tools`（OpenAI 的 tools 数组，
 * 另有可选的 `toolChoice`），本次 fire 的每一轮 LLM 请求都原样带上它们——
 * 补完那轮模型仍可能再发起调用。库不看 tools 的内容，执行照旧是
 * executeToolCalls 的事。
 *
 * 自排后续任务：fireCtx 和每轮的 sessionCtx 上都挂着 scheduleTask，宿主用它
 * 在这次 fire 里给同一个用户再建一条定时任务（「这条发完，一个半小时后我再
 * 接着说一句」）。写口在 sessionCtx 上也给，是因为要不要接着说往往是看完
 * LLM 输出才定的，那时 onBeforeFire 早已返回。凭据（apiKey）和投递配置从当前
 * 任务继承、宿主全程看不到（与 buildHookTask 屏蔽凭据同一个原则），宿主只提供
 * 「什么时候、说什么方向」。推送订阅不用继承——它是用户级的一份，新任务到点
 * 投递时读的就是当时最新的那份。
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
import { createStateAccessors } from './state-accessors.js';
import { createResultEmitter } from './result-emitter.js';
import { projectTask } from './task-projection.js';
import { isValidTimeZoneId } from './recurrence.js';
import { resolvePushSubscription } from './push-subscription-store.js';
import {
  hasChatCredRef,
  hasCredRefs,
  resolveFireCredentials,
  resolveLlmCredential as resolveLlmCredentialFromStore,
  supportsLlmCredentialsStore,
} from './llm-credentials-store.js';
import {
  appendPushesToOutbox,
  discardUndeliveredPushes,
  discardUndeliveredPushesForTask,
  markPushesDelivered,
} from './outbox-store.js';
import { shouldSendPush } from './push-policy.js';
import {
  DeploymentConfigError,
  isTaskCancelledError,
  markPermanent,
  markUnrecoverablePartialDelivery,
  NonRetryableError,
  sendTaggedPush,
} from './errors.js';
import { validateTaskPayloadSize } from './validation.js';

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
  const occurrenceMs = occurrenceMsOf(task);
  return occurrenceMs == null ? '' : `@${occurrenceMs}`;
}

/**
 * 本次触发的名义时刻（epoch 毫秒）。行上没有可解析的 next_send_at（比如直接
 * 喂进来的内存任务对象）时返回 null。
 *
 * @param {{ next_send_at?: string }} task
 * @returns {number|null}
 */
export function occurrenceMsOf(task) {
  const occurrenceMs = Date.parse(task && task.next_send_at);
  return Number.isFinite(occurrenceMs) ? occurrenceMs : null;
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
    // 凭据来源有两种：credRefs.chat 引用（fire 时现读 llm_credentials）或
    // 冻结在行里的内联三件套（存量任务）。有任一即走 LLM。
    return hasChatCredRef(decryptedPayload)
      || !!(decryptedPayload.apiUrl && decryptedPayload.apiKey && decryptedPayload.primaryModel);
  }
  return false;
}

/**
 * Frozen, credential-free view of the task for hook authors.
 *
 * nextSendAt 是这条任务原本的触发时刻。run-tick 领取任务时写的是 lease_until，
 * next_send_at 那一列不动，所以这里给出去的和库里的是同一个值——宿主拿它当
 * 时间锚点（窗口判断、缓存键）时对得上。
 *
 * 导出给 run-tick 用：`serializeBy` 要从任务内容里取分组 key，拿到的就该是
 * 这一份（凭据剔掉、和 onBeforeFire 的 ctx.task 同一个形状），宿主不用为了
 * 分组再学第二套字段。
 */
export function buildHookTask(task, decryptedPayload) {
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
  throw markPermanent(
    new TypeError(
      'AGENTIC_BAD_BEFORE_FIRE: onBeforeFire must return ChatMessage[] | { messages, maxToolIterations?, totalTimeoutMs?, tools?, toolChoice? } | { skip: true } | null'
    ),
    'AGENTIC_BAD_BEFORE_FIRE'
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
 *
 *   收尾回执：onBeforeFire 一旦被调用，上面每一种结局（含抛错）都会调一次
 *   `ctx.onFireSettled`，见 notifyFireSettled。
 */
export async function runAgenticFire({ task, decryptedPayload, userKey, ctx }) {
  const hooks = ctx.hooks;
  if (typeof hooks.onLLMOutput !== 'function') {
    throw new DeploymentConfigError(
      'AGENTIC_CONFIG_ERROR: hooks.onBeforeFire requires hooks.onLLMOutput to classify LLM rounds',
      { code: 'AGENTIC_CONFIG_ERROR' }
    );
  }

  // Injectable seams for tests only (fake clock / no real 1500ms pacing).
  const nowFn = typeof ctx._agenticNow === 'function' ? ctx._agenticNow : Date.now;
  const sleep = typeof ctx._agenticSleep === 'function' ? ctx._agenticSleep : defaultSleep;

  // client_state 的读写口。实现与 `GET/PUT /client-state` 共用一份（见
  // lib/state-accessors.js），fire 级和 config 级 hook 拿到的是同一套语义。
  const { readState, writeState } = createStateAccessors({
    db: ctx.db,
    userId: task.user_id,
    userKey,
    maxStateValueBytes: ctx.maxStateValueBytes,
    now: nowFn,
  });

  // 这一次 fire 的三个身份值，整条链共用一份：sessionId 钉在（任务 id + 名义
  // 触发时刻）上，同一 occurrence 的重试复用同一个 session、不同 occurrence 各
  // 一个（见 occurrenceSuffix）。它是给日志和去重用的**不透明 id**，想知道是哪
  // 条任务、哪一次触发，读 sessionCtx 上的 taskId / taskUuid / occurrenceMs，
  // 别去拆它。messageIdBase 同理，是推送与结果两条路的 messageId 前缀——两边
  // 各算一份的话，任务行没有 id 时（instant 那条路）两边会各掷一个随机数。
  const sessionId = task.id != null ? `sess_task_${task.id}${occurrenceSuffix(task)}` : `sess_${randomUUID()}`;
  const messageIdBase = task.id != null ? `msg_task_${task.id}${occurrenceSuffix(task)}` : `msg_${randomUUID()}`;
  const occurrenceMs = occurrenceMsOf(task);

  // 结果出口：把一条宿主自定义的结果落进收件箱并推出去（见
  // lib/result-emitter.js）。与 readState / writeState 同待遇，fire 级和每轮的
  // sessionCtx、以及收尾 hook 上都挂着同一个。
  const { emitResult } = createResultEmitter({
    db: ctx.db,
    task,
    userKey,
    decryptedPayload,
    messageIdBase,
    sessionId,
    occurrenceMs,
    webpush: ctx.webpush,
    now: nowFn,
    // run-tick 在投递 ctx 上挂的取消信号（与 guardWebpushWithLease 读的是同一
    // 个租约状态），emitResult 不发推送的那条路要靠它拦下已取消任务的落行。
    isCancelled: typeof ctx.isTaskCancelled === 'function' ? ctx.isTaskCancelled : null,
  });

  const maxScheduledTasksPerFire =
    Number.isInteger(ctx.maxScheduledTasksPerFire) && ctx.maxScheduledTasksPerFire >= 0
      ? ctx.maxScheduledTasksPerFire
      : DEFAULT_MAX_SCHEDULED_TASKS_PER_FIRE;
  // 本次 fire 已经用掉的建任务额度。校验通过、真的要写库时才 +1，参数不合法的
  // 调用不占额度；uuid 撞车（那条任务其实已经建出来了）照样占。
  let scheduledTaskCount = 0;

  /**
   * 按 uuid 把一条已存在的任务读回来，投影成 `GET /messages` 那份形状。
   * 读不到（行已不是 pending、适配器没有 getTaskByUuid、解密失败）→ null：
   * 这只是给宿主的一份补充信息，不该把整条 fire 拖挂。
   */
  async function readExistingTask(uuid) {
    if (!ctx.db || typeof ctx.db.getTaskByUuid !== 'function') return null;
    try {
      const row = await ctx.db.getTaskByUuid(uuid, task.user_id);
      if (!row) return null;
      const payload = JSON.parse(await decryptFromStorage(row.encrypted_payload, userKey));
      return projectTask(row, payload);
    } catch (error) {
      console.warn('[amsg-server] scheduleTask: 读取撞车任务失败（已忽略）:', error && error.message);
      return null;
    }
  }

  /**
   * scheduleTask(options) —— 在这次 fire 里给**同一个用户**再建一条定时任务。
   *
   * 典型用法：角色发完这条，想过一个半小时再接着说一句。以前只能写进
   * client_state 等客户端上线重放，用户一直不上线这条链就断了；建成任务行之后，
   * 到点由 cron 直接触发，跟别的定时消息一样。
   *
   * 凭据与投递配置（apiUrl / apiKey / primaryModel / maxTokens / temperature /
   * splitPattern）以及 contactName / avatarUrl / messageSubtype / userMessage /
   * tzId 从当前任务继承，宿主只说「什么时候、说什么方向」——hook 全程看不到
   * 凭据。推送订阅是用户级的一份，任务不携带，到点投递时现读。
   * completePrompt / messages 不继承（都置 null），见文件头。
   *
   * @param {Object} options
   * @param {string} options.firstSendTime      - 必填，ISO 8601；至少比现在晚 60 秒
   * @param {'none'|'daily'|'weekly'} [options.recurrenceType='none']
   * @param {string|null} [options.tzId]        - IANA 时区 id，循环推进按这个时区的墙钟走；默认继承当前任务
   * @param {'auto'|'prompted'|'fixed'} [options.messageType]  - 默认继承当前任务
   * @param {Object} [options.metadata]         - 整体替换（不是深合并）当前任务的 metadata
   * @param {string} [options.contactName]      - 默认继承
   * @param {string|null} [options.avatarUrl]   - 默认继承
   * @param {string} [options.messageSubtype]   - 默认继承
   * @param {string|null} [options.userMessage] - 默认继承；messageType 'fixed' 时必须有
   * @param {string} [options.uuid]             - 默认 randomUUID()；传确定性 uuid 可做重试幂等
   * @returns {Promise<{ created: true, id: number|null, uuid: string, nextSendAt: string }
   *   | { created: false, reason: 'duplicate', uuid: string, task: import('./task-projection.js').TaskProjection|null }>}
   *   撞 uuid 时 `task` 是那条已经存在的任务行的投影（与 `GET /messages` 同款
   *   形状，不含任何凭据），宿主据此把它记进自己的任务账本、随 push 带回客户端
   *   认领。行读不回来（已经不是 pending，或适配器没有 getTaskByUuid）→ `null`。
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

    // 循环推进跟着哪个时区的墙钟走。不传就继承当前任务，显式传 null 表示
    // 「按 UTC 推进」。
    const tzId = options.tzId === undefined ? (decryptedPayload.tzId ?? null) : (options.tzId || null);
    if (tzId !== null && !isValidTimeZoneId(tzId)) {
      throw new TypeError(
        `scheduleTask: tzId 必须是可用的 IANA 时区 id（如 Asia/Tokyo），收到 ${JSON.stringify(tzId)}`
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

    // 字段构成与 POST /schedule-message 落库的那份保持一致，只是走库内部、不经 HTTP。
    const fullTaskData = {
      contactName,
      avatarUrl: options.avatarUrl === undefined ? (decryptedPayload.avatarUrl || null) : (options.avatarUrl || null),
      messageType,
      messageSubtype: (options.messageSubtype === undefined ? decryptedPayload.messageSubtype : options.messageSubtype) || 'chat',
      userMessage: userMessage || null,
      firstSendTime: nextSendAt,
      recurrenceType,
      tzId,
      // 凭据继承按 **credRefs.chat** 分支：
      //   - 父带 chat 引用 → 复制整份引用、内联置空（换 Key 只要覆盖
      //     llm_credentials 里那一行，自排链上的后代自动跟随——「自排链传旧
      //     Key」那个洞的修口）；
      //   - 父只带非 chat 引用（如仅 emotion）→ 引用与内联**都**复制：引用归
      //     hook 用途，聊天凭据在内联那份里，只复制引用会造出既无引用可解析
      //     又无内联的空壳后代；
      //   - 父没带引用 → 照旧复制内联三件套。
      ...(hasChatCredRef(decryptedPayload)
        ? {
          apiUrl: null,
          apiKey: null,
          primaryModel: null,
          credRefs: { ...decryptedPayload.credRefs },
        }
        : {
          apiUrl: decryptedPayload.apiUrl || null,
          apiKey: decryptedPayload.apiKey || null,
          primaryModel: decryptedPayload.primaryModel || null,
          credRefs: hasCredRefs(decryptedPayload) ? { ...decryptedPayload.credRefs } : null,
        }),
      // 见文件头：fire-time hook 每次现场重组 prompt，旧 prompt 带过去只会在新
      // 任务走回老链路时顶替宿主的意图。
      completePrompt: null,
      messages: null,
      maxTokens: decryptedPayload.maxTokens ?? null,
      temperature: decryptedPayload.temperature ?? null,
      splitPattern: decryptedPayload.splitPattern ?? null,
      // 与凭据同列的投递配置：中转的非标准参数（thinking 之类）跟着任务走，
      // 自排的后续任务不该突然掉档。
      llmExtraBody: decryptedPayload.llmExtraBody ?? null,
      metadata,
    };

    // 与 POST /schedule-message 同一道闸门：任务内容太大在这里就说清楚，别等
    // 落库时撞上存储的单行上限、抛一句看不出所以然的错。hook 往 metadata 里塞
    // 一坨大对象是最容易撞上的。
    //
    // 位置排在额度之前，跟其余参数护栏（contactName / uuid / tzId / …）一致：
    // 正文超限也是「这次调用的参数不合法」，不该烧掉一次建任务额度——hook 捕获
    // 之后换份小 metadata 重排时，会莫名其妙撞上「单次 fire 最多建 N 条」。
    const serializedTaskData = JSON.stringify(fullTaskData);
    const sizeError = validateTaskPayloadSize(serializedTaskData);
    if (sizeError) {
      throw markPermanent(
        new RangeError(`${sizeError.code}: ${sizeError.message}`),
        sizeError.code
      );
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
      throw new DeploymentConfigError(
        'AGENTIC_SCHEDULE_UNSUPPORTED: 当前数据库适配器不支持建任务（缺 createTask）',
        { code: 'AGENTIC_SCHEDULE_UNSUPPORTED' }
      );
    }
    scheduledTaskCount++;

    const encryptedPayload = await encryptForStorage(serializedTaskData, userKey);

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
      // 时刻推出来的那种）就天然幂等，重试不会多排一条。重跑那轮要能拿到已经
      // 存在的那条任务，否则这条任务只活在数据库里——宿主的面板列不出、用户
      // 取消不了，却照样到点触发。
      if (isUniqueViolation(error)) {
        return {
          created: false,
          reason: 'duplicate',
          uuid,
          task: await readExistingTask(uuid),
        };
      }
      throw error;
    }
    if (!created) {
      throw new NonRetryableError(
        'AGENTIC_SCHEDULE_FAILED: createTask 没有返回新建的任务行',
        { code: 'AGENTIC_SCHEDULE_FAILED' }
      );
    }
    return {
      created: true,
      id: created.id ?? null,
      uuid: created.uuid ?? uuid,
      nextSendAt: created.next_send_at ?? nextSendAt,
    };
  };

  /**
   * cancelTask(uuid) —— 取消同一个用户的一条 pending 任务。
   *
   * 有了 scheduleTask 却没有它，云端轮的角色「看得见任务、动不了」：用户说
   * 「取消那个提醒」，角色只能口头答应，任务照旧触发。语义与
   * `DELETE /cancel-message` 完全一致（按 uuid + user_id 删行），只是给 fire
   * 内的工具循环用。
   *
   * 不允许取消**当前正在 fire 的这条**：它的收尾（删行 / 推进排期 / 标失败）
   * 归 run-tick 管，fire 中途从底下抽掉行会让收尾写库踩空。当前这条不想发，
   * 用 onBeforeFire 的 `{ skip: true }` 或 onLLMOutput 的 `skip-push`。
   *
   * @param {string} uuid
   * @returns {Promise<{ cancelled: boolean }>} cancelled=false 表示行不存在
   *   （已发出 / 已删除）——对「用户要它别响」来说结果已达成，不算错误。
   */
  const cancelTask = async (uuid) => {
    if (typeof uuid !== 'string' || !uuid.trim()) {
      throw new TypeError('cancelTask(uuid) 需要非空字符串 uuid');
    }
    if (task.uuid != null && uuid === task.uuid) {
      throw new RangeError(
        'cancelTask: 不能取消当前正在 fire 的任务——这条的收尾归 run-tick 管。' +
        "这次不想发的话，用 onBeforeFire 的 { skip: true } 或 onLLMOutput 的 'skip-push'。"
      );
    }
    if (!ctx.db || typeof ctx.db.deleteTaskByUuid !== 'function') {
      throw new DeploymentConfigError(
        'AGENTIC_CANCEL_UNSUPPORTED: 当前数据库适配器不支持删任务（缺 deleteTaskByUuid）',
        { code: 'AGENTIC_CANCEL_UNSUPPORTED' }
      );
    }
    const cancelled = await ctx.db.deleteTaskByUuid(uuid, task.user_id);
    if (cancelled) {
      // 与 DELETE /cancel-message 同一收尾：那条任务此前投递到一半失败过的话，
      // 没发出去的分段还躺在 outbox 里等重试，行删了它们不会跟着走——不撤掉的
      // 话客户端下一次 GET /outbox 照样把已取消任务的内容补收回去。
      // best-effort：清不掉不翻掉这次取消（行已经删了）。
      await discardUndeliveredPushesForTask({ db: ctx.db, userId: task.user_id, taskUuid: uuid });
    }
    return { cancelled: !!cancelled };
  };

  /**
   * renewTask(uuid, nextSendAt) —— 把同一个用户的一条 pending 任务改到新的
   * 触发时刻（「那个提醒推迟到明早九点」）。语义与 `PUT /update-message` 只改
   * nextSendAt 一致：payload 里的 firstSendTime 跟着改、重试计数清零、退避
   * 放掉。护栏与 scheduleTask 相同：新时刻至少比现在晚 60 秒。
   *
   * @param {string} uuid
   * @param {string} nextSendAt - ISO 8601
   * @returns {Promise<{ renewed: true, uuid: string, nextSendAt: string }
   *   | { renewed: false, reason: 'not_found' | 'in_flight' }>}
   *   not_found = 行不存在或已不是 pending（宿主自己决定要不要转头 scheduleTask
   *   一条新的）；in_flight = 那条任务此刻正被一次投递占着，排期没改动——它正要
   *   发出去，收尾会按自己那份排期推进，硬改进去也留不住。宿主想推迟的那次已经
   *   在路上了，通常没什么好补救的；真要顺延下一次，等这次发完再调一遍。
   */
  const renewTask = async (uuid, nextSendAt) => {
    if (typeof uuid !== 'string' || !uuid.trim()) {
      throw new TypeError('renewTask(uuid, nextSendAt) 需要非空字符串 uuid');
    }
    if (task.uuid != null && uuid === task.uuid) {
      throw new RangeError('renewTask: 不能改当前正在 fire 的任务——这条的排期推进归 run-tick 管');
    }
    if (typeof nextSendAt !== 'string' || !nextSendAt.trim()) {
      throw new RangeError('renewTask: nextSendAt 必填，且必须是 ISO 8601 字符串');
    }
    const sendAt = new Date(nextSendAt);
    if (Number.isNaN(sendAt.getTime())) {
      throw new RangeError(`renewTask: nextSendAt 解析不出合法时间：${nextSendAt}`);
    }
    const earliest = nowFn() + MIN_SCHEDULE_LEAD_MS;
    if (sendAt.getTime() < earliest) {
      throw new RangeError(
        `renewTask: nextSendAt 至少要比现在晚 ${MIN_SCHEDULE_LEAD_MS / 1000} 秒` +
        `（最早可排 ${new Date(earliest).toISOString()}，收到 ${sendAt.toISOString()}）`
      );
    }
    if (!ctx.db || typeof ctx.db.getTaskByUuid !== 'function' || typeof ctx.db.updateTaskByUuid !== 'function') {
      throw new DeploymentConfigError(
        'AGENTIC_RENEW_UNSUPPORTED: 当前数据库适配器不支持改任务（缺 getTaskByUuid / updateTaskByUuid）',
        { code: 'AGENTIC_RENEW_UNSUPPORTED' }
      );
    }
    const row = await ctx.db.getTaskByUuid(uuid, task.user_id);
    if (!row) return { renewed: false, reason: 'not_found' };
    // payload 里的 firstSendTime 跟排期一起改（与 PUT /update-message 的读-改-
    // 写同构），两处时刻不漂移。
    const payload = JSON.parse(await decryptFromStorage(row.encrypted_payload, userKey));
    const nextSendAtIso = sendAt.toISOString();
    const encrypted = await encryptForStorage(JSON.stringify({ ...payload, firstSendTime: nextSendAtIso }), userKey);
    const updated = await ctx.db.updateTaskByUuid(uuid, task.user_id, encrypted, {
      next_send_at: nextSendAtIso,
      retry_count: 0,
      ...(typeof ctx.db.claimTask === 'function' ? { retry_after: null } : {}),
    });
    if (!updated) {
      // 行还在、还是 pending 的话，改不动的原因是它正被一次投递占着。
      const stillPending = await ctx.db.getTaskByUuid(uuid, task.user_id);
      return { renewed: false, reason: stillPending ? 'in_flight' : 'not_found' };
    }
    return { renewed: true, uuid, nextSendAt: nextSendAtIso };
  };

  /**
   * resolveLlmCredential(credId) —— 按 cred_id 现读一份凭据，每次调用返回
   * **新对象**；没有这行 / 适配器不支持 → null。宿主 hook 用它取非 chat 用途
   * 的副 API（如情绪评估），凭据从此不必随 metadata 走。
   *
   * 红线：拿到就用（当场发请求），**不得**把结果挂到 ctx / task / metadata /
   * push 上——那些对象会流向 hook 与 push，凭据跟着走就把
   * CREDENTIAL_PAYLOAD_KEYS 那道防线绕空了。
   */
  const resolveLlmCredential = async (credId) => {
    if (typeof credId !== 'string' || !credId.trim()) {
      throw new TypeError('resolveLlmCredential(credId) 需要非空字符串 credId');
    }
    if (!supportsLlmCredentialsStore(ctx.db)) return null;
    return resolveLlmCredentialFromStore({ db: ctx.db, userId: task.user_id, userKey, credId });
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
    emitResult,
    scheduleTask,
    cancelTask,
    renewTask,
    resolveLlmCredential,
    now: new Date(nowFn()),
    scratch,
  });

  // 本次 fire 的进度。收尾回执（onFireSettled）要照实说「发出去几段、跑了几
  // 轮、为什么没发、花了多少」，而这些数字在半路抛错时是拿不到返回值的，只能一
  // 路记在这里。
  //   - usage：最后一轮 LLM 响应的 usage（没跑到 LLM → null）；
  //   - usageTotal：本次 fire 所有轮次的 usage 相加（见 accumulateUsage）；
  //   - llmCalls：实际发出去的 LLM 请求数，失败的那一次也算；
  //   - outboxed：finish 的整批是否已经落进了 outbox（落定之后推送再失败，重试
  //     只补推送、不重新生成，见 lib/message-processor.js 的 redeliverCommittedBatch）。
  const progress = {
    sentCount: 0,
    pushedCount: 0,
    total: 0,
    iterations: 0,
    skipReason: null,
    usage: null,
    usageTotal: null,
    llmCalls: 0,
    outboxed: false,
  };

  // 结局默认按 failed 记：下面只要有任何一步抛出去，finally 里发出的就是这个。
  let settledStatus = 'failed';
  let settledError = null;
  try {
    const outcome = await runFireChain({
      task, decryptedPayload, userKey, ctx, hooks, nowFn, sleep,
      readState, writeState, emitResult, scratch, scheduleTask, cancelTask, renewTask,
      resolveLlmCredential, fireCtx, progress,
      sessionId, messageIdBase, occurrenceMs,
    });
    settledStatus = !outcome.handled
      ? 'not-handled'
      : (outcome.result.status === 'skipped' ? 'skipped' : 'sent');
    return outcome;
  } catch (error) {
    settledError = error;
    throw error;
  } finally {
    await notifyFireSettled(ctx, {
      task,
      status: settledStatus,
      skipReason: settledStatus === 'skipped' ? progress.skipReason : null,
      sentCount: progress.sentCount,
      pushedCount: progress.pushedCount,
      total: progress.total,
      iterations: progress.iterations,
      error: settledError,
      // 解密 payload 里的 metadata 子字段（与 onStaleSkip 同待遇）：task 行本
      // 身是密文，宿主要靠它对上「这是哪个角色的哪类任务」——尤其是 fire 在
      // onBeforeFire 里就失败、宿主还没来得及自己记账的那种结局。凭据字段
      // （apiKey / pushSubscription）照旧不透传。
      metadata: decryptedPayload.metadata ?? null,
      // 最后一轮 LLM 响应的 usage（prompt/completion tokens；没跑到 LLM →
      // null）。宿主拿它更新用量记账，不用从 llmResponse 里自己扒。
      usage: progress.usage,
      // 整次 fire 的用量：所有轮次的 token 相加、实际发了几次 LLM 请求（失败
      // 的那次也算）。失败结局一样带——「失败也花了钱」宿主要记得上。
      usageTotal: progress.usageTotal,
      llmCalls: progress.llmCalls,
      // finish 的整批已经落进 outbox 了吗。true 时客户端补收一定拿得到全部
      // total 段，推送没发完的那部分库会在重试时补推、不会重新生成。
      outboxed: progress.outboxed,
      scratch,
      readState,
      writeState,
      emitResult,
    });
  }
}

/**
 * 一次 fire 的主链：onBeforeFire → LLM 轮次 → finish / skip-push / 工具循环。
 * 拆出来只是为了让 runAgenticFire 能在外面用一个 try/finally 兜住所有结局，
 * 保证 onFireSettled 一次不漏。
 *
 * @returns {Promise<{ handled: false } | { handled: true, result: Object }>}
 */
async function runFireChain({
  task, decryptedPayload, userKey, ctx, hooks, nowFn, sleep,
  readState, writeState, emitResult, scratch, scheduleTask, cancelTask, renewTask,
  resolveLlmCredential, fireCtx, progress,
  sessionId, messageIdBase, occurrenceMs,
}) {
  const before = await hooks.onBeforeFire(fireCtx);
  if (before == null) return { handled: false };

  // Pre-LLM skip: the host judged this fire moot before generation (e.g. the
  // conversation moved on after the task was scheduled). Shaped exactly like
  // the post-LLM 'skipped' result, so run-tick's success handling (delete
  // once-off / advance recurrence) applies unchanged — and zero tokens spent.
  if (typeof before === 'object' && before.skip === true) {
    progress.skipReason = 'before-fire';
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

  let messages = normalized.messages.slice();

  // chat 凭据进循环前解析一次（多轮共用同一份；credRefs.chat 缺席时是 null，
  // 存量内联任务零开销）。解析结果只合进每轮传给 callLlm 的请求对象，不写回
  // decryptedPayload——那份会流向 hook 与 push。解析不到（行被删且无内联兜底）
  // 抛 CREDENTIAL_MISSING，走任务的常规失败/重试。
  const chatCred = await resolveFireCredentials({
    db: ctx.db, userId: task.user_id, userKey, decryptedPayload,
  });

  for (let iteration = 0; iteration < maxToolIterations; iteration++) {
    if (nowFn() >= deadline) {
      throw new Error(`AGENTIC_TOTAL_TIMEOUT: fire chain exceeded ${totalTimeoutMs}ms after ${iteration} LLM round(s)`);
    }
    progress.iterations = iteration + 1;

    // Shrink each round's fetch timeout to the remaining wall-time budget
    // (capped at the legacy 300s single-call ceiling) — a hung LLM request
    // must not outlive totalTimeoutMs waiting for its own 300s abort.
    const roundTimeoutMs = Math.max(1, Math.min(300_000, deadline - nowFn()));
    // 发请求之前就记一次：这一轮失败了（上游拒了、超时）请求也已经发出去了，
    // 宿主记账要算上它。
    progress.llmCalls++;
    const { response: llmResponse } = await callLlm(
      {
        ...decryptedPayload,
        ...(chatCred || {}),
        messages,
        ...(normalized.tools ? { tools: normalized.tools, toolChoice: normalized.toolChoice } : {}),
      },
      { requireContent: false, timeoutMs: roundTimeoutMs }
    );

    const assistantMessage = extractAssistantMessage(llmResponse);
    messages = [...messages, assistantMessage];
    // usage 每轮覆盖（settle 时报出去的就是最后一轮的，语义不变）；usageTotal
    // 逐轮累加，是整次 fire 的花费。
    progress.usage = (llmResponse && typeof llmResponse === 'object' && llmResponse.usage) || null;
    progress.usageTotal = accumulateUsage(progress.usageTotal, progress.usage);

    // 共享的 SessionContext（与 amsg-instant 同形状）之上，再挂任务身份、
    // 两个状态访问器和 scheduleTask：
    //   - taskId / taskUuid / occurrenceMs 直接给，是因为「这轮输出属于哪条
    //     任务的哪一次触发」是宿主写回执、对账时的必备信息，不该靠拆
    //     sessionId 的字符串拿；
    //   - 大内容要不要旁路存、要不要给自己排条后续，往往到工具跑完、组 push
    //     时才知道，而那正是 onLLMOutput / executeToolCalls 的位置，
    //     onBeforeFire 早就返回了。
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
      taskId: task.id ?? null,
      taskUuid: task.uuid ?? null,
      occurrenceMs,
      readState,
      writeState,
      emitResult,
      scheduleTask,
      cancelTask,
      renewTask,
      resolveLlmCredential,
    });

    const decision = await hooks.onLLMOutput(sessionCtx);
    try {
      assertValidDecision(decision, { inlineToolCalls: true });
    } catch (error) {
      // 决策形状不合契约：宿主的分类器返回了库不认的东西，重试必然同败。
      // 标成确定性失败之前保住它原本的 TypeError 身份（宿主可能按类型分流）。
      throw markPermanent(error, 'AGENTIC_BAD_DECISION');
    }

    if (decision.decision === 'continue') {
      messages = decision.nextHistory.slice();
      continue;
    }

    if (decision.decision === 'skip-push') {
      progress.skipReason = 'skip-push';
      return { handled: true, result: { success: true, messagesSent: 0, status: 'skipped', iterations: iteration + 1 } };
    }

    if (decision.decision === 'finish') {
      const messagesSent = await sendHookPushPayloads({
        pushPayloads: decision.pushPayloads,
        decryptedPayload,
        ctx,
        sessionId,
        messageIdBase,
        occurrenceMs,
        task,
        userKey,
        sleep,
        scratch,
        readState,
        writeState,
        emitResult,
        progress,
      });
      return { handled: true, result: { success: true, messagesSent, status: 'finished', iterations: iteration + 1 } };
    }

    // 'tool-request' — execute right here in the worker.
    const toolCalls = extractToolCallsFromDecision(decision);
    if (toolCalls.length === 0) {
      // 留在退避阶梯里：这一轮模型没吐出能解析的 tool_calls，是这次生成的结果，
      // 不是部署配置错了。判成终态的话，一次性任务第一次掷歪就永久 failed，而
      // 且行离开 pending 之后连 PUT 都救不回来（409 TASK_ALREADY_COMPLETED）。
      throw taggedRetryableError(
        'AGENTIC_EMPTY_TOOL_REQUEST: tool-request decision carried no toolCalls (neither decision.toolCalls nor pushPayloads[].toolCalls)',
        'AGENTIC_EMPTY_TOOL_REQUEST'
      );
    }
    if (typeof hooks.executeToolCalls !== 'function') {
      throw new DeploymentConfigError(
        'AGENTIC_CONFIG_ERROR: onLLMOutput returned tool-request but hooks.executeToolCalls is not configured',
        { code: 'AGENTIC_CONFIG_ERROR' }
      );
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

  // 同样留在退避阶梯里：把回合数用光是模型这一轮的走向，隔两分钟重掷一次通常
  // 就正常收尾了。
  throw taggedRetryableError(
    `AGENTIC_LOOP_EXCEEDED: no finish/skip-push decision within ${maxToolIterations} LLM round(s)`,
    'AGENTIC_LOOP_EXCEEDED'
  );
}

/**
 * 带 `code` 的普通错误——会走 run-tick 的重试阶梯。
 *
 * 跟 {@link NonRetryableError} 的分界线：错误只跟「这一次生成掷出了什么」有关
 * 就用这个（重掷一次多半就好了），跟部署配置 / 宿主 hook 契约有关才用那个。
 *
 * @param {string} message
 * @param {string} code
 * @returns {Error}
 */
function taggedRetryableError(message, code) {
  const error = new Error(message);
  /** @type {any} */ (error).code = code;
  return error;
}

/**
 * ctx.onAfterSend?.({ task, sentCount, pushedCount, total, error, usage,
 * usageTotal, llmCalls, outboxed, scratch, readState, writeState }) —— 推送发
 * 出（或发挂）之后的可选 hook。发送前的 hook
 * （onBeforeFire / onLLMOutput）只能在推送发出前写副作用，LLM 成功但推送全挂
 * 时会「云端记得说过、用户没收到」；宿主要把「真的发出去了几段」写回自己的
 * 存储，就挂这个。
 *
 * 载荷各字段：
 *   - task：任务行本身（tick 内最多 8 个任务并发投递，回执要靠它对号入座）
 *   - sentCount / total：这批走完了几段、一共几段。`sentCount === total` 就是
 *     整批都到位了
 *   - pushedCount：这几段里真的占用了推送通道的有几条。到了客户端不会弹通知
 *     的段默认只落收件箱、不推送（见 lib/push-policy.js），那种段照样计进
 *     sentCount，但不计 pushedCount
 *   - error：全部成功为 null；第 k 段失败时 sentCount = k、error 带原始错误，
 *     且 hook 会在错误往上抛之前调用完
 *   - scratch：本次 fire 的便签对象，与 onBeforeFire / onLLMOutput 拿到的是
 *     同一个引用——「这次生成了哪几段正文」之类的上下文直接从这里读
 *   - readState / writeState：与 fire 级 hook 同一套 client_state 读写口
 *   - usage：最后一轮 LLM 响应的 usage（prompt/completion tokens；没有 → null）
 *   - usageTotal：本次 fire 所有 LLM 轮次的 usage 相加
 *     `{ prompt_tokens, completion_tokens, total_tokens }`（形状不齐时尽量相加，
 *     见 accumulateUsage；所有轮次都没报 → null）
 *   - llmCalls：本次 fire 实际发出的 LLM 请求数（失败的那次也算）
 *   - outboxed：这一批是否已经整批落进了 outbox。true 时客户端补收一定拿得到全
 *     部 total 段——推送发挂了的那部分，库在任务重试时只补推送、不重新生成，重
 *     试那一跳也不会再调这个 hook。false（适配器没有 outbox、或落行失败）时推
 *     送是唯一的腿：一条都没推出去的照旧重试（会重新生成），已经推出去几条的就
 *     地终审（error.permanent 为 true），免得客户端拼出两份内容
 *
 * hook 自身抛错只 console.warn，不影响主流程。
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
 * ctx.onFireSettled?.({ task, status, skipReason, sentCount, pushedCount,
 * total, iterations, error, metadata, usage, usageTotal, llmCalls, outboxed,
 * scratch, readState, writeState })
 * —— 一次 fire 收尾的可选 hook。**onBeforeFire 被调用过，这个就一定会被调用
 * 一次**，无论这次是发完了、跳过了、还是半路抛错。
 *
 * sentCount 是这批走完了几段，pushedCount 是其中真的占用了推送通道的有几条
 * （不会弹通知的段默认只落收件箱，见 lib/push-policy.js）。
 *
 * metadata 是解密 payload 里的 metadata 子字段（与 onStaleSkip 同待遇）：
 * task 行本身是密文，宿主要靠它对上「这是哪个角色的哪类任务」——尤其是链路
 * 在 onBeforeFire 里就失败、宿主还没来得及自己记账的那种结局。usage 是最后
 * 一轮 LLM 响应的 usage（没跑到 LLM → null）。凭据字段照旧不透传。
 *
 * 用量按整次 fire 算的两个字段，每种结局都带（失败也花了钱）：
 *   - usageTotal：所有 LLM 轮次的 usage 相加，形状固定
 *     `{ prompt_tokens, completion_tokens, total_tokens }`，形状不齐时尽量相加
 *     （见 accumulateUsage）；一轮都没报 usage（或没跑到 LLM）→ null；
 *   - llmCalls：实际发出的 LLM 请求数，失败的那次也算；没跑到 LLM → 0。
 *
 * outboxed：finish 的整批是否已经落进了 outbox（没走到 finish → false）。含义
 * 见 notifyAfterSend。status 为 `failed` 而 outboxed 为 true，说明内容已经生成
 * 并落定、只是推送没发完：客户端补收拿得到全部 total 段，库重试时只补推送、不
 * 重新生成，补推那一跳也不再调这个 hook。
 *
 * error.permanent === true 表示这次失败一跳终审、不会再重试：hook 抛的
 * NonRetryableError、LLM 上游明确拒了这次请求（401 / 403 / 400 …，见
 * lib/errors.js 的 isPermanentLlmFailure），以及没落进 outbox 的批次推到一半
 * 失败。反过来不成立：推送服务回 404 / 410 / 413、订阅没登记这几种也是一跳终
 * 审，但判定在投递侧（lib/errors.js 的 isPermanentDeliveryFailure），错误对象
 * 上不带 permanent。
 *
 * 有了 onAfterSend 为什么还要它：onAfterSend 只在「有 push 要发」这条路上
 * 走。hook 判断这次不用说话（`{ skip: true }` / `skip-push`）、或者链路中途
 * 抛错时，宿主收不到任何收尾信号——于是「开始时占点什么、结束时放掉」的写法
 * 必然漏。典型两种：fire 里用 ctx.scheduleTask 建出来的任务已经真的写进库
 * 了，但记账的代码挂在发送后，这次没发成就没人记，那条任务从此只活在数据库
 * 里；以及 fire 开头拿的锁没有可靠的释放点，一次 skip 就把资源占满整个 TTL。
 *
 * status 四种：
 *   - `sent`        —— pushPayloads 全部发完（sentCount === total）
 *   - `skipped`     —— 这次不发。skipReason 区分是 onBeforeFire 直接
 *                      `{ skip: true }`（`'before-fire'`），还是模型跑完之后
 *                      判定不发（`'skip-push'`）
 *   - `failed`      —— 链路抛错，error 带原始错误。部分失败也是这个：发到第
 *                      k 段挂了 → sentCount = k、total 是原本要发的段数
 *   - `not-handled` —— onBeforeFire 返回 null，这条任务交还给排程时冻结的
 *                      prompt 老链路。那条链路不归 fire hook 管，所以它后面
 *                      发没发出去不体现在这里
 *
 * 与 onAfterSend 的关系：正常发完时两个都会调，onAfterSend 在前。
 * 没配 hooks 的部署、以及不需要 LLM 的固定文本任务不走 fire 这条路径，两个
 * hook 都不会调。
 *
 * hook 自身抛错只 console.warn，不影响主流程（收尾回执挂掉不该把一次成功的
 * 投递变成失败）。
 */
async function notifyFireSettled(ctx, info) {
  if (typeof ctx.onFireSettled !== 'function') return;
  try {
    await ctx.onFireSettled(info);
  } catch (hookError) {
    console.warn('[amsg-server] onFireSettled hook 抛错（已忽略）:', hookError && hookError.message);
  }
}

/**
 * 把任务的调度身份投影进一条 push。
 *
 * 客户端收到推送时要知道「这是哪条任务、哪一次触发、它还会不会再来」——不然
 * 角色在 fire 里自排的任务客户端从没见过，只能靠猜。这三个字段由库统一补，
 * 宿主不用再往 metadata 里抄一遍（抄漏一个就够坏事了）。
 *
 * 放在 push 顶层，和 messageId / sessionId / timestamp / messageIndex /
 * totalMessages 一样，不塞进 metadata：metadata 是宿主自己的地盘，库往里写
 * 会和宿主的键打架。
 *
 * @param {Object} push - 待发送的 push（原地补字段）
 * @param {Object} task - 数据库任务行
 * @param {Object} decryptedPayload
 * @param {number|null} occurrenceMs
 */
function stampTaskIdentity(push, task, decryptedPayload, occurrenceMs) {
  push.taskId = task.id ?? null;
  push.taskUuid = task.uuid ?? null;
  push.recurrenceType = decryptedPayload.recurrenceType || 'none';
  push.occurrenceMs = occurrenceMs;
}

/**
 * Deliver the hook's pushPayloads sequentially. Mirrors instant's
 * sendPushesSequentially: force-overwrite messageIndex/totalMessages,
 * stamp missing ids, pace with the same 1500ms spacing. Ids are
 * deterministic per (task, occurrence, index) so a retried occurrence
 * reuses the same ids and clients can dedupe (see occurrenceSuffix)。
 * 调用方显式带了 messageId / sessionId 时以调用方为准，只有缺省值掺
 * occurrence。任务的调度身份（taskId / taskUuid / recurrenceType /
 * occurrenceMs）由库覆盖写，调用方带了也以库为准——它描述的是任务行的事实，
 * 不是内容。
 *
 * 这批字段加起来占的字节由 PUSH_ENVELOPE_RESERVED_BYTES 兜住（见
 * lib/webpush-webcrypto.js）：hook 组 payload 时要按那个额度预算，不然会
 * 「量的时候装得下、补完字段就超了」。
 */
async function sendHookPushPayloads({
  pushPayloads,
  decryptedPayload,
  ctx,
  sessionId,
  messageIdBase,
  occurrenceMs,
  task,
  userKey,
  sleep,
  scratch,
  readState,
  writeState,
  emitResult,
  progress,
}) {
  const total = pushPayloads.length;
  let sentCount = 0;
  /** 这批里真的占用了推送通道的条数（其余只落收件箱，见 lib/push-policy.js）。 */
  let pushedCount = 0;
  progress.total = total;
  // LLM 轮次到这里已经全部跑完，用量是最终值。
  const afterSendBase = {
    task,
    total,
    scratch,
    readState,
    writeState,
    emitResult,
    usage: progress.usage,
    usageTotal: progress.usageTotal,
    llmCalls: progress.llmCalls,
  };
  const sentIds = [];
  /** 定稿后的整批 push（发送前就落进 outbox 的那一份）。取消收尾要按它撤行。 */
  const finalized = [];
  /** 这一批落进 outbox 没有。落进去了，这次触发的内容就定了（见 progress.outboxed）。 */
  let outboxed = false;
  try {
    // 先定稿整批（补 id / index / 任务身份），再发送——发送前整批落进
    // message_outbox（客户端补收的事实来源，best-effort，见 lib/outbox-store.js），
    // 落的必须是发送时的同一份内容。
    //
    // 落行排在查 VAPID / 订阅之前：生成已经成功了，之后的任何一步失败（订阅那
    // 一下读库超时、VAPID 暂时没配齐……）都只该重试投递，而「只重试投递」的前提
    // 是这一批已经落定在 outbox 里（见 lib/message-processor.js 的
    // redeliverCommittedBatch）。反过来排的话，这些失败会让重试把整条生成再跑一遍。
    for (let i = 0; i < total; i++) {
      const push = { ...pushPayloads[i] };
      if (typeof push.messageId !== 'string' || !push.messageId) push.messageId = `${messageIdBase}_hook_${i}`;
      if (typeof push.sessionId !== 'string' || !push.sessionId) push.sessionId = sessionId;
      if (typeof push.timestamp !== 'string' || !push.timestamp) push.timestamp = new Date().toISOString();
      push.messageIndex = i + 1;
      push.totalMessages = total;
      stampTaskIdentity(push, task, decryptedPayload, occurrenceMs);
      finalized.push(push);
    }
    outboxed = await appendPushesToOutbox({ db: ctx.db, userId: task.user_id, userKey, pushes: finalized });
    progress.outboxed = outboxed;

    if (!ctx.vapid || !ctx.vapid.email || !ctx.vapid.publicKey || !ctx.vapid.privateKey) {
      throw new Error('VAPID configuration missing - push notifications cannot be sent');
    }
    // 用户级订阅，投递时现读（任务行不携带它）。升级前创建的任务把订阅冻结
    // 在 payload 里，用户级存储没有时兜底用那一份。
    const pushSubscription = await resolvePushSubscription({
      db: ctx.db,
      userId: task.user_id,
      userKey,
      legacyFallback: (decryptedPayload && decryptedPayload.pushSubscription) ?? null,
    });

    // 到了客户端不会弹通知的那些（hook 发的 tool_request / error，或者显式
    // `notification: { show: false }` 的）不推，只留在 outbox 里等客户端补
    // 拉——推过去等于白违约一次 `userVisibleOnly` 的约定，而内容一个字不少。
    // 见 lib/push-policy.js。
    const pushGate = { outboxed };
    const willPush = finalized.map(push => shouldSendPush(push, pushGate));
    // 段间节流是给推送服务留的，最后一条真正要推的之后没必要再等。
    const lastPushIndex = willPush.lastIndexOf(true);

    for (let i = 0; i < total; i++) {
      if (willPush[i]) {
        await sendTaggedPush(ctx.webpush, pushSubscription, JSON.stringify(finalized[i]));
        pushedCount++;
        progress.pushedCount = pushedCount;
        sentIds.push(finalized[i].messageId);
      }
      // 只落收件箱的那几条也算这一批处理过了：sentCount 是「这批走到第几条」，
      // 宿主拿 sentCount === total 判整批跑完没有，跳过推送不该让它看起来像半
      // 途失败。真正占用了推送通道的条数在 pushedCount 里。
      sentCount++;
      progress.sentCount = sentCount;
      if (willPush[i] && i < lastPushIndex) await sleep(SLEEP_BETWEEN_MESSAGES_MS);
    }
  } catch (error) {
    // 这一批没落进 outbox、又已经推出去了几条：重试只能重新生成，客户端会拼出
    // 两份内容，所以就地判终审（见 lib/errors.js 的
    // markUnrecoverablePartialDelivery）。放在通知宿主之前，onAfterSend /
    // onFireSettled 看到的 error.permanent 与投递侧的处置一致。
    markUnrecoverablePartialDelivery(error, { outboxed, pushedCount });
    // 部分失败：已发出的段在 outbox 里标 delivered（没标的正是要补收的），
    // 再让宿主知道已经发出去了几段——先通知，再把错误往上抛。
    await markPushesDelivered({ db: ctx.db, userId: task.user_id, messageIds: sentIds });
    if (isTaskCancelledError(error)) {
      // 投递到一半任务被取消 / 顶替：剩下这几条不会再发了，行也别留着——留着
      // 客户端会从 GET /outbox 把它们补收回去（见 lib/outbox-store.js）。
      await discardUndeliveredPushes({
        db: ctx.db, userId: task.user_id, pushes: finalized, sentIds,
      });
    }
    await notifyAfterSend(ctx, { ...afterSendBase, sentCount, pushedCount, outboxed, error });
    throw error;
  }
  await markPushesDelivered({ db: ctx.db, userId: task.user_id, messageIds: sentIds });
  await notifyAfterSend(ctx, { ...afterSendBase, sentCount, pushedCount, outboxed, error: null });
  return total;
}

/**
 * 把这一轮的 usage 累加进整次 fire 的合计，返回新的合计（不改传入的对象）。
 *
 * 合计的形状固定是 `{ prompt_tokens, completion_tokens, total_tokens }`，每个字
 * 段是「报过这一项的那几轮」相加的结果，一轮都没报过的那一项是 null。各家供应
 * 商的 usage 形状不齐，能加的尽量加：
 *   - prompt / completion 认 OpenAI 的 `prompt_tokens` / `completion_tokens`，
 *     没有就认 Anthropic 风格的 `input_tokens` / `output_tokens`；
 *   - 这一轮没报 `total_tokens`、但 prompt 和 completion 都有，就拿两者之和补上；
 *   - 只收有限的非负数，别的一律当没报。
 *
 * 这一轮三项都拿不到（没有 usage，或者形状完全认不出）就原样返回之前的合计——
 * 所有轮次都这样的话合计保持 null。
 *
 * @param {{ prompt_tokens: number|null, completion_tokens: number|null, total_tokens: number|null } | null} total
 * @param {unknown} usage - 这一轮 LLM 响应的 usage
 * @returns {{ prompt_tokens: number|null, completion_tokens: number|null, total_tokens: number|null } | null}
 */
export function accumulateUsage(total, usage) {
  if (!usage || typeof usage !== 'object') return total;
  const prompt = readTokenCount(usage, ['prompt_tokens', 'input_tokens']);
  const completion = readTokenCount(usage, ['completion_tokens', 'output_tokens']);
  let totalTokens = readTokenCount(usage, ['total_tokens']);
  if (totalTokens === null && prompt !== null && completion !== null) totalTokens = prompt + completion;
  if (prompt === null && completion === null && totalTokens === null) return total;

  const base = total || { prompt_tokens: null, completion_tokens: null, total_tokens: null };
  return {
    prompt_tokens: addTokenCount(base.prompt_tokens, prompt),
    completion_tokens: addTokenCount(base.completion_tokens, completion),
    total_tokens: addTokenCount(base.total_tokens, totalTokens),
  };
}

/**
 * @param {Object} usage
 * @param {string[]} keys - 按顺序认，取第一个是有限非负数的
 * @returns {number|null}
 */
function readTokenCount(usage, keys) {
  for (const key of keys) {
    const value = /** @type {Record<string, unknown>} */ (usage)[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

/**
 * @param {number|null} sum
 * @param {number|null} value
 * @returns {number|null}
 */
function addTokenCount(sum, value) {
  if (value === null) return sum;
  return (sum ?? 0) + value;
}

export { stampTaskIdentity };
