---
"@rei-standard/amsg-client": minor
---

服务端回非 JSON 时抛带 `status` 的错；状态同步按 `updatedAt` 合并

**1. 非 JSON 响应抛 `NON_JSON_RESPONSE`**

走 JSON 信封的方法遇到服务端回非 JSON（网关的 HTML 错误页、空响应）时抛普通 `Error`，带 `status` 和 `code: 'NON_JSON_RESPONSE'`。非 2xx 的 JSON 信封照旧原样返回，不抛。`init()` / `getVapidPublicKey()` 失败抛的错带 `status` 和服务端的 `code`。`getCapabilities()` 遇到非 JSON 仍返回 `null`。

**2. latest-state-sync 按 `updatedAt` 合并**

同一 key 入队时按 `updatedAt` 取新：晚入队但 `updatedAt` 更旧的快照不会顶掉还没发出的新快照。

**3. Node 版本要求 ≥ 20.3.0**

`package.json` 的 `engines` 定为 `node >= 20.3.0`。
