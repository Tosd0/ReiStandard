/**
 * Handler: client-state
 *
 * Cloud mirror of client-side state for the single-user deployment. The
 * client batch-syncs entries up (PUT) whenever convenient — e.g. in the
 * few-seconds window before iOS backgrounds the page — and fire-time
 * hooks read them back via ctx.readState(namespace). One live copy per
 * (user, namespace, key); the client is the only writer.
 *
 *   PUT    /client-state                 batch upsert, last-write-wins on updatedAt
 *   GET    /client-state?namespace=<ns>  one namespace's entries (decrypted, response re-encrypted)
 *   DELETE /client-state                 wipe every entry of this user
 *
 * 单条 value 超过 200KB 时由服务端透明分块（见 lib/state-chunks.js）：写入时
 * 切片跨行存储，GET / readState 返回拼好的原值，客户端与 hook 作者无感。
 * 单条总上限默认 5MB，工厂配置 maxStateValueBytes 可调。批内某条超限/非法
 * 只拒它自己：有拒绝时响应带 data.rejected 逐条给原因，全部成功时响应形状
 * 与单值时代完全一致。
 *
 * Auth & crypto follow the existing endpoints exactly: X-Client-Token is
 * all-or-nothing via resolveTenant, PUT bodies must be encrypted
 * (X-Payload-Encrypted / X-Encryption-Version), values are stored as
 * encryptForStorage ciphertext under the per-user key, and GET responses
 * ride the existing encrypted-response envelope.
 */

import { deriveUserEncryptionKey, decryptPayload, encryptPayload, encryptForStorage, decryptFromStorage } from '../lib/encryption.js';
import { getHeader, isPlainObject, parseEncryptedBody } from '../lib/request.js';
import { isValidUUIDv4 } from '../lib/validation.js';
import {
  STATE_CHUNK_SLICE_BYTES,
  DEFAULT_MAX_STATE_VALUE_BYTES,
  INTERNAL_STATE_CHAR_RE,
  chunkNamespaceFor,
  chunkKeyFor,
  chunkKeyPrefixFor,
  buildChunkedRootValue,
  splitStateValue,
  resolveClientStateEntries,
} from '../lib/state-chunks.js';

// 单个存储行的 plaintext 上限 = 分块切片大小：≤ 此值的 value 走历史单行路径
// （存储字节级不变），超过的由服务端透明分块（见 lib/state-chunks.js）。
export const MAX_STATE_VALUE_BYTES = STATE_CHUNK_SLICE_BYTES;
// "a few dozen entries in one background-window request" is the design
// load; 200 bounds a single request with generous headroom.
export const MAX_STATE_ENTRIES_PER_REQUEST = 200;
const MAX_NAMESPACE_CHARS = 128;
const MAX_KEY_CHARS = 256;

const utf8 = new TextEncoder();

function err(status, code, message, details) {
  const error = details === undefined ? { code, message } : { code, message, details };
  return { status, body: { success: false, error } };
}

function requireUserId(headers) {
  const userId = getHeader(headers, 'x-user-id');
  if (!userId) return { error: err(400, 'USER_ID_REQUIRED', '缺少用户标识符') };
  if (!isValidUUIDv4(userId)) return { error: err(400, 'INVALID_USER_ID_FORMAT', 'X-User-Id 必须是 UUID v4 格式') };
  return { userId };
}

function rejectEntry(entry, index, code, message, extra) {
  const rejection = { index, code, message, ...(extra || {}) };
  if (entry && typeof entry === 'object') {
    if (typeof entry.namespace === 'string') rejection.namespace = entry.namespace;
    if (typeof entry.key === 'string') rejection.key = entry.key;
  }
  return rejection;
}

