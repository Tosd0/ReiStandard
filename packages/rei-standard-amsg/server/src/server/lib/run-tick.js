/**
 * Scheduled tick core: fetch due tasks, deliver, reschedule/retry, cleanup.
 * Extracted verbatim from the send-notifications handler so both the HTTP
 * handler (multi-tenant) and the CF scheduled() path (single-user) share it.
 *
 * 每个 tick 是一次独立调用（cron 每分钟一跳，不会因为上一跳还没跑完就跳过
 * 这一跳），而一次投递「组 prompt → 调 LLM → 跑工具 → 推送」可能要几分钟。
 * 所以每条任务开跑前先占位：在这一行的 lease_until 上写下「归我管到什么时
 * 候」，本次投递期间别的 tick 领不走它。占位失败（0 行）说明别人先领走了，
 * 直接跳过。
 *
 * 租约写在自己的列上，next_send_at 全程不动——那一列是用户设的触发时刻，
 * 任务列表要读它、循环任务推进下一次也要拿它当基准。投递收尾时把租约放掉，
 * 这条任务立刻可以被下一跳接手。
 *
 * 投递失败的退避写在另一列（retry_after）上，不跟租约挤在一起：租约的意思只
 * 有「这条正在跑」，而正在等重试的任务其实闲着——两件事共用一列的话，分组串行
 * （见下）会把一条闲着的任务当成「这个分组忙着」，同组别的任务白等一轮退避。
 *
 * 领了任务的 tick 中途没了（Worker 被回收之类）就没人来放租约，这条任务要
 * 等租约到期才会被接手。为了把这个空窗压到分钟级而不是租期级，投递期间按
 * 心跳滚动续租：占位时只写一小段租约（默认 90 秒），之后每隔一个心跳（默认
 * 30 秒）把租约再推到 now + 90s。isolate 活着，租约永远够用；isolate 死了，
 * 租约在 ~90 秒内到期，下一跳 cron 就能接手——不用再为最慢的投递把租期焊死
 * 成十几分钟。适配器没实现 renewTaskLease（自定义适配器）、或宿主把
 * ctx.leaseHeartbeatMs 设成 0 时，退回一次性长租约的老行为
 * （claimLeaseMs，默认 10 分钟）。
 *
 * @param {Object} ctx - { db, masterKey, vapid, webpush, claimLeaseMs?, leaseHeartbeatMs?, staleAfterMs?, serializeBy?, onStaleSkip? }
 *   ctx.serializeBy?.(task)：可选的分组串行。返回一个分组标识（同一个角色、
 *   同一份台账……宿主自己定义），同一分组的任务同时只放行一条；返回 null /
 *   空串 / 不配这个函数 = 这条任务不参与串行，行为与以前完全一致。参数是与
 *   `onBeforeFire` 的 `ctx.task` 同一份的只读任务视图（凭据已剔除）。被拦下
 *   的任务是**推迟**不是丢弃：库一个字段都不动它，下一跳原样再捞一次。
 *   函数自身抛错时这条任务这一跳不跑——分不清它属于哪一组，就不该冒着破坏
 *   宿主台账的风险跑下去。
 *   ctx.onStaleSkip?.(task, info)：任务错过触发时刻太久、这一次（或这几次）
 *   不再补发时调用（best-effort，hook 抛错只记日志不影响主流程）。一次性任务
 *   和循环任务都会调，靠 info.action 区分——见 StaleSkipInfo。task 是数据库
 *   行原样（payload 是密文），所以解密出来的 metadata 单独放在 info 里；只透传
 *   metadata 这一个子字段，解密 payload 里的 apiKey / pushSubscription 等凭据
 *   不会递给 hook。
 * @returns {Promise<Object>} summary { totalTasks, successCount, failedCount, processedAt, executionTime, details }
 */

import { hmacSha256, bytesToBase64Url, utf8 } from './webcrypto-utils.js';
import { sanitizeErrorSummary } from './errors.js';
import { deriveUserEncryptionKey, decryptFromStorage, encryptForStorage } from './encryption.js';
import { processSingleMessage } from './message-processor.js';
import { buildHookTask } from './agentic-fire.js';
import { createStateAccessors } from './state-accessors.js';
import { nextFutureOccurrence, planNextOccurrence } from './recurrence.js';

// 占位租期（一次性长租约的老行为）：要盖住最慢的一次投递。老链路单次 LLM
// 调用上限 300s，agentic 链路整链默认 240s，再留出推送节奏的余量。只在心跳
// 续租不可用（适配器没实现 renewTaskLease，或 ctx.leaseHeartbeatMs = 0）时
// 生效——心跳可用时租约是滚动的短租约，见 DEFAULT_LEASE_HEARTBEAT_MS。
export const DEFAULT_CLAIM_LEASE_MS = 10 * 60 * 1000;
// 宿主把 totalTimeoutMs 调大时租期跟着抬，别让下一跳在投递还没跑完时就把行
// 捞回去。（onBeforeFire 里按次放宽的预算这里看不到，那种情况请显式设
// ctx.claimLeaseMs。）
const CLAIM_LEASE_MARGIN_MS = 2 * 60 * 1000;

