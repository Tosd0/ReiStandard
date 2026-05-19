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

import { createInstantHandler, buildInstantPushPayload } from '@rei-standard/amsg-instant';
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
      pushPayload: {
        type: 'tool-request',
        sessionId: ctx.sessionId,
        iteration: ctx.iteration,
        // Pass enough state for the SW to re-POST /continue
        messages: ctx.messages,
        tool: parseToolName(text),
        // Anything else the SW needs — keep it JSON-safe.
      },
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
  // The 13-field v0.6 default push payload still works fine — call
  // `buildInstantPushPayload` if you want it. Or build your own; the
  // SW is yours.
  return {
    decision: 'finish',
    pushPayload: buildInstantPushPayload({
      message: text,
      index: 0,
      total: 1,
      contactName: ctx.contactName,
      avatarUrl: ctx.avatarUrl ?? null,
    }),
  };
}

function parseToolName(text) {
  const m = text.match(/NEED_TOOL\s+(\S+)/);
  return m ? m[1] : 'unknown';
}
