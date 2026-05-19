# `examples/custom-blob-store`

Two ~30-line `BlobStoreAdapter` templates showing how to plug an
arbitrary backend (Postgres, Redis, anything else) into v0.7. The
package itself ships D1 / KV / Memory; everything else is reusing
this same interface.

## Contract recap

```ts
interface BlobStoreAdapter {
  put(key: string, body: string, ttlSeconds: number): Promise<void>;
  read(key: string): Promise<string | null>;
}
```

- `read` MUST be non-destructive (no DELETE). Push redelivery may
  cause the SW to fetch the same key multiple times within TTL.
- TTL handling can be backend-native (Redis `EX`, KV `expirationTtl`)
  or per-row column (`expires_at`) — the adapter just has to filter
  expired rows out of `read`.
- For SQL-style backends without native TTL, schedule a cron sweeper
  (`DELETE ... WHERE expires_at < now`) — `read` doesn't delete, so
  without a sweeper expired rows accumulate forever.

## Files

| File                     | Backend     | TTL strategy        |
|--------------------------|-------------|---------------------|
| `postgres-adapter.js`    | Postgres / Neon | per-row column + sweeper |
| `redis-adapter.js`       | Redis / Upstash | native `EX`         |
