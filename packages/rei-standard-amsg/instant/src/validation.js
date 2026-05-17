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
 * @returns {{ valid: true } | { valid: false, errorCode: string, errorMessage: string, details?: Object }}
 */
export function validateInstantPayload(payload) {
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

  if (payload.avatarUrl !== undefined && payload.avatarUrl !== null && !isValidUrl(payload.avatarUrl)) {
    return {
      valid: false,
      errorCode: 'INVALID_PAYLOAD_FORMAT',
      errorMessage: 'avatarUrl 格式无效',
      details: { invalidFields: ['avatarUrl'] }
    };
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

  return { valid: true };
}
