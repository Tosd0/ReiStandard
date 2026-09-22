/**
 * message_outbox 的写入侧：push 发送前落行、发送成功后标 delivered。
 *
 * 这张表是「客户端补收」的事实来源：客户端上线后 `GET /outbox?since=` 拉未
 * ack 的行、收到后 `POST /outbox/ack`，不再靠「messageId 在不在本地近 N 条
 * 里」去猜哪些推送丢了。发送方（老链路 message-processor 与 agentic 链路的
 * sendHookPushPayloads）共用这一份实现。
 *
 * 全程 best-effort：outbox 是投递的旁路账本，落行失败不该把一次本来能成的
 * 推送变成失败——最坏情况只是退回「没有账本」的旧行为。
 */

import { decryptFromStorage, encryptForStorage } from './encryption.js';

/** 适配器支持 outbox 吗（写入侧要用的两个方法都在才算）。 */
export function supportsOutbox(db) {
  return !!db
    && typeof db.appendOutboxMessages === 'function'
    && typeof db.markOutboxDelivered === 'function';
}

/**
 * 发送前把这一批 push 落进 outbox。push 对象须已定稿（messageId / sessionId /
 * messageIndex / totalMessages / 任务身份都已补齐）——落进去的密文就是客户端
 * 补收时拿到的那一份。
 *
 * @param {Object} args
 * @param {Object} args.db
 * @param {string} args.userId
 * @param {CryptoKey|string} args.userKey - per-user 存储密钥
 * @param {Object[]} args.pushes - 定稿后的 push 对象
 * @returns {Promise<boolean>} 是否真的落了行（适配器不支持 / 落行失败 → false）
 */
export async function appendPushesToOutbox({ db, userId, userKey, pushes }) {
  if (!supportsOutbox(db) || !pushes || pushes.length === 0) return false;
  try {
    await db.appendOutboxMessages(userId, await toOutboxRows(pushes, userKey, Date.now()));
    return true;
  } catch (error) {
    console.warn('[amsg-server] outbox 落行失败（不影响投递）:', error && error.message);
    return false;
  }
}

/**
 * 把 push 对象转成 message_outbox 的行（payload 加密）。
 *
 * 抽出来是给 `ctx.emitResult()` 用的：它落的行要跟推送链路落的完全同构——
 * 列一样、加密方式一样、身份字段的取法一样，客户端补收时才不用区分是谁写的。
 *
 * @param {Object[]} pushes - 定稿后的 push 对象
 * @param {CryptoKey|string} userKey
 * @param {number} createdAt - epoch 毫秒
 * @returns {Promise<Object[]>}
 */
export async function toOutboxRows(pushes, userKey, createdAt) {
  return Promise.all(pushes.map(async (push) => ({
    message_id: push.messageId,
    task_uuid: push.taskUuid ?? null,
    session_id: push.sessionId ?? null,
    message_index: push.messageIndex ?? null,
    total_messages: push.totalMessages ?? null,
    payload: await encryptForStorage(JSON.stringify(push), userKey),
    created_at: createdAt,
  })));
}

/**
 * 把发出去的那部分标成 delivered（发送半途失败时只标已发出的段）。
 *
 * @param {Object} args
 * @param {Object} args.db
 * @param {string} args.userId
 * @param {string[]} args.messageIds
 */
export async function markPushesDelivered({ db, userId, messageIds }) {
  if (!supportsOutbox(db) || !messageIds || messageIds.length === 0) return;
  try {
    await db.markOutboxDelivered(userId, messageIds, Date.now());
  } catch (error) {
    console.warn('[amsg-server] outbox 标记 delivered 失败（已忽略）:', error && error.message);
  }
}

/**
 * 把这一批还没发出去的行从 outbox 里撤掉。
 *
 * 用在任务投递到一半被取消 / 顶替的时候。整批 push 是发送前就落进 outbox 的
 * （那是补收的事实来源），取消只拦住了 Web Push 这一路；不撤掉这些行的话，
 * 客户端下一次 `GET /outbox` 照样把剩下的拉回去——用户看到的就是「取消接口回
 * 了成功，消息还是来了」。
 *
 * 已经推出去的那几条不在此列（调用方只传没发出去的 id）：推给设备的撤不回来，
 * 行留着让客户端照常 ack。
 *
 * @param {Object} args
 * @param {Object} args.db
 * @param {string} args.userId
 * @param {string[]} args.messageIds
 */
