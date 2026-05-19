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
 */

/**
 * @typedef {Object} ChatMessage
 * @property {string} role  - One of system / user / assistant / tool / etc.
 * @property {string | unknown[]} [content]
 * @property {unknown} [tool_calls]
 * @property {string} [tool_call_id]
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

/**
 * Build a SessionContext from a validated payload + the latest LLM
 * response. Caller must pass the already-appended messages array
 * (i.e. `[...originalHistory, choices[0].message]`).
 *
 * The returned object is frozen so a hook implementation cannot
 * accidentally mutate the live messages array — if the hook chooses
 * `decision:'continue'`, the worker still owns its copy.
 *
 * @param {Object} args
 * @param {string} args.sessionId
 * @param {ChatMessage[]} args.messages
 * @param {unknown} args.llmResponse
 * @param {number} args.iteration
 * @param {string} args.contactName
 * @param {string} [args.avatarUrl]
 * @param {string} [args.charId]
 * @param {Record<string, unknown>} [args.metadata]
 * @returns {SessionContext}
 */
export function buildSessionContext({
  sessionId,
  messages,
  llmResponse,
  iteration,
  contactName,
  avatarUrl,
  charId,
  metadata,
}) {
  const llmOutputText = readLlmOutputText(llmResponse);
  const ctx = {
    sessionId,
    charId,
    messages,
    llmResponse,
    llmOutputText,
    iteration,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    contactName,
    avatarUrl: avatarUrl || undefined,
  };
  return Object.freeze(ctx);
}

/**
 * Safely read `choices[0].message.content` as a string. Pure
 * tool-call responses legitimately have empty content, so we return
 * '' rather than throwing — matches the documented contract:
 *   "llmOutputText: ... 注意可能为空字符串 (纯 tool_calls 响应)".
 *
 * @param {unknown} llmResponse
 * @returns {string}
 */
function readLlmOutputText(llmResponse) {
  if (!llmResponse || typeof llmResponse !== 'object') return '';
  const choices = /** @type {{ choices?: unknown }} */ (llmResponse).choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const message = /** @type {{ message?: { content?: unknown } }} */ (choices[0])?.message;
  const content = message?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * Extract the `choices[0].message` whole object — preserving
 * `tool_calls` / `reasoning_content` / `refusal` etc. — for appending
 * to the running history. Falls back to a minimal placeholder when
 * the response is malformed so the hook still gets a chance to react
 * via `llmOutputText === ''`.
 *
 * Critically, we keep the entire message object (not just
 * `{role, content}`): the next round may need to forward a
 * `tool_calls` array to OpenAI alongside the matching tool-result
 * messages, and stripping the field would make the API reject the
 * request.
 *
 * @param {unknown} llmResponse
 * @returns {ChatMessage}
 */
export function extractAssistantMessage(llmResponse) {
  const message =
    llmResponse &&
    typeof llmResponse === 'object' &&
    Array.isArray(/** @type {{ choices?: unknown }} */ (llmResponse).choices) &&
    /** @type {{ choices: Array<{ message?: unknown }> }} */ (llmResponse).choices[0]?.message;
  if (message && typeof message === 'object') {
    return /** @type {ChatMessage} */ (message);
  }
  return { role: 'assistant', content: '' };
}
