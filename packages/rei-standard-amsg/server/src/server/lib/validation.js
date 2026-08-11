/**
 * Validation utility library (SDK version)
 */

import { isValidUrl, validateAvatarUrl, validateLlmMessagesShape } from '@rei-standard/amsg-shared';
import { isValidTimeZoneId } from './recurrence.js';
import { hasChatCredRef, validateCredRefs } from './llm-credentials-store.js';

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

// ─── 任务正文的大小闸门 ────────────────────────────────────────────────
//
// 一条任务的正文（messages / completePrompt / metadata …）整个加密成一个字符
// 串，落在 scheduled_messages.encrypted_payload 这一列上。D1 对「单个字符串 /
// 单行」的上限是 2,000,000 字节
// （https://developers.cloudflare.com/d1/platform/limits/），而
// encryptForStorage 的输出是 `hex(iv):hex(tag):hex(密文)`——十六进制让字节数正
// 好翻倍：
//
//   落库字符串字节数 = 2 × 明文字节数 + 66   （iv / tag 各 32 个 hex 字符 + 两个冒号）
//
// 顶穿之后 D1 回的是 `D1_ERROR: string or blob too big`，包到 500 里，调用方既
// 看不出是哪份数据太大、也看不出上限是多少。本地测试跑的是 SQLite（单值上限
// 十亿字节）、Postgres 的 text 上限 1GB，两边都碰不到这条线，只有线上 D1 会炸。
// 所以在写库之前先量一次，超了当场 400 并把字节数报回去。
//
// 上限对所有适配器一视同仁：同一份任务在 D1 / Postgres 之间搬家时契约不该跟着
// 变（client_state 的单条 value 上限也是这么定的）。

/** D1 的单个字符串 / 单行上限（字节）。 */
const D1_MAX_ROW_BYTES = 2_000_000;
/** hex 密文的固定开销：iv 与 tag 各 16 字节 → 各 32 个 hex 字符，加两个冒号。 */
const STORAGE_HEX_OVERHEAD_BYTES = 66;
/** 同一行里除 encrypted_payload 之外的列（uuid / user_id / 时间戳 / last_error…）。 */
const TASK_ROW_OTHER_COLUMNS_BYTES = 4096;
// 投递失败时 run-tick 会往明文正文里补一段 lastError 再加密回写。这段增量长在
// 明文那侧（落库同样翻倍），预算里先扣掉——不扣的话，正好卡在上限的任务建得进
// 去，第一次投递失败时才在回写那一步炸，而且那条路径既不推进重试计数也不放租约。
const TASK_LAST_ERROR_RESERVED_BYTES = 2048;

/**
 * 一条任务正文（`JSON.stringify` 的结果）的明文上限，UTF-8 字节数。
 * 客户端想在提交前自己预算就读这个数（从 `@rei-standard/amsg-server` 导出）。
 */
export const MAX_TASK_PAYLOAD_BYTES = Math.floor(
  (D1_MAX_ROW_BYTES - TASK_ROW_OTHER_COLUMNS_BYTES - STORAGE_HEX_OVERHEAD_BYTES) / 2
) - TASK_LAST_ERROR_RESERVED_BYTES;

const taskPayloadEncoder = new TextEncoder();

/**
 * 落库前量一次任务正文。合法返回 null，超限返回可以直接放进 400 响应体的
 * error 对象——`POST /schedule-message` 与 `PUT /update-message` 共用同一个错
 * 误码和同一套 details，下游判断读 `details.bytes` / `details.maxBytes`，不用
 * 去解析那句人话。
 *
 * 按 UTF-8 字节算而不是字符数：D1 限的是字节，加密前也是先转 UTF-8，一段全中
 * 文的正文字符数只有字节数的三分之一，用 `.length` 量等于把上限放大三倍。
 *
 * @param {string} serializedPayload - 将要交给 encryptForStorage 的那个字符串。
 * @returns {{ code: string, message: string, details: { bytes: number, maxBytes: number } } | null}
 */