async function discardPushesFromOutbox({ db, userId, messageIds }) {
  if (!db || typeof db.discardOutboxMessages !== 'function') return;
  if (!messageIds || messageIds.length === 0) return;
  try {
    await db.discardOutboxMessages(userId, messageIds);
  } catch (error) {
    console.warn('[amsg-server] outbox 撤回未发出的行失败（已忽略）:', error && error.message);
  }
}

/**
 * 把这一批 push 里「没发出去的那些」从 outbox 撤掉。
 *
 * 取消撞上投递时用：整批 push 在开发之前就落进了 outbox，取消只拦住了 Web
 * Push 这一路，剩下的行不撤掉，客户端下一次 GET /outbox 会照样把它们拉回去
 * ——用户看到的就是「取消接口回了成功，消息还是来了」。
 *
 * 「哪些算没发出去」这条判据收在这里：投递侧只要把整批 push 和已发出的
 * messageId 交过来就行。
 *
 * @param {Object} args
 * @param {Object} args.db
 * @param {string} args.userId
 * @param {Array<{ messageId: string }>} args.pushes - 落进 outbox 的整批 push
 * @param {string[]} args.sentIds - 已经发出去的 messageId
 */
export async function discardUndeliveredPushes({ db, userId, pushes, sentIds }) {
  const delivered = new Set(sentIds);
  await discardPushesFromOutbox({
    db,
    userId,
    messageIds: (pushes || [])
      .map(push => push.messageId)
      .filter(messageId => !delivered.has(messageId)),
  });
}

// 回退扫描（适配器没有按任务删除的读法）时的翻页参数。页大小与 GET /outbox
// 同量级。行数上限是防呆——outbox 只留最近四周的推送（tick 顺手清），正常远到
// 不了；真到了（cleanupOutbox 不运行的部署形态）会漏撤并打日志，见下。
const OUTBOX_SCAN_PAGE_SIZE = 100;
const OUTBOX_SCAN_MAX_ROWS = 5000;

/**
 * 把某条任务名下「还没发出去的」行从 outbox 撤掉。
 *
 * 用在取消 / 顶替之后的每条收尾路上（`DELETE /message`、`supersedesUuid`、
 * fire 内的 cancelTask、投递侧发现行已被取消）：任务此前投递到一半失败过的话，
 * 没发出去的那几段还躺在 outbox 里等重试，任务行删掉它们也不会跟着走。不撤的
 * 话客户端下一次 `GET /outbox` 照样把它们补收回去——用户看到的就是「取消接口回
 * 了成功，消息还是来了」。
 *
 * 判据与 discardUndeliveredPushes 一致：只撤 delivered_at 为 null 的行。已经推
 * 给设备的那几条撤不回来，行留着让客户端照常 ack——取消的意思是「别再发后面
 * 的」，不是「把已经收到的从收件箱里抹掉」。
 *
 * 优先走适配器的按任务删除（discardUndeliveredOutboxForTask）：一个来回，且不
 * 受未 ack 积压量的影响。没有这个方法的适配器（宿主自带的旧实现）退回翻页扫
 * 描——被取消任务的行通常是最新的，积压超过扫描上限时正好扫不到它们，所以扫到
 * 上限还没扫完必须吵出来，不能装作清干净了。
 *
 * 同样是 best-effort：适配器缺读/删任一侧就静默跳过，出错只记日志。取消 / 顶
 * 替本身已经生效了，不该因为账本没清干净被翻成失败。
 *
 * @param {Object} args
 * @param {Object} args.db
 * @param {string} args.userId
 * @param {string} args.taskUuid - 被取消 / 被顶替的任务 uuid
 */
