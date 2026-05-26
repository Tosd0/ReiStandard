# amsg-instant 0.8.0-next.4 — `pushPayloads`-only hook decision API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `decision.pushPayload` (singular) + lib-side `splitHookPushPayload` auto-split with `decision.pushPayloads: PushPayload[]` (plural) where the hook returns the exact N pushes it wants the lib to send, and the lib does zero splitting.

**Architecture:** The lib drops every split helper (`splitHookPushPayload`, `splitMessageIntoSentences`, `splitOnceByRegex`, `pickSplitConfig`, `validateSplitPattern`, `validatePerKindSplitPatterns`, `DEFAULT_SPLIT_REGEX`, `SPLIT_PATTERN_MAX_*`). `runAgenticLoop` calls a new `sendPushesSequentially(pushPayloads, payload, ctx, sessionId, sleep)` that runs `for (const push of pushPayloads) await sendPushWithMaybeBlob(...)` with 1500ms gaps. Reasoning auto-emit shifts to a simpler one-shot path (no Layer-1 split; Layer-2 byte chunking via `chunkReasoningByUtf8Bytes` stays). Validation rejects the legacy fields with `HookError` so pre-release callers see the migration line immediately. The legacy v0.6 path is the *only* place `splitMessageIntoSentences` survives, because that path turns raw LLM text into N pushes itself (no hook involved); that helper stays inlined inside `runLegacyInstant` and is no longer exported.

**Tech Stack:** Node.js (≥18) ESM, `node --test` runner, `tsup` bundler, `@rei-standard/amsg-shared` v0.1.0-next.3 push builders.

---

## File map

**Modify:**
- `packages/rei-standard-amsg/instant/src/message-processor.js` — tear out split helpers; rewrite `runAgenticLoop`'s finish/tool-request branch around `pushPayloads`; rewrite reasoning auto-emit to drop Layer-1 split; rewrite LOOP_EXCEEDED diagnostic to single-shot.
- `packages/rei-standard-amsg/instant/src/validation.js` — drop `validateSplitPattern` + `validatePerKindSplitPatterns`; reject request-body `splitPattern` / `reasoningSplitPattern` / `errorSplitPattern` with the migration message.
- `packages/rei-standard-amsg/instant/src/index.js` — drop the `splitMessageIntoSentences` re-export; refresh `InstantHandlerOptions` JSDoc; refresh `onLLMOutput` JSDoc.
- `packages/rei-standard-amsg/instant/test/agentic-loop.test.mjs` — migrate existing tests from `pushPayload` to `pushPayloads: [push]`.
- `packages/rei-standard-amsg/instant/test/handler.test.mjs` — drop the `splitPattern` validation/`splitMessageIntoSentences` blocks (move what's salvageable into the legacy path coverage).
- `packages/rei-standard-amsg/instant/test/e2e.test.mjs` — migrate hook returns to `pushPayloads`.
- `packages/rei-standard-amsg/instant/test/reasoning-push.test.mjs` — migrate hook returns to `pushPayloads`; drop any expectation that the reasoning path runs through `splitHookPushPayload`.
- `packages/rei-standard-amsg/instant/README.md` — rewrite the Hook section, delete the splitPattern subsections.
- `packages/rei-standard-amsg/instant/CHANGELOG.md` — prepend the `0.8.0-next.4 — BREAKING` entry.
- `packages/rei-standard-amsg/instant/package.json` — bump version to `0.8.0-next.4`.
- `packages/rei-standard-amsg/instant/examples/agentic-loop-skeleton/worker.js` — convert `pushPayload` → `pushPayloads: [push]`.

**Delete:**
- `packages/rei-standard-amsg/instant/test/split-pattern-hook.test.mjs` — entire suite is meaningless once the lib stops splitting.

**Create:**
- `packages/rei-standard-amsg/instant/test/pushpayloads-array.test.mjs` — the 13-case matrix from spec §测试要求.
- `packages/rei-standard-amsg/instant/docs/migration-0.8.0-next.4.md` — long-form migration guide (linked from the CHANGELOG entry).

---

## Background facts an executor needs

1. **Worktree location:** All file paths in this plan are relative to `/Users/tntobsidian/Documents/GitHub/ReiStandard/.worktrees/push-schema/`. The branch is `feature/push-schema-unification-0.8`.
2. **Current version on this branch:** `0.8.0-next.3` (see `packages/rei-standard-amsg/instant/package.json:3`). Target version: `0.8.0-next.4`.
3. **Legacy path is unaffected.** `runLegacyInstant` is the no-hook v0.6 compat path. It still calls `splitMessageIntoSentences` on raw LLM text — that is *not* the hook path's `splitHookPushPayload`. Keep `splitMessageIntoSentences` inlined inside `message-processor.js` (it's still needed for `runLegacyInstant`) but do NOT export it from `src/index.js` anymore (the only public consumer was hook authors who now have no use for it).
4. **HookError signature:** `new HookError(message, { cause? })`. The handler maps `instanceof HookError` to HTTP 500 with `error.code = 'HOOK_THREW'`. This is the right error class for any spec-§校验规则 violation.
5. **`sendPushWithMaybeBlob` already does per-push blob fallback.** Do not duplicate that logic — just call it in a loop.
6. **`SLEEP_BETWEEN_MESSAGES_MS = 1500` constant** lives at the top of `message-processor.js`. Reuse it; do not introduce a new spacing constant.
7. **`extractAssistantMessage` and `buildSessionContext`** are imported from `./session-context.js` — keep them.
8. **`readReasoningContent`** is exported from `message-processor.js` — keep it.
9. **Builders re-exported from `@rei-standard/amsg-shared`** (`buildContentPush`, `buildReasoningPush`, `buildErrorPush`, `chunkReasoningByUtf8Bytes`) are imported on line 18 of `message-processor.js`. The new reasoning path needs only `buildReasoningPush` + `chunkReasoningByUtf8Bytes`.
10. **Test runner:** `node --test test/*.test.mjs` from `packages/rei-standard-amsg/instant/`. No mocha/jest — pure node:test + node:assert/strict. Tests use `helpers.mjs` for VAPID/subscription setup + `createFetchRouter` for fetch interception + `decryptCapturedPushBody` for round-trip verification.

---

## Task 1: Add the validation fences (split-pattern fields + pushPayload-singular)

This goes first because it lets later tasks assume the hot-path code never sees the legacy fields. Pure rejection logic — no behaviour migration yet.

**Files:**
- Modify: `packages/rei-standard-amsg/instant/src/validation.js` (drop `validateSplitPattern` + `validatePerKindSplitPatterns`, add rejection in both `validateInstantPayload` and `validateContinuePayload`)
- Modify: `packages/rei-standard-amsg/instant/src/index.js` (drop the `splitMessageIntoSentences` re-export at line ~614)

- [ ] **Step 1: Write a failing test for request-level `splitPattern` rejection**

Append to `packages/rei-standard-amsg/instant/test/handler.test.mjs` (above the existing `validateInstantPayload` describe block is fine):

```javascript
describe('next.4 — split-pattern fields removed', () => {
  it('rejects request body splitPattern with INVALID_PAYLOAD_FORMAT', () => {
    const r = validateInstantPayload(makeValidPayload({ splitPattern: '([。！？!?]+)' }));
    assert.equal(r.valid, false);
    assert.equal(r.errorCode, 'INVALID_PAYLOAD_FORMAT');
    assert.match(r.errorMessage, /splitPattern is removed in next\.4/);
  });
  it('rejects request body reasoningSplitPattern', () => {
    const r = validateInstantPayload(makeValidPayload({ reasoningSplitPattern: '([。！？!?]+)' }));
    assert.equal(r.valid, false);
    assert.match(r.errorMessage, /reasoningSplitPattern is removed in next\.4/);
  });
  it('rejects request body errorSplitPattern', () => {
    const r = validateInstantPayload(makeValidPayload({ errorSplitPattern: '([。！？!?]+)' }));
    assert.equal(r.valid, false);
    assert.match(r.errorMessage, /errorSplitPattern is removed in next\.4/);
  });
});
```

- [ ] **Step 2: Run the test, expect failures**

Run: `cd packages/rei-standard-amsg/instant && node --test test/handler.test.mjs`
Expected: 3 new failures complaining the payload was accepted.

- [ ] **Step 3: Drop `validateSplitPattern` + `validatePerKindSplitPatterns` and replace with rejection**

In `src/validation.js`:

1. Delete the const block (`SPLIT_PATTERN_MAX_LENGTH` / `SPLIT_PATTERN_MAX_ITEMS`) at lines 50–51.
2. Delete `export function validateSplitPattern(value)` at lines 53–87.
3. Delete `function validatePerKindSplitPatterns(payload)` at lines 468–486.
4. Replace the two call sites (`const splitErr = validatePerKindSplitPatterns(payload); if (splitErr) return splitErr;`) inside `validateInstantPayload` (line 316) and `validateContinuePayload` (line 454) with this rejection block:

```javascript
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
```

- [ ] **Step 4: Run the test again, expect pass**

