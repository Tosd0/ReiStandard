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

import { encryptForStorage } from './encryption.js';

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

// 按任务清 outbox 时的扫描参数。适配器只提供「按用户翻页列未 ack 行」这一种
// 读法，所以得翻一遍挑出属于这条任务的行；页大小与 GET /outbox 同量级。行数上
// 限是防呆——outbox 只留最近四周的推送（tick 顺手清），正常远到不了。
const OUTBOX_SCAN_PAGE_SIZE = 100;
const OUTBOX_SCAN_MAX_ROWS = 5000;

/**
 * 把某条任务名下「还没发出去的」行从 outbox 撤掉。
 *
 * 用在取消 / 顶替只碰了任务行的那两条路上（`DELETE /message` 与
 * `supersedesUuid`）：任务此前投递到一半失败过的话，没发出去的那几段还躺在
 * outbox 里等重试，任务行删掉它们也不会跟着走。不撤的话客户端下一次
 * `GET /outbox` 照样把它们补收回去——用户看到的就是「取消接口回了成功，消息还
 * 是来了」。
 *
 * 判据与 discardUndeliveredPushes 一致：只撤 delivered_at 为 null 的行。已经推
 * 给设备的那几条撤不回来，行留着让客户端照常 ack——取消的意思是「别再发后面
 * 的」，不是「把已经收到的从收件箱里抹掉」。
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
  if (!db || typeof db.listUnackedOutbox !== 'function' || typeof db.discardOutboxMessages !== 'function') return;
  if (!taskUuid) return;

  const messageIds = [];
  try {
    let cursor = 0;
    let scanned = 0;
    while (scanned < OUTBOX_SCAN_MAX_ROWS) {
      const rows = await db.listUnackedOutbox(userId, cursor, OUTBOX_SCAN_PAGE_SIZE);
      if (!rows || rows.length === 0) break;
      scanned += rows.length;
      let nextCursor = cursor;
      for (const row of rows) {
        if (row.id > nextCursor) nextCursor = row.id;
        if (row.task_uuid !== taskUuid) continue;
        // 已经推出去的那几条不动（见上）。
        if (row.delivered_at != null) continue;
        messageIds.push(row.message_id);
      }
      // 游标没往前走说明适配器没按 `id > sinceId` 翻页，再翻就是死循环。
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
      if (rows.length < OUTBOX_SCAN_PAGE_SIZE) break;
    }
  } catch (error) {
    console.warn('[amsg-server] outbox 查未投递的行失败（已忽略）:', error && error.message);
    return;
  }

  await discardPushesFromOutbox({ db, userId, messageIds });
}
