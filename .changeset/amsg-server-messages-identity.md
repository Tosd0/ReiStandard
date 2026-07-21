---
"@rei-standard/amsg-server": minor
---

`GET /messages` 每条任务额外返回 `charId` / `clientTaskId`（取自任务 metadata 的 `charId` / `amsgClientTaskId`，缺省为 null），供宿主按角色归属筛选任务。metadata 的其余字段不回传，凭据类字段照旧不回传。
