/**
 * Lightweight validation for amsg-instant.
 *
 * Unlike amsg-server's `validateScheduleMessagePayload`, instant rejects:
 *   - `firstSendTime` (instant is one-shot; no scheduling)
 *   - `recurrenceType` other than (absent | 'none')
 *   - `messageType: 'fixed' | 'prompted' | 'auto'` (instant requires LLM call)
 * to keep the contract crisp and prevent users from accidentally relying on
 * scheduled-only fields here.
 */

function isValidUrl(s) {
  if (typeof s !== 'string') return false;
  try { new URL(s); return true; } catch { return false; }
}

const VALID_MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

const AVATAR_URL_MAX_LENGTH = 2048;

/**
 * Validate the optional `avatarUrl` field. Rejects `data:` URIs (typically
 * base64-encoded inline images) and anything longer than 2048 chars, both
 * of which are the dominant trigger for downstream 413 / Web Push 4 KB
 * payload errors. Returns an error message string, or null when valid.
 *
 * Mirrors amsg-server's `validateAvatarUrl` (kept in lockstep on purpose —
 * both packages forward `avatarUrl` to the same SW push payload).
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function validateAvatarUrl(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    return 'avatarUrl 必须是字符串';
  }
  if (/^data:/i.test(value)) {
    return '头像不支持传入 data: URI，请改为公网可访问的 https:// 图片 URL';
  }
  if (value.length > AVATAR_URL_MAX_LENGTH) {
    return `头像 URL 长度 ${value.length} 字符超过 ${AVATAR_URL_MAX_LENGTH} 上限，请改为更短的图片 URL`;
  }
  if (!isValidUrl(value)) {
    return 'avatarUrl 不是合法 URL';
  }
  return null;
}

function validateMessagesArray(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'messages 必须是长度 ≥ 1 的数组';
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      return `messages[${i}] 必须是对象`;
    }
    if (!VALID_MESSAGE_ROLES.has(m.role)) {
      return `messages[${i}].role 必须是 system / user / assistant / tool 之一`;
    }

    // OpenAI 协议:assistant 消息在带 tool_calls 时, content 可为 null / 空串 / 缺省.
    // 跳过 content 校验, 但仍要求 tool_calls 是非空数组 (否则就是无意义的纯空 assistant).
    const isAssistantToolCallCarrier =
      m.role === 'assistant'
      && Array.isArray(m.tool_calls)
      && m.tool_calls.length > 0;
    if (isAssistantToolCallCarrier) {
      // tool_calls 形状轻量校验 — 不严, 上游 LLM API 会再校一遍.
      for (let j = 0; j < m.tool_calls.length; j++) {
        const tc = m.tool_calls[j];
        if (!tc || typeof tc !== 'object' || typeof tc.id !== 'string' || !tc.function) {
          return `messages[${i}].tool_calls[${j}] 形状非法 (需要 { id, type:'function', function:{ name, arguments } })`;
        }
      }
      continue;
    }

    // tool 消息: content 允许空串 (工具返回空结果是合法的, 例如 search 无命中);
    // tool_call_id 必填 — 这是 OpenAI 协议的硬约束 (用于关联到此前的 tool_call).
    if (m.role === 'tool') {
      if (typeof m.content !== 'string' && !Array.isArray(m.content)) {
        return `messages[${i}].content (tool) 必须是字符串或数组`;
      }
      if (typeof m.tool_call_id !== 'string' || !m.tool_call_id) {
        return `messages[${i}].tool_call_id 必填 (tool 消息必须关联到一次 tool_call)`;
      }
      continue;
    }

    // system / user / 不带 tool_calls 的 assistant: 老校验.
    if (typeof m.content === 'string') {
      if (!m.content) {
        return `messages[${i}].content 不能是空字符串`;
      }
    } else if (Array.isArray(m.content)) {
      if (m.content.length === 0) {
        return `messages[${i}].content 数组不能为空`;
      }
      // Element schema is intentionally not validated — passed through to LLM as-is.
    } else {
      return `messages[${i}].content 必须是非空字符串或长度 ≥ 1 的数组`;
    }
  }
  return null;
}

/**
 * Validate an instant payload.
 *
 * @param {Object} payload
 * @param {Object} [opts]
 * @param {boolean} [opts.hookPath=false]            - When the handler was configured with `onLLMOutput`. The hook path rejects `completePrompt` because the hook author cannot predict v0.6's internal prompt-to-messages translation.
 * @param {number} [opts.maxLoopIterations=10]
 * @returns {{ valid: true } | { valid: false, errorCode: string, errorMessage: string, details?: Object }}
 */
