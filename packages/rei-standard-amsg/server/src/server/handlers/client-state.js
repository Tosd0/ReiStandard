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
 * Auth & crypto follow the existing endpoints exactly: X-Client-Token is
 * all-or-nothing via resolveTenant, PUT bodies must be encrypted
 * (X-Payload-Encrypted / X-Encryption-Version), values are stored as
 * encryptForStorage ciphertext under the per-user key, and GET responses
 * ride the existing encrypted-response envelope.
 */

import { deriveUserEncryptionKey, decryptPayload, encryptPayload, encryptForStorage, decryptFromStorage } from '../lib/encryption.js';
import { getHeader, isPlainObject, parseEncryptedBody } from '../lib/request.js';
import { isValidUUIDv4 } from '../lib/validation.js';

// One value may hold a serialized state chunk, but must stay well under
// D1's per-row limits — reject early with a clear error instead of an
// opaque DB failure.
export const MAX_STATE_VALUE_BYTES = 200 * 1024;
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

function validateEntry(entry, index) {
  if (!isPlainObject(entry)) return err(400, 'INVALID_STATE_ENTRY', `entries[${index}] 必须是对象`);
  if (typeof entry.namespace !== 'string' || !entry.namespace.trim() || entry.namespace.length > MAX_NAMESPACE_CHARS) {
    return err(400, 'INVALID_STATE_NAMESPACE', `entries[${index}].namespace 必须是 1-${MAX_NAMESPACE_CHARS} 字符的字符串`);
  }
  if (typeof entry.key !== 'string' || !entry.key.trim() || entry.key.length > MAX_KEY_CHARS) {
    return err(400, 'INVALID_STATE_KEY', `entries[${index}].key 必须是 1-${MAX_KEY_CHARS} 字符的字符串`);
  }
  if (typeof entry.value !== 'string') {
    return err(400, 'INVALID_STATE_VALUE', `entries[${index}].value 必须是字符串（宿主自行序列化）`);
  }
  const bytes = utf8.encode(entry.value).length;
  if (bytes > MAX_STATE_VALUE_BYTES) {
    return err(413, 'STATE_VALUE_TOO_LARGE', `entries[${index}].value 超过单条上限`, { index, key: entry.key, bytes, maxBytes: MAX_STATE_VALUE_BYTES });
  }
  if (!Number.isInteger(entry.updatedAt) || entry.updatedAt <= 0) {
    return err(400, 'INVALID_STATE_UPDATED_AT', `entries[${index}].updatedAt 必须是正整数（epoch 毫秒）`);
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
    for (let i = 0; i < entries.length; i++) {
      const invalid = validateEntry(entries[i], i);
      if (invalid) return invalid;
    }

    if (typeof db.upsertClientState !== 'function') {
      return err(501, 'CLIENT_STATE_NOT_SUPPORTED', '当前数据库适配器不支持 client_state');
    }

    const encryptedEntries = await Promise.all(entries.map(async (entry) => ({
      namespace: entry.namespace,
      key: entry.key,
      value: await encryptForStorage(entry.value, userKey),
      updatedAt: entry.updatedAt,
    })));

    const { upserted, skipped } = await db.upsertClientState(userId, encryptedEntries);
    return { status: 200, body: { success: true, data: { upserted, skipped } } };
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

    if (typeof db.getClientState !== 'function') {
      return err(501, 'CLIENT_STATE_NOT_SUPPORTED', '当前数据库适配器不支持 client_state');
    }

    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    const rows = await db.getClientState(userId, namespace);
    const decrypted = await Promise.all(rows.map(async (row) => ({
      namespace: row.namespace,
      key: row.key,
      value: await decryptFromStorage(row.value, userKey),
      updatedAt: row.updated_at,
    })));

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
