---
"@rei-standard/amsg-server": minor
"@rei-standard/amsg-client": minor
---

`GET /capabilities` 特性探测端点 + 客户端 `getCapabilities()`

worker 部署版本落后时，新功能只是「探测不到」而不是静默失效。单用户 worker 新增 `GET /capabilities`，返回 `{ serverVersion, features }`（feature 名如 `client-state` / `client-state-chunking` / `agentic-hooks`，随版本演进追加；表达代码能力，不反映部署配置）；鉴权与 `/vapid-public-key` 一致。客户端 SDK 新增 `getCapabilities()`：打到没有该路由的老 worker（404）返回 `null` 不抛错，前端可据此在设置里提示「worker 需要重新部署」。
