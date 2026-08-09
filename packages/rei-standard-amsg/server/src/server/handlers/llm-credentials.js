/**
 * Handler: llm-credentials
 *
 * 用户级 LLM API 凭据的读写口。任务行不再各自冻结 apiUrl / apiKey /
 * primaryModel，改在 payload 里带 `credRefs: { <purpose>: <cred_id> }` 引用
 * 这里的行，到点解析时现读。换 Key 覆盖对应行就够了——已经排好的任务、包括
 * 角色在 fire 里给自己排的那些，下次触发用的都是新凭据。
 *
 *   PUT    /llm-credentials   批量登记 / 覆盖（body 加密：{ credentials: [{ credId, value }] }）
 *   GET    /llm-credentials   对账清单 { credentials: [{ credId, updatedAt }] }
 *   DELETE /llm-credentials   删除（body 加密：{ credIds: [...] } 或 { all: true }）
 *
 * GET 永不回凭据本体——一个字段都不回（对齐 task-projection 的白名单哲学）；
 * 客户端要判断的是「云端有哪些、新旧如何」，credId + updatedAt 就够对上了。
 *
 * 鉴权与加密跟其它端点一样：X-Client-Token 走 resolveTenant，PUT / DELETE 的
 * body 必须加密（X-Payload-Encrypted / X-Encryption-Version），凭据落库前用
 * per-user key 加密。
 */

import { deriveUserEncryptionKey, decryptPayload } from '../lib/encryption.js';
import { getHeader, isPlainObject, parseEncryptedBody, requireUserId } from '../lib/request.js';
import {
  CRED_PUT_BATCH_MAX,
  CRED_ROWS_PER_USER_MAX,
  isValidCredId,
  validateCredValue,
  saveLlmCredentials,
  supportsLlmCredentialsStore,
} from '../lib/llm-credentials-store.js';

function err(status, code, message, details) {
  const error = details === undefined ? { code, message } : { code, message, details };
  return { status, body: { success: false, error } };
}

const UNSUPPORTED = err(
  501,
  'LLM_CREDENTIALS_NOT_SUPPORTED',
  '当前数据库适配器不支持用户级 LLM 凭据存储'
);

