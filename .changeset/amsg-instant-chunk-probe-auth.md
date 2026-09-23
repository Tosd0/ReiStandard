---
"@rei-standard/amsg-instant": patch
---

分片大小上限的校验按最长的 messageKind 算；X-Client-Token 的校验只留一份实现

`multipart.maxChunkBytes` 的上限校验用一条探针量信封开销，探针之前固定用 `reasoning`，比最长的 `tool_request` 短 3 字节。把 `maxChunkBytes` 配在上限附近（例如照着 `createInstantHandler` 抛错时建议的最大值去配）的部署，`content` / `reasoning` 的分片发得出去，`tool_request` 的分片每一片都超出单条 push 的明文上限、被推送服务拒收。现在按真实取值里最长的那个量，报出来的最大值对所有类型都成立。

导出的 `validateClientAuth` 与 `createInstantHandler` 内部的校验现在共用同一份实现（存在性检查、常时比较、401 响应体都是同一处），两边不会再各自漂。函数签名和行为不变，handler 仍然用启动时编好的 token 字节，没有每请求重编。
