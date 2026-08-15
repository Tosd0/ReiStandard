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
 * 心跳还兼着取消的耳朵：续租是条件写（只更新仍持有租约的 pending 行），没匹配
 * 到行就说明这条任务在投递期间被删了——`DELETE /message` 取消、或
 * `supersedesUuid` 顶替。占位到推送之间投递侧不再读库，这是唯一能知道这件事的
 * 信号，所以收到之后剩下的推送一条都不发，这一跳把它记进 details.cancelledTasks，
 * 既不算成功也不算失败。
 *
 * @param {Object} ctx - { db, masterKey, vapid, webpush, multipart?, claimLeaseMs?, leaseHeartbeatMs?, staleAfterMs?, serializeBy?, onStaleSkip? }
 *   ctx.multipart?：分片传输的限额 { maxChunkBytes, maxChunks, maxTotalBytes,
 *   ttlMs }，宿主传给 `installReiSW` 的那一份原样传过来。整份 ctx 会展开给
 *   processSingleMessage，发送端据此切片、排发送节奏（见 lib/message-processor.js
 *   的 resolveMultipartOptions）。不传 = 两边都用默认值。
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
 *   ctx.clientStateTtl?：client_state 的按命名空间过期清理，形状是
 *   `{ 命名空间: 天数 }`。不配 = 一个都不清（默认行为不变）。见
 *   cleanupExpiredClientState。
 * @returns {Promise<Object>} summary { totalTasks, successCount, failedCount, processedAt, executionTime, details }
 */

import { hmacSha256, bytesToBase64Url, utf8 } from './webcrypto-utils.js';
import {
  buildErrorExtra,
  isPermanentDeliveryFailure,
  sanitizeErrorSummary,
  TASK_CANCELLED_CODE,
} from './errors.js';
import { deriveUserEncryptionKey, decryptFromStorage, encryptForStorage } from './encryption.js';
import { processSingleMessage } from './message-processor.js';
import { buildHookTask, occurrenceSuffix } from './agentic-fire.js';
import { createStateAccessors } from './state-accessors.js';
import { planClientStateCleanup } from './client-state-store.js';
import { createResultEmitter } from './result-emitter.js';
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

// 「重试也好不了」的判定（永久性错误码、终态推送状态码、payload 超限）住在
// lib/errors.js —— 定时任务的退避阶梯和 instant 任务的三轮重试用同一份口径。

// 投递期间发现「这条已经不归我了」时，推送侧抛的错误码住在 lib/errors.js
// （见 guardWebpushWithLease）：发送方要靠它把「取消」和「发失败」分开处置。

/** 推送服务回的状态码；拿不到（不是推送失败，或宿主的 webpush 实现没带）→ null。 */
/**
 * 认定「这个适配器写不了 `last_error` 列」的适配器（之后的写不再带这个字段）。
 *
 * 记在适配器实例上（不是模块级布尔），同一个进程里并排跑好几个库、或者宿主中途
 * 换适配器时才不会互相串。正面结果不用记：默认就是把 last_error 和状态字段合成
 * 一笔写，写得进去就什么都不用做。
 */
const adaptersWithoutLastErrorColumn = new WeakSet();

/**
 * 「这个适配器可能没有 last_error 列」的嫌疑计数（适配器 → 次数）。
 *
 * 判据是「带这个字段的写挂了，退回去只写状态字段的同一笔却成了」——不靠错误措辞
 * 猜（自建适配器拒绝未知字段时说什么全凭它自己）。但这个判据一次观察还不够：连
 * 接重置、语句超时、D1 的 `Network connection lost` 这类瞬时错误恰好落在前一笔上
 * 时，长得跟「没这一列」一模一样。而认定的后果是永久的（长驻 Node 部署里适配器
 * 活到进程结束），一次瞬时错误就再也不写 last_error，之后每个失败任务的
 * `GET /message` 都只剩 lastError: null。所以要连续两次撞上同一个形状才认定；中
 * 间只要有一笔带 last_error 的写成功了，嫌疑就清零。
 */
const lastErrorColumnSuspicions = new WeakMap();

/**
 * 「带 last_error 的写没成功」这条运维提示已经说过了。
 *
 * 刻意不用 WeakSet 按适配器记：Cloudflare 部署每个请求都 `new D1Adapter(env.DB)`，
 * 按适配器记等于每跳一条，cron 一分钟一跳，日志会被刷满。挂在模块上就是 isolate
 * 内说一次——它要传达的信息（去把表结构补上）说一次就够。
 */