Run: `cd packages/rei-standard-amsg/instant && node --test test/handler.test.mjs`
Expected: the 3 new cases pass. Existing tests that USE `splitPattern` will now fail (handler.test.mjs has a whole `splitPattern (0.6.0)` block from line ~172). That's expected — we'll fix them in Task 5 / by deletion. Note them but do not touch them this task.

- [ ] **Step 5: Drop the `splitMessageIntoSentences` export from `src/index.js`**

In `packages/rei-standard-amsg/instant/src/index.js`, edit the re-export block (lines 613–619):

```javascript
// BEFORE
export {
  splitMessageIntoSentences,
  processInstantMessage,
  normalizeAiApiUrl,
  sendPushWithMaybeBlob,
  readReasoningContent,
} from './message-processor.js';

// AFTER
export {
  processInstantMessage,
  normalizeAiApiUrl,
  sendPushWithMaybeBlob,
  readReasoningContent,
} from './message-processor.js';
```

Don't delete the function from `message-processor.js` yet — `runLegacyInstant` still calls it internally. Just stop exposing it. (Step 5 only changes one line; it's batched with the other rejection work because it's the same conceptual change: the public split-related API is gone.)

- [ ] **Step 6: Run the full instant suite — expect many failures, ALL in tests that explicitly touch splitPattern**

Run: `cd packages/rei-standard-amsg/instant && node --test test/*.test.mjs 2>&1 | head -80`
Expected: failures concentrated in `test/split-pattern-hook.test.mjs` (entire file), `test/handler.test.mjs` (the splitPattern block + `describe('splitMessageIntoSentences', ...)`), and any reasoning/handler test using `reasoningSplitPattern`. The agentic loop / pushPayload / blob tests should still pass.

If unrelated tests fail, stop and investigate — the validation rejection should not have broken anything else.

- [ ] **Step 7: Commit**

