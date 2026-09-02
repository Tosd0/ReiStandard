---
"@rei-standard/amsg-client": minor
---

`putClientState()` 的 entry 认 `value: null`，表示删掉这个 key

类型放宽到 `value: string | null`。传 `null` 时 server 把这个 key 的行（含大值的切片行）删干净，之后 `getClientState()` 读不到它；删除同样按 `updatedAt` last-write-wins，被拦下的 key 进响应的 `data.skippedEntries`，删掉的条数在 `data.deleted`。

server 从特性位 `client-state-delete` 起认这个语义，用 `getCapabilities()` 探测；老 server 会把 null 条目按 `INVALID_STATE_VALUE` 逐条拒掉、其余条目照常入库。SDK 本身不做运行时校验，与从前一致。
