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
    const now = Date.now();
    const rows = await Promise.all(pushes.map(async (push) => ({
      message_id: push.messageId,
      task_uuid: push.taskUuid ?? null,
      session_id: push.sessionId ?? null,
      message_index: push.messageIndex ?? null,
      total_messages: push.totalMessages ?? null,
      payload: await encryptForStorage(JSON.stringify(push), userKey),
      created_at: now,
    })));
    await db.appendOutboxMessages(userId, rows);
    return true;
  } catch (error) {
    console.warn('[amsg-server] outbox 落行失败（不影响投递）:', error && error.message);
    return false;
  }
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
export async function discardPushesFromOutbox({ db, userId, messageIds }) {
  if (!db || typeof db.discardOutboxMessages !== 'function') return;
  if (!messageIds || messageIds.length === 0) return;
  try {
    await db.discardOutboxMessages(userId, messageIds);
  } catch (error) {
    console.warn('[amsg-server] outbox 撤回未发出的行失败（已忽略）:', error && error.message);
  }
}
