/**
 * Handler: client-state-namespaces
 *
 *   GET /client-state/namespaces[?limit=<n>]
 *     → （加密信封）{ namespaces: [{ namespace, entryCount, byteSize, updatedAt }], truncated }
 *
 * 「云端到底存了什么」的对账口。宿主把这份清单和自己本地的清单一对，就知道哪
 * 些命名空间是本地已经不存在的残留（角色删了、重装过），再用
 * `DELETE /client-state?namespace=<ns>` 一个一个清掉——在此之前只有「整表全清」
 * 这一个粒度。
 *
 * 命名空间名本身是用户数据（宿主常把角色身份编在里面），所以响应跟
 * `GET /client-state` 一样走加密信封，不明文出门。
 *
 * 三件事值得说清楚：
 *
 *   1. **保留命名空间不单独列。** 单条 value 超过 200KB 时库会把它切片存进
 *      `\u001famsg-chunks\u001f<原命名空间>`（见 lib/state-chunks.js），那是存储
 *      实现细节，宿主眼里不该有这个东西。所以切片行折算进原命名空间：`byteSize`
 *      和 `updatedAt` 算进去（地方确实是它占的、写入确实发生过），`entryCount`
 *      不算（切片是一个逻辑条目的几段，不是几个条目）。
 *
 *   2. **`byteSize` 是存储字节，不是原文字节。** 值落库前都加密过
 *      （`encryptForStorage`，十六进制密文），所以这个数比明文大一截。它回答的是
 *      「这个命名空间在云端占了多大地方」，不是「里面的文本有多长」。
 *
 *   3. **有条数上限。** 默认 200 条，`limit` 可以往下调（上不封顶地返回等于把一
 *      个无界列表塞进一次响应）。被截断时 `truncated: true`——宿主至少知道「还有
 *      没列出来的」，不会把这份清单当全集去反推「本地有、云端没有 = 可以删」。
 *
 * 鉴权与既有端点一致：X-Client-Token 走 resolveTenant，X-User-Id 必填。
 */

import { deriveUserEncryptionKey, encryptPayload } from '../lib/encryption.js';
import { requireUserId } from '../lib/request.js';
import { CHUNK_NAMESPACE_PREFIX } from '../lib/state-chunks.js';

/** 一次最多列几个命名空间（也是 `limit` 的上限）。 */
export const MAX_CLIENT_STATE_NAMESPACES = 200;

function err(status, code, message, details) {
  const error = details === undefined ? { code, message } : { code, message, details };
  return { status, body: { success: false, error } };
}

export function createClientStateNamespacesHandler(ctx) {
  async function GET(url, headers) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers);
    if (!tenantResult.ok) return tenantResult.error;
    const { db, masterKey } = tenantResult.context;

    const gate = requireUserId(headers);
    if (gate.error) return gate.error;
    const { userId } = gate;

    const limitRaw = new URL(url, 'https://dummy').searchParams.get('limit');
    let limit = limitRaw == null || limitRaw === '' ? MAX_CLIENT_STATE_NAMESPACES : Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0) {
      return err(400, 'INVALID_NAMESPACE_LIMIT', `limit 必须是 1-${MAX_CLIENT_STATE_NAMESPACES} 的整数`);
    }
    limit = Math.min(limit, MAX_CLIENT_STATE_NAMESPACES);

    if (typeof db.listClientStateNamespaces !== 'function') {
      return err(501, 'CLIENT_STATE_NAMESPACES_NOT_SUPPORTED', '当前数据库适配器不支持按命名空间统计 client_state');
    }

    // 多要一条：回来的比 limit 多就说明还有没列出来的。用「捞满一页」判断会把
    // 「正好 limit 个命名空间」也标成截断。
    const rows = await db.listClientStateNamespaces(userId, {
      limit: limit + 1,
      foldPrefix: CHUNK_NAMESPACE_PREFIX,
    });
    const truncated = rows.length > limit;

    const namespaces = rows.slice(0, limit).map((row) => ({
      namespace: row.namespace,
      entryCount: Number(row.entry_count || 0),
      byteSize: Number(row.byte_size || 0),
      updatedAt: Number(row.updated_at || 0),
    }));

    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    const encryptedResponse = await encryptPayload({ namespaces, truncated, limit }, userKey);
    return { status: 200, body: { success: true, encrypted: true, version: 1, data: encryptedResponse } };
  }

  return { GET };
}
