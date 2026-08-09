/**
 * 用户级 LLM API 凭据（llm_credentials 表的上层）。
 *
 * 任务行不再各自冻结一份 apiUrl / apiKey / primaryModel，改带引用：payload 里
 * 的 `credRefs: { <purpose>: <cred_id> }`。到点解析时按 `credRefs.chat` 现读
 * 这张表——换 Key 覆盖对应行就够了，不用把每条任务翻出来逐行刷（角色在 fire
 * 里给自己排的任务客户端根本不知道存在，逐行刷这条路本来也走不通，与
 * push_subscriptions 同一个动机）。
 *
 * `cred_id` 是客户端起名的**不透明字符串**，服务端不解释语义。约定（不强制）：
 * `char:<charId>/<purpose>`、`global/<purpose>`。`purpose` 键里只有 `chat` 是
 * 服务端认识的（fire 时的主 LLM 调用）；其余 purpose 归宿主 hook 侧，用
 * `ctx.resolveLlmCredential(credId)` 自取。
 *
 * 凭据落库前用 per-user key 加密（和任务 payload、push 订阅同一套）。
 */

import { decryptFromStorage, encryptForStorage } from './encryption.js';

/** cred_id 的长度上限。 */
export const CRED_ID_MAX_LENGTH = 128;
/** value 单字段（apiUrl / apiKey / primaryModel）的长度上限。 */
export const CRED_VALUE_FIELD_MAX_LENGTH = 2048;
/** PUT 单批最多几条。 */
export const CRED_PUT_BATCH_MAX = 100;
/** 单用户最多存几行凭据。 */
export const CRED_ROWS_PER_USER_MAX = 500;
/** credRefs 最多几个 purpose 条目。 */
export const CRED_REFS_MAX_ENTRIES = 16;
/** credRefs 的 purpose 键长度上限。 */
export const CRED_REFS_KEY_MAX_LENGTH = 64;

/** 适配器支不支持用户级凭据存储。 */
export function supportsLlmCredentialsStore(db) {
  return !!db
    && typeof db.upsertLlmCredentials === 'function'
    && typeof db.getLlmCredentials === 'function'
    && typeof db.listLlmCredentials === 'function'
    && typeof db.deleteLlmCredentials === 'function';
}

// 控制字符（含 DEL）不许出现在 cred_id / purpose 键里。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 一个字符串是不是合法 cred_id：非空、≤128 字符、不含控制字符。
 *
 * @param {unknown} credId
 * @returns {boolean}
 */
export function isValidCredId(credId) {
  return typeof credId === 'string'
    && credId.length > 0
    && credId.length <= CRED_ID_MAX_LENGTH
    && !CONTROL_CHARS.test(credId);
}

/**
 * 一份凭据 value 的形状：{ apiUrl, apiKey, primaryModel } 三字段全必填。
 * 校验口径对齐 update-message 的凭据刷新：只查 truthy（+ 长度上限），不做
 * 格式校验。
 *
 * @param {unknown} value
 * @returns {string|null} 错误描述，合法时 null
 */
export function validateCredValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'value 必须是 { apiUrl, apiKey, primaryModel } 对象';
  }
  for (const field of ['apiUrl', 'apiKey', 'primaryModel']) {
    const v = /** @type {Record<string, unknown>} */ (value)[field];
    if (typeof v !== 'string' || !v) return `value.${field} 必须是非空字符串`;
    if (v.length > CRED_VALUE_FIELD_MAX_LENGTH) {
      return `value.${field} 不能超过 ${CRED_VALUE_FIELD_MAX_LENGTH} 字符`;
    }
  }
  return null;
}

/**
 * 任务 payload 里 credRefs 字段的形状校验（schedule-message 与 update-message
 * 共用一份口径）。
 *
 * @param {unknown} credRefs
 * @returns {string|null} 错误描述，合法时 null
 */
export function validateCredRefs(credRefs) {
  if (!credRefs || typeof credRefs !== 'object' || Array.isArray(credRefs)) {
    return 'credRefs 必须是 { <purpose>: <credId> } 形状的普通对象';
  }
  const entries = Object.entries(credRefs);
  if (entries.length === 0) return 'credRefs 不能是空对象（不需要就别带这个字段）';
  if (entries.length > CRED_REFS_MAX_ENTRIES) {
    return `credRefs 最多 ${CRED_REFS_MAX_ENTRIES} 个条目`;
  }
  for (const [purpose, credId] of entries) {
    if (purpose.length > CRED_REFS_KEY_MAX_LENGTH || CONTROL_CHARS.test(purpose)) {
      return `credRefs 的 purpose 键不能超过 ${CRED_REFS_KEY_MAX_LENGTH} 字符、不能含控制字符`;
    }
    if (!isValidCredId(credId)) {
      return `credRefs['${purpose}'] 必须是 1–${CRED_ID_MAX_LENGTH} 字符、不含控制字符的 cred_id`;
    }
  }
  return null;
}

/**
 * payload 带没带可用的 chat 凭据引用（`credRefs.chat`）。fire 侧的
 * taskNeedsLlm 和校验共用这一个判据。
 *
 * @param {Object|null|undefined} payload
 * @returns {boolean}
 */
export function hasChatCredRef(payload) {
  const refs = payload && payload.credRefs;
  return !!refs && typeof refs === 'object' && !Array.isArray(refs)
    && typeof refs.chat === 'string' && refs.chat.length > 0;
}

