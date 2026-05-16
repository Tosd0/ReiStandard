# Changelog — @rei-standard/amsg-client

## 2.1.0 — 2026-05-16

### Added

- `client.sendInstant(payload, endpointPath?, opts?)` — sends a one-shot instant message via `@rei-standard/amsg-instant`. Uses the same `userKey` fetched by `init()`, the same AES-256-GCM envelope, and the same `X-User-Id` / `X-Payload-Encrypted` / `X-Encryption-Version` headers as `scheduleMessage`. Accepts an optional `Authorization` header passthrough for deployments that enable amsg-instant's `tokenSigningKey`.
- New constructor option `customBaseUrls` — a per-endpoint base URL override map (key = endpoint name, e.g. `instant`). Falls back to `baseUrl` when an endpoint name is not present. Set this when an endpoint is deployed separately (e.g. `instant` on Cloudflare Workers while the rest run on Netlify). This is a general mechanism — future endpoints can be overridden with the same field instead of adding more `*BaseUrl` constructor options.

### Deprecated (soft)

- `client.scheduleMessage({ messageType: 'instant', ... })` — still works for backward compatibility (it routes through amsg-server's `/schedule-message` endpoint, which creates a task → processes → deletes the task in one round-trip). New code should prefer `sendInstant()` which skips the DB round-trip entirely.

## 2.0.1

(See git history.)
