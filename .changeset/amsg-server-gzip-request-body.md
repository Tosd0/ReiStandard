---
"@rei-standard/amsg-server": minor
---

请求体带 `Content-Encoding: gzip` 时自动解压，所有带 body 的端点一次全通

客户端把大 body（一整批 `client_state`、一条内容很长的任务）压了再传能省下几倍传输量，之前服务端不认这个头，压过的请求体会被当明文读，报出来是一句「请求体不是有效的 JSON」。

现在正文的读取统一走 `readRequestBody()`，`Content-Encoding: gzip` 在那一步还原，单用户 Worker 上每个带 body 的端点都认。放在路由之前是有意的——各端点自己判那个头的话，漏判的那个照样收到乱码。

边界：没有这个头 → 原样读，行为一字不差；说是 gzip 而字节是明文 → 按明文处理（有些边缘网关会替你解开却留着这个头）；`br` / `deflate` 之类 → `415 UNSUPPORTED_CONTENT_ENCODING`，不猜着解；解压后超过上限 → `413 REQUEST_BODY_TOO_LARGE`（默认 32MB，config 的 `maxRequestBodyBytes` 可调，上限只管压缩这条路——几百 KB 的压缩数据能展开成几个 GB）；数据坏了 → `400 INVALID_CONTENT_ENCODING`。

新导出：`readRequestBody`、`DEFAULT_MAX_REQUEST_BODY_BYTES`（自己包路由的宿主用它代替 `await request.text()`）。特性位：`gzip-request-body`。
