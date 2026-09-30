---
"@rei-standard/amsg-server": minor
---

Add per-task `maxGenerationRetries` configuration and `onFireSettled.willRetry` / `failureStage` receipts. Interactive requests can stop after their first generation failure without provider-specific error codes, while committed outbox batches retain delivery-only retries. Existing tasks and default retry behavior remain compatible.