```bash
git add packages/rei-standard-amsg/instant/src/validation.js packages/rei-standard-amsg/instant/src/index.js packages/rei-standard-amsg/instant/test/handler.test.mjs
git commit -m "$(cat <<'EOF'
feat(amsg-instant)!: 0.8.0-next.4 — reject removed split-pattern fields

Request body fields `splitPattern` / `reasoningSplitPattern` /
`errorSplitPattern` are now rejected with INVALID_PAYLOAD_FORMAT and a
migration hint pointing at `decision.pushPayloads`. Removes
`validateSplitPattern` / `validatePerKindSplitPatterns` from validation
and stops re-exporting `splitMessageIntoSentences` (legacy path still
uses it internally; hook authors don't get it back).

Breaking on purpose — next.4 is pre-release; we're consolidating two
overlapping mechanisms (lib-side splitPattern auto-split + hook-side
pushPayload) into one (pushPayloads array) before 1.0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add the validation fences for `pushPayload` (singular) + per-push `splitPattern`

Same pattern, but inside `assertValidDecision` in `message-processor.js`, since the hook decision is validated at runtime, not at request parse time.

**Files:**
- Modify: `packages/rei-standard-amsg/instant/src/message-processor.js` (rewrite `assertValidDecision`)
- Modify: `packages/rei-standard-amsg/instant/test/agentic-loop.test.mjs` (write failing tests for the new contract)

- [ ] **Step 1: Write failing tests**

Append to `test/agentic-loop.test.mjs` (or any agentic-loop test file — pick `agentic-loop.test.mjs` so they sit next to existing decision tests):

```javascript
describe('next.4 — decision contract: pushPayloads', () => {
  async function dispatchHookReturn(hookReturn) {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('llm answer'),
    });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: () => hookReturn,
    });
    const res = await handler(makeRequest('http://h/instant', basePayload()));
    return { res, body: await res.json(), router };
  }

  it('rejects singular pushPayload field with HookError + migration message', async () => {
    const { res, body } = await dispatchHookReturn({
      decision: 'finish',
      pushPayload: { messageKind: 'content', message: 'hi' },
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /pushPayload \(singular\) is removed in next\.4, use pushPayloads: \[yourPayload\]/);
  });

  it('rejects when BOTH pushPayload and pushPayloads are set', async () => {
    const { res, body } = await dispatchHookReturn({
      decision: 'finish',
      pushPayload: { messageKind: 'content', message: 'a' },
      pushPayloads: [{ messageKind: 'content', message: 'b' }],
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /pushPayload \(singular\) is removed in next\.4, use pushPayloads/);
  });

  it('rejects pushPayloads: [] (empty array)', async () => {
    const { res, body } = await dispatchHookReturn({
      decision: 'finish',
      pushPayloads: [],
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /use decision: skip-push to skip notification entirely/);
  });

  it('rejects a push that carries splitPattern', async () => {
    const { res, body } = await dispatchHookReturn({
      decision: 'finish',
      pushPayloads: [{ messageKind: 'content', message: 'hi', splitPattern: '([。！？!?]+)' }],
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /splitPattern is removed in next\.4/);
  });
});
```

- [ ] **Step 2: Run the test, expect failures**

Run: `cd packages/rei-standard-amsg/instant && node --test test/agentic-loop.test.mjs 2>&1 | tail -30`
Expected: 4 failures — calls succeed instead of throwing HookError.

- [ ] **Step 3: Rewrite `assertValidDecision` in `src/message-processor.js`**

Replace the existing function (lines 1035–1050) with:

```javascript
function assertValidDecision(decision) {
  if (!decision || typeof decision !== 'object') {
    throw new TypeError(`onLLMOutput returned invalid decision: ${stringifyForError(decision)}`);
  }
  const tag = /** @type {{ decision?: unknown }} */ (decision).decision;
  if (typeof tag !== 'string' || !VALID_DECISIONS.has(tag)) {
    throw new TypeError(`onLLMOutput returned invalid decision tag: ${stringifyForError(tag)}`);
  }

  const hasSingular = Object.prototype.hasOwnProperty.call(decision, 'pushPayload');
  const hasPlural = Object.prototype.hasOwnProperty.call(decision, 'pushPayloads');

  if (hasSingular) {
    throw new TypeError(
      hasPlural
        ? 'pushPayload (singular) is removed in next.4, use pushPayloads'
        : 'pushPayload (singular) is removed in next.4, use pushPayloads: [yourPayload]'
    );
  }

  if (tag === 'continue') {
    if (!Array.isArray(/** @type {{ nextHistory?: unknown }} */ (decision).nextHistory)) {
      throw new TypeError('decision:"continue" requires a nextHistory array');
    }
    return;
  }

  if (tag === 'skip-push') {
    return;
  }

  // 'finish' / 'tool-request' — both need pushPayloads array
  if (!hasPlural || !Array.isArray(/** @type {{ pushPayloads?: unknown }} */ (decision).pushPayloads)) {
    throw new TypeError(`decision:"${tag}" requires a pushPayloads array`);
  }
  const pushes = /** @type {Array<unknown>} */ (decision.pushPayloads);
  if (pushes.length === 0) {
    throw new TypeError('pushPayloads: [] — use decision: skip-push to skip notification entirely');
  }
  for (let i = 0; i < pushes.length; i++) {
    const p = pushes[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new TypeError(`pushPayloads[${i}] must be a plain object, got ${stringifyForError(p)}`);
    }
    if (Object.prototype.hasOwnProperty.call(p, 'splitPattern')) {
      throw new TypeError(`pushPayloads[${i}].splitPattern is removed in next.4; caller is responsible for splitting`);
    }
  }
}
```

Note: `assertValidDecision` throws `TypeError`; `runAgenticLoop`'s catch block already maps any throw from this function to `new HookError(...)` (see lines 938–960 in current code). So the error class wrapping is handled — we just throw with the right message.

- [ ] **Step 4: Run the failing tests, expect pass**

Run: `cd packages/rei-standard-amsg/instant && node --test test/agentic-loop.test.mjs 2>&1 | tail -30`
Expected: the 4 new cases pass. The other agentic-loop tests still fail because they pass `pushPayload` (singular) — Task 3 fixes those.

- [ ] **Step 5: Commit**

```bash
git add packages/rei-standard-amsg/instant/src/message-processor.js packages/rei-standard-amsg/instant/test/agentic-loop.test.mjs
git commit -m "$(cat <<'EOF'
feat(amsg-instant)!: 0.8.0-next.4 — reject decision.pushPayload + pushPayloads:[]

assertValidDecision now requires `pushPayloads: [...]` on `finish` /
`tool-request` decisions. The singular `pushPayload` field is rejected
with a migration line. Empty `pushPayloads: []` is rejected and points
the caller at `decision: 'skip-push'`. Per-push `splitPattern` is also
rejected.

These cases all route through the existing HOOK_THREW pipeline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rewrite finish/tool-request delivery to consume `pushPayloads`

Now that the contract is locked, swap the lib's delivery code to read the array. Strip `splitHookPushPayload`, `pickSplitConfig`, `sendChunkedPush` — they no longer have a reason to exist.

**Files:**
- Modify: `packages/rei-standard-amsg/instant/src/message-processor.js` (replace the finish/tool-request branch in `runAgenticLoop`)

- [ ] **Step 1: Write the failing happy-path test**

Append to `test/agentic-loop.test.mjs`:

```javascript
describe('next.4 — pushPayloads happy paths', () => {
  it('sends N pushes from a 3-element pushPayloads array with messageIndex/totalMessages auto-fill', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('whatever'),
    });
    const sleeps = [];
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      autoEmitReasoning: false,
      onLLMOutput: () => ({
        decision: 'finish',
        pushPayloads: [
          { messageKind: 'content', message: 'first' },
          { messageKind: 'content', message: 'second' },
          { messageKind: 'content', message: 'third' },
        ],
      }),
    });
    // Drive through processInstantMessage directly so we can inject sleep
    // and avoid the 3×1500ms wall-clock wait.
    const result = await processInstantMessage(basePayload(), {
      vapid,
      fetch: router.fetch,
      sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
      onLLMOutput: () => ({
        decision: 'finish',
        pushPayloads: [
          { messageKind: 'content', message: 'first' },
          { messageKind: 'content', message: 'second' },
          { messageKind: 'content', message: 'third' },
        ],
      }),
      autoEmitReasoning: false,
      requestUrl: 'http://localhost/instant',
    });
    assert.equal(result.status, 'finished');
    assert.equal(router.pushCalls.length, 3);
    const decoded = [];
    for (const c of router.pushCalls) decoded.push(JSON.parse(await decryptCapturedPushBody(c.body, subKit)));
    assert.deepEqual(decoded.map(p => p.message), ['first', 'second', 'third']);
    assert.deepEqual(decoded.map(p => p.messageIndex), [1, 2, 3]);
    assert.deepEqual(decoded.map(p => p.totalMessages), [3, 3, 3]);
    // sleeps: 1500 between push 1↔2 and 2↔3
    assert.deepEqual(sleeps, [1500, 1500]);
  });

  it('preserves hook-set messageId, overwrites caller-set messageIndex/totalMessages', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('whatever'),
    });
    await processInstantMessage(basePayload(), {
      vapid,
      fetch: router.fetch,
      sleep: () => Promise.resolve(),
      onLLMOutput: () => ({
        decision: 'finish',
        pushPayloads: [
          { messageKind: 'content', message: 'a', messageId: 'custom-id-1', messageIndex: 99, totalMessages: 99 },
          { messageKind: 'content', message: 'b' },
        ],
      }),
      autoEmitReasoning: false,
      requestUrl: 'http://localhost/instant',
    });
    const decoded = [];
    for (const c of router.pushCalls) decoded.push(JSON.parse(await decryptCapturedPushBody(c.body, subKit)));
    assert.equal(decoded[0].messageId, 'custom-id-1', 'caller messageId kept');
    assert.notEqual(decoded[1].messageId, decoded[0].messageId, 'auto messageId distinct');
    assert.equal(decoded[0].messageIndex, 1, 'lib overwrites caller messageIndex');
    assert.equal(decoded[0].totalMessages, 2, 'lib overwrites caller totalMessages');
    assert.equal(decoded[1].messageIndex, 2);
    assert.equal(decoded[1].totalMessages, 2);
  });

  it('mid-array push failure aborts remaining pushes, no final_pushed event', async () => {
    let pushIdx = 0;
    const events = [];
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('whatever'),
      pushHandler: () => {
        pushIdx++;
        if (pushIdx === 2) {
          return { ok: false, status: 502, statusText: 'Bad Gateway', async text() { return 'fail'; } };
        }
        return { ok: true, status: 201, async text() { return ''; } };
      },
    });
    let caught;
    try {
      await processInstantMessage(basePayload(), {
        vapid,
        fetch: router.fetch,
        sleep: () => Promise.resolve(),
        onEvent: (e) => events.push(e),
        onLLMOutput: () => ({
          decision: 'finish',
          pushPayloads: [
            { messageKind: 'content', message: 'one' },
            { messageKind: 'content', message: 'two' },
            { messageKind: 'content', message: 'three' },
          ],
        }),
        autoEmitReasoning: false,
        requestUrl: 'http://localhost/instant',
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'mid-array failure should propagate');
    assert.equal(pushIdx, 2, 'second push attempted, third skipped');
    assert.equal(events.some(e => e.type === 'final_pushed'), false, 'no final_pushed on partial delivery');
  });
});
```

Note: this test uses a `pushHandler` knob on `createFetchRouter` that may not exist. Check `test/helpers.mjs` first; if the helper only intercepts and always returns 201, extend it (this is a one-line addition) before the test runs. The point of this step is to surface that requirement, so:

  1. Read `test/helpers.mjs` (~200 lines).
  2. If `createFetchRouter` only supports a single static push response, add a `pushHandler` option that defaults to the current behaviour and replaces the response when provided.
  3. Re-run the tests.

- [ ] **Step 2: Run, expect failures**

Run: `cd packages/rei-standard-amsg/instant && node --test test/agentic-loop.test.mjs 2>&1 | tail -40`
Expected: 3 failures — the new tests can't run because `runAgenticLoop` still expects `decision.pushPayload`.

- [ ] **Step 3: Rip out the split machinery from `src/message-processor.js`**

Delete these functions / consts (current line ranges):
- `DEFAULT_SPLIT_REGEX` (line 49)
- `splitOnceByRegex` (lines 51–65)
- `splitMessageIntoSentences` — **keep** the function but make it module-internal: change `export function splitMessageIntoSentences` to `function splitMessageIntoSentences` (line 89). It's still called by `runLegacyInstant` at line 783.
- `pickSplitConfig` (lines 107–186)
- `splitHookPushPayload` (lines 188–312)
- `sendChunkedPush` (lines 314–340)
- The `import { validateSplitPattern }` from validation (line 29) — already gone in Task 1; remove this import line.

- [ ] **Step 4: Rewrite the finish/tool-request branch of `runAgenticLoop`**

Replace the block at lines 977–999 (current code: `const isReasoning = ...; const messagesSent = isReasoning ? emitReasoning(...) : sendChunkedPush(...);`) with:

```javascript
    // 'finish' or 'tool-request' — deliver pushPayloads sequentially.
    // The lib does no splitting; the hook returned the exact N pushes.
    const messagesSent = await sendPushesSequentially(
      decision.pushPayloads,
      payload,
      ctx,
      sessionId,
      sleep,
    );
    onEvent({
      type: decision.decision === 'finish' ? 'final_pushed' : 'tool_request_pushed',
      sessionId,
      iteration,
      messagesSent,
    });
    return { status: decision.decision === 'finish' ? 'finished' : 'tool_requested', sessionId, iteration };
```

Then add `sendPushesSequentially` somewhere below `runAgenticLoop` (before `assertValidDecision`):

```javascript
/**
 * Deliver `pushPayloads` sequentially via `sendPushWithMaybeBlob`,
 * spacing 1500ms between consecutive pushes. Auto-fills:
 *   - `messageId`        — only when the hook didn't set one
 *   - `messageIndex`     — always overwritten (1-based)
 *   - `totalMessages`    — always overwritten
 *
 * Throws on the first failed push; subsequent pushes are not attempted.
 *
 * @param {Array<Record<string, unknown>>} pushPayloads
 * @param {Record<string, unknown>} payload
 * @param {Object} ctx
 * @param {string} sessionId
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<number>}
 */
async function sendPushesSequentially(pushPayloads, payload, ctx, sessionId, sleep) {
  const total = pushPayloads.length;
  for (let i = 0; i < total; i++) {
    const push = pushPayloads[i];
    // Auto-fill — see header doc. `messageId` is preserved when caller set it.
    if (push.messageId === undefined) {
      push.messageId = `msg_${randomUUID()}_chunk_${i}`;
    }
    push.messageIndex = i + 1;
    push.totalMessages = total;
    await sendPushWithMaybeBlob(push, payload, ctx, sessionId);
    if (i < total - 1) {
      await sleep(SLEEP_BETWEEN_MESSAGES_MS);
    }
  }
  return total;
}
```

- [ ] **Step 5: Rewrite the LOOP_EXCEEDED diagnostic**

Find the loop_exceeded block at lines 1002–1023. Replace `await sendChunkedPush(diagnostic, payload, ctx, sessionId, sleep);` with a single-shot call:

```javascript
    await sendPushWithMaybeBlob(diagnostic, payload, ctx, sessionId);
```

The diagnostic is one push by construction (it's a single `buildErrorPush(...)`), so no looping is needed.

- [ ] **Step 6: Run the happy-path tests, expect pass**

Run: `cd packages/rei-standard-amsg/instant && node --test test/agentic-loop.test.mjs 2>&1 | tail -40`
Expected: the 3 new tests pass. Other previously-passing tests that use `pushPayload` (singular) all fail — that's expected. They get migrated in Task 5.

- [ ] **Step 7: Commit**

```bash
git add packages/rei-standard-amsg/instant/src/message-processor.js packages/rei-standard-amsg/instant/test/agentic-loop.test.mjs packages/rei-standard-amsg/instant/test/helpers.mjs
git commit -m "$(cat <<'EOF'
feat(amsg-instant)!: 0.8.0-next.4 — sendPushesSequentially(pushPayloads)

Hook's finish/tool-request decisions now read `pushPayloads: PushPayload[]`
and the lib delivers exactly that array in order with 1500ms spacing.
Per-push: `messageId` is auto-filled when the hook didn't set one;
`messageIndex` / `totalMessages` are always overwritten with the
array-derived values.

Removed: splitHookPushPayload, sendChunkedPush, splitOnceByRegex,
DEFAULT_SPLIT_REGEX, pickSplitConfig. `splitMessageIntoSentences` is
still used internally by `runLegacyInstant`; no longer exported.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Simplify the reasoning auto-emit path

Reasoning Layer-1 sentence split is gone (it used `splitHookPushPayload`); Layer-2 byte chunking stays. The auto-emit becomes: `buildReasoningPush(...)` → if `reasoningContent` exceeds `reasoningChunkBytes`, slice into N chunks and ship each with `chunkIndex` / `totalChunks`; otherwise ship as one.

**Files:**
- Modify: `packages/rei-standard-amsg/instant/src/message-processor.js` (replace `expandReasoningPushChunks` + `emitReasoning`)

- [ ] **Step 1: Write the failing tests**

Add to `test/reasoning-push.test.mjs`:

```javascript
describe('next.4 — reasoning byte-chunking simplified', () => {
  it('short reasoning ships as a single push (no chunkIndex on wire)', async () => {
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('hi.', { reasoning_content: 'short thought' }),
    });
    const handler = createInstantHandler({ vapid, fetch: router.fetch });
    await handler(makeRequest(basePayload()));
    const decoded = await decryptAll(router.pushCalls);
    const r = decoded.find(p => p.messageKind === 'reasoning');
    assert.ok(r);
    assert.equal('chunkIndex' in r, false);
    assert.equal('totalChunks' in r, false);
    assert.equal('messageIndex' in r, false, 'no Layer-1 split → no messageIndex');
  });

  it('oversized reasoning gets byte-chunked into N pushes with chunkIndex/totalChunks', async () => {
    const big = 'x'.repeat(5500); // > default 2000 B threshold
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('hi.', { reasoning_content: big }),
    });
    const events = [];
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onEvent: (e) => events.push(e),
    });
    await handler(makeRequest(basePayload()));
    const decoded = await decryptAll(router.pushCalls);
    const reasoning = decoded.filter(p => p.messageKind === 'reasoning');
    assert.ok(reasoning.length >= 3, 'expected >= 3 chunks for 5500B reasoning at 2000B threshold');
    for (let i = 0; i < reasoning.length; i++) {
      assert.equal(reasoning[i].chunkIndex, i + 1);
      assert.equal(reasoning[i].totalChunks, reasoning.length);
    }
    // Reassembling yields the original
    const reassembled = reasoning.map(p => p.reasoningContent).join('');
    assert.equal(reassembled, big);
    // reasoning_chunked event fires exactly once
    const chunkedEvts = events.filter(e => e.type === 'reasoning_chunked');
    assert.equal(chunkedEvts.length, 1);
    assert.equal(chunkedEvts[0].totalChunks, reasoning.length);
  });
});
```

- [ ] **Step 2: Run, expect failures (or pass — depends on whether old code still works without splitPattern)**

Run: `cd packages/rei-standard-amsg/instant && node --test test/reasoning-push.test.mjs 2>&1 | tail -30`
Expected: new tests likely fail because `expandReasoningPushChunks` still calls the now-deleted `splitHookPushPayload`. (Task 3 likely already broke this file — that's fine, we're about to rewrite it.)

- [ ] **Step 3: Rewrite `expandReasoningPushChunks` and `emitReasoning`**

Replace the entire block (lines 342–482) with:

```javascript
// ─── Reasoning byte chunking ────────────────────────────────────────────

