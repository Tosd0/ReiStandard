/**
 * Validation utility library (SDK version)
 * ReiStandard SDK v2.0.1
 */

import { validateAvatarUrl } from '@rei-standard/amsg-shared';

/**
 * Validate ISO 8601 date string.
 * @param {string} dateString
 * @returns {boolean}
 */
export function isValidISO8601(dateString) {
  const date = new Date(dateString);
  return date instanceof Date && !isNaN(date.getTime());
}

/**
 * Validate URL format.
 * @param {string} urlString
 * @returns {boolean}
 */
export function isValidUrl(urlString) {
  try {
    new URL(urlString);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate UUID format.
 * @param {string} uuid
 * @returns {boolean}
 */
export function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Validate UUID v4 format.
 * @param {string} uuid
 * @returns {boolean}
 */
export function isValidUUIDv4(uuid) {
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Regex.test(uuid);
}

const VALID_LLM_MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

// `validateAvatarUrl` 与其 2048 字符上限现统一在 @rei-standard/amsg-shared，
// server / instant / client 共用一份规则。此处重导出，保持本模块及
// `createReiServer` 的公开导出不变。
export { validateAvatarUrl };

const SPLIT_PATTERN_MAX_LENGTH = 200;
const SPLIT_PATTERN_MAX_ITEMS = 10;

/**
 * Validate the optional `splitPattern` field (amsg-server scheduled tasks
 * only; amsg-instant 0.8.0 dropped its request-level `splitPattern`).
 * Accepts `string`, `string[]`, or absent/null. Returns an error message
 * string, or null when valid.
 *
 * Limits (per-item length ≤ 200, array ≤ 10 items, must compile via
 * `new RegExp(item)`) are an **input-size guard**, NOT a ReDoS defense —
 * a 6-character pattern like `(a+)+$` is enough to trigger catastrophic
 * backtracking. The real backstop is Worker / runtime CPU limits + the
 * fact that splitPattern is stored under the user's own encrypted task
 * and matched against output from the user's own LLM API key, so the
 * blast radius is self-inflicted only (no cross-tenant attack surface).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function validateSplitPattern(value) {
  if (value === undefined || value === null) return null;
  const isArray = Array.isArray(value);
  const items = isArray ? value : [value];
  if (isArray && items.length === 0) return null;          // empty array = use default
  if (items.length > SPLIT_PATTERN_MAX_ITEMS) {
    return `splitPattern 数组最多 ${SPLIT_PATTERN_MAX_ITEMS} 项`;
  }
  for (let i = 0; i < items.length; i++) {
    const s = items[i];
    const label = isArray ? `splitPattern[${i}]` : 'splitPattern';
    if (typeof s !== 'string') return `${label} 必须是字符串`;
    if (s.length > SPLIT_PATTERN_MAX_LENGTH) {
      return `${label} 不能超过 ${SPLIT_PATTERN_MAX_LENGTH} 字符`;
    }
    try { new RegExp(s); }
    catch (_) { return `${label} 不是有效正则表达式`; }
  }
  return null;
}

/**
 * Validate an OpenAI-style messages array. Same shape contract as
 * `@rei-standard/amsg-instant` (kept in lockstep on purpose — both packages
 * end up forwarding this to the same LLM body).
 *
 * @param {unknown} messages
 * @returns {string | null}   Error message, or null if valid.
 */
export function validateLlmMessagesArray(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'messages must be a non-empty array';
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      return `messages[${i}] must be an object`;
    }
    if (!VALID_LLM_MESSAGE_ROLES.has(m.role)) {
      return `messages[${i}].role must be one of system / user / assistant / tool`;
    }
    if (typeof m.content === 'string') {
      if (!m.content) return `messages[${i}].content must be a non-empty string`;
    } else if (Array.isArray(m.content)) {
      if (m.content.length === 0) return `messages[${i}].content array must be non-empty`;
      // Element schema is intentionally not enforced — passed through to LLM as-is.
    } else {
      return `messages[${i}].content must be a non-empty string or a non-empty array`;
    }
  }
  return null;
}

/**
 * Validate the schedule-message request payload.
 *
 * @param {Object} payload
 * @returns {{ valid: boolean, errorCode?: string, errorMessage?: string, details?: Object }}
 */
