---
"@rei-standard/amsg-server": patch
---

单用户 Worker 默认的 CORS 放行头加上 `Content-Encoding`，浏览器跨域发 gzip 压缩的请求体时预检能通过，不用再自己配 `cors.allowHeaders`。云端数据清理重试次数用完、停止重试时，操作记录里的错误文案写「已停止重试」，与 `failed` 状态一致。示例 `schema.sql` 补齐云端清理用的表、索引和触发器，单独执行它建出的库能通过 `getSchemaVersion` 自查。
