/**
 * hook 手里的 client_state 读写口：`readState(namespace)` /
 * `writeState(namespace, entries)`。
 *
 * 读到和写出的都是客户端 `GET/PUT /client-state` 那套数据（加密、大值分块、
 * 切片清理全部共用 lib/client-state-store.js 与 lib/state-chunks.js），所以
 * hook 写下的东西客户端读得回，反过来也一样。
 *
 * 每个 hook 载荷都现造一份：闭包里握着的 db 绑定和用户密钥属于**这一次**
 * 调用。Cloudflare Workers 上跨请求复用上一次的绑定会撞上「Cannot perform
 * I/O on behalf of a different request」，所以这份口子从来不缓存到模块作用域。
 */

import { decryptFromStorage } from './encryption.js';
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

/**
 * @typedef {Object} StateAccessors
 * @property {(namespace: string) => Promise<Array<{ namespace: string, key: string, value: string, updatedAt: number }>>} readState
 *   一个 namespace 下的全部条目（值已解密、分块的已拼回原文）。适配器不支持
 *   client_state 时返回空数组——读不到状态，hook 走自己的兜底就行。
 * @property {(namespace: string, entries: Array<{ key: string, value: string|null, updatedAt?: number }>) => Promise<{ upserted: number, skipped: number, deleted: number }>} writeState
 *   批量写。`value` 是字符串 → 整条覆盖（不是追加，宿主自己序列化）；
 *   `value` 为 `null` → 删掉这个 key（连它的分块切片行一起）。`updatedAt`
 *   默认取当前时刻，语义与客户端同步一致：比库里已有值旧的写入（或删除）
 *   不生效，客户端后写的数据不会被这次调用盖回去。
 *   适配器不支持 client_state 时抛错（静默成功会让 push 带上一个指向不存在
 *   数据的引用键）。
 */

/**
 * 造一份作用于某个用户的状态读写口。
 *
 * 典型用法是「大内容旁路」：一条 Web Push 的正文只有 4KB 出头（见
 * lib/webpush-webcrypto.js 的 MAX_PUSH_PAYLOAD_BYTES），塞不下的内容先写进
 * client_state，push 里只带一个引用键，客户端上线后按键取回。
 *
 * 谁清、什么时候清：库不做 TTL 也不自动回收，写进去的东西一直在，直到有人
 * 覆盖或删除它。旁路内容建议放在固定的少量 key 上（例如每个角色一个），下次
 * 写同一个 key 直接覆盖，存量天然有上限；一次性的大内容在确认客户端取走后，
 * 用 `{ key, value: null }` 删掉。`DELETE /client-state` 仍然是清空这个用户
 * 全部状态的兜底。
 *
 * @param {Object} args
 * @param {import('../adapters/interface.js').DbAdapter} args.db
 * @param {string} args.userId
 * @param {string} args.userKey - per-user 存储密钥
 * @param {number} [args.maxStateValueBytes] - 单条 value 的字节上限（默认 5MB）
 * @param {() => number} [args.now] - 取当前时刻（测试可注入假时钟）
 * @returns {StateAccessors}
 */
export function createStateAccessors({ db, userId, userKey, maxStateValueBytes, now }) {
  const nowFn = typeof now === 'function' ? now : Date.now;
  const valueCeiling = Number.isInteger(maxStateValueBytes) && maxStateValueBytes > 0
    ? maxStateValueBytes
    : DEFAULT_MAX_STATE_VALUE_BYTES;

  const readState = async (namespace) => {
    if (typeof namespace !== 'string' || !namespace.trim()) {
      throw new TypeError('readState(namespace) requires a non-empty string');
    }
    if (!db || typeof db.getClientState !== 'function') return [];
    const rows = await db.getClientState(userId, namespace);
    // 分块存储的值在这里拼回原文（见 state-chunks.js）；块不齐全的 key 视为
    // 不存在 —— hook 作者拿到的与客户端写入的一致，永远不会是半截数据。
    return resolveClientStateEntries(
      rows,
      () => db.getClientState(userId, chunkNamespaceFor(namespace)),
      (value) => decryptFromStorage(value, userKey)
    );
  };

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
    if (!db || typeof db.upsertClientState !== 'function') {
      throw new Error('AGENTIC_STATE_WRITE_UNSUPPORTED: 当前数据库适配器不支持 client_state 写入');
    }

    const at = nowFn();
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
        if (bytes > valueCeiling) {
          throw new RangeError(`writeState: entries[${index}].value 为 ${bytes} 字节，超过单条上限 ${valueCeiling} 字节`);
        }
      }
      if (entry.updatedAt !== undefined && (!Number.isInteger(entry.updatedAt) || entry.updatedAt <= 0)) {
        throw new TypeError(`writeState: entries[${index}].updatedAt 必须是正整数（epoch 毫秒）`);
      }
      return {
        namespace,
        key: entry.key,
        value: entry.value,
        updatedAt: entry.updatedAt ?? at,
      };
    });

    return writeClientStateEntries({ db, userId, userKey, entries: normalized });
  };

  return { readState, writeState };
}
