---
"@rei-standard/amsg-server": patch
---

`ctx.emitResult` 的 `source` 跟着 `messageType` 走

结果推送里的 `source` 原来写死 `'scheduled'`，in-server instant 的 fire 里发结果会产出 `{ messageType: 'instant', source: 'scheduled' }`，违反标准的配对规则（`messageType: 'instant'` 必配 `source: 'instant'`）。现在与聊天推送同一判据：`messageType` 是 `'instant'` 时 `source` 也是 `'instant'`，其余照旧 `'scheduled'`。
