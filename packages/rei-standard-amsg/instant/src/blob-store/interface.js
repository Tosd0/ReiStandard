/**
 * BlobStore — pluggable transient store for "envelope-redirected" pushes.
 *
 * Web Push has a small plaintext payload budget (see README §BlobStore
 * for provenance). When the hook returns a large pushPayload (e.g.
 * tool-request envelopes carrying replay history + reasoning),
 * amsg-instant writes the body to a BlobStoreAdapter and pushes a
 * small envelope `{ _blob:true, key, url, type? }` instead. The SW /
 * client recovers the original body through that envelope contract.
 *
 * Adapter contract:
 *   put(key, body, ttlSeconds)  - durable until ttlSeconds elapses (or
 *                                 sweeper deletes the row). MAY throw
 *                                 (full / network / quota) — the
 *                                 caller catches and emits
 *                                 `blob_put_failed`.
 *   read(key)                   - **non-destructive**. Multiple reads
 *                                 within TTL must return the same body
 *                                 (so SW can dedup *after* fetch).
 *                                 Returns `null` for expired/missing.
 *
 * Physical cleanup is the deployer's job: SQL backends should ship a
 * cron sweeper that runs `DELETE FROM amsg_transient_blobs WHERE
 * expires_at < now`. KV-style backends with native TTL handle it
 * automatically.
 *
 * @typedef {Object} BlobStoreAdapter
 * @property {(key: string, body: string, ttlSeconds: number) => Promise<void>} put
 * @property {(key: string) => Promise<string | null>} read
 */

/**
 * @typedef {Object} BlobStoreConfig
 * @property {BlobStoreAdapter} adapter
 * @property {number} [maxInlineBytes=2600]   - UTF-8 byte threshold. Above this, the envelope detour kicks in. See README for the 2820 B web-push-php derivation.
 * @property {number} [ttlSeconds=60]         - Lifetime for blob bodies. 60s is enough for the SW round-trip plus a couple of push redeliveries.
 */

// Intentionally type-only module; nothing to export at runtime. JSDoc
// `@typedef`s above are picked up by `tsup --dts` and tooling.
export {};