export async function discardUndeliveredPushesForTask({ db, userId, taskUuid }) {
  if (!db || !taskUuid) return;

  if (typeof db.discardUndeliveredOutboxForTask === 'function') {
    try {
      await db.discardUndeliveredOutboxForTask(userId, taskUuid);
    } catch (error) {
      console.warn('[amsg-server] outbox 按任务撤回未投递的行失败（已忽略）:', error && error.message);
    }
    return;
  }

  if (typeof db.listUnackedOutbox !== 'function' || typeof db.discardOutboxMessages !== 'function') return;

  let scan;
  try {
    scan = await scanUnackedOutboxForTask(db, userId, taskUuid);
  } catch (error) {
    console.warn('[amsg-server] outbox 查未投递的行失败（已忽略）:', error && error.message);
    return;
  }

  if (!scan.exhausted) {
    console.warn(
      `[amsg-server] outbox 扫描到 ${OUTBOX_SCAN_MAX_ROWS} 行上限仍未扫完，`
      + `任务 ${taskUuid} 可能还有未投递的行没撤掉（被取消任务的行通常是最新的，正好在上限之外）。`
      + '给适配器实现 discardUndeliveredOutboxForTask 可绕开这个上限。'
    );
  }

  await discardPushesFromOutbox({
    db,
    userId,
    // 已经推出去的那几条不动（见上）。
    messageIds: scan.rows.filter(row => row.delivered_at == null).map(row => row.message_id),
  });
}

/**
 * 翻页扫一遍这个用户未 ack 的行，挑出属于某条任务的（给没实现按任务读写的适配
 * 器用的回退路径）。
 *
 * @param {Object} db
 * @param {string} userId
 * @param {string} taskUuid
 * @returns {Promise<{ rows: Array<Object>, exhausted: boolean }>} exhausted = 未 ack
 *   的行都看过了。扫到上限、或游标不动（适配器没按 `id > sinceId` 翻页）时为
 *   false——那两种情况都可能有属于这条任务的行没被看到。出错直接抛给调用方。
 */
async function scanUnackedOutboxForTask(db, userId, taskUuid) {
  const rows = [];
  let exhausted = false;
  let cursor = 0;
  let scanned = 0;
  while (scanned < OUTBOX_SCAN_MAX_ROWS) {
    const page = await db.listUnackedOutbox(userId, cursor, OUTBOX_SCAN_PAGE_SIZE);
    if (!page || page.length === 0) {
      exhausted = true;
      break;
    }
    scanned += page.length;
    let nextCursor = cursor;
    for (const row of page) {
      if (row.id > nextCursor) nextCursor = row.id;
      if (row.task_uuid === taskUuid) rows.push(row);
    }
    // 游标没往前走说明适配器没按 `id > sinceId` 翻页，再翻就是死循环。
    if (nextCursor <= cursor) break;
    cursor = nextCursor;
    if (page.length < OUTBOX_SCAN_PAGE_SIZE) {
      exhausted = true;
      break;
    }
  }
  return { rows, exhausted };
}

// ─── 已落定的批次：生成成功之后，重试只补推送 ───────────────────────────
//
// 一次触发（任务 + 名义触发时刻）的整批 push 一旦落进 outbox，这次触发的内容就
// 定了：客户端上线 `GET /outbox` 拉到的就是这一份。之后推送再失败、任务走重试，
// 重试那一跳不该把整条生成（onBeforeFire、每一轮 LLM）从头再跑一遍——那既多花
// 一整轮钱，又会让同一次触发在客户端那边出现两份不同的内容（已经推到设备上的
// 前几段来自第一次生成，补收 / 重推的后几段来自第二次）。
//
// 所以重试那一跳先来这里找：这次触发有没有已经落定的批次。有就只把还没送到的
// 那几条重新推一遍（见 lib/message-processor.js 的 redeliverCommittedBatch），
// 一个 token 都不再花。

/**
 * 往前多看这么久：行的 created_at 用的是 worker 的时钟，名义触发时刻却可能来
 * 自客户端（`messageType: 'instant'` 的 firstSendTime），两边对不齐时别把本次
 * 触发的行挡在窗口外面。循环任务相邻两次触发至少隔一天，这个余量不会把上一次
 * 的行大把捞进来——捞进来也没关系，下面还要按行里的 occurrenceMs 逐条核对。
 */
const COMMITTED_BATCH_LOOKBACK_MS = 60 * 60 * 1000;

/** 一次最多读回这么多行（一批 push 的段数远到不了；防呆）。 */
const COMMITTED_BATCH_MAX_ROWS = 500;

/**
 * @typedef {Object} CommittedBatchEntry
 * @property {Object}  push      - 落进 outbox 的那条 push（解密后，与当初要发的是同一份）
 * @property {boolean} delivered - Web Push 已经发出去过（delivered_at 不为空）
 * @property {boolean} acked     - 客户端已经确认收到（acked_at 不为空）
 */

