# Changelog — @rei-standard/amsg-sw

## 2.1.0-next.0 — Three-axis push schema + per-kind client events (pre-release)

Published under the `next` dist-tag (repo convention for prereleases). Coordinated with the other amsg sub-packages' `*-next.0` releases. Install with `npm install @rei-standard/amsg-sw@next`. Schema is locked; the next-tag window is for downstream integrators to validate end-to-end before this graduates to `latest`.

---

Coordinated minor with the rest of the amsg ecosystem. The SW now consumes the `AmsgPush` discriminated union from `@rei-standard/amsg-shared` (keyed by `payload.messageKind`) and bridges every push to controlled clients via a per-kind `postMessage` channel, so apps can render `reasoning` / `tool_request` / `error` in-app without going through the OS notification surface.

### New

- **`REI_SW_EVENT` constants** — per-kind event names dispatched to clients. Five values: `CONTENT_RECEIVED` / `REASONING_RECEIVED` / `TOOL_REQUEST_RECEIVED` / `ERROR_RECEIVED` / `UNKNOWN_RECEIVED`. The last one is the back-compat path for 2.0.x payloads (and blob envelopes) that lack `messageKind`.
- **`REI_AMSG_POSTMESSAGE_TYPE` constant** (= `'REI_AMSG_PUSH'`) — the `type` field on every SW → client envelope. Clients filter on this before reading `event` so a single `message` listener can coexist with other postMessage protocols.
- **Per-kind client dispatch.** Every push the SW receives is mirrored to every controlled window via `client.postMessage({ type: 'REI_AMSG_PUSH', event, payload })`. `clients.matchAll` runs with `{ type: 'window', includeUncontrolled: true }` so the broadcast reaches pages that haven't yet claimed the SW.
- **Blob envelope dispatch.** Envelopes like `{ _blob: true, key, url, messageKind, type? }` are forwarded to clients verbatim with the matching per-kind event name. The SW does NOT auto-fetch the blob body — the client decides whether and when to fetch.
- **Runtime dep on `@rei-standard/amsg-shared@0.1.0`** (exact, no caret). The SW code only references shared types via JSDoc `@typedef`; no runtime symbol is imported. Listing the dep keeps the package present in the dependency graph for hoisting / type resolution alongside `amsg-instant` and `amsg-server`.
- **First test suite.** `test/dispatch.test.mjs` covers every dispatch branch using a lightweight `ServiceWorkerGlobalScope` mock — no real Workbox or sw environment needed. The package now ships a real `npm test` script (`node --test test/*.test.mjs`).

### Behavioral

- **`showNotification` only fires for content kinds.** Concretely, the SW renders a notification iff `payload.messageKind === 'content'` OR `messageKind` is absent (legacy 2.0.x back-compat). `reasoning` / `tool_request` / `error` are dispatched to clients but render nothing on the OS notification surface. Same rule applies to blob envelopes — only `messageKind === 'content'` (or absent) renders a placeholder notification.
- **Per-client `postMessage` failures are swallowed.** One offline / broken tab should not abort delivery to the rest. The `dispatchPushToClients` helper wraps each `postMessage` in its own try/catch.
- **`clients.matchAll` rejection is non-fatal.** If the call rejects, the SW still attempts `showNotification` for `content` payloads — notification rendering is independent of the broadcast path.
- **Dispatch order is best-effort parallel.** The SW kicks off `postMessage` broadcasting and `showNotification` together inside one `event.waitUntil(Promise.all(...))`. Clients should not assume the notification has been rendered (or vice versa) before the message arrives.
- **Existing `REI_SW_MESSAGE_TYPE` queue API is unchanged.** Enqueue / flush / sync paths are unaffected — the new dispatch logic only adds to the `push` listener.

### Migration

- **Apps that want desktop notifications for non-content kinds must implement them in-app.** Listen on `navigator.serviceWorker.addEventListener('message', ...)`, filter by `e.data.type === 'REI_AMSG_PUSH'`, switch on `e.data.event`, and call `Notification.requestPermission()` + `new Notification(...)` (or `registration.showNotification`) yourself for the kinds you care about. The SW intentionally no longer makes that decision for you.
- **No producer-side change is required** for 2.0.x callers that have not yet adopted the three-axis schema — their payloads route through `UNKNOWN_RECEIVED` and still render notifications via the existing path.
- **TS / JSDoc users** can pull `AmsgPush`, `ContentPush`, etc. from `@rei-standard/amsg-shared` to type the client-side `e.data.payload`. The SW package itself only references those types via JSDoc and does not re-export them.

## 2.0.1

- Maintenance release. No behavioral changes documented prior to this changelog.

## 2.0.0

- Initial public release of the v2 SW SDK with `installReiSW` + offline queue.
