---
'@rei-standard/amsg-server': patch
---

Keep cron cleanup running when delivery or another cleanup step fails, and add machine-readable D1 limit codes to `error.cause`:

- `runScheduledTick` now runs task, outbox and `client_state` cleanup after every tick; each step fails independently and is logged without affecting the delivery result.
- `summarizeErrorCause` adds `D1_STORAGE_FULL`, `D1_DAILY_READ_LIMIT` or `D1_DAILY_WRITE_LIMIT` when the error has no code of its own.