// 心跳续租：投递期间每隔这么久把租约推到 now + DEFAULT_HEARTBEAT_LEASE_TTL_MS。
// isolate 被平台回收（fetch 的 waitUntil 预算耗尽之类）后没人再续，租约在
// ~90 秒内到期，任务被下一跳接手——用户不用盯着「正在输入…」等一个十分钟的
// 死租约走完。宿主可用 ctx.leaseHeartbeatMs 覆盖心跳间隔（0 = 关掉心跳，退
// 回一次性长租约）。
export const DEFAULT_LEASE_HEARTBEAT_MS = 30 * 1000;
export const DEFAULT_HEARTBEAT_LEASE_TTL_MS = 90 * 1000;

// 补发新鲜度：错过名义触发时刻超过这个时长的任务不再照常补发。服务停摆几天
// 恢复后，一次性任务不该把攒了几天的旧话一口气倒出来，循环任务更不该每分钟
// 补发一天。正在重试链上的任务（retry_count > 0）不算过期——它的 next_send_at
// 一直是名义时刻，重试拖过一小时不等于用户错过了它——但重试时刻（retry_after）
// 本身也被拖过了这个时长的除外：那说明停摆发生在重试窗口里，内容一样旧。
// 宿主可用 ctx.staleAfterMs 覆盖（与 claimLeaseMs 同一模式）。
export const STALE_AFTER_MS = 60 * 60 * 1000;

function resolveStaleAfterMs(ctx) {
  return positiveNumber(ctx.staleAfterMs) || STALE_AFTER_MS;
}

/**
 * @typedef {Object} StaleSkipInfo
 * @property {'stale'} reason
 * @property {'expired'|'fast_forwarded'} action
 *   `expired` = 一次性任务，这一次永远不会补发了，行已标 failed；
 *   `fast_forwarded` = 循环任务，攒下的这几次都跳过，排期已快进到未来第一个
 *   名义时刻，行仍是 pending，下一次照常触发。
 * @property {Object|null} metadata - 解密 payload 里的 metadata 子字段
 * @property {string} recurrenceType - 'none' / 'daily' / 'weekly'
 * @property {number|null} occurrenceMs - 被跳过的第一个名义时刻（epoch 毫秒）
 * @property {number} skippedCount - 一共跳过几次（一次性任务恒为 1）
 * @property {number[]} skippedOccurrences - 被跳过的名义时刻列表（epoch 毫秒）；
 *   超过 32 次时只给首末两个，并把 skippedTruncated 置 true
 * @property {boolean} skippedTruncated
 * @property {string|null} nextSendAt - 循环任务快进到的下一次触发时刻；一次性任务为 null
 * @property {(namespace: string) => Promise<Array>} readState
 * @property {(namespace: string, entries: Array) => Promise<Object>} writeState
 */

function isRecurringType(recurrenceType) {
  return recurrenceType === 'daily' || recurrenceType === 'weekly';
}

function positiveNumber(value) {
  return (typeof value === 'number' && Number.isFinite(value) && value > 0) ? value : 0;
}

// 脱敏实现住在 lib/errors.js（message-processor 也要用，而它已经被本模块
// import——放这边会成环）。此处转口导出，公开出口不变。
export { sanitizeErrorSummary };

function resolveClaimLeaseMs(ctx) {
  return positiveNumber(ctx.claimLeaseMs)
    || Math.max(DEFAULT_CLAIM_LEASE_MS, positiveNumber(ctx.totalTimeoutMs) + CLAIM_LEASE_MARGIN_MS);
}

/**
 * 把宿主给的分组 key 变成落库用的分组标识。
 *
 * 不直接存 key 本身：它多半是角色 id / 联系人名这类宿主数据，而任务内容一律
 * 加密落库，多开一列明文出口不合适。这里用该用户的存储密钥做 HMAC——同一个
 * 用户的同一个 key 每次都得到同一个值（分组判定要的就是相等性），换个用户
 * 得到的值必然不同（分组天然按用户隔开，SQL 那边不用再比 user_id），拿到数
 * 据库也反推不回原 key。
 *
 * @param {string} userKey - 该用户的存储密钥（deriveUserEncryptionKey 的结果）
 * @param {string} rawKey - serializeBy 返回的分组 key
 * @returns {Promise<string>} 43 字符的 base64url 串（列宽 64 够放）
 */
export async function deriveSerializeGroup(userKey, rawKey) {
  return bytesToBase64Url(await hmacSha256(utf8(userKey), utf8(rawKey)));
}

