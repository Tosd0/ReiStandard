---
"@rei-standard/amsg-instant": minor
---

接收端支持 gzip 压缩的请求体。带 `X-Amsg-Request-Encoding: gzip` 头的请求会先 gunzip 再解析，未带该头的请求按原样读取（行为不变）；CORS 预检白名单加入该头。这样 `@rei-standard/amsg-client` 的 `deliver({ compressRequest })` 能直接发到 `amsg-instant` 的 `/instant` / `/continue`，无需自建后端解压。