export function validateInstantPayload(payload, opts) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'payload 必须是 JSON 对象'
    };
  }

  if (payload.firstSendTime !== undefined) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'amsg-instant 不接受 firstSendTime；该字段属于 amsg-server 的定时消息',
      details: { invalidFields: ['firstSendTime'] }
    };
  }

  if (payload.recurrenceType !== undefined && payload.recurrenceType !== 'none') {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'amsg-instant 不支持 recurrenceType（必须省略或为 "none"）',
      details: { invalidFields: ['recurrenceType'] }
    };
  }

  if (payload.messageType !== undefined && payload.messageType !== 'instant') {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'amsg-instant 仅支持 messageType: "instant"（或省略）',
      details: { invalidFields: ['messageType'] }
    };
  }

  if (typeof payload.contactName !== 'string' || !payload.contactName.trim()) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'contactName 必填',
      details: { missingFields: ['contactName'] }
    };
  }

  const hasCompletePrompt = payload.completePrompt !== undefined;
  const hasMessages = payload.messages !== undefined;
  const hookPath = !!(opts && opts.hookPath);

  if (hookPath && hasCompletePrompt) {
    // The hook path speaks in normalised `messages` arrays — the
    // hook author has no way to anticipate how v0.6 stitches
    // `completePrompt` into the LLM request, so we reject early.
    return {
      valid: false,
      errorCode: 'COMPLETE_PROMPT_NOT_SUPPORTED_ON_HOOK_PATH',
      errorMessage: 'completePrompt is not supported when onLLMOutput is configured; pass a `messages` array directly',
      details: { invalidFields: ['completePrompt'], hint: 'pass messages array directly' }
    };
  }

  if (hasCompletePrompt && hasMessages) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'exactly one of `completePrompt` or `messages` must be provided（两者不能同时出现）',
      details: { invalidFields: ['completePrompt', 'messages'] }
    };
  }
  if (!hasCompletePrompt && !hasMessages) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'exactly one of `completePrompt` or `messages` must be provided',
      details: { missingFields: ['completePrompt', 'messages'] }
    };
  }

  if (hasCompletePrompt) {
    if (typeof payload.completePrompt !== 'string' || !payload.completePrompt.trim()) {
      return {
        valid: false,
        errorCode: 'INVALID_PAYLOAD_FORMAT',
        errorMessage: 'completePrompt 必须是非空字符串',
        details: { invalidFields: ['completePrompt'] }
      };
    }
  } else {
    const messagesError = validateMessagesArray(payload.messages);
    if (messagesError) {
      return {
        valid: false,
        errorCode: 'INVALID_PAYLOAD_FORMAT',
        errorMessage: messagesError,
        details: { invalidFields: ['messages'] }
      };
    }
  }

  if (
    payload.temperature !== undefined &&
    payload.temperature !== null &&
    (typeof payload.temperature !== 'number' || !Number.isFinite(payload.temperature))
  ) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'temperature 必须是有限数字',
      details: { invalidFields: ['temperature'] }
    };
  }

  if (typeof payload.apiUrl !== 'string' || !payload.apiUrl.trim()) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'apiUrl 必填',
      details: { missingFields: ['apiUrl'] }
    };
  }
  if (typeof payload.apiKey !== 'string' || !payload.apiKey.trim()) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'apiKey 必填',
      details: { missingFields: ['apiKey'] }
    };
  }
  if (typeof payload.primaryModel !== 'string' || !payload.primaryModel.trim()) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'primaryModel 必填',
      details: { missingFields: ['primaryModel'] }
    };
  }

  if (
    payload.maxTokens !== undefined &&
    payload.maxTokens !== null &&
    (!Number.isInteger(payload.maxTokens) || payload.maxTokens <= 0)
  ) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'maxTokens 必须是正整数',
      details: { invalidFields: ['maxTokens'] }
    };
  }

  if (
    !payload.pushSubscription ||
    typeof payload.pushSubscription !== 'object' ||
    typeof payload.pushSubscription.endpoint !== 'string'
  ) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'pushSubscription 必须是合法 Web Push 订阅对象',
      details: { missingFields: ['pushSubscription.endpoint'] }
    };
  }

  const avatarErr = validateAvatarUrl(payload.avatarUrl);
  if (avatarErr) {
    // Soft-strip: a bad avatarUrl (data: URI / oversized / malformed) used to
    // 400 the whole /instant call. Avatar is cosmetic — drop the field, log,
    // and let the push go through without an icon. See standards §6.2.
    console.warn('[amsg-instant] avatarUrl 不合法，已置空：', avatarErr);
    payload.avatarUrl = null;
  }

  // messageSubtype is a free-form string tag for SW-side classification.
  // We only check the type — the actual taxonomy is the consumer's call.
  // amsg-server v2.0.1 still enum-checks chat/forum/moment, so values
  // beyond that set may be rejected if you also route through
  // amsg-server's scheduleMessage path.
  if (
    payload.messageSubtype !== undefined &&
    payload.messageSubtype !== null &&
    typeof payload.messageSubtype !== 'string'
  ) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'messageSubtype 必须是字符串',
      details: { invalidFields: ['messageSubtype'] }
    };
  }

  const removedField = ['splitPattern', 'reasoningSplitPattern', 'errorSplitPattern']
    .find((field) => payload[field] !== undefined);
  if (removedField) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: `${removedField} is removed in next.4; caller is responsible for splitting (return decision.pushPayloads with the exact pushes you want sent)`,
      details: { invalidFields: [removedField] },
    };
  }

  // Hook-path-only fields are validated regardless of which path
  // we're on — even legacy callers passing them should get a clean
  // 400 rather than silent acceptance.
  const sharedErr = validateHookPathSharedFields(payload, opts);
  if (sharedErr) return sharedErr;

  return { valid: true };
}