export async function runScheduledTick(ctx) {
  const tasks = await ctx.db.getPendingTasks(50);
  const summary = await deliverTasks(ctx, tasks);
  await ctx.db.cleanupOldTasks(7);
  // outbox 的顺手清理（适配器支持才做）：已 ack 的留 7 天，未 ack 的留 28 天
  // （Web Push 的 TTL 上限四周，比它更老的推送客户端也永远收不到了）。
  if (typeof ctx.db.cleanupOutbox === 'function') {
    try {
      await ctx.db.cleanupOutbox({
        ackedBeforeMs: Date.now() - 7 * 24 * 60 * 60 * 1000,
        allBeforeMs: Date.now() - 28 * 24 * 60 * 60 * 1000,
      });
    } catch (error) {
      console.warn('[amsg-server] cleanupOutbox 失败（已忽略）:', error && error.message);
    }
  }
  return summary;
}

/**
 * 只跑一条任务的官方入口，给「fetch 里只来得及 enqueue、真正的 fire 交给
 * CF Queue 消费者（15 分钟预算）跑」这类宿主用——不用再依赖 cron 恰好捞到。
 *
 * 与 cron tick 走完全同一条投递链：占位（含心跳续租）、过期守卫、分组串行
 * （单任务场景下退化为占位时的跨 tick 分组门）、失败重试/终态、hook 全套。
 * 行没到点（next_send_at 在未来）或正处在退避窗口（retry_after 未到点）时不
 * 跑——这个入口只是换了个触发器，不是绕过排期的后门。
 *
 * @param {Object} ctx - 与 runScheduledTick 同一份 ctx
 * @param {string} uuid - 任务 uuid（pending 行）
 * @returns {Promise<{ ran: false, reason: 'not_found'|'not_due'|'retry_pending', nextSendAt?: string, retryAfter?: string }
 *   | { ran: true, summary: Object }>} summary 与 runScheduledTick 的返回同构
 *   （totalTasks 恒为 1）；任务被别的执行者占着时体现在 summary.details.claimSkippedTasks。
 */
export async function runTask(ctx, uuid) {
  if (typeof uuid !== 'string' || !uuid.trim()) {
    throw new TypeError('runTask(ctx, uuid) requires a non-empty uuid string');
  }
  const task = await ctx.db.getTaskByUuidOnly(uuid);
  if (!task) return { ran: false, reason: 'not_found' };
  const dueMs = Date.parse(task.next_send_at);
  if (Number.isFinite(dueMs) && dueMs > Date.now()) {
    return { ran: false, reason: 'not_due', nextSendAt: task.next_send_at };
  }
  const retryAfterMs = task.retry_after ? Date.parse(task.retry_after) : NaN;
  if (Number.isFinite(retryAfterMs) && retryAfterMs > Date.now()) {
    return { ran: false, reason: 'retry_pending', retryAfter: task.retry_after };
  }
  return { ran: true, summary: await deliverTasks(ctx, [task]) };
}

/**
 * 一批任务的投递主体（不含捞取与收尾清库）。runScheduledTick 喂它 cron 捞到
 * 的到点任务，runTask 喂它单条——两个入口共享同一条投递链。
 */