const SLEEP_BETWEEN_REASONING_CHUNKS_MS = 100;
const DEFAULT_REASONING_CHUNK_BYTES = 2000;

/**
 * Slice a ReasoningPush into one or more byte-bounded pushes. When
 * `reasoningContent` UTF-8 length exceeds `reasoningChunkBytes`, the
 * lib chunks at UTF-8 codepoint boundaries via
 * `chunkReasoningByUtf8Bytes` and ships each chunk as its own push
 * with `chunkIndex` / `totalChunks`. Otherwise ships as one.
 *
 * `null` for `reasoningChunkBytes` disables chunking entirely —
 * oversized reasoning then either flows through `sendPushWithMaybeBlob`
 * (and BlobStore) or throws `PayloadTooLargeError`.
 *
 * @param {Object} reasoningPush
 * @param {number | null | undefined} reasoningChunkBytes
 * @param {number | undefined} iteration
 * @returns {Array<Object>}
 */
function sliceReasoningPush(reasoningPush, reasoningChunkBytes, iteration) {
  if (reasoningChunkBytes === null) return [reasoningPush];
  const threshold = (Number.isInteger(reasoningChunkBytes) && reasoningChunkBytes >= 4)
    ? reasoningChunkBytes
    : DEFAULT_REASONING_CHUNK_BYTES;

  const text = typeof reasoningPush.reasoningContent === 'string'
    ? reasoningPush.reasoningContent
    : '';
  if (!text) return [reasoningPush];

  const byteLen = PUSH_PAYLOAD_BYTE_ENCODER.encode(text).byteLength;
  if (byteLen <= threshold) return [reasoningPush];

  const pieces = chunkReasoningByUtf8Bytes(text, threshold);
  const totalChunks = pieces.length;
  const iterTag = Number.isInteger(iteration) ? iteration : 0;
  return pieces.map((piece, i) => ({
    ...reasoningPush,
    messageId: `msg_${randomUUID()}_iter_${iterTag}_reasoning_chunk_${i + 1}`,
    reasoningContent: piece,
    chunkIndex: i + 1,
    totalChunks,
  }));
}

/**
 * Ship a ReasoningPush, byte-chunking if oversized. Fires a single
 * `reasoning_chunked` event when chunking actually splits the push.
 *
 * @param {Object} reasoningPush
 * @param {Object} payload
 * @param {Object} ctx
 * @param {string} sessionId
 * @param {(ms: number) => Promise<void>} sleep
 * @param {number | undefined} iteration
 * @returns {Promise<number>}
 */
async function emitReasoning(reasoningPush, payload, ctx, sessionId, sleep, iteration) {
  const leaves = sliceReasoningPush(reasoningPush, ctx.reasoningChunkBytes, iteration);

  if (leaves.length > 1) {
    const onEvent = typeof ctx.onEvent === 'function' ? ctx.onEvent : () => {};
    const totalBytes = typeof reasoningPush.reasoningContent === 'string'
      ? PUSH_PAYLOAD_BYTE_ENCODER.encode(reasoningPush.reasoningContent).byteLength
      : 0;
    const evt = { type: 'reasoning_chunked', sessionId, totalChunks: leaves.length, totalBytes };
    if (Number.isInteger(iteration)) evt.iteration = iteration;
    onEvent(evt);
  }

  for (let i = 0; i < leaves.length; i++) {
    await sendPushWithMaybeBlob(leaves[i], payload, ctx, sessionId);
    if (i < leaves.length - 1) {
      await sleep(SLEEP_BETWEEN_REASONING_CHUNKS_MS);
    }
  }
  return leaves.length;
}
```

Note that `emitReasoning` is still called from two places: `runLegacyInstant` (around line 767) and `runAgenticLoop`'s `autoEmitReasoning` block (around line 912). Neither call site needs to change — the function signature is unchanged.

- [ ] **Step 4: Run reasoning tests, expect pass**

Run: `cd packages/rei-standard-amsg/instant && node --test test/reasoning-push.test.mjs 2>&1 | tail -30`
Expected: both new tests pass. Most existing reasoning tests should also pass (they don't depend on Layer-1 split — that was an opt-in feature). Any that explicitly tested `reasoningSplitPattern` are dead and need migration in Task 6 (or deletion).

- [ ] **Step 5: Commit**

```bash
git add packages/rei-standard-amsg/instant/src/message-processor.js packages/rei-standard-amsg/instant/test/reasoning-push.test.mjs
git commit -m "$(cat <<'EOF'
feat(amsg-instant)!: 0.8.0-next.4 — reasoning auto-emit drops Layer-1 split

emitReasoning is now a single-layer transform: byte chunking via
chunkReasoningByUtf8Bytes when reasoningContent exceeds
ctx.reasoningChunkBytes, single-push passthrough otherwise. The Layer-1
sentence split (reasoningSplitPattern) is gone — callers wanting
sentence-level reasoning chunks should disable autoEmitReasoning and
build the pushes themselves.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Migrate existing hook tests to `pushPayloads`

The agentic loop / e2e / reasoning suites carry `pushPayload: { ... }` returns. Convert each one to `pushPayloads: [...]` (typically 1-element). Don't add new behaviour — this is mechanical migration.

**Files:**
- Modify: `packages/rei-standard-amsg/instant/test/agentic-loop.test.mjs`
- Modify: `packages/rei-standard-amsg/instant/test/e2e.test.mjs`
- Modify: `packages/rei-standard-amsg/instant/test/reasoning-push.test.mjs`
- Modify: `packages/rei-standard-amsg/instant/examples/agentic-loop-skeleton/worker.js`

