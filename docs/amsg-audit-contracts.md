# Task inputs, fire task views, attachments, and state synchronization

This is an additive contract for `amsg-server` and `amsg-client`. It does not add
application policies, change package versions, or migrate the separate
`amsg-instant` transport.

## Task-bound input

`POST /schedule-message` accepts optional `taskInput: object | null`. The server
stores it in the encrypted task payload, in the same transaction as task creation
and atomic replacement on built-in adapters. `onBeforeFire` reads it through
`ctx.task.taskInput`. A rejected request cannot overwrite an older task's input.

The entire task, including input, remains subject to `MAX_TASK_PAYLOAD_BYTES`.
`taskInput` is not a field supported by `PUT /update-message`; create a replacement
when the input changes. Keep credentials outside the input and use `credRefs` so
credential rotation remains live. Application-owned dynamic settings can still be
read through `readState` at fire time.

`ctx.scheduleTask({ ..., taskInput })` accepts explicit input for a child task.
Omitting it produces `null`; the parent's request is never silently copied into a
new task. Custom encrypted acceptance routes can use the public
`deriveUserEncryptionKey`, `decryptPayload`, and `encryptPayload` exports.

Large inputs can instead live at an application-owned, unique `client_state`
key, with only an immutable reference in `taskInput`. `ctx.readState(namespace,
{ key })` returns zero or one decrypted entry and reassembles its chunks. D1
selects only that root and its chunk-key range; it does not load every input in
the namespace. The one-argument form still reads the full namespace. Legacy
adapters that ignore selection options remain correct through root filtering,
but must implement `getClientState(userId, namespace, { key, keyPrefix })` to
obtain the same bounded reads. The application owns reference validation,
immutability, resource ownership, and retention for its input namespace.

## Task facts inside fire hooks

`ctx.listTasks({ status = 'pending', limit = 100, offset = 0,
includeMetadata = true })` is available in `onBeforeFire`, `onLLMOutput`, and
`executeToolCalls`. It returns `{ tasks, pagination: { total, limit, offset,
hasMore } }` using the same credential-free projection as the HTTP task APIs.
`limit` is 1–100. It reads only the current authenticated user's rows; application
owners such as characters are filtered by the host using metadata.

A page is not the whole task set. Exhaust pagination before calculating a quota
or declaring a task absent. These reads are live pages, not an isolated database
snapshot; concurrent mutations require another reconciliation. `pending` includes
leased/in-flight and overdue tasks until settlement, and may include the task
currently firing. A completed one-shot task has been removed from this set.

Successful `scheduleTask` and `renewTask` responses add `task`, the safe task
projection describing the accepted change. Existing success booleans and failure
reasons retain their meaning. A duplicate create still returns the existing task
when it is readable. These responses are mutation receipts, not a durable journal.
Applications can use their existing `emitResult` path for UI delivery and task
listing to recover facts after a missed receipt. Do not treat a new context
snapshot as acknowledgment that a client imported a task.

## Execution permissions

An object returned by `onBeforeFire` may include `allowedToolNames: string[]`.
Omitting it preserves the trusted-hook contract. An empty list disables execution;
a nonempty list permits only those names. This list is independent of the `tools`
and `toolChoice` transport fields.

Both native and text-protocol calls returned by `onLLMOutput` are checked before
`executeToolCalls`. Denied calls receive a tool result with
`error.code: 'TOOL_NOT_ALLOWED'`, allowing the model to continue without executing
the operation. Hosts remain responsible for parsing text safely and for applying
business policy inside any direct hook-side operations.

## Occurrence-bound attachments

`ctx.storeAttachment(serializedValue, { ttlMs?, owner?, kind?, ownerGeneration? })`
returns `{ version: 1, namespace, key, taskUuid, occurrenceMs, expiresAt }`.
The namespace is `amsg:attachments`; every write has a fresh random key. The
stored envelope binds the key to the task and occurrence. A retry may create an
additional attachment, but cannot replace the content referenced by an earlier
result. Pass the complete reference in the push/outbox payload.

Use explicit `owner`, `kind` (default `attachment`), and `ownerGeneration` when
attachments belong to an application entity. These fields are stored in the
cloud resource metadata and envelope, allowing ordinary owner cleanup to find
them. The originating task's generation guard still applies; an attachment cannot
write across owners or resurrect a retired owner.

`client.getAttachment(ref)` returns the original string, or `null` for missing,
expired, or mismatched data. Read/network errors remain errors. It uses
`client.getClientState(namespace, { key })`, which limits the response to one
entry. D1 reads that root by index and only that entry's chunk range. Custom
adapters may implement the optional third argument
`getClientState(userId, namespace, { key?, keyPrefix? })`; older adapters retain a
filtered-response fallback but may still read the whole namespace internally.

Reads do not delete or acknowledge attachments: another device, outbox replay, or
push retry may need the same reference. The default TTL and maximum TTL are 30
days. A shorter TTL is enforced on reads; cron physically reclaims attachment roots
and chunks after 30 days even without an application `clientStateTtl` setting.
Physical cleanup requires the adapter's `cleanupClientState` implementation and a
running scheduled tick. Applications should keep attachment TTL at least as long
as their result-recovery window. Existing state size/chunk limits apply.

## Reliable client-state writes

`classifyClientStateWrite(entries, response)` returns one outcome per submitted
entry: `applied`, `conflict`, `rejected`, `unknown`, or `failed`. It checks
`skippedEntries`, `rejected`, and receipt counts. HTTP success with an incomplete
receipt never authorizes clearing pending state. It does not advance timestamps
or resolve conflicts with another device.

`createLatestStateSync({ send, loadPending?, savePending? })` is an optional queue:

```js
const sync = createLatestStateSync({
  send: entries => client.putClientState(entries),
  loadPending: () => localStore.loadPending(),
  savePending: entries => localStore.savePending(entries),
});
const report = await sync.enqueue(entries);
```

`enqueue` persists the latest value per namespace/key before uploading. If a newer
save arrives during an upload, the new value is sent immediately afterward. An
older request can only clear the exact version it sent. `flush()` restores and
retries pending work; `getPending()` returns a copy.

Reports contain `{ outcomes, pending, revision }`. Network failures, conflicts,
rejections, and unknown outcomes remain pending. Each version is attempted at most
once in a flush, so an error does not create a retry loop. The host schedules
backoff/reconnect retries and chooses conflict resolution; automatically increasing
a timestamp would risk overwriting another device. Storage failures reject the
operation while preserving pending data. If restoration fails, construct a new
synchronizer after storage recovers; the failed instance will not pretend its
unknown durable queue is empty. One instance coordinates one user's queue;
cross-tab storage arbitration remains the adapter's responsibility.