/**
 * 批量写入（覆盖）这个用户的凭据。value 在这里加密。
 *
 * @param {Object} args
 * @param {import('../adapters/interface.js').DbAdapter} args.db
 * @param {string} args.userId
 * @param {string} args.userKey
 * @param {Array<{ credId: string, value: Object }>} args.credentials
 * @returns {Promise<{ upserted: number }>}
 */
export async function saveLlmCredentials({ db, userId, userKey, credentials }) {
  const entries = [];
  for (const { credId, value } of credentials) {
    entries.push({ credId, encryptedValue: await encryptForStorage(JSON.stringify(value), userKey) });
  }
  const upserted = await db.upsertLlmCredentials(userId, entries);
  return { upserted };
}

/**
 * 排程 / 更新时的存在性检查：credRefs 里引用的 credId 有哪些还不在表里。
 * 空缺不是这里的错误——回给调用方点名，由它组 4xx。
 *
 * @param {Object} args
 * @param {import('../adapters/interface.js').DbAdapter} args.db
 * @param {string} args.userId
 * @param {Object} args.credRefs
 * @returns {Promise<string[]>} 缺失的 credId（去重）
 */
export async function findMissingCredIds({ db, userId, credRefs }) {
  const wanted = [...new Set(Object.values(credRefs))];
  const rows = await db.getLlmCredentials(userId, wanted);
  const present = new Set(rows.map((row) => row.cred_id));
  return wanted.filter((credId) => !present.has(credId));
}

/**
 * 按 cred_id 解出一份明文凭据。每次调用返回**新对象**；没有这行 / 解不开
 * （换过 masterKey）→ null。
 *
 * 结果只该被「拿到就用」：合进发给 LLM 的请求对象、或在 hook 里当场发请求。
 * 不要写回 payload / ctx / metadata——那些对象会流向 hook 和 push，凭据跟着
 * 走就把 CREDENTIAL_PAYLOAD_KEYS 那道防线绕空了。
 *
 * @param {Object} args
 * @param {import('../adapters/interface.js').DbAdapter} args.db
 * @param {string} args.userId
 * @param {string} args.userKey
 * @param {string} args.credId
 * @returns {Promise<{ apiUrl: string, apiKey: string, primaryModel: string }|null>}
 */
export async function resolveLlmCredential({ db, userId, userKey, credId }) {
  const rows = await db.getLlmCredentials(userId, [credId]);
  const row = rows.find((r) => r.cred_id === credId);
  if (!row || typeof row.encrypted_value !== 'string' || !row.encrypted_value) return null;
  let parsed;
  try {
    parsed = JSON.parse(await decryptFromStorage(row.encrypted_value, userKey));
  } catch (_error) {
    // 密文解不开（换过 masterKey 之类）就当没有这行：fire 侧会按
    // CREDENTIAL_MISSING 走重试，客户端重新 PUT 一份即自愈。
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    apiUrl: parsed.apiUrl,
    apiKey: parsed.apiKey,
    primaryModel: parsed.primaryModel,
  };
}

/** 带稳定 `code` 属性的错误：消费方按 error.code 分支，不用字符串匹配 message。 */
function codedError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/**
 * fire 时的 chat 凭据解析（message-processor 的两条老路径和 agentic 循环共用）。
 *
 * 解析顺序：
 *   1. payload 没带 `credRefs.chat` → 返回 null，调用方按内联三件套的老行为走
 *      （存量任务的零开销路径，不多打一次库）。
 *   2. 带了 → 查表取值，查到就用表里那份（表是用户最近一次登记的，比冻结在
 *      行里的新）。
 *   3. 查不到行（被删 / 换过 masterKey / 适配器不支持）→ 退回内联三件套兜底
 *      （update-message 给存量任务补 credRefs 时内联还留着，正是给这里用的）。
 *   4. 都没有 → 抛 `code: 'CREDENTIAL_MISSING'`，走任务的常规失败/重试——用户
 *      补传凭据后下一轮自愈。
 *
 * 返回的对象只许合进**发给 LLM 的请求对象**，见 resolveLlmCredential 的红线。
 *
 * @param {Object} args
 * @param {import('../adapters/interface.js').DbAdapter} args.db
 * @param {string} args.userId
 * @param {string} args.userKey
 * @param {Object} args.decryptedPayload
 * @returns {Promise<{ apiUrl: string, apiKey: string, primaryModel: string }|null>}
 */
export async function resolveFireCredentials({ db, userId, userKey, decryptedPayload }) {
  if (!hasChatCredRef(decryptedPayload)) return null;
  const credId = decryptedPayload.credRefs.chat;

  if (supportsLlmCredentialsStore(db)) {
    const resolved = await resolveLlmCredential({ db, userId, userKey, credId });
    if (resolved && resolved.apiUrl && resolved.apiKey && resolved.primaryModel) return resolved;
  }

  if (decryptedPayload.apiUrl && decryptedPayload.apiKey && decryptedPayload.primaryModel) {
    return {
      apiUrl: decryptedPayload.apiUrl,
      apiKey: decryptedPayload.apiKey,
      primaryModel: decryptedPayload.primaryModel,
    };
  }

  throw codedError(
    'CREDENTIAL_MISSING',
    `凭据 ${credId} 不存在（PUT /llm-credentials 补传后这条任务下一轮重试即自愈）`
  );
}