/**
 * Validate the `/continue` body. Same shape as `/instant`'s hook
 * path, with two extras:
 *
 *   - `sessionId` is required (must match the original turn).
 *   - `messages` is required (no `completePrompt` accepted on
 *     `/continue` ever — `/continue` is a v0.7-only endpoint).
 *
 * The `iteration` field is **0-indexed** and represents the
 * **next** round (= the `iteration` the hook saw, plus 1). It must
 * stay within `[0, maxLoopIterations)` — out-of-range values
 * indicate a broken client (off-by-one / retry stuck) and we
 * fail-fast with 400 rather than burning an LLM call.
 *
 * @param {Object} payload
 * @param {{ maxLoopIterations?: number }} [opts]
 * @returns {{ valid: true } | { valid: false, errorCode: string, errorMessage: string, details?: Object }}
 */
export function validateContinuePayload(payload, opts) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'payload 必须是 JSON 对象'
    };
  }

  if (typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'sessionId 必填且为非空字符串',
      details: { missingFields: ['sessionId'] }
    };
  }

  if (payload.completePrompt !== undefined) {
    return {
      valid: false,
      errorCode: 'COMPLETE_PROMPT_NOT_SUPPORTED_ON_HOOK_PATH',
      errorMessage: 'completePrompt is not accepted on /continue; pass a `messages` array directly',
      details: { invalidFields: ['completePrompt'] }
    };
  }

  if (payload.messages === undefined) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: '`messages` is required on /continue',
      details: { missingFields: ['messages'] }
    };
  }
  const messagesError = validateMessagesArray(payload.messages);
  if (messagesError) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: messagesError,
      details: { invalidFields: ['messages'] }
    };
  }

  if (typeof payload.contactName !== 'string' || !payload.contactName.trim()) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'contactName 必填',
      details: { missingFields: ['contactName'] }
    };
  }
  if (typeof payload.apiUrl !== 'string' || !payload.apiUrl.trim()) {
    return {
      valid: false, errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'apiUrl 必填', details: { missingFields: ['apiUrl'] }
    };
  }
  if (typeof payload.apiKey !== 'string' || !payload.apiKey.trim()) {
    return {
      valid: false, errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'apiKey 必填', details: { missingFields: ['apiKey'] }
    };
  }
  if (typeof payload.primaryModel !== 'string' || !payload.primaryModel.trim()) {
    return {
      valid: false, errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'primaryModel 必填', details: { missingFields: ['primaryModel'] }
    };
  }
  if (
    payload.maxTokens !== undefined && payload.maxTokens !== null &&
    (!Number.isInteger(payload.maxTokens) || payload.maxTokens <= 0)
  ) {
    return {
      valid: false, errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'maxTokens 必须是正整数', details: { invalidFields: ['maxTokens'] }
    };
  }
  if (
    payload.temperature !== undefined && payload.temperature !== null &&
    (typeof payload.temperature !== 'number' || !Number.isFinite(payload.temperature))
  ) {
    return {
      valid: false, errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'temperature 必须是有限数字', details: { invalidFields: ['temperature'] }
    };
  }
  if (
    !payload.pushSubscription ||
    typeof payload.pushSubscription !== 'object' ||
    typeof payload.pushSubscription.endpoint !== 'string'
  ) {
    return {
      valid: false, errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'pushSubscription 必须是合法 Web Push 订阅对象',
      details: { missingFields: ['pushSubscription.endpoint'] }
    };
  }
  const avatarErr = validateAvatarUrl(payload.avatarUrl);
  if (avatarErr) {
    // Soft-strip: same policy as /instant — drop the field, log, continue.
    // See standards §6.2.
    console.warn('[amsg-instant] /continue avatarUrl 不合法，已置空：', avatarErr);
    payload.avatarUrl = null;
  }

  const removedField = ['splitPattern', 'reasoningSplitPattern', 'errorSplitPattern']
    .find((field) => payload[field] !== undefined);
  if (removedField) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: `${removedField} is removed in next.4; caller is responsible for splitting (return decision.pushPayloads with the exact pushes you want sent)`,
      details: { invalidFields: [removedField] },
    };
  }

  return validateHookPathSharedFields(payload, opts) || { valid: true };
}