export function validateTaskPayloadSize(serializedPayload) {
  const bytes = taskPayloadByteLength(serializedPayload);
  if (bytes <= MAX_TASK_PAYLOAD_BYTES) return null;
  return {
    code: 'TASK_PAYLOAD_TOO_LARGE',
    message: `任务内容 ${bytes} 字节，超过 ${MAX_TASK_PAYLOAD_BYTES} 字节上限`,
    details: { bytes, maxBytes: MAX_TASK_PAYLOAD_BYTES }
  };
}

/**
 * 任务正文的 UTF-8 字节数（与 {@link validateTaskPayloadSize} 同一把尺子）。
 *
 * `PUT /update-message` 拿它跟改动前的正文比大小：上限是后加的，比它更早建出来
 * 的大任务不该因此连排期都改不了，只要这次改动没把它变得更大就放行。
 *
 * @param {string} serializedPayload
 * @returns {number}
 */
export function taskPayloadByteLength(serializedPayload) {
  return taskPayloadEncoder.encode(serializedPayload).length;
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

  // immediate：这条任务不排未来，落库后由下一跳 cron（最多一分钟后）直接
  // 触发。有了它，「马上发一条走 cron 链路的任务」不用再预留提前量凑
  // firstSendTime——慢网/低端机把提前量吃光就会 400 的那类竞态从此不存在。
  if (payload.immediate !== undefined && typeof payload.immediate !== 'boolean') {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: 'immediate 必须是布尔值', details: { invalidFields: ['immediate'] } };
  }
  const immediate = payload.immediate === true;
  if (immediate && payload.messageType === 'instant') {
    // instant 的语义本来就是「建行的那一刻就投递」，immediate 对它是重复修饰；
    // 明确拒掉比静默接受好——接受了会让人以为两者组合有额外含义。
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: "messageType 'instant' 本就立即投递，不能再带 immediate", details: { invalidFields: ['immediate'] } };
  }

  if (immediate) {
    // immediate 时 firstSendTime 可省略（服务端取当前时刻）；传了只校验格式，
    // 不再要求在未来——它只是客户端本地的「想发的时刻」，不参与排期。
    if (payload.firstSendTime !== undefined && payload.firstSendTime !== null && !isValidISO8601(payload.firstSendTime)) {
      return { valid: false, errorCode: 'INVALID_TIMESTAMP', errorMessage: '时间格式无效', details: { field: 'firstSendTime' } };
    }
  } else {
    if (!payload.firstSendTime || !isValidISO8601(payload.firstSendTime)) {
      return { valid: false, errorCode: 'INVALID_TIMESTAMP', errorMessage: '时间格式无效', details: { field: 'firstSendTime' } };
    }

    if (payload.firstSendTime && new Date(payload.firstSendTime) <= new Date()) {
      return { valid: false, errorCode: 'INVALID_TIMESTAMP', errorMessage: '时间必须在未来', details: { field: 'firstSendTime', reason: 'must be in the future' } };
    }
  }

  // supersedesUuid：建这条的同时取消旧的那条（同一用户）。与「先 DELETE 再
  // POST」两次请求的差别在原子性：适配器支持时删旧建新落在同一事务里，不会
  // 出现「旧的删了、新的没建成」的中间态，也省一次串行往返。
  if (payload.supersedesUuid !== undefined && payload.supersedesUuid !== null) {
    if (typeof payload.supersedesUuid !== 'string' || !isValidUUID(payload.supersedesUuid)) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: 'supersedesUuid 必须是合法 UUID', details: { invalidFields: ['supersedesUuid'] } };
    }
    if (payload.uuid && payload.supersedesUuid === payload.uuid) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: 'supersedesUuid 不能与本条任务的 uuid 相同', details: { invalidFields: ['supersedesUuid'] } };
    }
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

  // userMessage 给了就必须是字符串。正文最终要过 splitMessageIntoSentences 的
  // 正则切分，传个数字进来这一步收得下、到点投递时才炸在 `chunk.split` 上——
  // 那时早已离开 HTTP 请求，用户只看到一条任务莫名其妙失败，还要连着重试三轮
  // 同样地失败。
  if (
    payload.userMessage !== undefined &&
    payload.userMessage !== null &&
    typeof payload.userMessage !== 'string'
  ) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { invalidFields: ['userMessage (must be a string)'] } };
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

  // credRefs：任务不冻结凭据、改带引用（{ <purpose>: <cred_id> }，服务端只认
  // `chat` 这个 purpose，其余归宿主 hook）。形状校验一份口径（update-message
  // 复用同一个 validateCredRefs）。
  if (payload.credRefs !== undefined && payload.credRefs !== null) {
    const credRefsErr = validateCredRefs(payload.credRefs);
    if (credRefsErr) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: credRefsErr, details: { invalidFields: ['credRefs'] } };
    }
  }
  const hasChatRef = hasChatCredRef(payload);
  // chat 凭据只能有一个来源：带了 credRefs.chat 就不许再带内联三件套的任何
  // 一个（新 API 没有存量调用方，混着传只会留下「到底用哪份」的歧义）。
  if (hasChatRef && (payload.apiUrl || payload.apiKey || payload.primaryModel)) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: 'credRefs.chat 与内联 apiUrl / apiKey / primaryModel 不能同时提供（二选一）', details: { invalidFields: ['credRefs.chat', 'apiUrl', 'apiKey', 'primaryModel'] } };
  }

  if (payload.messageType === 'prompted' || payload.messageType === 'auto') {
    const missingAiFields = [];
    if (!hasPrompt) missingAiFields.push('completePrompt or messages');
    if (!hasChatRef) {
      const hasAnyInline = !!(payload.apiUrl || payload.apiKey || payload.primaryModel);
      if (!hasAnyInline) {
        // 三件套整个缺席时提示两条路都行，而不是只报内联那条。
        missingAiFields.push('credRefs.chat or (apiUrl + apiKey + primaryModel)');
      } else {
        if (!payload.apiUrl) missingAiFields.push('apiUrl');
        if (!payload.apiKey) missingAiFields.push('apiKey');
        if (!payload.primaryModel) missingAiFields.push('primaryModel');
      }
    }
    if (missingAiFields.length > 0) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: '缺少必需参数或参数格式错误', details: { missingFields: missingAiFields } };
    }
  }

  if (payload.messageType === 'instant') {
    if (payload.recurrenceType && payload.recurrenceType !== 'none') {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: 'instant 类型的 recurrenceType 必须为 none', details: { invalidFields: ['recurrenceType (must be "none" for instant type)'] } };
    }
    const hasAiConfig = hasPrompt && (hasChatRef || (payload.apiUrl && payload.apiKey && payload.primaryModel));
    const hasUserMessage = payload.userMessage;
    if (!hasAiConfig && !hasUserMessage) {
      return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: 'instant 类型必须提供 userMessage 或完整的 AI 配置', details: { missingFields: ['userMessage or ((completePrompt | messages) + (credRefs.chat | apiUrl + apiKey + primaryModel))'] } };
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

  // 透传给 LLM 中转的非标准参数（thinking 之类）。只查形状（普通对象）——
  // 里面的字段库不认识也不该认识，中转认不认是调用方与中转之间的契约。
  if (
    payload.llmExtraBody !== undefined &&
    payload.llmExtraBody !== null &&
    (typeof payload.llmExtraBody !== 'object' || Array.isArray(payload.llmExtraBody))
  ) {
    return { valid: false, errorCode: 'INVALID_PARAMETERS', errorMessage: 'llmExtraBody 必须是普通对象', details: { invalidFields: ['llmExtraBody'] } };
  }

  return { valid: true };
}
