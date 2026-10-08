# Cloud data management

`cloud-data-management` is an authenticated, per-user management protocol. The
D1 adapter advertises it only when transactional `batch` is available. Other
adapters return 501 and do not advertise it. Upgrading the client alone does
not upgrade a deployed Worker: check `/capabilities` first and run the normal
schema upgrade (`ensureSchema` or `/init-tenant`) after deploying the server.

## Inventory and ownership

The inventory reads actual task, client state, credential, outbox (including
acknowledged), and push subscription rows. It does not use an owner directory
as the source of truth. State chunks are grouped with their logical root;
orphan chunks and unreadable ciphertext remain visible. Responses never
include chat bodies, keys, or subscription endpoints.

Configure the single-user server/Cloudflare Worker with:

```js
cloudData: {
  async resolveOwner({ type, namespace, key, value, credId, payload, task, tasks }) {
    // Host-specific legacy ownership rules; use only reliable identifiers.
    // `value` is decrypted state text, `payload` is decrypted task/outbox data,
    // `tasks` is the current user's cloud tasks during inventory scans.
    if (type === 'state' && namespace?.startsWith('character:')) {
      return { owner: { type: 'character', id: namespace.slice(10) }, kind: 'context' };
    }
    return { owner: null, kind: null };
  }
}
```

New task, state, and credential writes accept `owner: {type,id,label?}`, `kind`,
and `ownerGeneration`. Labels and resource metadata are encrypted with the
existing per-user key. Legacy ownership is resolved from cloud records on
read and guard checks, without a browser-side migration dependency. Unknown
ownership remains unknown. Shared/global data should return `owner: null`.

The resources endpoint creates a 15-minute encrypted snapshot. Its opaque
cursor is bound to the user and filters; page through `nextCursor` until null.
`complete` reports source readability, independently of pagination. Failed
sources populate `gaps`, and incomplete inventories cannot create cleanup
plans. Refresh to see writes that happened after the snapshot was created.

## Routes

All routes use the existing user authentication/encryption protocol.

| Method | Route | Meaning |
| --- | --- | --- |
| GET | `/cloud-data/summary` | Actual resource counts/bytes and completeness |
| GET | `/cloud-data/resources` | `cursor`, `limit` (1–200), `type`, `ownerType`, `ownerId` |
| POST | `/cloud-data/cleanup-plans` | `{mode, resourceIds?, owner?, types?}` |
| POST | `/cloud-data/cleanup-operations` | `{planId,idempotencyKey}` |
| GET | `/cloud-data/cleanup-operations` | Durable operation history |
| GET | `/cloud-data/cleanup-operations/:id` | Read-only operation status |
| GET | `/cloud-data/owners` | All persisted owner retirement/generation records |
| GET | `/cloud-data/owner` | `ownerType`, `ownerId` retirement/generation |
| POST | `/cloud-data/owner` | `{action:'restore',owner}` |

`purge` requires selected resource IDs or an owner; types only narrow that
selection. Empty or ambiguous selections are rejected. Plans expire after
15 minutes and preserve resource summaries and cryptographic versions, never copies
of original payloads. Execution reloads the matching rows and conditionally deletes
the exact current physical snapshot. Changed resources are
not deleted under old previews. Missing resources already count as removed.

`retire-owner` requires exactly one owner and no resource/type restriction.
The preview explains that execution covers **all resources owned at execution
time**, including additions since preview. Execution first retires the owner,
then discovers and removes its resources. Subscriptions and shared data are
not implicitly owned by a character.

Operations are encrypted and persisted. The first request handles up to 25
resources, with cron continuing later even when the browser closes. Continuation
requires the Worker scheduled/cron trigger to remain enabled. If the host pauses
background tasks by removing that trigger, cleanup remains pending until the
trigger is restored; this release does not install a separate cleanup alarm. A renewable database
lease with a fencing token prevents expired workers from deleting resources or
overwriting another worker’s progress. Failures remain pending with exponential
backoff; stale previews or eight failed attempts stop with an explicit failure.
Completion requires a new successful inventory showing no selected remainder.
GET polling reads the operation record only. Consumed plans are removed; expired
plans and inventory snapshots are reclaimed by cron after one hour, completed or
failed operation summaries after 30 days. Indexed expiry reclaim runs in batches
of at most 100 records; active processing leases are preserved. Retired owner markers remain discoverable
through `/cloud-data/owners`. Idempotency keys are user-scoped
and cannot be reused for a different plan.

## Retirement, recovery, and in-flight work

An owner starts active at generation 0. Retirement and explicit restoration
each increment its generation; restoring an already-active owner is idempotent. **Omitting `ownerGeneration` means zero**, never
"use whatever the current generation is." After restoration, the application
must retain the returned generation and send it on future task, credential and
state writes. Old devices and late requests therefore remain invalid.

Accepted tasks persist their owner generation. Derived tasks and outbox writes
inherit it; task-scoped state writes check both the running task and the target
resource. Database writes check retirement/generation in the same transaction
as the mutation, not just in a preflight read. Fire checks its captured generation
before starting and immediately before sending a push. Once handed to an
external push service, a notification cannot be recalled.

The restore endpoint rejects an owner whose cleanup is pending/running. A
failed cleanup can be inspected and retried by creating a fresh plan; unknown
or unreadable resources remain available for explicit selection.

## Demand-driven D1 maintenance

Schema `2.6.0-cloud-data.2` adds `cloud_data_work`, `cloud_data_maintenance`, two
partial scheduling/expiry indexes and deletion triggers. `ensureSchema` checks
these indexes and triggers, so existing deployments install them once after an
upgrade. The work index stores opaque identities and absolute execution/expiry
times; resource contents, labels and operation details stay encrypted.

Resource deletion removes its exact metadata sidecar in the same transaction,
including ordinary cancellation, credentials, subscription changes and TTL
retention. Logical state metadata remains while either the root or any of its
chunks exists. Roots and chunks use separate full-key index probes. Cron does
not run a global orphan-sidecar sweep.

Existing sidecars and management records receive a one-time bounded repair:
100 root rows per source per tick, with persistent rowid cursors and an initial
upper bound. Finished repair does not restart after Worker eviction/redeployment.
Unreadable legacy operation records remain available for inspection, rather
than being guessed safe to delete. Concurrently changed operations are not
rescheduled from stale repair snapshots.

Normal continuation selects at most 25 due unfinished operations through the
work index, skips future retries and active leases, and never decrypts completed
history on each tick. Inventory/plan TTL is one hour; terminal operation TTL is
30 days from completion/failure. Pending/running operations never expire merely
because they are old. Existing task, state and outbox retention also deletes at
most 100 rows per retention predicate per tick, without changing their cutoffs.

`GET /cloud-data/resources` includes an optional `summary` from the same inventory
snapshot as its pages. Clients should reuse it instead of immediately calling
`GET /cloud-data/summary`. The standalone summary route remains available for
older clients; cursor pages retain the original snapshot and summary. Explicit
refresh and deletion preview still build a fresh inventory to validate actual
resources and their versions.
