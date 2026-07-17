/**
 * SessionContext builder for the v0.7 agentic-loop hook.
 *
 * The hook author receives a frozen view of the in-flight turn:
 *
 *   { sessionId, charId?, messages, llmResponse, llmOutputText,
 *     iteration, metadata, contactName, avatarUrl? }
 *
 * Credentials (`apiUrl`, `apiKey`, `primaryModel`, `maxTokens`,
 * `temperature`, `pushSubscription`, `vapid`) are intentionally NOT
 * exposed:
 *   1. A `console.log(ctx)` from a hook author can otherwise leak the
 *      API key into a request log.
 *   2. A third-party npm hook installed into a downstream worker can
 *      exfiltrate `apiKey` and burn the caller's LLM credits.
 *
 * The worker still owns those fields in its closure; the hook only
 * gets to *decide* (finish / tool-request / continue / skip-push), not
 * to re-execute LLM or push calls itself.
 *
 * Implementation lives in `@rei-standard/amsg-shared` so
 * `@rei-standard/amsg-server`'s fire-time loop builds the exact same
 * context shape. The typedefs stay here for this package's own d.ts
 * generation and internal `import('./session-context.js')` references.
 */

/**
 * @typedef {Object} ChatMessage
 * @property {'system' | 'user' | 'assistant' | 'tool'} role
 * @property {string | unknown[] | null} [content]  - 文本或多模态数组. 带 tool_calls 的 assistant 消息允许为 null / 空串 / 缺省.
 * @property {Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>} [tool_calls]  - assistant 发起工具调用时携带.
 * @property {string} [tool_call_id]  - tool 消息必填, 用于关联到此前的 tool_call.
 * @property {string} [name]
 */

/**
 * @typedef {Object} SessionContext
 * @property {string}                   sessionId
 * @property {string}                   [charId]
 * @property {ChatMessage[]}            messages         - Including the just-appended assistant turn.
 * @property {unknown}                  llmResponse      - Full LLM response (choices, usage, …).
 * @property {string}                   llmOutputText    - May be '' for pure tool-call responses.
 * @property {number}                   iteration        - 0-indexed: the round that just finished.
 * @property {Record<string, unknown>}  metadata
 * @property {string}                   contactName
 * @property {string}                   [avatarUrl]
 */

export { buildSessionContext, extractAssistantMessage } from '@rei-standard/amsg-shared';