let warnedAboutMissingLastErrorColumn = false;

/** 已经就「行里没有 retry_after」告过警的适配器，每个只说一次。 */
const adaptersWarnedAboutRetryAfter = new WeakSet();

/**
 * @param {Object} db
 */
function warnMissingRetryAfterColumn(db) {
  if (!db || adaptersWarnedAboutRetryAfter.has(db)) return;
  adaptersWarnedAboutRetryAfter.add(db);
  console.warn(
    '[amsg-server] 适配器返回的任务行里没有 retry_after，退避守卫失效：'
    + '还在退避里的任务会被立刻重跑。投递路径的行要带上这一列，'
    + '见 adapters/interface.js 的 TASK_DELIVERY_COLUMNS。'
  );
}

/**
 * 「带 last_error 的写没成功」的告警（isolate 内只说一次，见
 * warnedAboutMissingLastErrorColumn）。
 *
 * 第一次撞上就说，不等到坐实——Cloudflare 部署每个请求都新建适配器，坐实要看同一
 * 个适配器上的连续两次，那边永远等不到，运维也就永远看不到这条提示。反过来说，
 * 一次瞬时错误也会让它说一句：所以措辞把两种可能都写出来，别只说「缺列」。
 *
 * @param {unknown} error - 带 last_error 的那笔写报的错（原文照录，别自己转述）
 */
function warnMissingLastErrorColumn(error) {
  if (warnedAboutMissingLastErrorColumn) return;
  warnedAboutMissingLastErrorColumn = true;
  console.warn(
    '[amsg-server] 带 last_error 的写没成功，已退回只写状态字段'
    + '（失败原因仍记在 payload 的 lastError 里）。库升级后没重跑过 /init-tenant 的话，'
    + '补一次表结构就能恢复；只是偶发的话不用管:',
    error && /** @type {{ message?: unknown }} */ (error).message
  );
}

function toPushStatus(value) {
  return Number.isInteger(value) ? value : null;
}

/**
 * 收尾写库有没有落到行上。适配器契约里 `updateTaskById` 是 `TaskRow|null`、
 * `deleteTaskById` 是 `boolean`，所以只把明确的「没匹配到行」当成行已消失；
 * 什么都不返回的自定义适配器按老行为算成功——宁可少报一次，也不能把一次正常
 * 投递误判成取消。
 */
function rowVanished(writeResult) {
  return writeResult === null || writeResult === false;
}

/**
 * 给 ctx.webpush 套一层取消检查。
 *
 * 推送是这条链上唯一不可撤销的一步——发出去就落到用户设备上了，撤不回来。所以
 * 取消的检查点就放在它前面：心跳一旦发现这条任务已经不归自己管（见
 * startLeaseHeartbeat 的 lost），后面每一条 push 都当场抛 TASK_CANCELLED，一条
 * 也不发；整批发到一半才被取消的，剩下的那些就此打住。
 *
 * 心跳没开（适配器没实现 renewTaskLease，或宿主把 leaseHeartbeatMs 设成 0）时
 * 拿不到这个信号，行为与以前一致。
 *
 * 做法是拿宿主那个对象当原型现造一层影子对象，只在影子上盖住
 * `sendNotification`，其余属性照旧走原型链读到原件。不用 Proxy：宿主按常见写法
 * 传 `Object.freeze({ sendNotification })` 时，冻结对象上的属性是
 * non-writable + non-configurable，get trap 返回包装函数会踩 Proxy 不变式当场
 * 抛 TypeError——那个部署下每一条定时消息都会发不出去。
 *
 * @param {Object} webpush - 宿主给的 webpush 实现
 * @param {{ lost: boolean }} lease - 租约状态（心跳会就地改 lost）
 */
