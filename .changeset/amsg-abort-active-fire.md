---
"@rei-standard/amsg-shared": patch
"@rei-standard/amsg-server": patch
---

Abort active LLM requests when task cancellation or supersession invalidates the lease. Expose signal, isCancelled and throwIfCancelled to fire hooks; stop agentic continuation and outbox delivery after cancellation, and settle cancelled fires without retries. Shared callLlm now accepts an external AbortSignal while preserving its request timeout.