- [ ] **Step 1: Inventory all `pushPayload:` usages in the test/example files**

Run:
```bash
grep -rn "pushPayload:" packages/rei-standard-amsg/instant/test packages/rei-standard-amsg/instant/examples
```

Expected output: a list of ~15–25 occurrences across the three test files + one in the example. Note each one.

- [ ] **Step 2: Migrate each occurrence mechanically**

For every `pushPayload: { ... }` inside a `return { decision: 'finish'|'tool-request', pushPayload: X }` (or `({ decision: ..., pushPayload: X })` arrow return), replace with `pushPayloads: [X]`. Don't touch the X — its keys / messageKind stay verbatim.

This is a Find/Replace pass per file, but be careful: the regex `pushPayload:` matches both the wrapper key AND any nested property called `pushPayload` (rare but possible). Use Edit per file rather than a sed sweep so you can verify each one in context.

Example diff:

```diff
-    onLLMOutput: () => ({
-      decision: 'finish',
-      pushPayload: { messageKind: 'content', message: 'hi' },
-    }),
+    onLLMOutput: () => ({
+      decision: 'finish',
+      pushPayloads: [{ messageKind: 'content', message: 'hi' }],
+    }),
```

- [ ] **Step 3: Run the full suite**

Run: `cd packages/rei-standard-amsg/instant && node --test test/*.test.mjs 2>&1 | tail -60`
Expected: green except for:
  - `test/split-pattern-hook.test.mjs` (entire suite — deleted in Task 6).
  - `test/handler.test.mjs` — the `splitPattern (0.6.0)` block and the `splitMessageIntoSentences` describe block (deleted in Task 6).

If anything else fails, stop and read the failure. It's likely a test that asserted `messageIndex` / `totalMessages` based on the old "single push" assumption — now those fields ARE auto-filled (1/1), which may surprise older assertions. Adjust the assertion to match.

- [ ] **Step 4: Commit**