function guardWebpushWithLease(webpush, lease) {
  if (!webpush || typeof webpush.sendNotification !== 'function') return webpush;
  const guarded = Object.create(webpush);
  // 用 defineProperty 而不是赋值：原件冻结时赋值会顺着原型链撞上那个
  // non-writable 的同名属性，在 ESM 的严格模式下直接抛。
  Object.defineProperty(guarded, 'sendNotification', {
    value: async (...args) => {
      if (lease.lost) {
        const error = new Error('任务在投递期间被取消或顶替，推送已中止');
        error.code = TASK_CANCELLED_CODE;
        throw error;
      }
      return webpush.sendNotification(...args);
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return guarded;
}

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
 * @property {(payload: Object) => Promise<{ messageId: string, pushed: boolean }>} emitResult
 *   往客户端补一条自定义结果（落收件箱 + 推送，见 lib/result-emitter.js）。
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
  await cleanupExpiredClientState(ctx);
  return summary;
}

/**
 * client_state 的按命名空间过期清理（宿主配了 `ctx.clientStateTtl` 才做）。
 *
 * 默认什么都不清：写进 client_state 的东西是宿主的数据，库不替它决定什么时候
 * 该没。但「大内容旁路」那类用法（一条 push 塞不下的正文先写进状态、push 里
 * 只带引用键）写的是一次性内容，客户端取走之后没人再去删，攒着只会白占库。
 * 给这类命名空间配上天数，这里每跳顺手清一次。
 *
 * 配置形状是 `{ 命名空间: 天数 }`，逐个命名空间开——没写进配置的一个都不动。
 * 判据是行的 `updated_at` 列（本来就有，不加列）：升级后老库不用改表结构，
 * 也就没有「表没跟上 → cron 静默挂在缺的那一列上」这一说。
 *
 * 一个坑说在前头：`PUT /client-state` 和 `writeState()` 的条件写护栏
 * （entry 上的 `version`）落的就是这一列。护栏值传的是自增计数器之类的小整数
 * 时，这行的 `updated_at` 看起来就像 1970 年，第一次清理就会被扫走。要给某个
 * 命名空间配 TTL，就让它的写入方把 `version` 传成毫秒时间戳。
 *
 * 全程 best-effort：清理失败只记日志——它是顺手做的库存卫生，不该把一整跳投
 * 递带下水。
 *
 * @param {Object} ctx - 与 runScheduledTick 同一份 ctx
 */
async function cleanupExpiredClientState(ctx) {
  if (typeof ctx.db.cleanupClientState !== 'function') return;
  const targets = planClientStateCleanup(ctx.clientStateTtl, Date.now());
  if (targets.length === 0) return;
  try {
    await ctx.db.cleanupClientState(targets);
  } catch (error) {
    console.warn('[amsg-server] cleanupClientState 失败（已忽略）:', error && error.message);
  }
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
 * 四种不跑的情形分开回报，调用方不用猜：
 *   - `not_found`：没有这条 uuid。一次性任务发完即删，所以「发完了」的那条也
 *     落在这里；行还在但已经是终态的走下面那条。
 *   - `already_settled`：行还在，但已经是 sent / failed（`status` 带上是哪
 *     个）。适配器没实现 `getTaskStatusByUuidOnly` 时这种情况并进 `not_found`。
 *   - `not_due`：还没到 `next_send_at`（`nextSendAt` 带上是什么时候）。
 *   - `retry_pending`：上次投递失败，还在退避窗口里（`retryAfter` 带上什么时
 *     候到点）。
 *
 * @param {Object} ctx - 与 runScheduledTick 同一份 ctx
 * @param {string} uuid - 任务 uuid（pending 行）
 * @returns {Promise<{ ran: false, reason: 'not_found'|'already_settled'|'not_due'|'retry_pending', status?: string, nextSendAt?: string, retryAfter?: string }
 *   | { ran: true, summary: Object }>} summary 与 runScheduledTick 的返回同构
 *   （totalTasks 恒为 1）；任务被别的执行者占着时体现在 summary.details.claimSkippedTasks。
 */
export async function runTask(ctx, uuid) {
  if (typeof uuid !== 'string' || !uuid.trim()) {
    throw new TypeError('runTask(ctx, uuid) requires a non-empty uuid string');
  }
  const task = await ctx.db.getTaskByUuidOnly(uuid);
  if (!task) {
    // 捞不到 pending 行有两种可能：这条压根不存在，或者它已经跑完进了终态。
    // 后者对调用方是「不用再催了」，前者是「uuid 传错了」——两件事分开说。
    if (typeof ctx.db.getTaskStatusByUuidOnly === 'function') {
      const settled = await ctx.db.getTaskStatusByUuidOnly(uuid);
      if (settled) return { ran: false, reason: 'already_settled', status: settled.status };
    }
    return { ran: false, reason: 'not_found' };
  }
  const dueMs = Date.parse(task.next_send_at);
  if (Number.isFinite(dueMs) && dueMs > Date.now()) {
    return { ran: false, reason: 'not_due', nextSendAt: task.next_send_at };
  }
  // 「这一列是 NULL」和「这一列压根没读出来」是两回事，但两者的 Date.parse 都
  // 是 NaN，守卫一样不触发——后者会让一条还在退避里的任务被立刻重跑一遍。投递
  // 路径的行要求带上 retry_after（见 adapters/interface.js 的
  // TASK_DELIVERY_COLUMNS），带没带得看适配器有没有照办，所以缺了就说一声。
  if (!Object.prototype.hasOwnProperty.call(task, 'retry_after')) {
    warnMissingRetryAfterColumn(ctx.db);
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
    cancelledTasks: [],
    reasoningSkippedTasks: [],
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
   * 投递期间的租约心跳：每 heartbeatMs 把 lease_until 推到 now + TTL，顺带盯着
   * 「这条还归不归我」。返回 { lost, stop }：
   *
   *   - `lost`：续租的条件写没匹配到行。renewTaskLease 只更新「仍是 pending 且
   *     还持有租约」的行，所以返回 false 的意思是这条任务已经不在原处了——
   *     `DELETE /message` 取消、`supersedesUuid` 顶替，或者被别的执行者收尾。
   *     从占位到推送之间投递侧不再读库，这是唯一能知道这件事的信号；丢掉它就
   *     会出现「接口回了取消成功，消息照样发出去」。
   *   - `stop`：投递收尾（不管成败）必须调，不然定时器抱着 db 绑定活到请求结
   *     束之后。
   *
   * 续租抛错只告警：租约还有一个 TTL 的余量，下个心跳再试；真续不上，行为退化
   * 成「租约到期被接手」，正是心跳想要的兜底方向。抛错不等于行没了，所以不置
   * lost；同理，只有明确的 false 才算行没了，什么都不返回的自定义适配器照旧。
   */
  function startLeaseHeartbeat(task) {
    const lease = { lost: false, released: false, stop: () => {} };
    if (!heartbeatEnabled) return lease;
    let stopped = false;
    let timer = null;
    const beat = async () => {
      if (stopped) return;
      let renewed;
      try {
        renewed = await db.renewTaskLease(task.id, new Date(Date.now() + heartbeatLeaseTtlMs).toISOString());
      } catch (error) {
        console.warn('[amsg-server] 租约续租失败（下个心跳再试）:', error && error.message);
      }
      if (renewed === false) {
        // 续不上有两种可能，`false` 本身分不出来：
        //   - 这次投递已经收尾了（收尾写库会把 lease_until 置空、成功的一次性
        //     任务干脆把行删掉），租约是我们自己放的手；
        //   - 行真的被取消或顶替了。
        // 前者要安静收场：收尾之后宿主 hook 还可能 await 一阵子（onStaleSkip
        // 之类），这期间飞在路上的心跳会照样落地，报成「任务被取消」的话，运维
        // 就会在 tick 日志里看到一条正常送达的消息带着取消告警。
        if (stopped || lease.released) return;
        lease.lost = true;
        console.warn(`[amsg-server] 任务 ${task.id} 的租约已失效（行被取消或顶替），剩余推送将中止`);
        return;
      }
      if (!stopped) schedule();
    };
    const schedule = () => {
      timer = setTimeout(beat, heartbeatMs);
      // Node 下别让心跳定时器拖住进程退出；Workers 的 setTimeout 没有 unref。
      if (timer && typeof timer.unref === 'function') timer.unref();
    };
    schedule();
    lease.stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
    return lease;
  }

  /** 正在跑的任务 → 它的租约对象。收尾写库时要靠它标记「租约是我们自己放的」。 */
  const activeLeases = new Map();

  /**
   * 标记这条任务的租约已经由本次投递主动放掉。
   *
   * 之后 renewTaskLease 当然续不上，但那不是「行被取消」——见 startLeaseHeartbeat
   * 里对 `false` 的处理。
   *
   * @param {number|string} taskId
   */
  function markLeaseReleased(taskId) {
    const lease = activeLeases.get(taskId);
    if (lease) lease.released = true;
  }

  // last_error 一律往行上写，写不进去再退回去（见 updateTaskWithLastError）。
  //
  // 不能拿「实现了 claimTask 吗」当判据：投影那边只看行上带不带 last_error 这
  // 个键，而 claimTask 是可选的——跟着包内 schema 建表、却没实现 claimTask 的
  // 适配器，行上有这一列、投影认它权威，可写入侧从来不写，`lastError` 就永远
  // 读成 null，客户端看不到上次为什么没发出去。
  //
  // 也不能拿「捞回来的这一行带不带这个键」当判据：投递用的列集
  // （TASK_DELIVERY_COLUMNS）本来就不含 last_error，投递时没必要把上一次的失
  // 败原因一起读出来。

  /**
   * updateTaskById 的包一层：状态推进（标 failed / 推进排期 / 放租约）和
   * last_error 这条记录分开对待——前者是状态机，后者是锦上添花，后者写不进去
   * 不能把前者挡住。
   *
   * 默认就是合成一笔写（状态字段 + last_error）：库有这一列时永远只花一个来回，
   * 不用先探一次——探测结果只能记在适配器实例上，而 Cloudflare 部署每个请求都新
   * 建一个 D1Adapter，探一次记一次等于永远在探。
   *
   * 这一笔挂了，退回去只写状态字段再来一次：
   *   - 退回的这笔成了 → 问题就出在 last_error 这个字段上（`updateTaskById` 是
   *     单条 UPDATE，字段不认时整条不生效，所以退回重写是安全的，写的又都是绝对
   *     值、重放一次没有副作用）。记一次嫌疑，连续两次才认定这个库没有这一列。
   *   - 退回的这笔也挂了 → 是库真出问题了，跟哪个字段无关。原样抛出去按既有路径
   *     处理，什么都不缓存。
   *
   * 不按错误措辞猜「是不是缺列」：自建适配器拒绝未知字段时说什么全凭它自己，
   * 猜不中就是状态永远推不动——retry_count 不涨、next_send_at 不动，任务被每
   * 一跳 cron 重新捞起来，LLM 每次重跑一遍还每次都计费。
   */
  async function updateTaskWithLastError(taskId, fields) {
    // 这一写会把租约放掉的话，先在本地标一下：之后心跳续不上租约是我们自己放
    // 的手，不是行被取消或顶替（见 markLeaseReleased）。
    if (fields.lease_until === null) markLeaseReleased(taskId);

    if (!Object.prototype.hasOwnProperty.call(fields, 'last_error')) {
      return db.updateTaskById(taskId, fields);
    }
    const { last_error: _lastError, ...stateFields } = fields;
    if (adaptersWithoutLastErrorColumn.has(db)) return db.updateTaskById(taskId, stateFields);

    let combinedError;
    try {
      const result = await db.updateTaskById(taskId, fields);
      // 写进去了 = 这一列在。之前那次失败是瞬时的，嫌疑清零。
      lastErrorColumnSuspicions.delete(db);
      return result;
    } catch (error) {
      combinedError = error;
    }

    // 退回只写状态字段。这一笔再挂就是库真出问题了，原样抛给调用方（既有路径会
    // 把它记成 retry_update_failed / stale_update_failed），一个字都不缓存。
    const result = await db.updateTaskById(taskId, stateFields);

    // 告警第一次就说（见 warnMissingLastErrorColumn），认定要等第二次。
    warnMissingLastErrorColumn(combinedError);
    const suspicions = (lastErrorColumnSuspicions.get(db) || 0) + 1;
    if (suspicions >= 2) {
      adaptersWithoutLastErrorColumn.add(db);
      lastErrorColumnSuspicions.delete(db);
    } else {
      lastErrorColumnSuspicions.set(db, suspicions);
    }
    return result;
  }

  /**
   * 落进 last_error 列的 JSON（形状与 payload 里的 lastError 一致，reason 已脱敏）。
   *
   * 投递失败时 extra 会带上 `pushStatus`（推送服务回的状态码）：下游要判断
   * 「是不是订阅失效了」，读这个数就够，不用去正则匹配 reason 那句人话——那句
   * 是给用户看的，措辞随时会变。
   */
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
   * 投递期间这条任务不再归本次投递管：行被 `DELETE /message` 取消、被
   * `supersedesUuid` 顶替，或被别的执行者收尾了。
   *
   * 这里一个字段都不写——行已经不在了，写回去只会把一条用户已经取消的任务复
   * 活。既不算成功也不算失败：算成功的话「回了取消成功却照样发出去」在 tick
   * summary 里完全看不出来，算失败又会让接入方以为该去查投递链路。
   */
  function recordCancelled(task, status) {
    results.cancelledTasks.push({
      taskId: task.id,
      reason: '任务在投递期间被取消或顶替',
      status
    });
    console.warn(`[amsg-server] 任务 ${task.id} 在投递期间被取消或顶替（${status}）`);
  }

  /**
   * 行上的密文还是占位时手里这一份吗？
   *
   * 每一次重写 `encrypted_payload` 之前都要问一遍。手里这份 payload 是占位时
   * 的快照，而一次投递可能跑几十秒——其间用户 `PUT /update-message` 改过这条
   * 任务的话，把快照原样写回去就等于把那次修改静默回滚了（更新走的是按 id 匹
   * 配的写，没有条件判断拦着；没实现 claimTask 的适配器也没有租约拦着）。
   *
   * 读不到就当它可能变过：留一条过时的 lastError，比吞掉用户刚保存的改动强。
   *
   * @param {Object} task - 数据库行（占位时那一份）
   * @returns {Promise<boolean>}
   */
  async function payloadStillFresh(task) {
    if (typeof db.getTaskByUuid !== 'function' || !task.uuid) return true;
    try {
      const current = await db.getTaskByUuid(task.uuid, task.user_id);
      return Boolean(current) && current.encrypted_payload === task.encrypted_payload;
    } catch (_readError) {
      return false;
    }
  }

  /**
   * 把这次的错误记进 payload 的 lastError（best-effort）。
   *
   * 行上的 last_error 列才是投影读的权威那一份（每次失败刷新、成功清空），密
   * 文里这一份是给没有那一列的适配器兜底的——投影读不到列时才会回退到它，见
   * lib/task-projection.js。加密不了就算了，记录失败不该拖垮状态推进。
   *
   * 这一份要重写整个 `encrypted_payload`，所以同样先过 payloadStillFresh。
   *
   * @param {Object} task
   * @param {Object} decryptedPayload
   * @param {string} userKey
   * @param {string} reason
   * @param {Object} [extra] - 额外记进 lastError 的字段（例如快进跳过了几次）
   */
  async function encryptPayloadWithLastError(task, decryptedPayload, userKey, reason, extra) {
    if (!decryptedPayload || !userKey) return null;
    if (!(await payloadStillFresh(task))) return null;
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
   * 把 payload 里的 lastError 剔掉再加密（best-effort）。
   *
   * 行上有 last_error 列时，投影读的是行上那一份，密文里这一份是给没有那一列
   * 的适配器兜底的；但两份都得清干净——同一个部署换个适配器、或者投影从不同的
   * 列集读行，剩下的那一份就会翻出来当成「最近一次失败」。
   *
   * 同样先过 payloadStillFresh：清不掉最多留一条过时的 lastError，下一次成功
   * 投递会自己把它清掉。
   *
   * @param {Object} task - 数据库行（占位时那一份）
   * @param {Object} decryptedPayload
   * @param {string} userKey
   * @returns {Promise<string|null>} 不该写 / 加密不了 → null（调用方原样不动 payload）
   */
  async function encryptPayloadWithoutLastError(task, decryptedPayload, userKey) {
    if (!decryptedPayload || !userKey) return null;
    if (!(await payloadStillFresh(task))) return null;
    try {
      const { lastError: _cleared, ...rest } = decryptedPayload;
      return await encryptForStorage(JSON.stringify(rest), userKey);
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
   *
   * @param {Object} [failure] - 这次失败的机读标注
   * @param {string|null} [failure.errorCode] - 底层错误的稳定 `code`
   * @param {boolean} [failure.permanent] - hook 侧 NonRetryableError 的透传
   * @param {number|null} [failure.pushStatus] - 推送服务回的 HTTP 状态码
   */
  async function handleDeliveryFailure(task, reason, recurrenceType, decryptedPayload, userKey, failure = {}) {
    results.failedCount++;
    const errorCode = failure.errorCode ?? null;
    const pushStatus = toPushStatus(failure.pushStatus);
    const tzId = decryptedPayload ? (decryptedPayload.tzId ?? null) : null;
    // 重试也好不了的失败不进退避阶梯：一次性任务直接进终审处置，循环任务直接
    // 作废本次 occurrence。判定口径见 lib/errors.js 的 isPermanentDeliveryFailure。
    const permanent = isPermanentDeliveryFailure({ permanent: failure.permanent, errorCode, pushStatus });
    // 机读标注跟着 reason 一起记：reason 是给用户看的人话（措辞随时会变），
    // errorCode / pushStatus 是给下游判定用的。判终态的依据也在这两个字段里，
    // 不写出去的话下游只知道「失败了」，不知道该让用户重建订阅还是裁短内容。
    const errorExtra = buildErrorExtra(errorCode, pushStatus);
    try {
      if (permanent || task.retry_count >= 3) {
        const encrypted = await encryptPayloadWithLastError(task, decryptedPayload, userKey, reason, errorExtra);
        if (isRecurringType(recurrenceType)) {
          const nextSendAt = nextFutureOccurrence(Date.parse(task.next_send_at), recurrenceType, Date.now(), tzId);
          await updateAndRelease(task.id, {
            next_send_at: nextSendAt,
            retry_count: 0,
            ...(encrypted ? { encrypted_payload: encrypted } : {}),
            last_error: lastErrorJson(task, reason, errorExtra)
          });
          results.failedTasks.push({ taskId: task.id, reason, retryCount: task.retry_count, status: 'occurrence_skipped', nextSendAt, ...(permanent ? { permanent: true } : {}) });
        } else {
          await updateAndRelease(task.id, {
            status: 'failed',
            ...(encrypted ? { encrypted_payload: encrypted } : {}),
            last_error: lastErrorJson(task, reason, errorExtra)
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
            last_error: lastErrorJson(task, reason, errorExtra)
          });
        } else {
          await updateTaskWithLastError(task.id, {
            next_send_at: nextRetryTime.toISOString(),
            retry_count: task.retry_count + 1,
            last_error: lastErrorJson(task, reason, errorExtra)
          });
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
    const lease = startLeaseHeartbeat(task);
    activeLeases.set(task.id, lease);
    try {
      await deliverClaimedTask(task, decrypted, lease);
    } finally {
      lease.stop();
      activeLeases.delete(task.id);
    }
  }

  /** 占位之后的投递主体（从解密守卫到发送收尾），从 processTask 拆出来只是
   *  为了让心跳的 try/finally 能整段兜住它。 */
  async function deliverClaimedTask(task, decrypted, lease) {
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
        // 结果出口也一并给：「这一条（这几条）没响」本身就常是要送回客户端
        // 的一条结果，宿主不用为这个场合另开一条回程（见 lib/result-emitter.js）。
        const { emitResult } = createResultEmitter({
          db,
          task,
          userKey,
          decryptedPayload,
          messageIdBase: task.id != null
            ? `msg_task_${task.id}${occurrenceSuffix(task)}`
            : `msg_stale_${task.uuid || ''}`,
          sessionId: task.id != null
            ? `sess_task_${task.id}${occurrenceSuffix(task)}`
            : `sess_stale_${task.uuid || ''}`,
          occurrenceMs,
          webpush: ctx.webpush
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
          last_error: lastErrorJson(task, 'stale', recurring ? { skippedCount, nextSendAt } : undefined)
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
          ...stateAccessors,
          emitResult
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
      // webpush 套一层取消检查（见 guardWebpushWithLease）：投递期间任务被取消
      // 的话，推送在发出去之前就被拦下。
      sendResult = await processSingleMessage(
        task, { ...ctx, db, masterKey, webpush: guardWebpushWithLease(ctx.webpush, lease) }, masterKey,
        { userKey, payload: decryptedPayload }
      );
    } catch (error) {
      if (lease.lost) {
        recordCancelled(task, 'cancelled_mid_delivery');
        return;
      }
      // 兜底分支：processSingleMessage 自己把整个流程包在 try/catch 里，失败
      // 走的是下面的 sendResult 分支。走到这儿说明是它没兜住的意外异常，跟
      // 推送服务无关，所以不带 pushStatus——那个字段只描述「推送那一步回了什
      // 么状态码」，任何来路的 `statusCode` 都不该冒充它（404 / 410 会让任务
      // 被判成订阅失效、永久 failed）。
      await handleDeliveryFailure(
        task, error.message || '消息发送失败', recurrenceType, decryptedPayload, userKey,
        { errorCode: error.code || null, permanent: error.permanent === true, pushStatus: null }
      );
      return;
    }

    if (!sendResult.success) {
      // 取消是拦下来的，不是发失败——按失败走会给一条已经不存在的行排重试，
      // 也会把这件事混进 failedTasks 里。
      if (lease.lost) {
        recordCancelled(task, 'cancelled_mid_delivery');
        return;
      }
      await handleDeliveryFailure(
        task, sendResult.error || '消息发送失败', recurrenceType, decryptedPayload, userKey,
        { errorCode: sendResult.errorCode || null, permanent: sendResult.permanent === true, pushStatus: sendResult.pushStatusCode }
      );
      return;
    }

    // 正文送到了，只有那条思考过程没发出去（超限、被推送服务拒收……）。这条任务
    // 仍然是成功的——思考过程是正文之外的附赠内容，把它算成失败会让接入方跑去查
    // 投递链路，还会给一条已经送达的消息排重试。但也不能一声不吭：不记在这里的
    // 话，这条被丢掉的 push 在 tick 汇总、日志、调用方响应里全都看不见。
    // 同理不写进 last_error：那一列说的是「上一次没发出去的原因」，一条正常送达
    // 的消息挂着它，客户端会当成这次投递失败了。
    if (sendResult.reasoningError) {
      results.reasoningSkippedTasks.push({ taskId: task.id, reason: sendResult.reasoningError });
      console.warn(
        `[amsg-server] 任务 ${task.id} 的正文已送达，思考过程没发出去: ${sendResult.reasoningError}`
      );
    }

    try {
      // 收尾写库匹配不到行 = 推送都发完了才发现这条已经被取消或顶替（心跳的
      // 间隔盖不住的那段窗口）。消息确实发出去了，但这一跳不能记成功——记成功
      // 的话，「取消接口回了 200、消息照样送达」在 summary 里一点痕迹都没有。
      if (recurrenceType === 'none') {
        // 行删掉之后租约当然也续不上了，跟收尾写库一样先标一下（见 markLeaseReleased）。
        markLeaseReleased(task.id);
        if (rowVanished(await db.deleteTaskById(task.id))) {
          recordCancelled(task, 'cancelled_after_delivery');
          return;
        }
        results.deletedOnceOffTasks++;
      } else {
        // 以这条任务原本的触发时刻为基准往后推（推进到未来第一个名义时刻）。
        // 这次成功了，把上一轮失败留下的记录两处一起清掉：行上的 last_error 列
        // 写 null，密文 payload 里那份重新加密一遍剔掉。不清的话，用户重新登记
        // 订阅、之后天天正常送达，GET /message 里还挂着那次 410——投影读哪一份
        // 取决于适配器有没有这一列，所以两份都得清。
        //
        // payload 那一份只在真有 lastError 时才重写（正常投递不会每次都重新加
        // 密整份正文），而且重写前会确认行上的密文还是手里这一份，见
        // encryptPayloadWithoutLastError。
        const nextSendAt = nextFutureOccurrence(occurrenceMs, recurrenceType, Date.now(), tzId);
        const clearedPayload = (decryptedPayload && decryptedPayload.lastError)
          ? await encryptPayloadWithoutLastError(task, decryptedPayload, userKey)
          : null;
        const updated = await updateAndRelease(task.id, {
          next_send_at: nextSendAt,
          retry_count: 0,
          last_error: null,
          ...(clearedPayload ? { encrypted_payload: clearedPayload } : {})
        });
        if (rowVanished(updated)) {
          recordCancelled(task, 'cancelled_after_delivery');
          return;
        }
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
      // 投递期间行被取消 / 顶替的任务。`cancelled_mid_delivery` = 推送在发出去
      // 之前被拦下；`cancelled_after_delivery` = 推送已经发完，收尾写库才发现
      // 行没了。两种都不计入 successCount / failedCount。
      cancelledTasks: results.cancelledTasks,
      // 正文送到了、只有思考过程没发出去的任务（{ taskId, reason }）。这些任务
      // 照常计入 successCount——列在这里只是让「这次没有思考过程」看得见。
      reasoningSkippedTasks: results.reasoningSkippedTasks,
      failedTasks: results.failedTasks
    }
  };
}
