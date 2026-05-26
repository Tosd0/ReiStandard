/**
 * Protocol-neutral agentic-loop skeleton for @rei-standard/amsg-instant.
 *
 * Demonstrates the three decision branches the v0.7 hook supports
 * (finish / tool-request / continue) using an **abstract** trigger
 * condition (`text.includes('NEED_TOOL')`). The package intentionally
 * ships **no business-protocol parser** — replace the trigger logic
 * with whatever your app actually speaks:
 *
 *   - Custom `[[TAG:get_weather]]` text markers
 *   - OpenAI `tool_calls` JSON
 *   - XML blocks
 *   - Natural-language intent classification
 *
 * This file is meant to be copy-pasted as the starting point of your
 * own `worker.js` — not imported as a library.
 */

import {
  createInstantHandler,
  buildContentPush,
  buildToolRequestPush,
} from '@rei-standard/amsg-instant';
import { createMemoryBlobStore } from '@rei-standard/amsg-instant/blob/memory';

export default {
  fetch: createInstantHandler({
    vapid: {
      email: 'mailto:you@example.com',
      publicKey: globalThis.VAPID_PUBLIC_KEY,
      privateKey: globalThis.VAPID_PRIVATE_KEY,
    },
    // Plug a real store in production (D1 / KV / Postgres / Redis).
    // Memory is fine for local dev only.
    blobStore: { adapter: createMemoryBlobStore() },
    maxLoopIterations: 10,
    onLLMOutput,
    onEvent: (e) => console.log('[amsg-instant]', e),
  }),
};

/**
 * @param {import('@rei-standard/amsg-instant').SessionContext} ctx
 */
async function onLLMOutput(ctx) {
  const text = ctx.llmOutputText;

  // ─── (A) Tool-call request: hand control back to the client ───────
  //
  // Replace the trigger with whatever your app's protocol uses. The
  // pushPayload is yours to shape — the SW will see exactly what you
  // return (modulo the `_blob` envelope wrapping for large bodies).
  if (text.includes('NEED_TOOL')) {
    return {
      decision: 'tool-request',
      pushPayloads: [buildToolRequestPush({
        messageType: 'instant',
        source: 'instant',
        messageId: `msg_${crypto.randomUUID()}_tool`,
        sessionId: ctx.sessionId,
        // OpenAI-compatible tool_calls passthrough — replace with your
        // own protocol shape (custom marker / XML / NL classification)
        // if you don't speak OpenAI tool-call JSON.
        toolCalls: [
          { id: 'call_0', type: 'function', function: { name: parseToolName(text), arguments: '{}' } },
        ],
        contactName: ctx.contactName,
        // SW can include arbitrary client routing state in metadata.
        metadata: { iteration: ctx.iteration, messages: ctx.messages },
      })],
    };
  }

  // ─── (B) Internal reflection: another LLM round without pushing ────
  //
  // Useful for "let me think again" cycles where the worker's
  // subrequest budget can absorb the extra round-trip. If your hook
  // itself does HTTP I/O each round, prefer the client-mediated
  // /continue path so each invocation resets its 50-subrequest budget.
  if (text.startsWith('REFLECT_AGAIN')) {
    return {
      decision: 'continue',
      // Default-safe pattern — keep the just-appended assistant turn
      // in scope, then add whatever feedback should re-trigger the LLM.
      nextHistory: [
        ...ctx.messages,
        { role: 'user', content: 'Refine the previous answer.' },
      ],
    };
  }

  // ─── (C) Plain answer: deliver and finish ──────────────────────────
  //
  // The hook returns a ContentPush (from @rei-standard/amsg-shared) so
  // the SW can dispatch on `messageKind === 'content'`. Build your own
  // free-form pushPayload object if you don't want shared types — the
  // hook contract is `pushPayload: unknown`.
  return {
    decision: 'finish',
    pushPayloads: [buildContentPush({
      messageType: 'instant',
      source: 'instant',
      messageId: `msg_${crypto.randomUUID()}_content_0`,
      sessionId: ctx.sessionId,
      message: text,
      title: `来自 ${ctx.contactName}`,
      contactName: ctx.contactName,
      avatarUrl: ctx.avatarUrl ?? null,
      messageIndex: 1,
      totalMessages: 1,
      taskId: null,
    })],
  };
}

function parseToolName(text) {
  const m = text.match(/NEED_TOOL\s+(\S+)/);
  return m ? m[1] : 'unknown';
}
