---
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-client": minor
---

Add task-bound inputs, live paginated task views in fire hooks, explicit tool
execution allowlists, and occurrence-bound attachments with owner metadata,
targeted encrypted reads, and bounded retention. Keep credential references live
and preserve existing atomic task replacement behavior.

Allow fire hooks to read one client-state key and only its chunks, supporting
large immutable task input references without loading an entire namespace.

Add strict per-entry state write receipt classification and an optional persistent
latest-value synchronization queue. Concurrent saves drain after the active upload;
failed or conflicting versions remain pending without automatic timestamp changes.
