/**
 * Validation utility library (SDK version)
 * ReiStandard SDK v1.2.2
 */

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

  if (payload.messageType === 'fixed') {
    if (!payload.userMessage) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { missingFields: ['userMessage (required for fixed type)'] } };
    }
  }

  if (payload.messageType === 'prompted' || payload.messageType === 'auto') {
    const missingAiFields = [];
    if (!payload.completePrompt) missingAiFields.push('completePrompt');
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
    const hasAiConfig = payload.completePrompt && payload.apiUrl && payload.apiKey && payload.primaryModel;
    const hasUserMessage = payload.userMessage;
    if (!hasAiConfig && !hasUserMessage) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: 'instant 类型必须提供 userMessage 或完整的 AI 配置', details: { missingFields: ['userMessage or (completePrompt + apiUrl + apiKey + primaryModel)'] } };
    }
  }

  if (payload.avatarUrl && !isValidUrl(payload.avatarUrl)) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { invalidFields: ['avatarUrl (invalid URL format)'] } };
  }
  if (payload.uuid && !isValidUUID(payload.uuid)) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { invalidFields: ['uuid (invalid UUID format)'] } };
  }
  if (payload.messageSubtype && !['chat', 'forum', 'moment'].includes(payload.messageSubtype)) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { invalidFields: ['messageSubtype'] } };
  }

  return { valid: true };
}
