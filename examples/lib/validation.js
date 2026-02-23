/**
 * 参数验证工具函数库
 * ReiStandard v1.1.0
 */

/**
 * 验证 ISO 8601 时间格式（放宽校验，允许无毫秒的变体）
 */
function isValidISO8601(dateString) {
  const date = new Date(dateString);
  // 只需确保能被 Date 解析且为有效日期即可
  return date instanceof Date && !isNaN(date.getTime());
}

/**
 * 验证 URL 格式
 */
function isValidUrl(urlString) {
  try {
    new URL(urlString);
    return true;
  } catch {
    return false;
  }
}

/**
 * 验证 UUID 格式
 */
function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * 验证 UUID v4 格式
 */
function isValidUUIDv4(uuid) {
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Regex.test(uuid);
}

/**
 * 验证请求体参数
 * 返回格式：{ valid: boolean, errorCode?: string, errorMessage?: string, details?: object }
 */
function validateScheduleMessagePayload(payload) {
  // 基础验证
  if (!payload.contactName || typeof payload.contactName !== 'string') {
    return {
      valid: false,
      errorCode: 'INVALID_PARAMETERS',
      errorMessage: '缺少必需参数或参数格式错误',
      details: { missingFields: ['contactName'] }
    };
  }

  // 消息类型验证 - 特殊错误码
  if (!payload.messageType || !['fixed', 'prompted', 'auto', 'instant'].includes(payload.messageType)) {
    return {
      valid: false,
      errorCode: 'INVALID_MESSAGE_TYPE',
      errorMessage: '消息类型无效',
      details: { providedType: payload.messageType, allowedTypes: ['fixed', 'prompted', 'auto', 'instant'] }
    };
  }

  // 时间格式验证 - 特殊错误码
  if (!payload.firstSendTime || !isValidISO8601(payload.firstSendTime)) {
    return {
      valid: false,
      errorCode: 'INVALID_TIMESTAMP',
      errorMessage: '时间格式无效',
      details: { field: 'firstSendTime' }
    };
  }

  // 时间必须在未来 - 特殊错误码
  if (payload.firstSendTime && new Date(payload.firstSendTime) <= new Date()) {
    return {
      valid: false,
      errorCode: 'INVALID_TIMESTAMP',
      errorMessage: '时间必须在未来',
      details: { field: 'firstSendTime', reason: 'must be in the future' }
    };
  }

  if (!payload.pushSubscription || typeof payload.pushSubscription !== 'object') {
    return {
      valid: false,
      errorCode: 'INVALID_PARAMETERS',
      errorMessage: '缺少必需参数或参数格式错误',
      details: { missingFields: ['pushSubscription'] }
    };
  }

  // 重复类型验证
  if (payload.recurrenceType && !['none', 'daily', 'weekly'].includes(payload.recurrenceType)) {
    return {
      valid: false,
      errorCode: 'INVALID_PARAMETERS',
      errorMessage: '缺少必需参数或参数格式错误',
      details: { invalidFields: ['recurrenceType'] }
    };
  }

  // 消息类型特定验证
  if (payload.messageType === 'fixed') {
    if (!payload.userMessage) {
      return {
        valid: false,
        errorCode: 'INVALID_PARAMETERS',
        errorMessage: '缺少必需参数或参数格式错误',
        details: { missingFields: ['userMessage (required for fixed type)'] }
      };
    }
  }

  if (payload.messageType === 'prompted' || payload.messageType === 'auto') {
    const missingAiFields = [];
    if (!payload.completePrompt) missingAiFields.push('completePrompt');
    if (!payload.apiUrl) missingAiFields.push('apiUrl');
    if (!payload.apiKey) missingAiFields.push('apiKey');
    if (!payload.primaryModel) missingAiFields.push('primaryModel');

    if (missingAiFields.length > 0) {
      return {
        valid: false,
        errorCode: 'INVALID_PARAMETERS',
        errorMessage: '缺少必需参数或参数格式错误',
        details: { missingFields: missingAiFields }
      };
    }
  }

  if (payload.messageType === 'instant') {
    // instant 类型 recurrenceType 必须为 none
    if (payload.recurrenceType && payload.recurrenceType !== 'none') {
      return {
        valid: false,
        errorCode: 'INVALID_PARAMETERS',
        errorMessage: 'instant 类型的 recurrenceType 必须为 none',
        details: { invalidFields: ['recurrenceType (must be "none" for instant type)'] }
      };
    }

    // instant 类型可以是固定消息或 AI 消息
    // 如果有 AI 配置，则使用 AI 生成；否则必须提供 userMessage
    const hasAiConfig = payload.completePrompt && payload.apiUrl && payload.apiKey && payload.primaryModel;
    const hasUserMessage = payload.userMessage;

    if (!hasAiConfig && !hasUserMessage) {
      return {
        valid: false,
        errorCode: 'INVALID_PARAMETERS',
        errorMessage: 'instant 类型必须提供 userMessage 或完整的 AI 配置',
        details: { missingFields: ['userMessage or (completePrompt + apiUrl + apiKey + primaryModel)'] }
      };
    }
  }

  // 扩展字段验证
  if (payload.avatarUrl && !isValidUrl(payload.avatarUrl)) {
    return {
      valid: false,
      errorCode: 'INVALID_PARAMETERS',
      errorMessage: '缺少必需参数或参数格式错误',
      details: { invalidFields: ['avatarUrl (invalid URL format)'] }
    };
  }
  if (payload.uuid && !isValidUUID(payload.uuid)) {
    return {
      valid: false,
      errorCode: 'INVALID_PARAMETERS',
      errorMessage: '缺少必需参数或参数格式错误',
      details: { invalidFields: ['uuid (invalid UUID format)'] }
    };
  }
  if (payload.messageSubtype && !['chat', 'forum', 'moment'].includes(payload.messageSubtype)) {
    return {
      valid: false,
      errorCode: 'INVALID_PARAMETERS',
      errorMessage: '缺少必需参数或参数格式错误',
      details: { invalidFields: ['messageSubtype'] }
    };
  }

  return { valid: true };
}

module.exports = {
  isValidISO8601,
  isValidUrl,
  isValidUUID,
  isValidUUIDv4,
  validateScheduleMessagePayload
};