// 逐条校验：返回 null（合法）或拒绝对象（进 data.rejected，只拒这一条）。
function validateEntry(entry, index, maxValueBytes) {
  if (!isPlainObject(entry)) {
    return rejectEntry(entry, index, 'INVALID_STATE_ENTRY', `entries[${index}] 必须是对象`);
  }
  if (typeof entry.namespace !== 'string' || !entry.namespace.trim() || entry.namespace.length > MAX_NAMESPACE_CHARS) {
    return rejectEntry(entry, index, 'INVALID_STATE_NAMESPACE', `entries[${index}].namespace 必须是 1-${MAX_NAMESPACE_CHARS} 字符的字符串`);
  }
  if (INTERNAL_STATE_CHAR_RE.test(entry.namespace)) {
    return rejectEntry(entry, index, 'INVALID_STATE_NAMESPACE', `entries[${index}].namespace 不能包含控制字符（\\u0000-\\u001f 为库内部保留）`);
  }
  if (typeof entry.key !== 'string' || !entry.key.trim() || entry.key.length > MAX_KEY_CHARS) {
    return rejectEntry(entry, index, 'INVALID_STATE_KEY', `entries[${index}].key 必须是 1-${MAX_KEY_CHARS} 字符的字符串`);
  }
  if (INTERNAL_STATE_CHAR_RE.test(entry.key)) {
    return rejectEntry(entry, index, 'INVALID_STATE_KEY', `entries[${index}].key 不能包含控制字符（\\u0000-\\u001f 为库内部保留）`);
  }
  if (typeof entry.value !== 'string') {
    return rejectEntry(entry, index, 'INVALID_STATE_VALUE', `entries[${index}].value 必须是字符串（宿主自行序列化）`);
  }
  const bytes = utf8.encode(entry.value).length;
  if (bytes > maxValueBytes) {
    return rejectEntry(entry, index, 'STATE_VALUE_TOO_LARGE', `entries[${index}].value 超过单条总上限`, { bytes, maxBytes: maxValueBytes });
  }
  if (!Number.isInteger(entry.updatedAt) || entry.updatedAt <= 0) {
    return rejectEntry(entry, index, 'INVALID_STATE_UPDATED_AT', `entries[${index}].updatedAt 必须是正整数（epoch 毫秒）`);
  }
  return null;
}

