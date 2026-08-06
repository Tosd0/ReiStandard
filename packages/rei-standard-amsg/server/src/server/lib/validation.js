/**
 * Validation utility library (SDK version)
 */

import { isValidUrl, validateAvatarUrl, validateLlmMessagesShape } from '@rei-standard/amsg-shared';
import { isValidTimeZoneId } from './recurrence.js';

export { isValidTimeZoneId };

// URL 校验统一走 shared 的实现（validateAvatarUrl 内部用的也是同一份），
// 两个包对「什么算 URL」不再各持一版。此处重导出，保持本模块及
// `createReiServer` 的公开导出不变。
export { isValidUrl };

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
 * Validate an OpenAI-style messages array. 形状规则统一在
 * `@rei-standard/amsg-shared` 的 `validateLlmMessagesShape`（amsg-instant
 * 的 `validateMessagesArray` 走同一实现，两包接受的形状不会漂移）——
 * 因此 agentic 会话回放（assistant 带 `tool_calls` 时 content 可空、
 * `role:'tool'` 消息要求 `tool_call_id`）在这里同样合法。本函数只把
 * 结构化错误码映射成本包既有的英文错误文案，返回形状不变。
 *
 * @param {unknown} messages
 * @returns {string | null}   Error message, or null if valid.
 */
export function validateLlmMessagesArray(messages) {
  const err = validateLlmMessagesShape(messages);
  if (!err) return null;
  const { code, index: i, toolCallIndex: j } = err;
  switch (code) {
    case 'MESSAGES_NOT_ARRAY':
      return 'messages must be a non-empty array';
    case 'MESSAGE_NOT_OBJECT':
      return `messages[${i}] must be an object`;
    case 'INVALID_ROLE':
      return `messages[${i}].role must be one of system / user / assistant / tool`;
    case 'TOOL_CALL_MALFORMED':
      return `messages[${i}].tool_calls[${j}] is malformed (expected { id, type:'function', function:{ name, arguments } })`;
    case 'TOOL_CONTENT_INVALID':
      return `messages[${i}].content (tool) must be a string or an array`;
    case 'TOOL_CALL_ID_MISSING':
      return `messages[${i}].tool_call_id is required (tool messages must reference a prior tool_call)`;
    case 'CONTENT_EMPTY_STRING':
      return `messages[${i}].content must be a non-empty string`;
    case 'CONTENT_EMPTY_ARRAY':
      return `messages[${i}].content array must be non-empty`;
    case 'CONTENT_INVALID_TYPE':
    default:
      return `messages[${i}].content must be a non-empty string or a non-empty array`;
  }
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

  // 推送订阅是用户级的一份（`PUT /push-subscription`），任务不携带它，到点
  // 投递时现读。排程请求里还带着它多半是照着老写法搬过来的，明确拒掉比静默
  // 丢弃好——静默丢弃会让人以为「这条任务用的是我传的这个订阅」。
  if (payload.pushSubscription !== undefined) {
    return {
      valid: false,
      errorCode: 'PUSH_SUBSCRIPTION_NOT_ACCEPTED',
      errorMessage: 'pushSubscription 不再随任务提交，改用 PUT /push-subscription 登记一份用户级订阅',
      details: { invalidFields: ['pushSubscription'] }
    };
  }

  if (payload.recurrenceType && !['none', 'daily', 'weekly'].includes(payload.recurrenceType)) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { invalidFields: ['recurrenceType'] } };
  }

  // 循环任务按哪个时区的墙钟推进。不传（或 null）= 按 UTC 推进。
  if (payload.tzId !== undefined && payload.tzId !== null && !isValidTimeZoneId(payload.tzId)) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: 'tzId 必须是可用的 IANA 时区 id（如 Asia/Tokyo）', details: { invalidFields: ['tzId'] } };
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