/**
 * Validate fields that are only meaningful on the hook path (or
 * `/continue`). Returns null when everything looks fine so the
 * caller can keep going.
 *
 * @param {Object} payload
 * @param {{ maxLoopIterations?: number }} [opts]
 */
function validateHookPathSharedFields(payload, opts) {
  if (payload.sessionId !== undefined) {
    if (typeof payload.sessionId !== 'string' || !payload.sessionId.trim()) {
      return {
        valid: false, errorCode: 'INVALID_PAYLOAD_FORMAT',
        errorMessage: 'sessionId 必须是非空字符串',
        details: { invalidFields: ['sessionId'] }
      };
    }
  }
  if (payload.charId !== undefined) {
    if (typeof payload.charId !== 'string' || !payload.charId.trim()) {
      return {
        valid: false, errorCode: 'INVALID_PAYLOAD_FORMAT',
        errorMessage: 'charId 必须是非空字符串',
        details: { invalidFields: ['charId'] }
      };
    }
  }
  if (payload.iteration !== undefined) {
    const maxLoop = opts && Number.isInteger(opts.maxLoopIterations) && opts.maxLoopIterations > 0
      ? opts.maxLoopIterations
      : 10;
    if (
      typeof payload.iteration !== 'number' ||
      !Number.isInteger(payload.iteration) ||
      payload.iteration < 0 ||
      payload.iteration >= maxLoop
    ) {
      return {
        valid: false, errorCode: 'INVALID_PAYLOAD_FORMAT',
        errorMessage: `iteration 必须是 0..${maxLoop - 1} 范围内的整数`,
        details: { invalidFields: ['iteration'] }
      };
    }
  }
  if (payload.metadata !== undefined && payload.metadata !== null) {
    if (
      typeof payload.metadata !== 'object' ||
      Array.isArray(payload.metadata)
    ) {
      return {
        valid: false, errorCode: 'INVALID_PAYLOAD_FORMAT',
        errorMessage: 'metadata 必须是普通对象',
        details: { invalidFields: ['metadata'] }
      };
    }
  }
  return null;
}