async function deliverTasks(ctx, tasks) {
  const db = ctx.db;
  const masterKey = ctx.masterKey;
  const claimLeaseMs = resolveClaimLeaseMs(ctx);
  const staleAfterMs = resolveStaleAfterMs(ctx);
  const serializeBy = typeof ctx.serializeBy === 'function' ? ctx.serializeBy : null;

  // 心跳续租可用吗？三个条件：适配器支持占位、支持续租、宿主没显式关掉。
  const heartbeatMs = ctx.leaseHeartbeatMs === 0
    ? 0
    : (positiveNumber(ctx.leaseHeartbeatMs) || DEFAULT_LEASE_HEARTBEAT_MS);
  const heartbeatEnabled = heartbeatMs > 0
    && typeof db.claimTask === 'function'
    && typeof db.renewTaskLease === 'function';
  // 滚动租约的时长：至少盖住两个心跳（一次续租失败不至于立刻被抢走）。
  const heartbeatLeaseTtlMs = Math.max(DEFAULT_HEARTBEAT_LEASE_TTL_MS, heartbeatMs * 2);

  const startTime = Date.now();

  const MAX_CONCURRENT = 8;
  const results = {
    totalTasks: tasks.length,
    successCount: 0,
    failedCount: 0,
    claimSkippedTasks: 0,
    serializeSkippedTasks: 0,
    deletedOnceOffTasks: 0,
    updatedRecurringTasks: 0,
    staleTasks: [],
    failedTasks: []
  };

  // 这一跳已经放行过的分组。一个分组一跳只放行一条：本跳里前面那条跑完之后
  // 也不补跑后面的，剩下的留给下一跳（cron 一分钟就再来一次），免得一跳里排
  // 出一条长长的串行链、把整跳的时间预算耗光。
  const groupsTakenThisTick = new Set();

  // 适配器没实现 claimTask（自定义适配器）→ 退回不占位的老行为：跑得动，只是
  // 超过一跳间隔的慢任务仍可能被下一跳重复触发。
  const supportsClaim = typeof db.claimTask === 'function';

  async function claimForThisTick(task, serializeGroup) {
    if (!supportsClaim) return true;
    // 心跳可用时占位只写一小段滚动租约（isolate 死亡 → ~90s 内被接手）；
    // 不可用时保持一次性长租约的老行为。
    const leaseUntil = new Date(
      Date.now() + (heartbeatEnabled ? heartbeatLeaseTtlMs : claimLeaseMs)
    ).toISOString();
    return !!(await db.claimTask(task.id, task.next_send_at, leaseUntil, serializeGroup));
  }

  /**
   * 投递期间的租约心跳：每 heartbeatMs 把 lease_until 推到 now + TTL。
   * 返回停止函数——投递收尾（不管成败）必须调，不然定时器抱着 db 绑定活到
   * 请求结束之后。续租失败只告警：租约还有一个 TTL 的余量，下一跳心跳再试；
   * 真续不上，行为退化成「租约到期被接手」，正是心跳想要的兜底方向。
   */
  function startLeaseHeartbeat(task) {
    if (!heartbeatEnabled) return () => {};
    let stopped = false;
    let timer = null;
    const beat = async () => {
      if (stopped) return;
      try {
        await db.renewTaskLease(task.id, new Date(Date.now() + heartbeatLeaseTtlMs).toISOString());
      } catch (error) {
        console.warn('[amsg-server] 租约续租失败（下个心跳再试）:', error && error.message);
      }
      if (!stopped) schedule();
    };
    const schedule = () => {
      timer = setTimeout(beat, heartbeatMs);
      // Node 下别让心跳定时器拖住进程退出；Workers 的 setTimeout 没有 unref。
      if (timer && typeof timer.unref === 'function') timer.unref();
    };
    schedule();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  // last_error 列跟 lease 那几列一个待遇：跟着包内 schema 走的适配器（实现
  // 了 claimTask 的）才写；自定义适配器多半没这一列，塞过去只会被它的白名单
  // 拒掉。
  const supportsLastError = supportsClaim;

  /**
   * updateTaskById 的包一层：升级后还没重跑 /init-tenant 的库缺 last_error
   * 列时，退掉这个字段重写一次——状态推进（标 failed / 推进排期 / 放租约）
   * 不能被一条锦上添花的记录挡住。
   */
  async function updateTaskWithLastError(taskId, fields) {
    try {
      return await db.updateTaskById(taskId, fields);
    } catch (error) {
      if (Object.prototype.hasOwnProperty.call(fields, 'last_error') && /last_error/i.test(error.message || '')) {
        const { last_error: _omit, ...rest } = fields;
        return db.updateTaskById(taskId, rest);
      }
      throw error;
    }
  }

  /** 落进 last_error 列的 JSON（形状与 payload 里的 lastError 一致，reason 已脱敏）。 */
  function lastErrorJson(task, reason, extra) {
    return JSON.stringify({
      at: new Date().toISOString(),
      occurrence: task.next_send_at ?? null,
      reason: sanitizeErrorSummary(reason),
      ...(extra || {}),
    });
  }

  /**
   * 投递收尾时写库，顺手把租约和退避都清掉。占位之后的每一次写库都要走这
   * 里，漏掉一条那条任务就得等租约到期才动得了。
   *
   * 没实现 claimTask 的适配器不会有这两列，就别往它的 updateTaskById 里塞
   * 这两个字段了。
   */
  async function updateAndRelease(taskId, fields) {
    return updateTaskWithLastError(
      taskId,
      supportsClaim ? { ...fields, lease_until: null, retry_after: null } : fields
    );
  }

  /**
   * 解密任务 payload。失败不抛——调用方拿到 ok:false 后按投递失败走既有的
   * 重试/终态逻辑（投递本身解的是同一份，解不开就必然发不出去）。
   */
  async function decryptTask(task) {
    try {
      const userKey = await deriveUserEncryptionKey(task.user_id, masterKey);
      const payload = JSON.parse(await decryptFromStorage(task.encrypted_payload, userKey));
      return { ok: true, userKey, payload };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /**
   * 这条任务归哪个串行分组管。
   *
   * 返回 { taken: true } 表示这一跳不跑它（分组已被本跳里别的任务占着，或者
   * serializeBy 自己抛错了）——两种情况都一个字段不动，下一跳原样再来。
   *
   * 占坑必须在同一个同步段里完成（判断完立刻 add）：一跳内最多 8 条任务并发
   * 跑，中间只要有一次 await，同组的两条就能双双通过判断。
   */
  function reserveSerializeGroup(task, decryptedPayload) {
    if (!serializeBy || !decryptedPayload) return { taken: false, rawKey: null };
    let rawKey;
    try {
      rawKey = serializeBy(buildHookTask(task, decryptedPayload));
    } catch (hookError) {
      console.warn('[amsg-server] serializeBy 抛错，本跳跳过这条任务:', hookError && hookError.message);
      return { taken: true, rawKey: null };
    }
    if (typeof rawKey !== 'string' || !rawKey) return { taken: false, rawKey: null };
    // 占坑的键带上 user_id：分组是按用户隔离的（落库那侧靠 per-user HMAC 天然
    // 隔开，见 deriveSerializeGroup），内存这侧不带用户维度的话，两个用户恰好
    // 返回同一个 rawKey（例如共用的默认角色名）会互相顶掉对方的任务。
    const scopedKey = `${task.user_id}\u0000${rawKey}`;
    if (groupsTakenThisTick.has(scopedKey)) return { taken: true, rawKey };
    groupsTakenThisTick.add(scopedKey);
    return { taken: false, rawKey };
  }

  /**
   * 把这次的错误记进 payload 的 lastError（best-effort）：GET /messages 解密
   * payload 时会把它透出来，宿主能看到「上次为什么没发出去」。加密不了就算了，
   * 记录失败不该拖垮状态推进。
   *
   * @param {Object} task
   * @param {Object} decryptedPayload
   * @param {string} userKey
   * @param {string} reason
   * @param {Object} [extra] - 额外记进 lastError 的字段（例如快进跳过了几次）
   */
  async function encryptPayloadWithLastError(task, decryptedPayload, userKey, reason, extra) {
    if (!decryptedPayload || !userKey) return null;
    try {
      return await encryptForStorage(JSON.stringify({
        ...decryptedPayload,
        lastError: {
          at: new Date().toISOString(),
          occurrence: task.next_send_at,
          reason,
          ...(extra || {})
        }
      }), userKey);
    } catch (_encryptError) {
      return null;
    }
  }

  /**
   * 过期跳过的回执（best-effort）。一次性任务和循环任务共用一个 hook，靠
   * info.action 区分：宿主只需要在一个地方写「这条（这几条）没响」。
   */
  async function notifyStaleSkip(task, info) {
    if (typeof ctx.onStaleSkip !== 'function') return;
    try {
      await ctx.onStaleSkip(task, info);
    } catch (hookError) {
      console.warn('[amsg-server] onStaleSkip hook 抛错（已忽略）:', hookError && hookError.message);
    }
  }

  /**
   * 投递失败的处置。重试没用完时安排退避重试；用完时一次性任务标 'failed'
   * 终态，循环任务只作废本次 occurrence（推进到下个周期、重试归零）——循环
   * 任务永远不进终态，一次雷暴不该让每日消息从此消失。
   *
   * 退避写在 retry_after 上（捞取条件会滤掉退避未到点的行，到点自然放行），
   * 同时把租约放掉——租约只表示「这条正在跑」，等重试的任务并没有在跑，占着
   * 租约会让分组串行把同组别的任务一起堵住。next_send_at 全程保持名义时刻：
   * 它是循环推进和过期判定的基准，被退避时间改写过一次，这条任务的钟点就永
   * 久漂了。没有这两列的适配器（没实现 claimTask）退回老行为，把重试时刻写
   * 进 next_send_at。
   */
  async function handleDeliveryFailure(task, reason, recurrenceType, decryptedPayload, userKey, errorCode = null, permanentFlag = false) {
    results.failedCount++;
    const tzId = decryptedPayload ? (decryptedPayload.tzId ?? null) : null;
    // 重试也好不了的失败不进退避阶梯：一次性任务直接进终审处置，循环任务直接
    // 作废本次 occurrence。两个来源：
    //   - 已知的永久性错误码（订阅没登记 / 适配器不支持订阅存储）；
    //   - hook 侧抛出的 NonRetryableError（permanentFlag，见 lib/errors.js）——
    //     fire_pack 缺失、解析失败这类重试必然同败的错，隔两分钟再试三次只是
    //     让用户多白等十二分钟，还把情绪评估之类的计费重跑三遍。
    const permanent = permanentFlag === true
      || errorCode === 'PUSH_SUBSCRIPTION_MISSING'
      || errorCode === 'PUSH_SUBSCRIPTION_STORE_UNSUPPORTED';
    try {
      if (permanent || task.retry_count >= 3) {
        const encrypted = await encryptPayloadWithLastError(task, decryptedPayload, userKey, reason);
        if (isRecurringType(recurrenceType)) {
          const nextSendAt = nextFutureOccurrence(Date.parse(task.next_send_at), recurrenceType, Date.now(), tzId);
          await updateAndRelease(task.id, {
            next_send_at: nextSendAt,
            retry_count: 0,
            ...(encrypted ? { encrypted_payload: encrypted } : {}),
            ...(supportsLastError ? { last_error: lastErrorJson(task, reason) } : {})
          });
          results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count, status: 'occurrence_skipped', nextSendAt, ...(permanent ? { permanent: true } : {}) });
        } else {
          await updateAndRelease(task.id, {
            status: 'failed',
            ...(encrypted ? { encrypted_payload: encrypted } : {}),
            ...(supportsLastError ? { last_error: lastErrorJson(task, reason) } : {})
          });
          results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count, status: 'permanently_failed', ...(permanent ? { permanent: true } : {}) });
        }
      } else {
        const nextRetryTime = new Date(Date.now() + (task.retry_count + 1) * 2 * 60 * 1000);
        if (supportsClaim) {
          // 等重试的行也带上 last_error：客户端不用等三轮跑完才知道「为什么
          // 还没来」，中途查 GET /message 就看得到当前的失败原因。
          await updateTaskWithLastError(task.id, {
            retry_after: nextRetryTime.toISOString(),
            lease_until: null,
            retry_count: task.retry_count + 1,
            ...(supportsLastError ? { last_error: lastErrorJson(task, reason) } : {})
          });
        } else {
          await db.updateTaskById(task.id, { next_send_at: nextRetryTime.toISOString(), retry_count: task.retry_count + 1 });
        }
        results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count + 1, nextRetryAt: nextRetryTime.toISOString() });
      }
    } catch (updateError) {
      results.failedTasks.push({ taskId: task.id, reason, status: 'retry_update_failed', updateError: updateError.message });
    }
  }

  /**
   * 消息已经送达，只是发送后的写库（删行 / 推进排期）没成。一次性任务标
   * 'sent' 防重发（维持既有行为）；循环任务不标 'sent'——那是终态，任务会
   * 从此退出捞取——而是再试一次把排期推进到下个周期。推进也失败时行保持
   * pending，租约到期后会被重发这个 occurrence（推送 id 掺了名义时刻，已
   * 送达的段会在客户端被去重）。
   */
  async function handlePostSendPersistenceFailure(task, reason, recurrenceType, tzId) {
    results.failedCount++;
    if (isRecurringType(recurrenceType)) {
      let advanced = false;
      let nextSendAt = null;
      try {
        nextSendAt = nextFutureOccurrence(Date.parse(task.next_send_at), recurrenceType, Date.now(), tzId);
        await updateAndRelease(task.id, { next_send_at: nextSendAt, retry_count: 0 });
        advanced = true;
      } catch (_advanceError) {
        advanced = false;
      }
      results.failedTasks.push({
        taskId: task.id,
        reason,
        status: advanced ? 'post_send_cleanup_failed_rescheduled' : 'post_send_cleanup_failed',
        messageDelivered: true
      });
      return;
    }
    let markedSent = false;
    try {
      await updateAndRelease(task.id, { status: 'sent', retry_count: 0 });
      markedSent = true;
    } catch (_markSentError) {
      markedSent = false;
    }
    results.failedTasks.push({
      taskId: task.id,
      reason,
      status: markedSent ? 'post_send_cleanup_failed_marked_sent' : 'post_send_cleanup_failed',
      messageDelivered: true
    });
  }

  /**
   * 投递一条任务。payload 在下面的预处理里已经解好了（分组 key 要在占位那一
   * 步就带上，而占位必须是判定和写租约的同一条语句，见适配器的 claimTask），
   * 这里不再解第二遍。
   *
   * @param {{ task: Object, decrypted: Object, serializeKey: string|null }} entry
   */
  async function processTask({ task, decrypted, serializeKey }) {
    const decryptedPayload = decrypted.ok ? decrypted.payload : null;
    const userKey = decrypted.ok ? decrypted.userKey : null;
    const serializeGroup = serializeKey
      ? await deriveSerializeGroup(userKey, serializeKey)
      : null;

    let claimed;
    try {
      claimed = await claimForThisTick(task, serializeGroup);
    } catch (error) {
      // 占位这一步就出错，说明库有问题——此时不知道别人有没有在跑这条，宁可
      // 不发。行还是 pending，下一跳会重新捞。
      results.failedCount++;
      results.failedTasks.push({ taskId: task.id, reason: error.message || '任务占位失败', status: 'claim_failed' });
      return;
    }
    if (!claimed) {
      // 另一个 tick 已经领走了这条，或者同分组有任务正在别的 tick 里跑。两种
      // 情况本次都什么都不做，下一跳再说。
      results.claimSkippedTasks++;
      return;
    }

    // 占位成功，投递期间滚动续租（见 startLeaseHeartbeat）。收尾必须停心跳，
    // 不管下面哪条路径退出——finally 兜住。
    const stopHeartbeat = startLeaseHeartbeat(task);
    try {
      await deliverClaimedTask(task, decrypted);
    } finally {
      stopHeartbeat();
    }
  }

  /** 占位之后的投递主体（从解密守卫到发送收尾），从 processTask 拆出来只是
   *  为了让心跳的 try/finally 能整段兜住它。 */
  async function deliverClaimedTask(task, decrypted) {
    const decryptedPayload = decrypted.ok ? decrypted.payload : null;
    const userKey = decrypted.ok ? decrypted.userKey : null;

    // recurrenceType 是过期判定、终审失败处置的依据。解密不了的话投递也无从
    // 谈起（投递用的就是这份解密结果），按投递失败走既有的重试/终态逻辑。
    if (!decrypted.ok) {
      await handleDeliveryFailure(task, (decrypted.error && decrypted.error.message) || '任务载荷解密失败', null, null, null);
      return;
    }
    const recurrenceType = decryptedPayload.recurrenceType;
    // 循环推进跟着哪个时区的墙钟走（没设就按 UTC，等价于固定 24h / 7×24h）。
    const tzId = decryptedPayload.tzId ?? null;

    // —— 补发新鲜度守卫 ——
    // 服务停摆 N 天恢复后，攒下的旧任务不照常补发：一次性任务标 'failed'；
    // 循环任务把排期快进到未来第一个名义时刻。两边都写 lastError、都调
    // onStaleSkip——「昨天那次没响」对用户是一样的事实，循环任务不该无声无息
    // 地把它抹掉。正在重试链上的（retry_count > 0）不算过期——除非排定的重试
    // 时刻（retry_after）本身也被拖过了 staleAfterMs：正常退避只有几分钟，
    // 拖过一小时说明停摆恰好落在重试窗口里，这时内容跟没进重试链的一样旧。
    // 见 STALE_AFTER_MS 的注释。
    const occurrenceMs = Date.parse(task.next_send_at);
    const retryAfterMs = task.retry_after ? Date.parse(task.retry_after) : NaN;
    const notOnFreshRetryChain = (task.retry_count || 0) === 0
      || (Number.isFinite(retryAfterMs) && Date.now() - retryAfterMs > staleAfterMs);
    if (Number.isFinite(occurrenceMs)
        && Date.now() - occurrenceMs > staleAfterMs
        && notOnFreshRetryChain) {
      try {
        // hook 的 client_state 读写口：过期跳过往往正是宿主要留一条痕迹的时
        // 候（服务停摆恢复后的第一跳，此前这个 tick 里可能一次 fire 都没跑
        // 过），所以现造一份递给它，而不是让宿主自己去别处找。
        const stateAccessors = createStateAccessors({
          db,
          userId: task.user_id,
          userKey,
          maxStateValueBytes: ctx.maxStateValueBytes
        });

        // 循环任务快进（fast_forwarded）与一次性任务作废（expired）的收尾
        // 完全同构：写 lastError → 写库 → 记 staleTasks → 调 onStaleSkip。
        // 差异全部收进 plan 里，尾部只写一遍——两个近似复制的分支各改各的，
        // 漏改一边是迟早的事。
        const recurring = isRecurringType(recurrenceType);
        const plan = recurring ? planNextOccurrence(occurrenceMs, recurrenceType, Date.now(), tzId) : null;
        const nextSendAt = recurring ? new Date(plan.nextMs).toISOString() : null;
        const action = recurring ? 'fast_forwarded' : 'expired';
        const skippedCount = recurring ? plan.skippedCount : 1;
        const encrypted = await encryptPayloadWithLastError(
          task, decryptedPayload, userKey, 'stale',
          recurring ? { skippedCount, nextSendAt } : undefined
        );
        await updateAndRelease(task.id, {
          ...(recurring ? { next_send_at: nextSendAt, retry_count: 0 } : { status: 'failed' }),
          ...(encrypted ? { encrypted_payload: encrypted } : {}),
          ...(supportsLastError
            ? { last_error: lastErrorJson(task, 'stale', recurring ? { skippedCount, nextSendAt } : undefined) }
            : {})
        });
        results.staleTasks.push({
          taskId: task.id,
          reason: 'stale',
          action,
          ...(recurring ? { nextSendAt } : {}),
          skippedCount
        });
        // 消费方用它写「错过了」回执；best-effort，hook 抛错不影响主流程。
        // task 是数据库行原样（metadata 锁在 encrypted_payload 密文里），所以
        // 把解密出的 metadata 单独递过去，hook 才能对上是哪个角色的任务。
        // 只透传 metadata 这一个子字段——解密 payload 里还有 apiKey /
        // pushSubscription 等凭据，不能整个递出去。
        await notifyStaleSkip(task, {
          reason: 'stale',
          action,
          metadata: decryptedPayload.metadata ?? null,
          recurrenceType: recurrenceType || 'none',
          occurrenceMs,
          skippedCount,
          skippedOccurrences: recurring ? plan.skippedOccurrences : [occurrenceMs],
          skippedTruncated: recurring ? plan.skippedTruncated : false,
          nextSendAt,
          ...stateAccessors
        });
      } catch (error) {
        results.failedCount++;
        results.failedTasks.push({ taskId: task.id, reason: error.message || '过期任务处理失败', status: 'stale_update_failed' });
      }
      return;
    }

    let sendResult;
    try {
      // 预扫描解好的 payload 一并递过去，投递侧不再解第二遍。
      sendResult = await processSingleMessage(
        task, { ...ctx, db, masterKey }, masterKey,
        { userKey, payload: decryptedPayload }
      );
    } catch (error) {
      await handleDeliveryFailure(
        task, error.message || '消息发送失败', recurrenceType, decryptedPayload, userKey,
        error.code || null, error.permanent === true
      );
      return;
    }

    if (!sendResult.success) {
      await handleDeliveryFailure(
        task, sendResult.error || '消息发送失败', recurrenceType, decryptedPayload, userKey,
        sendResult.errorCode || null, sendResult.permanent === true
      );
      return;
    }

    try {
      if (recurrenceType === 'none') {
        await db.deleteTaskById(task.id);
        results.deletedOnceOffTasks++;
      } else {
        // 以这条任务原本的触发时刻为基准往后推（推进到未来第一个名义时刻）。
        // 这次成功了，把上一轮失败留下的 last_error 一并清掉。
        const nextSendAt = nextFutureOccurrence(occurrenceMs, recurrenceType, Date.now(), tzId);
        await updateAndRelease(task.id, {
          next_send_at: nextSendAt,
          retry_count: 0,
          ...(supportsLastError ? { last_error: null } : {})
        });
        results.updatedRecurringTasks++;
      }

      results.successCount++;
    } catch (error) {
      await handlePostSendPersistenceFailure(task, error.message || '发送后状态更新失败', recurrenceType, tzId);
    }
  }

  // 先按捞取顺序（next_send_at 升序）逐条解密、逐条占分组的坑，再并发投递。
  //
  // 顺序在这一步就定死，是因为分组串行要的是「同一个角色的消息按时间顺序一条
  // 一条来」：并发解密谁先跑完是没准的，让它来决定同组谁先放行的话，两条都到
  // 点时晚的那条可能抢在早的前面发出去——这正是分组串行想避免的事。
  //
  // 没配 serializeBy 时这一步只是顺手把 payload 解出来，谁都不拦。解好的
  // payload 会随任务一路递到投递侧（processSingleMessage 的 predecrypted
  // 参数），全程只解这一遍。
  const taskQueue = [];
  for (const task of tasks) {
    const decrypted = await decryptTask(task);
    const reserved = reserveSerializeGroup(task, decrypted.ok ? decrypted.payload : null);
    if (reserved.taken) {
      // 同分组已经有任务在这一跳里放行了（或者 serializeBy 抛错）。行一个字段
      // 都不动——这是推迟，不是丢弃，下一跳照常把它捞回来。
      results.serializeSkippedTasks++;
      continue;
    }
    taskQueue.push({ task, decrypted, serializeKey: reserved.rawKey });
  }

  const processing = [];

  while (taskQueue.length > 0 || processing.length > 0) {
    while (processing.length < MAX_CONCURRENT && taskQueue.length > 0) {
      const entry = taskQueue.shift();
      const promise = processTask(entry);
      processing.push(promise);
      promise.finally(() => {
        const index = processing.indexOf(promise);
        if (index > -1) processing.splice(index, 1);
      });
    }
    if (processing.length > 0) {
      await Promise.race(processing);
    }
  }

  const executionTime = Date.now() - startTime;

  return {
    totalTasks: results.totalTasks,
    successCount: results.successCount,
    failedCount: results.failedCount,
    processedAt: new Date().toISOString(),
    executionTime,
    details: {
      claimSkippedTasks: results.claimSkippedTasks,
      // 分组串行拦下的条数：本跳里同分组已经放行过别的任务。跨跳被拦下的
      // （分组在别的 tick 里正忙）走的是占位那一步，计在 claimSkippedTasks。
      serializeSkippedTasks: results.serializeSkippedTasks,
      deletedOnceOffTasks: results.deletedOnceOffTasks,
      updatedRecurringTasks: results.updatedRecurringTasks,
      staleTasks: results.staleTasks,
      failedTasks: results.failedTasks
    }
  };
}
