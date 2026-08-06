/**
 * Handler: outbox
 *
 * 服务端消息收件箱的客户端侧两个口：
 *
 *   GET  /outbox?since=<cursor>[&limit=<n>]  拉未 ack 的消息（id 升序，游标翻页）
 *   POST /outbox/ack { messageIds }           确认收到（幂等）
 *
 * 服务端发出的每条 push 在发送前都先落进 message_outbox（见
 * lib/outbox-store.js），所以「哪些消息没送到」是从这里查出来的事实：
 * 客户端上线后拉一次未 ack 的，收到（或删除 / 重 roll）就 ack——不再需要
 * 拿「messageId 在不在本地近 N 条里」去猜，猜错导致的整族问题（删掉的回复
 * 复活、多段丢失没人补、与进行中会话竞态重复上屏）从根上不存在。
 *
 * `delivered_at` 为 null 的行是 Web Push 发送失败/中断的那部分——最需要补
 * 收的就是它们，但拉取不按它过滤：推送发出去了客户端也可能没收到（TTL 过
 * 期、订阅轮换），ack 才是「收到了」的唯一凭据。
 *
 * 鉴权与加密跟既有端点一致：X-Client-Token 走 resolveTenant，GET 响应走加
 * 密信封，POST 请求体必须加密。适配器不支持 outbox（自定义适配器）→ 501。
 *
 * @param {Object} ctx - Server context.
 * @returns {{ GET: function, POST: function }}
 */

import { deriveUserEncryptionKey, decryptPayload, encryptPayload, decryptFromStorage } from '../lib/encryption.js';
import { getHeader, isPlainObject, parseEncryptedBody, requireUserId } from '../lib/request.js';

// 一页最多拉多少条。outbox 存的是最近四周内的推送（更老的被 tick 清理），
// 100 已经远超一次补收的正常规模。
export const MAX_OUTBOX_PAGE_SIZE = 100;
export const DEFAULT_OUTBOX_PAGE_SIZE = 50;
// 一次 ack 的条数上限（与拉取页大小同数量级，客户端按页 ack 用不到更多）。
export const MAX_OUTBOX_ACK_IDS = 200;

function err(status, code, message, details) {
  const error = details === undefined ? { code, message } : { code, message, details };
  return { status, body: { success: false, error } };
}

export function createOutboxHandler(ctx) {
  async function GET(url, headers) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers);
    if (!tenantResult.ok) return tenantResult.error;
    const { db, masterKey } = tenantResult.context;

    const gate = requireUserId(headers);
    if (gate.error) return gate.error;
    const { userId } = gate;

    if (typeof db.listUnackedOutbox !== 'function') {
      return err(501, 'OUTBOX_NOT_SUPPORTED', '当前数据库适配器不支持 message_outbox');
    }

    const params = new URL(url, 'https://dummy').searchParams;
    const sinceRaw = params.get('since');
    const since = sinceRaw == null || sinceRaw === '' ? 0 : Number(sinceRaw);
    if (!Number.isInteger(since) || since < 0) {
      return err(400, 'INVALID_OUTBOX_CURSOR', 'since 必须是非负整数（上一页响应里的 cursor）');
    }
    const limitRaw = params.get('limit');
    let limit = limitRaw == null || limitRaw === '' ? DEFAULT_OUTBOX_PAGE_SIZE : Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0) {
      return err(400, 'INVALID_OUTBOX_LIMIT', `limit 必须是 1-${MAX_OUTBOX_PAGE_SIZE} 的整数`);
    }
    limit = Math.min(limit, MAX_OUTBOX_PAGE_SIZE);

    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    const rows = await db.listUnackedOutbox(userId, since, limit);

    const entries = [];
    let cursor = since;
    for (const row of rows) {
      cursor = Math.max(cursor, row.id);
      // 单条解密/解析失败只丢它自己（记日志），别让一条坏行把整页补收拖挂。
      let push;
      try {
        push = JSON.parse(await decryptFromStorage(row.payload, userKey));
      } catch (error) {
        console.warn('[amsg-server] outbox 行解密失败（已跳过）:', row.id, error && error.message);
        continue;
      }
      entries.push({
        id: row.id,
        messageId: row.message_id,
        taskUuid: row.task_uuid ?? null,
        sessionId: row.session_id ?? null,
        messageIndex: row.message_index ?? null,
        totalMessages: row.total_messages ?? null,
        createdAt: row.created_at,
        deliveredAt: row.delivered_at ?? null,
        push,
      });
    }

    const data = {
      entries,
      cursor,
      // 按「捞满一页」判断还有没有下一页；解密失败被跳过的行不影响游标推进。
      hasMore: rows.length === limit,
    };
    const encryptedResponse = await encryptPayload(data, userKey);
    return { status: 200, body: { success: true, encrypted: true, version: 1, data: encryptedResponse } };
  }

  async function POST(headers, body) {
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

    const messageIds = payload.messageIds;
    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return err(400, 'INVALID_OUTBOX_ACK', 'messageIds 必须是非空数组');
    }
    if (messageIds.length > MAX_OUTBOX_ACK_IDS) {
      return err(400, 'TOO_MANY_OUTBOX_ACK_IDS', `单次最多 ack ${MAX_OUTBOX_ACK_IDS} 条`, { count: messageIds.length });
    }
    if (!messageIds.every((id) => typeof id === 'string' && id.trim())) {
      return err(400, 'INVALID_OUTBOX_ACK', 'messageIds 的每一项必须是非空字符串');
    }

    if (typeof db.ackOutboxMessages !== 'function') {
      return err(501, 'OUTBOX_NOT_SUPPORTED', '当前数据库适配器不支持 message_outbox');
    }

    const acked = await db.ackOutboxMessages(userId, messageIds, Date.now());
    return { status: 200, body: { success: true, data: { acked } } };
  }

  return { GET, POST };
}