export function validateScheduleMessagePayload(payload) {
  if (!payload.contactName || typeof payload.contactName !== 'string') {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { missingFields: ['contactName'] } };
  }

  if (!payload.messageType || !['fixed', 'prompted', 'auto', 'instant'].includes(payload.messageType)) {
    return { valid: false, errorCode: 'INVALID_MESSAGE_TYPE', errorMessage: '消息类型无效', details: { providedType: payload.messageType, allowedTypes: ['fixed', 'prompted', 'auto', 'instant'] } };
  }

  if (!payload.firstSendTime || !isValidISO8601(payload.firstSendTime)) {
    return { valid: false, errorCode: 'INVALID_TIMESTAMP', errorMessage: '时间格式无效', details: { field: 'firstSendTime' } };
  }

  if (payload.firstSendTime && new Date(payload.firstSendTime) <= new Date()) {
    return { valid: false, errorCode: 'INVALID_TIMESTAMP', errorMessage: '时间必须在未来', details: { field: 'firstSendTime', reason: 'must be in the future' } };
  }

  if (!payload.pushSubscription || typeof payload.pushSubscription !== 'object') {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { missingFields: ['pushSubscription'] } };
  }

  if (payload.recurrenceType && !['none', 'daily', 'weekly'].includes(payload.recurrenceType)) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { invalidFields: ['recurrenceType'] } };
  }

  if (
    payload.maxTokens !== undefined &&
    payload.maxTokens !== null &&
    (!Number.isInteger(payload.maxTokens) || payload.maxTokens <= 0)
  ) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { invalidFields: ['maxTokens'] } };
  }

  if (payload.messageType === 'fixed') {
    if (!payload.userMessage) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { missingFields: ['userMessage (required for fixed type)'] } };
    }
  }

  // ─── Prompt schema (shared by prompted / auto / instant AI configs) ──
  //
  // Callers provide *exactly one of* `completePrompt` (string) or `messages`
  // (OpenAI-style array). Same contract as @rei-standard/amsg-instant; the
  // server's LLM path forwards either verbatim.
  const promptCheck = (() => {
    const hasCompletePrompt = payload.completePrompt !== undefined && payload.completePrompt !== null && payload.completePrompt !== '';
    const hasMessages = payload.messages !== undefined && payload.messages !== null;
    if (hasCompletePrompt && hasMessages) {
      return {
        error: { code: 'INVALID_PARAMETERS', message: 'exactly one of `completePrompt` or `messages` must be provided（两者不能同时出现）', details: { invalidFields: ['completePrompt', 'messages'] } },
        hasCompletePrompt: true, hasMessages: true,
      };
    }
    if (hasMessages) {
      const err = validateLlmMessagesArray(payload.messages);
      if (err) {
        return {
          error: { code: 'INVALID_PARAMETERS', message: err, details: { invalidFields: ['messages'] } },
          hasCompletePrompt: false, hasMessages: true,
        };
      }
    }
    return { error: null, hasCompletePrompt, hasMessages };
  })();

  if (promptCheck.error) {
    return { valid: false, errorCode: promptCheck.error.code, errorMessage: promptCheck.error.message, details: promptCheck.error.details };
  }
  const hasPrompt = promptCheck.hasCompletePrompt || promptCheck.hasMessages;

  if (payload.messageType === 'prompted' || payload.messageType === 'auto') {
    const missingAiFields = [];
    if (!hasPrompt) missingAiFields.push('completePrompt or messages');
    if (!payload.apiUrl) missingAiFields.push('apiUrl');
    if (!payload.apiKey) missingAiFields.push('apiKey');
    if (!payload.primaryModel) missingAiFields.push('primaryModel');
    if (missingAiFields.length > 0) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { missingFields: missingAiFields } };
    }
  }

  if (payload.messageType === 'instant') {
    if (payload.recurrenceType && payload.recurrenceType !== 'none') {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: 'instant 类型的 recurrenceType 必须为 none', details: { invalidFields: ['recurrenceType (must be "none" for instant type)'] } };
    }
    const hasAiConfig = hasPrompt && payload.apiUrl && payload.apiKey && payload.primaryModel;
    const hasUserMessage = payload.userMessage;
    if (!hasAiConfig && !hasUserMessage) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: 'instant 类型必须提供 userMessage 或完整的 AI 配置', details: { missingFields: ['userMessage or ((completePrompt | messages) + apiUrl + apiKey + primaryModel)'] } };
    }
  }

  if (
    payload.temperature !== undefined &&
    payload.temperature !== null &&
    (typeof payload.temperature !== 'number' || !Number.isFinite(payload.temperature))
  ) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { invalidFields: ['temperature (must be a finite number)'] } };
  }

  const avatarErr = validateAvatarUrl(payload.avatarUrl);
  if (avatarErr) {
    // Soft-strip: a bad avatarUrl (data: URI / oversized / malformed) used to
    // 400 the whole schedule. Avatar is cosmetic — drop the field, log, and
    // let the rest of the task ship. See standards §6.2.
    console.warn('[amsg-server] avatarUrl 不合法，已置空：', avatarErr);
    payload.avatarUrl = null;
  }
  if (payload.uuid && !isValidUUID(payload.uuid)) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { invalidFields: ['uuid (invalid UUID format)'] } };
  }
  // messageSubtype is a free-form string tag forwarded to SW-side push payload
  // for classification. Only the type is enforced; the taxonomy is the
  // consumer's call (previously the enum was chat/forum/moment).
  if (
    payload.messageSubtype !== undefined &&
    payload.messageSubtype !== null &&
    typeof payload.messageSubtype !== 'string'
  ) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { invalidFields: ['messageSubtype'] } };
  }

  const splitErr = validateSplitPattern(payload.splitPattern);
  if (splitErr) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: splitErr, details: { invalidFields: ['splitPattern'] } };
  }

  return { valid: true };
}