```bash
git add packages/rei-standard-amsg/instant/test packages/rei-standard-amsg/instant/examples
git commit -m "$(cat <<'EOF'
test(amsg-instant)!: migrate hook tests to pushPayloads array

Mechanical s/pushPayload:/pushPayloads: [/ on every finish/tool-request
hook return in agentic-loop, e2e, reasoning-push, and the
agentic-loop-skeleton example.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Delete the split-pattern test suite + the split-pattern blocks in handler.test.mjs

`test/split-pattern-hook.test.mjs` is 1659 lines pinning behaviour that no longer exists. Delete it.

`test/handler.test.mjs` has two relevant blocks:
  1. The `splitPattern (0.6.0)` validation block (~lines 172–225).
  2. The `splitMessageIntoSentences` describe block (~lines 288–345) — `splitMessageIntoSentences` is now module-internal, but the legacy path still uses it. The unit tests for it can stay (they import from `src/message-processor.js`)... wait, no — Step 5 of Task 1 already dropped the export. These tests import from `../src/index.js` which no longer re-exports. So they'll fail to import.

So: delete both blocks.

**Files:**
- Delete: `packages/rei-standard-amsg/instant/test/split-pattern-hook.test.mjs`
- Modify: `packages/rei-standard-amsg/instant/test/handler.test.mjs` (drop two blocks + the now-unused import)

- [ ] **Step 1: Delete the split-pattern suite**

```bash
rm packages/rei-standard-amsg/instant/test/split-pattern-hook.test.mjs
```

- [ ] **Step 2: Find the import + block ranges in `handler.test.mjs`**

Read `test/handler.test.mjs` lines 1–20 to find the import. It currently destructures `splitMessageIntoSentences` from `../src/index.js`. Remove it from the destructure (one of multiple imports — leave the others intact).

- [ ] **Step 3: Delete the two blocks**

Remove these two `describe(...)` blocks from `test/handler.test.mjs`:
1. The `splitPattern (0.6.0)` describe / its tests inside the validateInstantPayload block (the spec for those fields is now `next.4 — split-pattern fields removed` which we wrote in Task 1).
2. `describe('splitMessageIntoSentences', ...)` and everything inside it.

Use Edit, not sed — match each block by its `describe('...')` opening + its closing `});`. Verify visually before saving.

- [ ] **Step 4: Run the full suite, expect green**

Run: `cd packages/rei-standard-amsg/instant && node --test test/*.test.mjs 2>&1 | tail -30`
Expected: all tests pass. Specifically, look for the line `# tests <N>` / `# pass <N>` — the pass count should equal the test count.

- [ ] **Step 5: Commit**

```bash
git add packages/rei-standard-amsg/instant/test
git commit -m "$(cat <<'EOF'
test(amsg-instant)!: delete split-pattern suites

split-pattern-hook.test.mjs (1659 lines pinning lib-side hook split
behaviour) is removed wholesale. handler.test.mjs's splitPattern
validation block and splitMessageIntoSentences unit tests are removed
— the public split helper is gone, and request-level field rejection
is covered by the new "split-pattern fields removed" describe.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Write the 13-case `pushpayloads-array.test.mjs` matrix

The spec lists 13 fixtures (§测试要求). Most are covered already by Tasks 2/3 — but Spec asks for a single dedicated file so the contract is auditable.

**Files:**
- Create: `packages/rei-standard-amsg/instant/test/pushpayloads-array.test.mjs`

- [ ] **Step 1: Create the file with the full matrix**

Create `packages/rei-standard-amsg/instant/test/pushpayloads-array.test.mjs`:

```javascript
/**
 * next.4 — pushPayloads-only hook decision API contract matrix.
 *
 * Pins the 13 fixtures from spec §测试要求.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInstantHandler,
  processInstantMessage,
} from '../src/index.js';
import {
  generateTestVapid,
  generateTestSubscription,
  createFetchRouter,
  decryptCapturedPushBody,
  makeLlmResponse,
} from './helpers.mjs';

const LLM_URL = 'https://api.example.com/v1/chat/completions';
let vapid, subKit;
before(async () => { vapid = await generateTestVapid(); subKit = await generateTestSubscription(); });

function basePayload(overrides = {}) {
  return {
    contactName: 'Rei',
    messages: [{ role: 'user', content: 'kick the loop' }],
    apiUrl: LLM_URL,
    apiKey: 'sk-test',
    primaryModel: 'model-x',
    pushSubscription: subKit.subscription,
    sessionId: 'sess-fixture',
    ...overrides,
  };
}

function makeRequest(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function runDirect(hookReturn, ctxOverrides = {}) {
  const router = createFetchRouter({
    pushEndpoint: subKit.subscription.endpoint,
    llm: () => makeLlmResponse('llm-output', ctxOverrides.reasoning ? { reasoning_content: ctxOverrides.reasoning } : undefined),
  });
  const sleeps = [];
  const events = [];
  const result = await processInstantMessage(basePayload(ctxOverrides.payload), {
    vapid,
    fetch: router.fetch,
    sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    onEvent: (e) => events.push(e),
    onLLMOutput: () => hookReturn,
    autoEmitReasoning: ctxOverrides.autoEmitReasoning,
    reasoningChunkBytes: ctxOverrides.reasoningChunkBytes,
    blobStore: ctxOverrides.blobStore,
    requestUrl: 'http://localhost/instant',
  });
  const decoded = [];
  for (const c of router.pushCalls) {
    decoded.push(JSON.parse(await decryptCapturedPushBody(c.body, subKit)));
  }
  return { result, pushes: decoded, sleeps, events, router };
}

async function runHandler(hookReturn, ctxOverrides = {}) {
  const router = createFetchRouter({
    pushEndpoint: subKit.subscription.endpoint,
    llm: () => makeLlmResponse('llm-output'),
  });
  const handler = createInstantHandler({
    vapid,
    fetch: router.fetch,
    autoEmitReasoning: false,
    onLLMOutput: () => hookReturn,
  });
  const res = await handler(makeRequest('http://localhost/instant', basePayload(ctxOverrides.payload)));
  return { res, body: await res.json(), router };
}

// 1) Single-push happy path
describe('1) pushPayloads.length === 1', () => {
  it('single push goes through, messageIndex=1, totalMessages=1, metadata preserved', async () => {
    const { result, pushes, sleeps } = await runDirect({
      decision: 'finish',
      pushPayloads: [{
        messageKind: 'content',
        message: 'hi',
        metadata: { trace: 'x' },
        notification: { title: 'Rei', body: 'hi' },
      }],
    }, { autoEmitReasoning: false });
    assert.equal(result.status, 'finished');
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].message, 'hi');
    assert.equal(pushes[0].messageIndex, 1);
    assert.equal(pushes[0].totalMessages, 1);
    assert.deepEqual(pushes[0].metadata, { trace: 'x' });
    assert.deepEqual(pushes[0].notification, { title: 'Rei', body: 'hi' });
    assert.deepEqual(sleeps, []);
  });
});

// 2) Three-push multi-burst with 1500ms spacing
describe('2) pushPayloads.length === 3', () => {
  it('ships 3 pushes with correct indices + 1500ms spacing', async () => {
    const { pushes, sleeps } = await runDirect({
      decision: 'finish',
      pushPayloads: [
        { messageKind: 'content', message: 'a' },
        { messageKind: 'content', message: 'b' },
        { messageKind: 'content', message: 'c' },
      ],
    }, { autoEmitReasoning: false });
    assert.equal(pushes.length, 3);
    assert.deepEqual(pushes.map(p => p.message), ['a', 'b', 'c']);
    assert.deepEqual(pushes.map(p => p.messageIndex), [1, 2, 3]);
    assert.deepEqual(pushes.map(p => p.totalMessages), [3, 3, 3]);
    assert.deepEqual(sleeps, [1500, 1500]);
  });
});

// 3) Mid-array throw
describe('3) mid-array throw aborts remaining + no final_pushed', () => {
  it('push 2 fails → push 3 never sent, push_failed propagates', async () => {
    let pushIdx = 0;
    const router = createFetchRouter({
      pushEndpoint: subKit.subscription.endpoint,
      llm: () => makeLlmResponse('whatever'),
      pushHandler: () => {
        pushIdx++;
        if (pushIdx === 2) return { ok: false, status: 502, statusText: 'BG', async text() { return ''; } };
        return { ok: true, status: 201, async text() { return ''; } };
      },
    });
    const events = [];
    let caught;
    try {
      await processInstantMessage(basePayload(), {
        vapid,
        fetch: router.fetch,
        sleep: () => Promise.resolve(),
        onEvent: (e) => events.push(e),
        onLLMOutput: () => ({
          decision: 'finish',
          pushPayloads: [
            { messageKind: 'content', message: 'one' },
            { messageKind: 'content', message: 'two' },
            { messageKind: 'content', message: 'three' },
          ],
        }),
        autoEmitReasoning: false,
        requestUrl: 'http://localhost/instant',
      });
    } catch (e) { caught = e; }
    assert.ok(caught);
    assert.equal(pushIdx, 2);
    assert.equal(events.some(e => e.type === 'final_pushed'), false);
  });
});

// 4) Empty array → HookError
describe('4) pushPayloads: [] → HookError', () => {
  it('empty array routed to skip-push hint via HOOK_THREW', async () => {
    const { res, body } = await runHandler({ decision: 'finish', pushPayloads: [] });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /use decision: skip-push to skip notification entirely/);
  });
});

// 5) BOTH pushPayload + pushPayloads → HookError
describe('5) pushPayload + pushPayloads → HookError', () => {
  it('mixing singular and plural keys is rejected', async () => {
    const { res, body } = await runHandler({
      decision: 'finish',
      pushPayload: { messageKind: 'content', message: 'a' },
      pushPayloads: [{ messageKind: 'content', message: 'b' }],
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /use pushPayloads/);
  });
});

// 6) ONLY pushPayload (singular) → HookError with migration hint
describe('6) only pushPayload (singular) → HookError', () => {
  it('migration message tells the caller to wrap in an array', async () => {
    const { res, body } = await runHandler({
      decision: 'finish',
      pushPayload: { messageKind: 'content', message: 'a' },
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /pushPayloads: \[yourPayload\]/);
  });
});

// 7) push.splitPattern → HookError
describe('7) per-push splitPattern → HookError', () => {
  it('rejects splitPattern on individual push', async () => {
    const { res, body } = await runHandler({
      decision: 'finish',
      pushPayloads: [{ messageKind: 'content', message: 'a', splitPattern: '([。！？!?]+)' }],
    });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, 'HOOK_THREW');
    assert.match(body.error.message, /splitPattern is removed in next\.4/);
  });
});

// 8) request body splitPattern → 400 INVALID_PAYLOAD_FORMAT
describe('8) request body splitPattern → 400', () => {
  it('rejected pre-hook with INVALID_PAYLOAD_FORMAT', async () => {
    const router = createFetchRouter({ pushEndpoint: subKit.subscription.endpoint, llm: () => makeLlmResponse('x') });
    const handler = createInstantHandler({
      vapid,
      fetch: router.fetch,
      onLLMOutput: () => ({ decision: 'finish', pushPayloads: [{ messageKind: 'content', message: 'a' }] }),
    });
    const res = await handler(makeRequest('http://localhost/instant', basePayload({ splitPattern: '([。！？!?]+)' })));
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, 'INVALID_PAYLOAD_FORMAT');
    assert.match(body.error.message, /splitPattern is removed in next\.4/);
  });
});

// 9) tool-request decision with all content kinds — lib does not police kind/decision pairing
describe('9) decision: tool-request + all content kinds', () => {
  it('ships every push and returns tool_requested', async () => {
    const { result, pushes } = await runDirect({
      decision: 'tool-request',
      pushPayloads: [
        { messageKind: 'content', message: 'a' },
        { messageKind: 'content', message: 'b' },
      ],
    }, { autoEmitReasoning: false });
    assert.equal(result.status, 'tool_requested');
    assert.equal(pushes.length, 2);
  });
});

// 10) finish decision containing a tool_request kind push — also accepted
describe('10) decision: finish + tool_request kind push', () => {
  it('ships the tool_request push, returns finished', async () => {
    const { result, pushes } = await runDirect({
      decision: 'finish',
      pushPayloads: [
        { messageKind: 'content', message: 'narration' },
        { messageKind: 'tool_request', message: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'x' } }] },
      ],
    }, { autoEmitReasoning: false });
    assert.equal(result.status, 'finished');
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1].messageKind, 'tool_request');
    assert.deepEqual(pushes[1].toolCalls, [{ id: 'c1', type: 'function', function: { name: 'x' } }]);
  });
});

// 11) messageId precedence
describe('11) messageId hook vs auto', () => {
  it('hook-set messageId is preserved; unset → lib auto-fills with unique id', async () => {
    const { pushes } = await runDirect({
      decision: 'finish',
      pushPayloads: [
        { messageKind: 'content', message: 'a', messageId: 'hook-set-1' },
        { messageKind: 'content', message: 'b' },
        { messageKind: 'content', message: 'c', messageId: 'hook-set-3' },
      ],
    }, { autoEmitReasoning: false });
    assert.equal(pushes[0].messageId, 'hook-set-1');
    assert.equal(pushes[2].messageId, 'hook-set-3');
    assert.notEqual(pushes[1].messageId, undefined);
    assert.notEqual(pushes[1].messageId, pushes[0].messageId);
    assert.notEqual(pushes[1].messageId, pushes[2].messageId);
  });
});

// 12) messageIndex/totalMessages always overwritten
describe('12) messageIndex/totalMessages overwritten', () => {
  it('caller-supplied indices are clobbered with array-derived values', async () => {
    const { pushes } = await runDirect({
      decision: 'finish',
      pushPayloads: [
        { messageKind: 'content', message: 'a', messageIndex: 999, totalMessages: 0 },
        { messageKind: 'content', message: 'b', messageIndex: 999, totalMessages: 0 },
      ],
    }, { autoEmitReasoning: false });
    assert.deepEqual(pushes.map(p => p.messageIndex), [1, 2]);
    assert.deepEqual(pushes.map(p => p.totalMessages), [2, 2]);
  });
});

// 13) reasoning auto-emit + pushPayloads coexist
describe('13) reasoning auto-emit precedes hook pushPayloads', () => {
  it('reasoning push ships first, then hook pushes', async () => {
    const { pushes } = await runDirect({
      decision: 'finish',
      pushPayloads: [
        { messageKind: 'content', message: 'final answer' },
      ],
    }, { reasoning: 'thinking...' });
    assert.equal(pushes.length, 2);
    assert.equal(pushes[0].messageKind, 'reasoning');
    assert.equal(pushes[0].reasoningContent, 'thinking...');
    assert.equal(pushes[1].messageKind, 'content');
    assert.equal(pushes[1].message, 'final answer');
  });
});
```

- [ ] **Step 2: Run the new file, expect green**

Run: `cd packages/rei-standard-amsg/instant && node --test test/pushpayloads-array.test.mjs 2>&1 | tail -30`
Expected: 13 tests pass.

If `makeLlmResponse` isn't exported from `helpers.mjs`, copy the helper inline at the top of this file (it's small — see `test/split-pattern-hook.test.mjs` lines 99–107 as the canonical shape). Don't add a fresh helper if one already exists.

- [ ] **Step 3: Commit**

```bash
git add packages/rei-standard-amsg/instant/test/pushpayloads-array.test.mjs
git commit -m "$(cat <<'EOF'
test(amsg-instant): 13-case pushPayloads contract matrix

Pins the next.4 hook contract per spec §测试要求: single push,
multi-push spacing, mid-array throw, HookError rejection cases,
kind/decision decoupling, messageId precedence, index auto-fill, and
reasoning auto-emit interplay.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Rewrite README §Hook + delete splitPattern sections

The instant README is the public-facing contract doc. Section "Hook" needs a full rewrite. The splitPattern subsections (the table + per-push override + worked examples) need to go.

**Files:**
- Modify: `packages/rei-standard-amsg/instant/README.md`

- [ ] **Step 1: Read the existing Hook section**

Read `packages/rei-standard-amsg/instant/README.md` lines 100–340 to find the Hook section and the splitPattern section.

- [ ] **Step 2: Replace the splitPattern subsections with one short "Splitting is now caller-side" note**

Find the heading `#### \`splitPattern\` 系列：按 \`messageKind\` 独立的分句正则（0.6.0+ / 0.8.0-next.2+）` (line ~187) and the per-push override sub-section that follows (around line ~223 — header `##### Per-push override：\`pushPayload.splitPattern\`（0.8.0-next.3+）`). Replace EVERYTHING from the splitPattern heading down through the end of the per-push override sub-section with:

```markdown
#### 切分由 caller 负责（0.8.0-next.4 起）

next.4 起 lib 不再做任何拆分。hook 返 `pushPayloads: PushPayload[]`，里面装的就是 lib 会原样依次发的 N 条 push。常见 caller 会自己实现：

- 按 `\n` 或 CJK 字符之间的空格切（lookbehind / lookahead 写得出来）
- 按 inline tag（比如 `[[SEND_EMOJI: xxx]]`）独立成段
- 切完空段 `filter`、按业务规则前后 `merge` / `split` 二阶段
- per-chunk `notification.body` 用 sanitized 文本，`message` 字段保留 raw

如果想要 0.7 / next.2 / next.3 的「默认 `/([。！？!?]+)/` 句切」行为，自己写：

```js
const segments = text.split(/([。！？!?]+)/g)
  .reduce((acc, part, i, arr) => {
    if (i % 2 === 0 && part.trim()) acc.push(part.trim() + (arr[i + 1] || ''));
    return acc;
  }, [])
  .filter(s => s.length > 0);

return {
  decision: 'finish',
  pushPayloads: segments.map((message) => ({
    messageKind: 'content',
    sessionId: ctx.sessionId,
    message,
    notification: { title: `来自 ${ctx.contactName}`, body: message },
  })),
};
```

请求 body 上的 `splitPattern` / `reasoningSplitPattern` / `errorSplitPattern` 在 next.4 里直接 400；push 上带 `splitPattern` 抛 `HookError`。pre-release 强迫一次性改干净。
```

- [ ] **Step 3: Rewrite the §Hook contract section**

Find the section that describes `onLLMOutput`'s return shape (around line ~150 — search for `decision: 'finish'`). Replace the 4-decision summary code block with:

```markdown
```ts
type HookDecision =
  | { decision: 'finish';        pushPayloads: PushPayload[] }
  | { decision: 'tool-request';  pushPayloads: PushPayload[] }
  | { decision: 'continue';      nextHistory: ChatMessage[] }
  | { decision: 'skip-push' };
```

**没有单数 `pushPayload` 字段了。** 1 条就 `[push]`，3 条就 `[a, b, c]`。

lib 给每个 push 自动补这 3 个机械字段（hook 自己设 `messageId` 会被尊重，其余 2 个无论 hook 写什么都被覆盖）：

| 字段           | 自动补充行为                                   |
|----------------|-----------------------------------------------|
| `messageId`    | 未设时 lib 用 `msg_<uuid>_chunk_<i>` 填上     |
| `messageIndex` | 永远是 1-based 数组下标 + 1（hook 写啥都覆盖）|
| `totalMessages`| 永远是 `pushPayloads.length`                  |

剩下所有字段（`messageKind` / `notification` / `metadata` / `messageKind` 特定字段 / 等）都是 per-push，caller 完全控制。
```

- [ ] **Step 4: Add three worked examples**

Right below the contract section, add:

````markdown
##### 例 1：单 push

```js
return {
  decision: 'finish',
  pushPayloads: [{
    messageKind: 'content',
    sessionId: ctx.sessionId,
    message: 'Hello',
    notification: { title: 'Sully', body: 'Hello' },
  }],
};
```

##### 例 2：3 chunk content + 不同 notification.body（banner 显示 sanitized，bubble 显示 raw）

```js
return {
  decision: 'finish',
  pushPayloads: [
    {
      messageKind: 'content',
      sessionId: ctx.sessionId,
      message: '你看',
      notification: { title: '来自 Sully', body: '你看' },
    },
    {
      messageKind: 'content',
      sessionId: ctx.sessionId,
      message: '[[SEND_EMOJI: 笑]]',                    // raw 给客户端 app
      notification: { title: '来自 Sully', body: '[表情：笑]' },  // sanitized 给 banner
    },
    {
      messageKind: 'content',
      sessionId: ctx.sessionId,
      message: '我没事的',
      notification: { title: '来自 Sully', body: '我没事的' },
    },
  ],
};
```

##### 例 3：tool-request 混 content + 多 toolCalls

```js
return {
  decision: 'tool-request',
  pushPayloads: [
    {
      messageKind: 'content',
      sessionId: ctx.sessionId,
      message: '让我同时查日记和天气',
      notification: { title: '来自 Sully', body: '让我同时查日记和天气' },
    },
    {
      messageKind: 'tool_request',
      sessionId: ctx.sessionId,
      message: '',
      toolCalls: [
        { id: 'rd_1', type: 'function', function: { name: 'notion_read_diary', arguments: '{"date":"2024-05-21"}' } },
        { id: 'ws_1', type: 'function', function: { name: 'web_search',        arguments: '{"query":"北京天气"}' } },
      ],
      // 无 notification → 不弹 OS 横幅
    },
  ],
};
```

decision 跟 push 内容的 `messageKind` 分布完全解耦——lib 不检查「`tool-request` decision 是不是必须含 `tool_request` push」之类的搭配，hook 想怎么组合就怎么组合。
````

- [ ] **Step 5: Drop the typedef block's `splitPattern?:` line at line ~135**

In the section showing the request payload TypeScript-ish typedef (around line 130–145), remove the `splitPattern?: ...` line. Leave neighbouring fields alone.

- [ ] **Step 6: Update the "0.6 byte-level compat" note**

Around line 820 the README says: "Legacy 路径，字节级与 v0.6 一致（同 13 字段 payload、同 1500 ms 间隔、同 `splitPattern`、同 `onEvent` 事件）". Drop the `同 splitPattern` reference (legacy still uses default sentence regex internally — its behaviour is unchanged for callers, but the public `splitPattern` knob is gone).

- [ ] **Step 7: Commit**

```bash
git add packages/rei-standard-amsg/instant/README.md
git commit -m "$(cat <<'EOF'
docs(amsg-instant)!: rewrite README §Hook for pushPayloads-only API

Drop the splitPattern / reasoningSplitPattern / errorSplitPattern
subsections + per-push override sub-section (~150 lines). Add the new
pushPayloads contract block, the messageId/messageIndex/totalMessages
auto-fill table, and three worked examples (single push, 3-chunk
content with per-chunk notification.body, tool-request mixing content
and multi-toolCalls).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Add CHANGELOG entry + migration guide + version bump

**Files:**
- Modify: `packages/rei-standard-amsg/instant/CHANGELOG.md` (prepend new section)
- Create: `packages/rei-standard-amsg/instant/docs/migration-0.8.0-next.4.md`
- Modify: `packages/rei-standard-amsg/instant/package.json` (`0.8.0-next.3` → `0.8.0-next.4`)

- [ ] **Step 1: Prepend the CHANGELOG entry**

Add to the very top of `packages/rei-standard-amsg/instant/CHANGELOG.md` (above the existing `## 0.8.0-next.3` section):

```markdown
## 0.8.0-next.4 — BREAKING: pushPayloads-only hook decision API (pre-release)

Install with `npm install @rei-standard/amsg-instant@next`. Pre-release — breaking on purpose. 见 [`docs/migration-0.8.0-next.4.md`](./docs/migration-0.8.0-next.4.md) 完整迁移指南.

### Removed

- `decision.pushPayload` (singular). Replaced by `decision.pushPayloads: PushPayload[]`.
- Request-body fields `splitPattern` / `reasoningSplitPattern` / `errorSplitPattern` — rejected with 400 `INVALID_PAYLOAD_FORMAT` and a migration hint pointing at `pushPayloads`.
- `pushPayload.splitPattern` per-push override (next.3 only) — rejected with `HookError`.
- Public export `splitMessageIntoSentences` — used to be exported from `@rei-standard/amsg-instant` for hook authors who wanted "the same default split as the legacy path". The legacy path still uses it internally; hook authors implement their own split.
- Internal helpers `splitHookPushPayload` / `splitOnceByRegex` / `pickSplitConfig` / `validateSplitPattern` / `validatePerKindSplitPatterns` / `DEFAULT_SPLIT_REGEX` / `SPLIT_PATTERN_MAX_*` — all gone.
- The two-layer reasoning cascade collapsed to one layer (byte chunking). The Layer-1 sentence split via `reasoningSplitPattern` is gone with the field.

### Changed

- `runAgenticLoop`'s finish / tool-request branch now reads `decision.pushPayloads` and ships each push via `sendPushWithMaybeBlob` with `SLEEP_BETWEEN_MESSAGES_MS` (1500ms) between consecutive pushes. Per-push: `messageId` is auto-filled when absent (`msg_<uuid>_chunk_<i>`); `messageIndex` / `totalMessages` are always overwritten with array-derived values.
- LOOP_EXCEEDED diagnostic is now a single `sendPushWithMaybeBlob` call (no looping needed — the diagnostic is one push).
- Reasoning auto-emit (`autoEmitReasoning: true`, default): now a single transform. Short reasoning → 1 push; oversized → N byte-chunked pushes with `chunkIndex` / `totalChunks` (Layer-2 only).

### Unchanged

- Legacy v0.6 compat path (no `onLLMOutput`) still splits raw LLM text by sentence regex and ships sequential pushes — byte-level identical to v0.6. The public `splitPattern` knob on the request body is gone, but the path's internal behaviour is preserved (default regex `/([。！？!?]+)/`).
- HOOK_THREW handling (single-shot diagnostic, best-effort delivery), blob envelope, `maxLoopIterations`, `autoEmitReasoning`, `reasoningChunkBytes`, all 4 decisions (`finish` / `tool-request` / `continue` / `skip-push`).
- VAPID / push subscription / `apiKey` are still not exposed to the hook.
- HTTP status code mapping unchanged.

### Migration cheat sheet

| next.3                                                                  | next.4                                                                        |
|-------------------------------------------------------------------------|-------------------------------------------------------------------------------|
| `return { decision: 'finish', pushPayload: { ... } }`                   | `return { decision: 'finish', pushPayloads: [{ ... }] }`                      |
| Request body `splitPattern: '([。！？!?]+)'`                             | Implement the split in your hook; return one push per segment                |
| `pushPayload.splitPattern: null` (per-push disable from next.3)         | Return `pushPayloads: [singleUnsplit]`                                        |
| `reasoningSplitPattern` request field                                   | Set `autoEmitReasoning: false`, build N reasoning pushes yourself with `buildReasoningPush(...)`, include them at the start of `pushPayloads` |

### Why breaking in pre-release

The `0.8.0-next.*` series is pre-1.0 unstable. next.2 + next.3 stacked two overlapping mechanisms (lib-side splitPattern auto-split + hook-side pushPayload singular). next.4 collapses both into one (caller returns the exact pushes it wants sent) before 1.0 freezes the public surface.
```

- [ ] **Step 2: Create the migration guide doc**

Create `packages/rei-standard-amsg/instant/docs/migration-0.8.0-next.4.md` with the expanded migration content — copy the §Migration cheat sheet table from the CHANGELOG, plus add the three full worked examples from the README. The guide is the long-form companion; the CHANGELOG points to it.

The full content should mirror the spec's §迁移指南 block verbatim — copy that section in CN/EN per the spec's authorial voice.

- [ ] **Step 3: Bump the version**

In `packages/rei-standard-amsg/instant/package.json`:

```diff
-  "version": "0.8.0-next.3",
+  "version": "0.8.0-next.4",
```

Don't update `dependencies` — `@rei-standard/amsg-shared@0.1.0-next.3` is still the right peer.

- [ ] **Step 4: Verify build still works**

Run: `cd packages/rei-standard-amsg/instant && npm run build 2>&1 | tail -20`
Expected: tsup builds dist/ cleanly (the build doesn't read package.json version for code generation, but a sanity check catches any stray `splitMessageIntoSentences` import we missed).

If `npm run build` exits non-zero, read the error carefully — most likely cause is a stale import / re-export that escaped Task 1.

- [ ] **Step 5: Commit**

```bash
git add packages/rei-standard-amsg/instant/CHANGELOG.md packages/rei-standard-amsg/instant/docs/migration-0.8.0-next.4.md packages/rei-standard-amsg/instant/package.json
git commit -m "$(cat <<'EOF'
docs(amsg-instant)!: 0.8.0-next.4 CHANGELOG + migration guide + version bump

Pre-release breaking change documented end-to-end:
- CHANGELOG.md: BREAKING section enumerating Removed / Changed /
  Unchanged + migration cheat sheet
- docs/migration-0.8.0-next.4.md: long-form companion with worked
  examples for the 3 most common migrations
- package.json: 0.8.0-next.3 → 0.8.0-next.4

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Full-suite verification + final commit

**Files:**
- None (verification only — any drift surfaces a fixup commit)

- [ ] **Step 1: Run the full suite from scratch**

Run: `cd packages/rei-standard-amsg/instant && node --test test/*.test.mjs 2>&1 | tail -40`
Expected: green. Count `# pass <N>` and `# fail 0`.

- [ ] **Step 2: Build the dist bundle**

Run: `cd packages/rei-standard-amsg/instant && npm run build 2>&1 | tail -20`
Expected: tsup writes dist/ without errors. Look at `dist/index.mjs` and grep:

```bash
grep -n "splitHookPushPayload\|splitMessageIntoSentences\|validateSplitPattern\|sendChunkedPush\|DEFAULT_SPLIT_REGEX" packages/rei-standard-amsg/instant/dist/index.mjs | head -10
```

`splitMessageIntoSentences` may still appear (legacy path's internal use). All others MUST be gone. If any leak, that's a stale import or re-export — fix the source file and re-run from Step 1.

- [ ] **Step 3: Confirm no stray usages elsewhere in the monorepo**

Run:
```bash
grep -rn "pushPayload:" packages/rei-standard-amsg --include="*.js" --include="*.mjs" --include="*.md" | grep -v "node_modules\|dist\|CHANGELOG\|docs/migration"
```

Expected: empty (modulo the CHANGELOG / migration docs themselves, which legitimately reference the old field name in the `next.3` history section).

- [ ] **Step 4: Run the broader instant `agentic-loop-skeleton` example sanity check**

```bash
cd packages/rei-standard-amsg/instant && node -e "import('./examples/agentic-loop-skeleton/worker.js').then(m => console.log(Object.keys(m)))" 2>&1
```

Expected: the example imports cleanly (`{ default: ... }`). If it errors with "pushPayload is removed", Task 5 missed the example file. Fix and re-commit.

- [ ] **Step 5: One final smoke test — start node + drive a synthetic request**

This is optional but cheap. Skip if Steps 1–4 are all green.

- [ ] **Step 6: Confirm clean git status**

```bash
git status
```

Expected: clean working tree. All 9 prior commits visible in `git log`. If anything is uncommitted, look at it carefully — should be either fixup-worthy or actually intended.

- [ ] **Step 7: (Optional) Squash-merge prep**

The 9 commits track the implementation order for review. If the eventual PR is squash-merged, the squash message should be `feat(amsg-instant)!: 0.8.0-next.4 — pushPayloads-only hook decision API` with the CHANGELOG entry as the body. Do not squash on this branch unless the user explicitly asks — leave the commit history clean for `git log` traceability.

---

## Self-review

**Spec coverage:**
- §背景 痛点 1（split 规则正则表达不完）→ Task 8 README rewrite says caller does its own split; Task 7 fixtures #1, #2 exercise multi-push.
- §背景 痛点 2（per-chunk 字段独立性）→ Task 7 fixture #1 asserts `notification` survives per-push; Task 5 migration; Task 8 worked example #2.
- §API definition → Task 2 + Task 3 implement.
- §例 1 / 2 / 3 → Task 7 fixtures #1, #13, #9 — note example 3 is mirrored by fixture #9 (tool-request decision + mixed kinds).
- §校验规则 #1 (empty array) → Task 2 step 1 fixture; Task 7 fixture #4.
- §校验规则 #2 (both pushPayload + pushPayloads) → Task 2; Task 7 fixture #5.
- §校验规则 #3 (only pushPayload, no auto-wrap) → Task 2; Task 7 fixture #6.
- §校验规则 #4 (push.splitPattern) → Task 2; Task 7 fixture #7.
- §校验规则 #5 (request body split-pattern fields) → Task 1; Task 7 fixture #8.
- §lib 自动补充字段 → Task 3 `sendPushesSequentially`; Task 7 fixtures #11 + #12.
- §发送行为 → Task 3 `sendPushesSequentially` (sequential, 1500ms gap, mid-throw abort); Task 7 fixtures #2, #3.
- §reasoning push 路径独立 → Task 4 `sliceReasoningPush` / `emitReasoning`; Task 4 step 1 fixtures; Task 7 fixture #13.
- §删除 `splitPattern` 相关 → Task 1 (validation) + Task 3 (helpers gone) + Task 6 (tests gone).
- §迁移指南 → Task 9 CHANGELOG + migration doc.
- §测试要求 13 cases → Task 7 maps each one.
- §文档要求 → Task 8 (README) + Task 9 (CHANGELOG + migration).

**Placeholder scan:** No TBDs. Every "implement appropriate X" step has the actual code. Every "similar to Task N" mention points at one specific prior task and re-states the relevant bits.

**Type consistency:** `pushPayloads` everywhere (plural). `sendPushesSequentially` referenced consistently. `messageId` / `messageIndex` / `totalMessages` field names are identical across plan, code, and test sections. `HookError` (`{ cause? }` constructor) used uniformly.

**Risk:**
- The `pushHandler` knob on `createFetchRouter` referenced in Task 3 step 1 / Task 7 fixture #3 may not exist in `helpers.mjs`. Plan says "extend if missing" — that's a one-line addition that's already inside Task 3's step.
- Task 8 step 3 says "find section showing return shape … around line 150". If the README diverges from my count, the executor should re-locate via `grep -n "decision: 'finish'" README.md`. The replacement content is exact regardless of where it lands.