/**
 * 找这次触发已经落进 outbox 的那一批 push。
 *
 * 认行的规矩（三条都要满足）：
 *   - 行上 `total_messages` 不为空。推送链路定稿时每条都会写 messageIndex /
 *     totalMessages（agentic 与冻结 prompt 两条路都是），`ctx.emitResult()` 落的
 *     结果行没有；
 *   - 解开之后 `taskUuid` / `occurrenceMs` 与本次触发对得上（这两个字段由库覆盖
 *     写，宿主改不了，见 agentic-fire.js 的 stampTaskIdentity）；
 *   - `messageKind` 不是 `result`（再挡一道：emitResult 的 payload 是宿主的形状，
 *     万一自己带了 totalMessages 也不会被认成聊天分段）。
 *
 * 老链路的思考过程（reasoning）那条不带 totalMessages，不在认领范围内：批次落
 * 定时它本来就只落收件箱、不推送，补推也轮不到它。
 *
 * 已经被客户端 ack 的行也要读回来：客户端在两次重试之间上线、把整批补收并 ack
 * 了的话，这一批仍然算落定过——这时候要做的是「什么都不用推了」，而不是当成没
 * 生成过、再生成一份新的。
 *
 * 读不到（适配器没有 outbox、查询抛错）→ null，调用方退回重新生成的老行为：查
 * 不了不等于有，拿「可能多花一次」换「表结构没跟上的部署照样能重试送达」。
 *
 * @param {Object} args
 * @param {Object} args.db
 * @param {string} args.userId
 * @param {CryptoKey|string} args.userKey
 * @param {string|null|undefined} args.taskUuid
 * @param {number|null} args.occurrenceMs - 本次触发的名义时刻
 * @param {number} [args.now] - 当前时刻（epoch 毫秒，测试可注入）
 * @returns {Promise<{ entries: CommittedBatchEntry[] } | null>} entries 按
 *   messageIndex 升序；这次触发没有落定过批次 → null
 */
export async function findCommittedBatch({ db, userId, userKey, taskUuid, occurrenceMs, now = Date.now() }) {
  if (!db || !taskUuid || !Number.isFinite(occurrenceMs)) return null;

  let rows;
  try {
    rows = await listOutboxRowsForTask(db, userId, taskUuid, Math.min(occurrenceMs, now) - COMMITTED_BATCH_LOOKBACK_MS);
  } catch (error) {
    console.warn('[amsg-server] 查这次触发落定的批次失败（按没有处理，这一跳会重新生成）:', error && error.message);
    return null;
  }
  if (!rows || rows.length === 0) return null;

  const entries = [];
  for (const row of rows) {
    if (row.total_messages == null) continue;
    let push;
    try {
      push = JSON.parse(await decryptFromStorage(row.payload, userKey));
    } catch (_decryptError) {
      continue;
    }
    if (!push || typeof push !== 'object') continue;
    if (push.taskUuid !== taskUuid || push.occurrenceMs !== occurrenceMs) continue;
    if (push.messageKind === 'result') continue;
    entries.push({ push, delivered: row.delivered_at != null, acked: row.acked_at != null });
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => (a.push.messageIndex ?? 0) - (b.push.messageIndex ?? 0));
  return { entries };
}

/**
 * 某条任务名下的 outbox 行（带 payload / total_messages / delivered_at / acked_at）。
 *
 * 优先走适配器的 listOutboxForTask（任何状态的行都读得到，按 created_at 窗口收
 * 窄）。没有的话退回翻页扫描未 ack 的行——那条路读不到已 ack 的行：客户端恰好在
 * 两次重试之间把整批 ack 了，这一跳会当成没落定过、重新生成一份。适配器没有
 * outbox → null。
 *
 * @param {Object} db
 * @param {string} userId
 * @param {string} taskUuid
 * @param {number} sinceMs - 只要这个时刻之后落的行（epoch 毫秒）
 * @returns {Promise<Array<Object>|null>}
 */
async function listOutboxRowsForTask(db, userId, taskUuid, sinceMs) {
  if (typeof db.listOutboxForTask === 'function') {
    return db.listOutboxForTask(userId, taskUuid, { sinceMs, limit: COMMITTED_BATCH_MAX_ROWS });
  }
  if (typeof db.listUnackedOutbox === 'function') {
    const { rows } = await scanUnackedOutboxForTask(db, userId, taskUuid);
    return rows.filter(row => !(Number(row.created_at) < sinceMs));
  }
  return null;
}