export function createClientStateHandler(ctx) {
  async function PUT(headers, body) {
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

    const entries = payload.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      return err(400, 'INVALID_STATE_ENTRIES', 'entries 必须是非空数组');
    }
    if (entries.length > MAX_STATE_ENTRIES_PER_REQUEST) {
      return err(400, 'TOO_MANY_STATE_ENTRIES', `单次最多 ${MAX_STATE_ENTRIES_PER_REQUEST} 条`, { count: entries.length });
    }
    const maxValueBytes = Number.isInteger(ctx.maxStateValueBytes) && ctx.maxStateValueBytes > 0
      ? ctx.maxStateValueBytes
      : DEFAULT_MAX_STATE_VALUE_BYTES;

    // 逐条校验：坏条目只拒它自己（进 rejected），好条目照常入库。
    const accepted = [];
    const rejected = [];
    for (let i = 0; i < entries.length; i++) {
      const rejection = validateEntry(entries[i], i, maxValueBytes);
      if (rejection) rejected.push(rejection); else accepted.push(entries[i]);
    }

    if (typeof db.upsertClientState !== 'function') {
      return err(501, 'CLIENT_STATE_NOT_SUPPORTED', '当前数据库适配器不支持 client_state');
    }

    // 展开成物理行：小值 1 行（历史路径，字节级不变），大值 = 根 marker 行 +
    // 保留 namespace 里的 N 个加密切片行。每条 accepted 条目都配一条 cleanup
    // （同一 batch 里先删后写），把这个 key 旧写入留下的切片清干净 —— 覆盖写
    // 变小 / 缩块都不留尾巴；陈旧批次的 cleanup 因 updated_at 条件删不动新行。
    const physicalRows = [];
    const cleanups = [];
    const rootRowIndexes = [];
    for (const entry of accepted) {
      cleanups.push({
        namespace: chunkNamespaceFor(entry.namespace),
        keyPrefix: chunkKeyPrefixFor(entry.key),
        updatedAt: entry.updatedAt,
      });
      rootRowIndexes.push(physicalRows.length);
      if (utf8.encode(entry.value).length <= STATE_CHUNK_SLICE_BYTES) {
        physicalRows.push({
          namespace: entry.namespace,
          key: entry.key,
          value: await encryptForStorage(entry.value, userKey),
          updatedAt: entry.updatedAt,
        });
      } else {
        const slices = splitStateValue(entry.value);
        physicalRows.push({
          namespace: entry.namespace,
          key: entry.key,
          value: buildChunkedRootValue(slices.length),
          updatedAt: entry.updatedAt,
        });
        const encryptedSlices = await Promise.all(slices.map((slice) => encryptForStorage(slice, userKey)));
        for (let c = 0; c < encryptedSlices.length; c++) {
          physicalRows.push({
            namespace: chunkNamespaceFor(entry.namespace),
            key: chunkKeyFor(entry.key, c),
            value: encryptedSlices[c],
            updatedAt: entry.updatedAt,
          });
        }
      }
    }

    let upserted = 0;
    let skipped = 0;
    if (physicalRows.length > 0) {
      const result = await db.upsertClientState(userId, physicalRows, cleanups);
      if (Array.isArray(result.outcomes) && result.outcomes.length === physicalRows.length) {
        // 逻辑计数：一条 entry 的 upserted/skipped 看它的根行（切片行不计数）。
        for (const rootIndex of rootRowIndexes) {
          if (result.outcomes[rootIndex]) upserted++; else skipped++;
        }
      } else {
        // 自定义 adapter 只回老形状 { upserted, skipped } 时按物理行计数兜底。
        upserted = result.upserted;
        skipped = result.skipped;
      }
    }

    const data = { upserted, skipped };
    if (rejected.length > 0) data.rejected = rejected;
    return { status: 200, body: { success: true, data } };
  }

  async function GET(url, headers) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers);
    if (!tenantResult.ok) return tenantResult.error;
    const { db, masterKey } = tenantResult.context;

    const gate = requireUserId(headers);
    if (gate.error) return gate.error;
    const { userId } = gate;

    const namespace = new URL(url, 'https://dummy').searchParams.get('namespace') || '';
    if (!namespace.trim()) return err(400, 'NAMESPACE_REQUIRED', '必须提供 namespace 查询参数');
    if (INTERNAL_STATE_CHAR_RE.test(namespace)) {
      return err(400, 'INVALID_STATE_NAMESPACE', 'namespace 不能包含控制字符（\\u0000-\\u001f 为库内部保留）');
    }

    if (typeof db.getClientState !== 'function') {
      return err(501, 'CLIENT_STATE_NOT_SUPPORTED', '当前数据库适配器不支持 client_state');
    }

    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    const rows = await db.getClientState(userId, namespace);
    // 分块存储的值在这里拼回原文；块不齐全的 key 视为不存在（不抛错）。
    const decrypted = await resolveClientStateEntries(
      rows,
      () => db.getClientState(userId, chunkNamespaceFor(namespace)),
      (value) => decryptFromStorage(value, userKey)
    );

    const encryptedResponse = await encryptPayload({ namespace, entries: decrypted }, userKey);
    return { status: 200, body: { success: true, encrypted: true, version: 1, data: encryptedResponse } };
  }

  async function DELETE(url, headers) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers);
    if (!tenantResult.ok) return tenantResult.error;
    const { db } = tenantResult.context;

    const gate = requireUserId(headers);
    if (gate.error) return gate.error;
    const { userId } = gate;

    if (typeof db.clearClientState !== 'function') {
      return err(501, 'CLIENT_STATE_NOT_SUPPORTED', '当前数据库适配器不支持 client_state');
    }

    const deleted = await db.clearClientState(userId);
    return { status: 200, body: { success: true, data: { deleted } } };
  }

  return { PUT, GET, DELETE };
}