export function createLlmCredentialsHandler(ctx) {
  /** PUT / DELETE 共用的「解开加密 body」前半段。 */
  async function decryptBody(headers, body) {
    if (getHeader(headers, 'x-payload-encrypted') !== 'true') {
      return { error: err(400, 'ENCRYPTION_REQUIRED', '请求体必须加密') };
    }
    const gate = requireUserId(headers);
    if (gate.error) return { error: gate.error };
    const { userId } = gate;
    if (getHeader(headers, 'x-encryption-version') !== '1') {
      return { error: err(400, 'UNSUPPORTED_ENCRYPTION_VERSION', '加密版本不支持') };
    }

    const parsedBody = parseEncryptedBody(body);
    if (!parsedBody.ok) return { error: { status: 400, body: { success: false, error: parsedBody.error } } };

    return { userId, encryptedBody: parsedBody.data };
  }

  async function PUT(headers, body) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers);
    if (!tenantResult.ok) return tenantResult.error;
    const { db, masterKey } = tenantResult.context;

    const pre = await decryptBody(headers, body);
    if (pre.error) return pre.error;
    const { userId, encryptedBody } = pre;

    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    let payload;
    try {
      payload = await decryptPayload(encryptedBody, userKey);
    } catch (error) {
      if (error instanceof SyntaxError) {
        return err(400, 'INVALID_PAYLOAD_FORMAT', '解密后的数据不是有效 JSON');
      }
      return err(400, 'DECRYPTION_FAILED', '请求体解密失败');
    }
    if (!isPlainObject(payload)) return err(400, 'INVALID_PAYLOAD_FORMAT', '解密后的数据必须是 JSON 对象');

    const credentials = payload.credentials;
    if (!Array.isArray(credentials) || credentials.length === 0) {
      return err(400, 'INVALID_PARAMETERS', 'credentials 必须是非空数组', { invalidFields: ['credentials'] });
    }
    if (credentials.length > CRED_PUT_BATCH_MAX) {
      return err(400, 'INVALID_PARAMETERS', `credentials 一批最多 ${CRED_PUT_BATCH_MAX} 条`, { invalidFields: ['credentials'] });
    }
    for (let i = 0; i < credentials.length; i++) {
      const entry = credentials[i];
      if (!isPlainObject(entry) || !isValidCredId(entry.credId)) {
        return err(400, 'INVALID_PARAMETERS', `credentials[${i}].credId 必须是 1–128 字符、不含控制字符的字符串`, { invalidFields: [`credentials[${i}].credId`] });
      }
      const valueErr = validateCredValue(entry.value);
      if (valueErr) {
        return err(400, 'INVALID_PARAMETERS', `credentials[${i}].${valueErr}`, { invalidFields: [`credentials[${i}].value`] });
      }
    }

    if (!supportsLlmCredentialsStore(db)) return UNSUPPORTED;

    // 同批里同一个 credId 出现多次时保留最后一条（与 client_state 的
    // last-write-wins 同精神），行数上限也按去重后的集合算。
    const byId = new Map();
    for (const entry of credentials) byId.set(entry.credId, entry);
    const deduped = [...byId.values()];

    // 行数上限：已有行 + 本批新增不能超。查清单本身失败按可重试的 503 报。
    let existing;
    try {
      existing = await db.listLlmCredentials(userId);
    } catch (_error) {
      return err(503, 'LLM_CREDENTIALS_LOOKUP_FAILED', '凭据清单读取失败，请稍后重试');
    }
    const existingIds = new Set(existing.map((row) => row.cred_id));
    const newCount = deduped.filter((entry) => !existingIds.has(entry.credId)).length;
    if (existingIds.size + newCount > CRED_ROWS_PER_USER_MAX) {
      return err(400, 'LLM_CREDENTIALS_LIMIT_EXCEEDED', `单用户最多存 ${CRED_ROWS_PER_USER_MAX} 行凭据`, {
        existing: existingIds.size,
        adding: newCount,
        limit: CRED_ROWS_PER_USER_MAX,
      });
    }

    const { upserted } = await saveLlmCredentials({ db, userId, userKey, credentials: deduped });
    return { status: 200, body: { success: true, data: { upserted } } };
  }

  async function GET(url, headers) {
    const effectiveHeaders = headers || url || {};
    const tenantResult = await ctx.tenantManager.resolveTenant(effectiveHeaders);
    if (!tenantResult.ok) return tenantResult.error;
    const { db } = tenantResult.context;

    const gate = requireUserId(effectiveHeaders);
    if (gate.error) return gate.error;
    const { userId } = gate;

    if (!supportsLlmCredentialsStore(db)) return UNSUPPORTED;

    const rows = await db.listLlmCredentials(userId);
    return {
      status: 200,
      body: {
        success: true,
        data: {
          // 只有 credId 和 updatedAt——凭据本体永远不出这个接口。
          credentials: rows.map((row) => ({ credId: row.cred_id, updatedAt: row.updated_at })),
        },
      },
    };
  }

  async function DELETE(url, headers, body) {
    const tenantResult = await ctx.tenantManager.resolveTenant(headers, { url });
    if (!tenantResult.ok) return tenantResult.error;
    const { db, masterKey } = tenantResult.context;

    const pre = await decryptBody(headers, body);
    if (pre.error) return pre.error;
    const { userId, encryptedBody } = pre;

    const userKey = await deriveUserEncryptionKey(userId, masterKey);
    let payload;
    try {
      payload = await decryptPayload(encryptedBody, userKey);
    } catch (_error) {
      return err(400, 'DECRYPTION_FAILED', '请求体解密失败');
    }
    if (!isPlainObject(payload)) return err(400, 'INVALID_PAYLOAD_FORMAT', '解密后的数据必须是 JSON 对象');

    const wantsAll = payload.all === true;
    const credIds = payload.credIds;
    if (!wantsAll && (!Array.isArray(credIds) || credIds.length === 0)) {
      return err(400, 'INVALID_PARAMETERS', '要么 { all: true }，要么 credIds 非空数组', { invalidFields: ['credIds'] });
    }
    if (wantsAll && credIds !== undefined) {
      return err(400, 'INVALID_PARAMETERS', 'all 与 credIds 不能同时出现', { invalidFields: ['all', 'credIds'] });
    }
    if (!wantsAll) {
      for (let i = 0; i < credIds.length; i++) {
        if (!isValidCredId(credIds[i])) {
          return err(400, 'INVALID_PARAMETERS', `credIds[${i}] 不是合法 cred_id`, { invalidFields: [`credIds[${i}]`] });
        }
      }
    }

    if (!supportsLlmCredentialsStore(db)) return UNSUPPORTED;

    const deleted = await db.deleteLlmCredentials(userId, wantsAll ? null : [...new Set(credIds)]);
    return { status: 200, body: { success: true, data: { deleted } } };
  }

  return { PUT, GET, DELETE };
}
