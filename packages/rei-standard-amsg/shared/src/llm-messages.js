/**
 * OpenAI-style `messages` 数组形状校验 — 单一事实来源。
 *
 * `@rei-standard/amsg-instant` 的 `validateMessagesArray` 与
 * `@rei-standard/amsg-server` 的 `validateLlmMessagesArray` 都调用这里的
 * `validateLlmMessagesShape`，保证两个包接受完全相同的消息形状（含 agentic
 * 会话：assistant 带 `tool_calls` 时 content 可空、`role:'tool'` 要求
 * `tool_call_id`）。
 *
 * 本模块返回**结构化错误**（稳定 `code` + 定位索引），不返回面向用户的
 * 错误文案 — 各包各自把 code 映射成自己的错误信息（instant 中文 /
 * server 英文），公开 API 的措辞与返回形状因此保持不变。
 */

const VALID_LLM_MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * {@link validateLlmMessagesShape} 可能返回的稳定错误码。枚举固定 —
 * 新增校验分支时必须新增 code，各消费包据此穷举映射错误文案。
 *
 * @typedef {'MESSAGES_NOT_ARRAY'
 *   | 'MESSAGE_NOT_OBJECT'
 *   | 'INVALID_ROLE'
 *   | 'TOOL_CALL_MALFORMED'
 *   | 'TOOL_CONTENT_INVALID'
 *   | 'TOOL_CALL_ID_MISSING'
 *   | 'CONTENT_EMPTY_STRING'
 *   | 'CONTENT_EMPTY_ARRAY'
 *   | 'CONTENT_INVALID_TYPE'} LlmMessagesErrorCode
 */

/**
 * Runtime constant mirroring the {@link LlmMessagesErrorCode} type.
 */
export const LLM_MESSAGES_ERROR = Object.freeze({
  MESSAGES_NOT_ARRAY: 'MESSAGES_NOT_ARRAY',
  MESSAGE_NOT_OBJECT: 'MESSAGE_NOT_OBJECT',
  INVALID_ROLE: 'INVALID_ROLE',
  TOOL_CALL_MALFORMED: 'TOOL_CALL_MALFORMED',
  TOOL_CONTENT_INVALID: 'TOOL_CONTENT_INVALID',
  TOOL_CALL_ID_MISSING: 'TOOL_CALL_ID_MISSING',
  CONTENT_EMPTY_STRING: 'CONTENT_EMPTY_STRING',
  CONTENT_EMPTY_ARRAY: 'CONTENT_EMPTY_ARRAY',
  CONTENT_INVALID_TYPE: 'CONTENT_INVALID_TYPE',
});

/**
 * @typedef {Object} LlmMessagesShapeError
 * @property {LlmMessagesErrorCode} code
 * @property {number} [index]         - 出错的 messages 下标（数组级错误时缺省）。
 * @property {number} [toolCallIndex] - 出错的 tool_calls 下标（仅 TOOL_CALL_MALFORMED）。
 */

/**
 * Validate an OpenAI-style messages array. Pure（无副作用）。
 *
 * 接受的形状（与 OpenAI chat.completions 协议对齐）：
 *   - system / user / assistant: content 为非空字符串或长度 ≥ 1 的数组
 *     （数组元素 schema 故意不校验 — 原样透传给上游 LLM）。
 *   - assistant 带非空 `tool_calls`: content 可为 null / 空串 / 缺省；
 *     每个 tool_call 需满足 `{ id: string, function }` 的轻量形状
 *     （不严 — 上游 LLM API 会再校一遍）。
 *   - tool: content 允许空串（工具返回空结果合法，如 search 无命中），
 *     但必须是字符串或数组；`tool_call_id` 必填（OpenAI 协议硬约束）。
 *
 * @param {unknown} messages
 * @returns {LlmMessagesShapeError | null}   Structured error, or null if valid.
 */
export function validateLlmMessagesShape(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { code: LLM_MESSAGES_ERROR.MESSAGES_NOT_ARRAY };
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      return { code: LLM_MESSAGES_ERROR.MESSAGE_NOT_OBJECT, index: i };
    }
    if (!VALID_LLM_MESSAGE_ROLES.has(m.role)) {
      return { code: LLM_MESSAGES_ERROR.INVALID_ROLE, index: i };
    }

    // assistant 消息在带 tool_calls 时, content 可为 null / 空串 / 缺省.
    // 跳过 content 校验, 但仍要求 tool_calls 是非空数组 (否则就是无意义的纯空 assistant).
    const isAssistantToolCallCarrier =
      m.role === 'assistant'
      && Array.isArray(m.tool_calls)
      && m.tool_calls.length > 0;
    if (isAssistantToolCallCarrier) {
      for (let j = 0; j < m.tool_calls.length; j++) {
        const tc = m.tool_calls[j];
        if (!tc || typeof tc !== 'object' || typeof tc.id !== 'string' || !tc.function) {
          return { code: LLM_MESSAGES_ERROR.TOOL_CALL_MALFORMED, index: i, toolCallIndex: j };
        }
      }
      continue;
    }

    if (m.role === 'tool') {
      if (typeof m.content !== 'string' && !Array.isArray(m.content)) {
        return { code: LLM_MESSAGES_ERROR.TOOL_CONTENT_INVALID, index: i };
      }
      if (typeof m.tool_call_id !== 'string' || !m.tool_call_id) {
        return { code: LLM_MESSAGES_ERROR.TOOL_CALL_ID_MISSING, index: i };
      }
      continue;
    }

    // system / user / 不带 tool_calls 的 assistant.
    if (typeof m.content === 'string') {
      if (!m.content) {
        return { code: LLM_MESSAGES_ERROR.CONTENT_EMPTY_STRING, index: i };
      }
    } else if (Array.isArray(m.content)) {
      if (m.content.length === 0) {
        return { code: LLM_MESSAGES_ERROR.CONTENT_EMPTY_ARRAY, index: i };
      }
      // Element schema is intentionally not validated — passed through to LLM as-is.
    } else {
      return { code: LLM_MESSAGES_ERROR.CONTENT_INVALID_TYPE, index: i };
    }
  }
  return null;
}
